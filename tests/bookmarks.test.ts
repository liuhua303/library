import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BookmarkInput, BookRecord, CollectInput, Occurrence } from '../src/shared/types';
import { ReaderStore } from '../src/main/store';
import { validBookmark, validBookPatch } from '../src/main/validation';
import { BookWriteBuffer } from '../src/main/book-write-buffer';

const directories: string[] = [];
const stores: ReaderStore[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'yuejian-bookmarks-'));
  directories.push(directory);
  return directory;
}

function openStore(directory = temporaryDirectory()) {
  const store = new ReaderStore(directory);
  stores.push(store);
  return store;
}

function createFixture() {
  const store = openStore();
  const book = store.addBook(new Uint8Array([1, 2, 3]), { title: 'A book', author: 'Author', fileName: 'a.epub' });
  return { store, book, directory: store.directory };
}

function bookmarkInput(bookId: string = randomUUID(), progress = 0.25, section = 2): BookmarkInput {
  return { bookId, cfi: `epubcfi(/6/${section}!/4/2/1:0)`, chapterTitle: 'Chapter 1', excerpt: 'A paragraph worth returning to.', progress };
}

function collectInput(bookId: string): CollectInput {
  return { bookId, text: 'paragraph', kind: 'word', context: 'A paragraph worth returning to.', chapterTitle: 'Chapter 1',
    anchor: { cfi: 'epubcfi(/6/2!/4/2/1:2)', chapterHref: 'chapter.xhtml', startOffset: 2, endOffset: 11, contextStartOffset: 0 } };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    const resolved = path.resolve(directory);
    const relative = path.relative(path.resolve(os.tmpdir()), resolved);
    if (!relative.startsWith('yuejian-bookmarks-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path');
    rmSync(resolved, { recursive: true, force: true });
  }
});

describe('durable bookmarks', () => {
  it('adds a bookmarks table to a legacy database without changing existing book, vocabulary or settings', () => {
    const directory = temporaryDirectory();
    const legacyBook: BookRecord = { id: randomUUID(), title: 'Legacy', author: 'Writer', fileName: 'legacy.epub', importedAt: '2026-11-26T00:00:00Z', lastLocation: 'epubcfi(/6/2!/4/2/1:0)', progress: 0.4, fontSize: 24 };
    const input = collectInput(legacyBook.id);
    const legacyOccurrence: Occurrence = { id: randomUUID(), bookId: legacyBook.id, selectedText: input.text, targetText: input.text, kind: input.kind, anchor: input.anchor, originalAnchor: input.anchor, context: input.context, chapterTitle: input.chapterTitle, collectedAt: legacyBook.importedAt, status: 'pending', error: null, analysis: null };
    const database = new DatabaseSync(path.join(directory, 'reader.sqlite'));
    try {
      database.exec(`
        CREATE TABLE books (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
        CREATE TABLE occurrences (
          id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
          source_cfi TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
          UNIQUE(book_id, source_cfi)
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      database.prepare('INSERT INTO books VALUES (?, ?, ?)').run(legacyBook.id, 'legacy-hash', JSON.stringify(legacyBook));
      database.prepare('INSERT INTO occurrences(id, book_id, source_cfi, data, status) VALUES (?, ?, ?, ?, ?)')
        .run(legacyOccurrence.id, legacyBook.id, input.anchor.cfi, JSON.stringify(legacyOccurrence), legacyOccurrence.status);
      database.prepare('INSERT INTO settings VALUES (?, ?)').run('model', 'legacy-model');
    } finally { database.close(); }

    const store = openStore(directory);
    const migratedBook = { ...legacyBook, language: 'en', languageSource: 'legacy' };
    const migratedOccurrence = { ...legacyOccurrence, language: 'en' };
    expect(store.getBook(legacyBook.id)).toEqual(migratedBook);
    expect(store.listBooks()).toEqual([migratedBook]);
    expect(store.getOccurrence(legacyOccurrence.id)).toEqual(migratedOccurrence);
    expect(store.getSetting('model')).toBe('legacy-model');
    expect(store.listBookmarks(legacyBook.id)).toEqual([]);
    const bookmark = store.addBookmark(bookmarkInput(legacyBook.id));
    expect(store.listBookmarks(legacyBook.id)).toEqual([bookmark]);
    expect(store.updateBook(legacyBook.id, validBookPatch({ theme: 'calm' }))).toMatchObject({ ...legacyBook, theme: 'calm' });
    expect(store.getOccurrence(legacyOccurrence.id)).toEqual(migratedOccurrence);
  });

  it('persists bookmarks and per-book themes across reopen, deduplicates CFIs per book, and sorts by progress', () => {
    const { store, book, directory } = createFixture();
    const otherBook = store.addBook(new Uint8Array([4, 5]), { title: 'Other', author: '', fileName: 'other.epub' });
    const later = store.addBookmark(bookmarkInput(book.id, 0.8, 8));
    const earlier = store.addBookmark(bookmarkInput(book.id, 0.15, 2));
    expect(store.addBookmark({ ...bookmarkInput(book.id, 0.2, 2), excerpt: 'Changed preview' })).toEqual(earlier);
    const other = store.addBookmark(bookmarkInput(otherBook.id, 0.5, 2));
    expect(other.id).not.toBe(earlier.id);
    store.updateBook(book.id, validBookPatch({ theme: 'quiet', fontSize: 26 }));
    store.close();

    const reopened = openStore(directory);
    expect(reopened.listBookmarks(book.id)).toEqual([earlier, later]);
    expect(reopened.listBookmarks(otherBook.id)).toEqual([other]);
    expect(reopened.getBook(book.id)).toMatchObject({ theme: 'quiet', fontSize: 26 });
    expect(reopened.getBook(otherBook.id).theme).toBeUndefined();
  });

  it('removes only the chosen bookmark and leaves collected occurrences and pending work intact', () => {
    const { store, book } = createFixture();
    const otherBook = store.addBook(new Uint8Array([4]), { title: 'Other', author: '', fileName: 'other.epub' });
    const occurrence = store.collect(collectInput(book.id));
    const chosen = store.addBookmark(bookmarkInput(book.id));
    const remaining = store.addBookmark(bookmarkInput(book.id, 0.7, 6));
    const other = store.addBookmark(bookmarkInput(otherBook.id));
    expect(store.removeBookmark(chosen.id)).toEqual(chosen);
    expect(store.removeBookmark(chosen.id)).toBeUndefined();
    expect(store.listBookmarks(book.id)).toEqual([remaining]);
    expect(store.listBookmarks(otherBook.id)).toEqual([other]);
    expect(store.getOccurrence(occurrence.id)).toEqual(occurrence);
    expect(store.claim()?.occurrence.id).toBe(occurrence.id);
  });

  it('rejects bookmark access for a book that does not exist', () => {
    const { store } = createFixture();
    const unknown = randomUUID();
    expect(() => store.addBookmark(bookmarkInput(unknown))).toThrow('这本书不存在');
    expect(() => store.listBookmarks(unknown)).toThrow('这本书不存在');
  });

  it('keeps an unsaved position while a theme update is flushed', async () => {
    const { store, book } = createFixture();
    let failing = true;
    const writes = new BookWriteBuffer(async (id, patch) => {
      if (failing) throw new Error('Temporary disk failure');
      return store.updateBook(id, validBookPatch(patch));
    });
    await expect(writes.save(book.id, { lastLocation: 'epubcfi(/6/6!/4/2/1:0)', progress: 0.65 })).rejects.toThrow('disk failure');
    failing = false;
    await writes.save(book.id, { theme: 'paper' });
    await writes.flush();
    expect(store.getBook(book.id)).toMatchObject({ theme: 'paper', lastLocation: 'epubcfi(/6/6!/4/2/1:0)', progress: 0.65, fontSize: 20 });
  });
});

describe('bookmark IPC input validation', () => {
  it('accepts boundary progress values and empty previews for pages without text', () => {
    const input = { ...bookmarkInput(), chapterTitle: '', excerpt: '' };
    expect(validBookmark({ ...input, progress: 0 })).toEqual({ ...input, progress: 0 });
    expect(validBookmark({ ...input, progress: 1 })).toEqual({ ...input, progress: 1 });
  });

  it.each([
    ['invalid book id', { bookId: '../other-book' }],
    ['non-CFI position', { cfi: 'chapter.xhtml#one' }],
    ['unterminated CFI', { cfi: 'epubcfi(/6/2' }],
    ['oversized CFI', { cfi: `epubcfi(${'1'.repeat(8000)})` }],
    ['non-text CFI', { cfi: 4 }],
    ['oversized title', { chapterTitle: 'x'.repeat(1001) }],
    ['non-text title', { chapterTitle: null }],
    ['oversized excerpt', { excerpt: 'x'.repeat(2001) }],
    ['non-text excerpt', { excerpt: [] }],
    ['negative progress', { progress: -0.01 }],
    ['progress above one', { progress: 1.01 }],
    ['non-finite progress', { progress: Infinity }],
    ['NaN progress', { progress: NaN }],
    ['text progress', { progress: '0.2' }],
  ])('rejects %s', (_label, patch) => {
    expect(() => validBookmark({ ...bookmarkInput(), ...patch })).toThrow();
  });

  it.each([null, undefined, [], 'bookmark', 1])('rejects invalid top-level input %j', value => {
    expect(() => validBookmark(value)).toThrow('操作参数无效');
  });

  it('accepts all supported theme identifiers and rejects unknown or malformed themes', () => {
    for (const theme of ['original', 'quiet', 'paper', 'bold', 'calm', 'focus']) expect(validBookPatch({ theme })).toEqual({ theme });
    for (const theme of ['sepia', 'Quiet', '', undefined, null, 1, {}]) expect(() => validBookPatch({ theme })).toThrow('阅读主题无效');
  });
});
