// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { ReaderStore } from '../src/main/store';
import { upgradeLegacyBookLanguages } from '../src/main/book-language-upgrade';
import { indexText } from '../src/renderer/reader/text';
import type { AnalysisResult, BookLanguageSource, CollectInput } from '../src/shared/types';

const resources: { store: ReaderStore; root: string }[] = [];
const japanese = '今日は図書館へ行きました。静かな部屋で日本語の本を読んでいます。物語の続きをゆっくり楽しみました。';
const english = 'When Clara opened the little bookshop, she found a book on the table. There was a quiet room and she wanted to read the story.';
const analysis: AnalysisResult = { kind: 'word', targetText: 'read', meaningZh: '阅读', definitionEn: 'to understand written words', usage: 'read a book', example: 'I read every day.' };

function createStore(): ReaderStore {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yuejian-language-recovery-'));
  const store = new ReaderStore(root);
  resources.push({ store, root });
  return store;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, root } of resources.splice(0)) {
    store.close();
    const absolute = path.resolve(root);
    const relative = path.relative(path.resolve(os.tmpdir()), absolute);
    if (!relative.startsWith('yuejian-language-recovery-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unsafe recovery test cleanup path');
    rmSync(absolute, { recursive: true, force: true });
  }
});

function input(bookId: string, section = 2, context = 'I read a book.', text = 'read'): CollectInput {
  const start = context.indexOf(text);
  return { bookId, text, kind: 'word', context, chapterTitle: 'Chapter', anchor: {
    cfi: `epubcfi(/6/${section}!/4/2/1:0,/1:0,/1:4)`, chapterHref: 'chapter.xhtml',
    startOffset: start, endOffset: start + text.length, contextStartOffset: 0,
  } };
}

async function archive(title: string, language?: string, body = japanese): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('book.opf', `<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title>${language ? `<dc:language>${language}</dc:language>` : ''}</metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  zip.file('chapter.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>${body}</p></body></html>`);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('recovering books imported before language support', () => {
  it('updates legacy language on duplicate import while retaining the book and every collection', async () => {
    const store = createStore(); const bytes = await archive('Original', 'ja');
    const book = store.addBook(bytes, { title: 'Original', author: 'Writer', fileName: 'original.epub' });
    store.updateBook(book.id, { lastLocation: 'epubcfi(/6/2!/4/2/1:7)', progress: .4, fontSize: 26, theme: 'quiet' });
    const savedBook = store.getBook(book.id);
    const completed = store.collect(input(book.id)); store.complete(completed.id, analysis);
    const failed = store.collect(input(book.id, 4)); store.setTaskState(failed.id, 'failed', '缺少有效英文解释');
    const pending = store.collect(input(book.id, 6));
    const before = store.listOccurrences(book.id);
    const bookmark = store.addBookmark({ bookId: book.id, cfi: 'epubcfi(/6/2!/4/2/1:7)', chapterTitle: 'Chapter', excerpt: 'Saved', progress: .4 });
    store.setSetting('model', 'unchanged-model');
    const imported = store.addBook(bytes, { title: 'Replacement title', author: 'Replacement author', fileName: 'renamed.epub', language: 'ja', languageSource: 'metadata' });
    expect(imported).toEqual({ ...savedBook, language: 'ja', languageSource: 'metadata' });
    expect(store.listBooks()).toHaveLength(1);
    expect(store.readBook(book.id)).toEqual(bytes);
    expect(store.listOccurrences(book.id)).toEqual(before);
    expect(store.getOccurrence(completed.id)).toMatchObject({ status: 'completed', language: 'en', analysis });
    expect(store.getOccurrence(failed.id)?.language).toBe('en');
    expect(store.getOccurrence(pending.id)?.language).toBe('en');
    expect(store.listBookmarks(book.id)).toEqual([bookmark]);
    expect(store.getSetting('model')).toBe('unchanged-model');
    expect(store.collect(input(book.id, 8)).language).toBe('ja');
  });

  it('only reconciles uncertain automatic sources with reliable detection', () => {
    const store = createStore();
    const uncertain = store.addBook(new Uint8Array([1]), { title: 'Unknown', author: '', fileName: 'unknown.epub', language: 'en', languageSource: 'unknown' });
    expect(store.reconcileBookLanguage(uncertain.id, { language: 'ja', languageSource: 'content' })).toMatchObject({ language: 'ja', languageSource: 'content' });
    let seed = 2;
    for (const source of ['manual', 'metadata', 'content'] as const) {
      const bytes = new Uint8Array([seed++]);
      const book = store.addBook(bytes, { title: source, author: '', fileName: `${source}.epub`, language: 'en', languageSource: source });
      expect(store.reconcileBookLanguage(book.id, { language: 'ja', languageSource: 'metadata' })).toEqual(book);
      expect(store.addBook(bytes, { title: 'Another', author: '', fileName: 'another.epub', language: 'ja', languageSource: 'metadata' })).toEqual(book);
    }
    const legacy = store.addBook(new Uint8Array([seed++]), { title: 'Legacy', author: '', fileName: 'legacy.epub' });
    for (const languageSource of ['manual', 'legacy', 'unknown'] as BookLanguageSource[]) {
      expect(store.reconcileBookLanguage(legacy.id, { language: 'ja', languageSource })).toEqual(legacy);
    }
  });

  it('upgrades stored legacy EPUBs before use and isolates unreadable books without touching nonlegacy sources', async () => {
    const store = createStore();
    const ja = store.addBook(await archive('Japanese', 'ja-JP'), { title: 'Japanese', author: '', fileName: 'ja.epub' });
    const en = store.addBook(await archive('English', 'en', english), { title: 'English', author: '', fileName: 'en.epub' });
    const ambiguous = store.addBook(await archive('Ambiguous', undefined, '只有汉字没有足够线索判断具体语言。'), { title: 'Ambiguous', author: '', fileName: 'ambiguous.epub' });
    const broken = store.addBook(new Uint8Array([9]), { title: 'Broken', author: '', fileName: 'broken.epub' });
    const missing = store.addBook(await archive('Missing', 'ja'), { title: 'Missing', author: '', fileName: 'missing.epub' });
    const missingPath = path.resolve(store.directory, 'books', `${missing.id}.epub`);
    expect(path.dirname(missingPath)).toBe(path.resolve(store.directory, 'books'));
    rmSync(missingPath);
    const manual = store.addBook(new Uint8Array([10]), { title: 'Manual', author: '', fileName: 'manual.epub', language: 'en', languageSource: 'manual' });
    const detected = store.addBook(new Uint8Array([11]), { title: 'Detected', author: '', fileName: 'detected.epub', language: 'en', languageSource: 'metadata' });
    const unknown = store.addBook(new Uint8Array([12]), { title: 'Unknown', author: '', fileName: 'unknown.epub', language: 'en', languageSource: 'unknown' });
    const completed = store.collect(input(ja.id)); store.complete(completed.id, analysis);
    const pending = store.collect(input(ja.id, 4));
    const before = store.listOccurrences();
    const read = vi.spyOn(store, 'readBook');
    expect(await upgradeLegacyBookLanguages(store)).toEqual({ checked: 5, updated: 2, skipped: 1, failed: 2 });
    expect(store.getBook(ja.id)).toMatchObject({ language: 'ja', languageSource: 'metadata' });
    expect(store.getBook(en.id)).toMatchObject({ language: 'en', languageSource: 'metadata' });
    for (const book of [ambiguous, broken, missing, manual, detected, unknown]) expect(store.getBook(book.id)).toEqual(book);
    expect(read).toHaveBeenCalledTimes(5);
    for (const book of [manual, detected, unknown]) expect(read).not.toHaveBeenCalledWith(book.id);
    expect(store.listOccurrences()).toEqual(before);
    expect(store.getOccurrence(completed.id)).toMatchObject({ status: 'completed', analysis });
    expect(store.getOccurrence(pending.id)).toMatchObject({ status: 'pending', language: 'en' });
    expect(await upgradeLegacyBookLanguages(store)).toEqual({ checked: 3, updated: 0, skipped: 1, failed: 2 });
  });
});

describe('explicitly retrying a failed collection with a rebuilt source index', () => {
  it('replaces ruby-sensitive offsets, context and language together while preserving identity and collection time', () => {
    const store = createStore(); const book = store.addBook(new Uint8Array([1]), { title: 'Legacy', author: '', fileName: 'legacy.epub' });
    const root = document.createElement('p');
    root.innerHTML = '<ruby>今日<rt>きょう</rt></ruby>は<ruby>学校<rt>がっこう</rt></ruby>へ行く。';
    try {
      const oldIndex = indexText(root, 'en'); const newIndex = indexText(root, 'ja');
      const original = input(book.id, 2, oldIndex.text, '行く');
      const failed = store.collect(original);
      store.claim();
      store.complete(failed.id, { ...analysis, targetText: '行く' });
      store.setTaskState(failed.id, 'failed', '缺少有效英文解释', Date.now() + 10_000);
      store.reconcileBookLanguage(book.id, { language: 'ja', languageSource: 'metadata' });
      const replacement = { ...input(book.id, 2, newIndex.text, '行く'), kind: 'phrase' as const, chapterTitle: '日本語の章' };
      expect(replacement.anchor.cfi).toBe(original.anchor.cfi);
      expect(replacement.anchor.startOffset).toBeLessThan(original.anchor.startOffset);
      expect(replacement.context).toBe('今日は学校へ行く。');
      expect(replacement.context).not.toContain('きょう');
      const retried = store.retry(failed.id, { ...replacement, language: 'en' } as CollectInput)!;
      expect(retried).toEqual({ ...failed, selectedText: replacement.text, targetText: replacement.text, kind: replacement.kind,
        context: replacement.context, chapterTitle: replacement.chapterTitle, anchor: replacement.anchor, originalAnchor: replacement.anchor,
        language: 'ja', status: 'pending', error: null, analysis: null });
      expect(store.getOccurrence(failed.id)).toEqual(retried);
      const claimed = store.claim();
      expect(claimed).toMatchObject({ attempts: 1, occurrence: { id: failed.id, language: 'ja', context: newIndex.text } });
      expect(claimed?.occurrence.collectedAt).toBe(failed.collectedAt);
      expect(store.listEntries(book.id)[0]?.id).toBe('ja:phrase:行く');
      const repeated = store.collect(replacement);
      expect(repeated.id).toBe(failed.id);
      expect(store.listOccurrences(book.id)).toHaveLength(1);
    } finally { root.remove(); }
  });

  it('rejects a replacement for another book or original CFI without altering the failed task', () => {
    const store = createStore(); const book = store.addBook(new Uint8Array([1]), { title: 'A', author: '', fileName: 'a.epub' });
    const other = store.addBook(new Uint8Array([2]), { title: 'B', author: '', fileName: 'b.epub' });
    const failed = store.collect(input(book.id)); store.claim(); store.setTaskState(failed.id, 'failed', 'Old failure', 1234);
    const before = store.getOccurrence(failed.id);
    expect(() => store.retry(failed.id, { ...input(book.id), bookId: other.id })).toThrow('原收录位置不一致');
    expect(() => store.retry(failed.id, input(book.id, 4))).toThrow('原收录位置不一致');
    expect(store.getOccurrence(failed.id)).toEqual(before);
    expect(store.claim()).toBeUndefined();
  });

  it('leaves completed and processing records unchanged and rejects replacing other nonfailed states', () => {
    const store = createStore(); const book = store.addBook(new Uint8Array([1]), { title: 'A', author: '', fileName: 'a.epub' });
    const completed = store.collect(input(book.id)); store.complete(completed.id, analysis);
    const processing = store.collect(input(book.id, 4)); store.claim();
    const pending = store.collect(input(book.id, 6));
    const beforeCompleted = store.getOccurrence(completed.id); const beforeProcessing = store.getOccurrence(processing.id);
    expect(store.retry(completed.id, input(book.id))).toEqual(beforeCompleted);
    expect(store.retry(processing.id, input(book.id, 4))).toEqual(beforeProcessing);
    expect(() => store.retry(pending.id, input(book.id, 6))).toThrow('只有解析失败');
    expect(store.getOccurrence(pending.id)).toEqual(pending);
  });

  it('keeps the original retry contract and language snapshot without a replacement', () => {
    const store = createStore(); const book = store.addBook(new Uint8Array([1]), { title: 'A', author: '', fileName: 'a.epub' });
    const original = store.collect(input(book.id)); store.claim(); store.setTaskState(original.id, 'failed', 'Failed', 9999);
    store.updateBook(book.id, { language: 'ja' });
    expect(store.retry(original.id)).toEqual({ ...original, status: 'pending', error: null });
    expect(store.claim()).toMatchObject({ attempts: 1, occurrence: { language: 'en' } });
    store.removeOccurrence(original.id);
    expect(store.retry(original.id, input(book.id))).toBeUndefined();
  });
});
