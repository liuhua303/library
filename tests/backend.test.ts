import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import type { CollectInput, Occurrence } from '../src/shared/types';
import { ReaderStore } from '../src/main/store';
import { AnalysisQueue } from '../src/main/queue';
import { analyseOccurrence, validateAnalysis } from '../src/main/analysis';
import { inspectEpub } from '../src/main/epub';
import { validCollect } from '../src/main/validation';
import { BookWriteBuffer } from '../src/main/book-write-buffer';

const cleanups: (() => void)[] = [];
function createStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'yuejian-backend-'));
  const store = new ReaderStore(directory);
  cleanups.push(() => {
    store.close();
    const relative = path.relative(os.tmpdir(), directory);
    if (!relative.startsWith('yuejian-backend-') || relative.includes(path.sep)) throw new Error('Unsafe test cleanup path');
    rmSync(directory, { recursive: true, force: true });
  });
  const book = store.addBook(new Uint8Array([1, 2, 3]), { title: 'Sample', author: 'Author', fileName: 'sample.epub' });
  return { store, book, directory };
}

function input(bookId: string, text = 'give', context = 'She will give up soon.', slot = 0): CollectInput {
  const start = context.indexOf(text);
  return { bookId, text, kind: 'word', context, chapterTitle: 'Chapter 1', anchor: {
    cfi: `epubcfi(/6/${slot + 2}!/4/2/1:${start},/1:0,/1:${text.length})`,
    chapterHref: 'chapter.xhtml', startOffset: start, endOffset: start + text.length, contextStartOffset: 0,
  } };
}

const result = { kind: 'phrase', targetText: 'give up', meaningZh: '放弃', definitionEn: 'to stop trying', usage: 'give up doing something', example: 'Never give up learning.' };
const response = (data: unknown = result) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });

function createQueue(store: ReaderStore, options: Partial<ConstructorParameters<typeof AnalysisQueue>[1]> = {}) {
  const queue = new AnalysisQueue(store, { getApiKey: async () => 'synthetic-test-key', getModel: () => 'deepseek-flash', onChange: () => {}, retryDelayMs: 1, timeoutMs: 2000, ...options });
  cleanups.push(() => queue.stop());
  return queue;
}

afterEach(() => {
  vi.useRealTimers();
  cleanups.reverse().splice(0).forEach(cleanup => cleanup());
});

describe('durable vocabulary', () => {
  it('merges a word within one book, keeps contexts, and refreshes the collection date', () => {
    vi.useFakeTimers();
    const { store, book } = createStore();
    vi.setSystemTime(new Date('2026-11-26T00:00:00Z'));
    const first = store.collect(input(book.id, 'bank', 'The bank was closed.', 0));
    vi.setSystemTime(new Date('2026-11-27T00:00:00Z'));
    const second = store.collect(input(book.id, 'bank', 'We sat on the river bank.', 1));
    const entries = store.listEntries(book.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.occurrences).toHaveLength(2);
    expect(entries[0]?.latestCollectedAt).toBe(second.collectedAt);
    expect(entries[0]?.latestCollectedAt).not.toBe(first.collectedAt);
    store.removeOccurrence(first.id);
    expect(store.listEntries(book.id)[0]?.occurrences.map(item => item.id)).toEqual([second.id]);
    store.removeOccurrence(second.id);
    expect(store.listEntries(book.id)).toEqual([]);
  });

  it('does not merge books or charge a completed occurrence again', () => {
    const { store, book } = createStore();
    const other = store.addBook(new Uint8Array([4]), { title: 'Other', author: '', fileName: 'other.epub' });
    const occurrence = store.collect(input(book.id));
    store.complete(occurrence.id, result as any);
    const repeated = store.collect(input(book.id));
    store.collect(input(other.id));
    expect(repeated.id).toBe(occurrence.id);
    expect(repeated.status).toBe('completed');
    expect(store.claim()).toMatchObject({ occurrence: { bookId: other.id } });
    expect(store.listEntries(book.id)).toHaveLength(1);
  });

  it('restores interrupted work and persists the book and reading position', () => {
    const { store, book, directory } = createStore();
    store.updateBook(book.id, { lastLocation: 'epubcfi(/6/2!/4/2)', progress: 0.4, fontSize: 24 });
    const occurrence = store.collect(input(book.id));
    store.claim();
    store.close();
    const reopened = new ReaderStore(directory);
    cleanups.push(() => reopened.close());
    expect(reopened.getBook(book.id)).toMatchObject({ progress: 0.4, fontSize: 24 });
    expect(reopened.readBook(book.id)).toEqual(new Uint8Array([1, 2, 3]));
    expect(reopened.getOccurrence(occurrence.id)?.status).toBe('pending');
    expect(reopened.claim()?.attempts).toBe(1);
  });

  it('moves a resolved phrase to its own group without losing the original selection', () => {
    const { store, book } = createStore();
    const phrase = store.collect(input(book.id));
    store.collect(input(book.id, 'give', 'Please give me the book.', 1));
    store.complete(phrase.id, result as any);
    expect(store.listEntries(book.id).map(entry => entry.term).sort()).toEqual(['give', 'give up']);
    expect(store.getOccurrence(phrase.id)?.selectedText).toBe('give');
    expect(store.getOccurrence(phrase.id)?.originalAnchor).toEqual(phrase.anchor);
  });
});

describe('position persistence before closing', () => {
  it('waits for the final position IPC to persist before allowing a flush to complete', async () => {
    const { store, book } = createStore();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const writes = new BookWriteBuffer(async (id, patch) => { await waiting; return store.updateBook(id, patch); });
    const saving = writes.save(book.id, { lastLocation: 'epubcfi(/6/8!/4/2)', progress: 0.75 });
    let flushed = false;
    const flush = writes.flush().then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false);
    expect(store.getBook(book.id).lastLocation).toBeNull();
    release();
    await Promise.all([saving, flush]);
    expect(store.getBook(book.id)).toMatchObject({ lastLocation: 'epubcfi(/6/8!/4/2)', progress: 0.75 });
  });

  it('retains a failed position save when a later font update is persisted', async () => {
    const { store, book } = createStore();
    let failing = true;
    const writes = new BookWriteBuffer(async (id, patch) => {
      if (failing) throw new Error('Temporary write failure');
      return store.updateBook(id, patch);
    });
    await expect(writes.save(book.id, { lastLocation: 'epubcfi(/6/10!/4/2)', progress: 0.9 })).rejects.toThrow('write failure');
    failing = false;
    await writes.save(book.id, { fontSize: 26 });
    await writes.flush();
    expect(store.getBook(book.id)).toMatchObject({ lastLocation: 'epubcfi(/6/10!/4/2)', progress: 0.9, fontSize: 26 });
  });

  it('reports persistent save failure instead of silently approving a close', async () => {
    const { store, book } = createStore();
    let failing = true;
    const writes = new BookWriteBuffer(async (id, patch) => {
      if (failing) throw new Error('Disk is unavailable');
      return store.updateBook(id, patch);
    });
    await expect(writes.save(book.id, { progress: 0.6 })).rejects.toThrow('Disk');
    await expect(writes.flush()).rejects.toThrow('Disk');
    expect(store.getBook(book.id).progress).toBe(0);
    failing = false;
    await writes.flush();
    expect(store.getBook(book.id).progress).toBe(0.6);
  });
});

describe('analysis validation', () => {
  it('requires a phrase to cover the actual selected occurrence, not another occurrence in context', () => {
    const { store, book } = createStore();
    const text = 'give';
    const context = 'Please give me time. I will give up later.';
    const occurrence = store.collect(input(book.id, text, context));
    expect(() => validateAnalysis(result, occurrence)).toThrow('当前原文位置');
  });

  it('accepts original phrases across whitespace and requires four fields for words', () => {
    const { store, book } = createStore();
    const occurrence = store.collect(input(book.id, 'give', 'She will give\nup soon.'));
    expect(validateAnalysis(result, occurrence).targetText).toBe('give up');
    expect(() => validateAnalysis({ ...result, usage: '' }, occurrence)).toThrow('用法说明');
  });

  it('accepts sentence translation without inventing extra learning fields', () => {
    const { store, book } = createStore();
    const selected = input(book.id, 'She will give up soon.', 'She will give up soon.');
    selected.kind = 'sentence';
    const occurrence = store.collect(selected);
    expect(validateAnalysis({ meaningZh: '她很快就会放弃。' }, occurrence)).toEqual({ kind: 'sentence', targetText: selected.text, meaningZh: '她很快就会放弃。' });
  });

  it('sends one non-thinking structured request and rejects blank JSON output', async () => {
    const { store, book } = createStore();
    const occurrence = store.collect(input(book.id));
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '    ' } }] }), { status: 200 }));
    await expect(analyseOccurrence(occurrence, { apiKey: 'synthetic-test-key', model: 'deepseek-flash', signal: new AbortController().signal, fetchFn: fetchFn as typeof fetch })).rejects.toThrow('为空');
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('persistent queue', () => {
  it('waits without a key and resumes after configuration', async () => {
    const { store, book } = createStore();
    const occurrence = store.collect(input(book.id));
    let key: string | null = null;
    const fetchFn = vi.fn(async () => response());
    const queue = createQueue(store, { getApiKey: async () => key, fetchFn: fetchFn as typeof fetch });
    queue.start();
    await vi.waitFor(() => expect(store.getOccurrence(occurrence.id)?.status).toBe('needs_key'));
    expect(fetchFn).not.toHaveBeenCalled();
    key = 'synthetic-test-key';
    queue.resume();
    await vi.waitFor(() => expect(store.getOccurrence(occurrence.id)?.status).toBe('completed'));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('handles key provider errors as recoverable state', async () => {
    const { store, book } = createStore();
    const occurrence = store.collect(input(book.id));
    const queue = createQueue(store, { getApiKey: async () => { throw new Error('Key provider locked'); } });
    queue.start();
    await vi.waitFor(() => expect(store.getOccurrence(occurrence.id)).toMatchObject({ status: 'needs_key', error: expect.stringContaining('重新保存') }));
  });

  it('does not leave processing tasks behind when connectivity changes during key lookup', async () => {
    const { store, book } = createStore();
    const occurrence = store.collect(input(book.id));
    let resolveKey!: (key: string) => void;
    const key = new Promise<string>(resolve => { resolveKey = resolve; });
    const fetchFn = vi.fn(async () => response());
    const queue = createQueue(store, { getApiKey: () => key, fetchFn: fetchFn as typeof fetch });
    queue.start();
    queue.setOnline(false);
    resolveKey('synthetic-test-key');
    await vi.waitFor(() => expect(store.getOccurrence(occurrence.id)?.status).toBe('waiting_network'));
    expect(fetchFn).not.toHaveBeenCalled();
    queue.setOnline(true);
    await vi.waitFor(() => expect(store.getOccurrence(occurrence.id)?.status).toBe('completed'));
  });

  it('does not resurrect an occurrence cancelled while its request is in flight', async () => {
    const { store, book } = createStore();
    const occurrence = store.collect(input(book.id));
    let finish!: (value: Response) => void;
    const queue = createQueue(store, { fetchFn: (() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch });
    queue.start();
    await vi.waitFor(() => expect(store.getOccurrence(occurrence.id)?.status).toBe('processing'));
    store.removeOccurrence(occurrence.id);
    finish(response());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(store.listEntries(book.id)).toEqual([]);
  });

  it('pauses remaining tasks after auth failure, then retries only after explicit recovery', async () => {
    const { store, book } = createStore();
    const first = store.collect(input(book.id));
    const second = store.collect(input(book.id, 'give', 'They give up quickly.', 1));
    const fetchFn = vi.fn(async () => new Response('', { status: 401 }));
    const queue = createQueue(store, { fetchFn: fetchFn as typeof fetch });
    queue.start();
    await vi.waitFor(() => expect(store.getOccurrence(second.id)?.status).toBe('failed'));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(store.getOccurrence(first.id)?.error).toContain('API 密钥');
    fetchFn.mockImplementation(async () => response());
    queue.resume();
    await vi.waitFor(() => expect(store.getOccurrence(second.id)?.status).toBe('completed'));
    expect(store.getOccurrence(first.id)?.status).toBe('completed');
  });

  it('retries transient failures a bounded number of times', async () => {
    const { store, book } = createStore();
    const occurrence = store.collect(input(book.id));
    const fetchFn = vi.fn(async () => new Response('', { status: 503 }));
    const queue = createQueue(store, { fetchFn: fetchFn as typeof fetch });
    queue.start();
    await vi.waitFor(() => expect(store.getOccurrence(occurrence.id)?.status).toBe('failed'));
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('uses newly saved credentials after an older in-flight request fails', async () => {
    const { store, book } = createStore();
    const occurrence = store.collect(input(book.id));
    let key = 'old-synthetic-key';
    let finishFirst!: (value: Response) => void;
    const fetchFn = vi.fn<typeof fetch>();
    fetchFn.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
    fetchFn.mockImplementation(async () => response());
    const queue = createQueue(store, { getApiKey: async () => key, fetchFn });
    queue.start();
    await vi.waitFor(() => expect(store.getOccurrence(occurrence.id)?.status).toBe('processing'));
    key = 'new-synthetic-key';
    queue.resume();
    finishFirst(new Response('', { status: 401 }));
    await vi.waitFor(() => expect(store.getOccurrence(occurrence.id)?.status).toBe('completed'));
    expect((fetchFn.mock.calls[1]?.[1]?.headers as Record<string, string>).Authorization).toBe('Bearer new-synthetic-key');
  });

  it('processes a daily batch without losing the association between results and contexts', async () => {
    const { store, book } = createStore();
    const ids = Array.from({ length: 100 }, (_, index) => store.collect(input(book.id, 'give', `Story ${index}. They give up every day.`, index)).id);
    const fetchFn = vi.fn<typeof fetch>(async (_url, options) => {
      const body = JSON.parse(options?.body as string);
      const context = JSON.parse(body.messages[1].content).context as string;
      return response({ ...result, meaningZh: `放弃 ${context.match(/Story (\d+)/)?.[1]}` });
    });
    const queue = createQueue(store, { fetchFn });
    queue.start();
    await vi.waitFor(() => expect(store.getOccurrence(ids[99]!)?.status).toBe('completed'), { timeout: 5000 });
    ids.forEach((id, index) => expect(store.getOccurrence(id)?.analysis?.meaningZh).toBe(`放弃 ${index}`));
    expect(store.listEntries(book.id)[0]?.occurrences).toHaveLength(100);
    expect(fetchFn).toHaveBeenCalledTimes(100);
  });
});

async function epub(options: { fixed?: boolean; encrypted?: boolean; fontOnly?: boolean } = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/package.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Sample &amp; Test</dc:title><dc:creator>Author</dc:creator>${options.fixed ? '<meta property="rendition:layout">pre-paginated</meta>' : ''}</metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>`);
  zip.file('OEBPS/chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Hello world.</p></body></html>');
  if (options.encrypted || options.fontOnly) zip.file('META-INF/encryption.xml', `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="${options.fontOnly ? 'http://www.idpf.org/2008/embedding' : 'http://www.w3.org/2001/04/xmlenc#aes128-cbc'}"/><CipherData><CipherReference URI="${options.fontOnly ? 'OEBPS/font.otf' : 'OEBPS/chapter.xhtml'}"/></CipherData></EncryptedData></encryption>`);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('book compatibility and input validation', () => {
  it('reads ordinary EPUB metadata and permits font obfuscation', async () => {
    expect(await inspectEpub(await epub({ fontOnly: true }))).toEqual({ title: 'Sample & Test', author: 'Author' });
  });
  it('distinguishes protected content and fixed layout from ordinary EPUB', async () => {
    await expect(inspectEpub(await epub({ encrypted: true }))).rejects.toThrow('受保护');
    await expect(inspectEpub(await epub({ fixed: true }))).rejects.toThrow('固定版式');
    await expect(inspectEpub(new Uint8Array([1, 2]))).rejects.toThrow('损坏');
  });
  it('rejects unsafe or inconsistent collection input', () => {
    const { book } = createStore();
    const collection = input(book.id);
    expect(validCollect(collection)).toMatchObject({ bookId: book.id, text: 'give' });
    expect(() => validCollect({ ...collection, bookId: '../../other' })).toThrow('标识');
    expect(() => validCollect({ ...collection, context: 'short' })).toThrow('上下文');
  });
});
