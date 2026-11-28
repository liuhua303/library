import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import JSZip from 'jszip';
import { chapterLanguageSample, detectBookLanguage, sourceLanguageTag } from '../src/main/book-language';
import { inspectEpub } from '../src/main/epub';
import { ReaderStore } from '../src/main/store';
import { validBookPatch, validCollect } from '../src/main/validation';
import { BookWriteBuffer } from '../src/main/book-write-buffer';
import type { AnalysisResult, BookRecord, CollectInput, Occurrence } from '../src/shared/types';

const japanese = '今日は図書館へ行きました。静かな部屋で日本語の本を読んでいます。物語の続きをゆっくり楽しみました。';
const english = 'When Clara opened the little bookshop, she found a book on the table. There was a quiet room and she wanted to read the story.';
const directories: string[] = [];
const stores: ReaderStore[] = [];

function directory(): string {
  const result = mkdtempSync(path.join(os.tmpdir(), 'yuejian-language-'));
  directories.push(result);
  return result;
}

function openStore(root = directory()): ReaderStore {
  const store = new ReaderStore(root); stores.push(store); return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of directories.splice(0)) {
    const absolute = path.resolve(root);
    const relative = path.relative(path.resolve(os.tmpdir()), absolute);
    if (!relative.startsWith('yuejian-language-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unsafe language test cleanup path');
    rmSync(absolute, { recursive: true, force: true });
  }
});

async function epub(options: { language?: string; body?: string; chapterLanguage?: string; fixed?: boolean; chapters?: string[]; nav?: boolean } = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const chapters = options.chapters ?? [options.body ?? japanese];
  const manifest = chapters.map((_, index) => `<item id="c${index}" href="chapter${index}.xhtml" media-type="application/xhtml+xml"/>`);
  const spine = chapters.map((_, index) => `<itemref idref="c${index}"/>`);
  if (options.nav) {
    manifest.unshift('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
    spine.unshift('<itemref idref="nav"/>');
    zip.file('OEBPS/nav.xhtml', `<html lang="ja"><body><nav>${japanese.repeat(100)}</nav></body></html>`);
  }
  zip.file('OEBPS/package.opf', `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Language sample</dc:title><dc:creator>Writer</dc:creator>${options.language ? `<dc:language>${options.language}</dc:language>` : ''}${options.fixed ? '<meta property="rendition:layout">pre-paginated</meta>' : ''}</metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  for (const [index, body] of chapters.entries()) zip.file(`OEBPS/chapter${index}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"${options.chapterLanguage ? ` xml:lang="${options.chapterLanguage}"` : ''}><body><p>${body}</p></body></html>`);
  return zip.generateAsync({ type: 'uint8array' });
}

function collectInput(bookId: string, section = 2, text = 'AI'): CollectInput {
  return { bookId, text, kind: 'word', context: `The ${text} is here.`, chapterTitle: 'A chapter',
    anchor: { cfi: `epubcfi(/6/${section}!/4/2/1:4)`, chapterHref: 'chapter.xhtml', startOffset: 4, endOffset: 4 + text.length, contextStartOffset: 0 } };
}

describe('bounded EPUB language detection', () => {
  it('recognizes supported primary language tags without confusing unrelated languages', () => {
    for (const value of ['ja', 'ja-JP', 'JA-jpan-JP', 'jpn', 'ja_JP']) expect(sourceLanguageTag(value)).toBe('ja');
    for (const value of ['en', 'en-US', 'EN-gb', 'eng']) expect(sourceLanguageTag(value)).toBe('en');
    for (const value of [undefined, '', 'zh-Hans', 'jv', 'fr', 'japanese']) expect(sourceLanguageTag(value)).toBeUndefined();
  });

  it('uses declared primary language when content agrees or is too short to classify', () => {
    expect(detectBookLanguage(['ja-JP'], [{ text: japanese }])).toEqual({ language: 'ja', languageSource: 'metadata' });
    expect(detectBookLanguage(['en-US'], [{ text: english }])).toEqual({ language: 'en', languageSource: 'metadata' });
    expect(detectBookLanguage(['en', 'ja'], [{ text: 'Short title' }])).toEqual({ language: 'en', languageSource: 'metadata' });
  });

  it('uses clear prose when metadata is absent or obviously mismatched', () => {
    expect(detectBookLanguage([], [{ text: japanese }])).toEqual({ language: 'ja', languageSource: 'content' });
    expect(detectBookLanguage(['en'], [{ text: japanese.repeat(3) }])).toEqual({ language: 'ja', languageSource: 'content' });
    expect(detectBookLanguage(['ja'], [{ text: english.repeat(3) }, { text: english.repeat(3) }])).toEqual({ language: 'en', languageSource: 'content' });
  });

  it('does not infer Japanese from Han characters, a name, or a small quote alone', () => {
    expect(detectBookLanguage([], [{ text: '中文图书需要根据真实正文判断语言，不能仅根据汉字推断。' }])).toEqual({ language: 'en', languageSource: 'unknown' });
    expect(detectBookLanguage([], [{ text: '村上春樹' }]).languageSource).toBe('unknown');
    expect(detectBookLanguage(['en'], [{ text: english.repeat(30) + ' こんにちは。' }])).toEqual({ language: 'en', languageSource: 'metadata' });
    expect(detectBookLanguage([], [{ text: 'nihongo no hon wo yomimasu'.repeat(5) }]).languageSource).toBe('unknown');
  });

  it('does not replace correct metadata because of long quotations or isolated English front matter', () => {
    expect(detectBookLanguage(['en'], [{ text: english.repeat(3) + japanese.repeat(5) }])).toEqual({ language: 'en', languageSource: 'metadata' });
    const copyright = 'All rights reserved. No part of this book may be reproduced in any form without the permission of the publisher and the author. Printed in Japan. The publisher and the author are not responsible for any use of the information in this book. ';
    expect(detectBookLanguage(['ja'], [{ text: 'A Japanese Novel' }, { text: copyright.repeat(4) }, { text: 'For my family' }])).toEqual({ language: 'ja', languageSource: 'metadata' });
    expect(detectBookLanguage(['ja'], [{ text: copyright.repeat(4) }, { text: japanese.repeat(3) }])).toEqual({ language: 'ja', languageSource: 'metadata' });
  });

  it('excludes semantically marked cover, title, copyright and table of contents pages', () => {
    for (const type of ['cover', 'titlepage', 'copyright-page', 'toc']) {
      expect(chapterLanguageSample(`<html lang="en"><body epub:type="${type}">${english.repeat(5)}</body></html>`)).toBeUndefined();
    }
    const sample = chapterLanguageSample(`<html><body><section epub:type="copyright-page">${english.repeat(10)}</section><section>${japanese.repeat(3)}</section><div role="doc-toc">${english.repeat(10)}</div></body></html>`)!;
    expect(sample.text).not.toContain('Clara');
    expect(detectBookLanguage(['en'], [sample])).toEqual({ language: 'ja', languageSource: 'content' });
  });

  it('uses chapter language declarations as a fallback and excludes ruby, scripts, styles and navigation', () => {
    const sample = chapterLanguageSample(`<html xml:lang="ja-JP"><body><p>漢字</p><ruby>文字<rt>${japanese}</rt><rp>かな</rp></ruby><script>${japanese}</script><style>${japanese}</style><nav>${japanese}</nav></body></html>`)!;
    expect(sample.language).toBe('ja');
    expect(sample.text).toContain('漢字'); expect(sample.text).toContain('文字');
    expect(sample.text).not.toContain('図書館'); expect(sample.text).not.toContain('かな');
    expect(detectBookLanguage([], [sample])).toEqual({ language: 'ja', languageSource: 'content' });
  });

  it('recognizes numerically encoded kana without treating XML attributes as prose', () => {
    const numeric = [...japanese].map(character => `&#${character.codePointAt(0)};`).join('');
    const sample = chapterLanguageSample(`<html><body title="${english}"><p>${numeric}</p></body></html>`)!;
    expect(sample.text).toContain('図書館');
    expect(detectBookLanguage([], [sample]).language).toBe('ja');
  });

  it('imports Japanese metadata and samples missing or misleading language metadata', async () => {
    expect(await inspectEpub(await epub({ language: 'ja-JP' }))).toEqual({ title: 'Language sample', author: 'Writer', language: 'ja', languageSource: 'metadata' });
    expect(await inspectEpub(await epub())).toMatchObject({ language: 'ja', languageSource: 'content' });
    expect(await inspectEpub(await epub({ language: 'en', body: japanese.repeat(3) }))).toMatchObject({ language: 'ja', languageSource: 'content' });
    expect(await inspectEpub(await epub({ body: '漢字', chapterLanguage: 'ja' }))).toMatchObject({ language: 'ja', languageSource: 'content' });
  });

  it('ignores navigation and bounds sampling to four readable spine documents', async () => {
    expect(await inspectEpub(await epub({ language: 'en', body: english, nav: true }))).toMatchObject({ language: 'en', languageSource: 'metadata' });
    expect(await inspectEpub(await epub({ chapters: [english, english, english, english, japanese.repeat(100)] }))).toMatchObject({ language: 'en', languageSource: 'content' });
  });

  it('retains fixed-layout rejection and leaves Han-only ambiguous books available for manual selection', async () => {
    await expect(inspectEpub(await epub({ language: 'ja', fixed: true }))).rejects.toThrow('固定版式');
    expect(await inspectEpub(await epub({ body: '只有汉字没有足够线索判断具体语言。' }))).toMatchObject({ language: 'en', languageSource: 'unknown' });
  });
});

describe('durable per-book language and occurrence snapshots', () => {
  it('records detected language on new books and snapshots it from trusted storage', () => {
    const store = openStore();
    const book = store.addBook(new Uint8Array([1]), { title: '日本語', author: '', fileName: 'ja.epub', language: 'ja', languageSource: 'metadata' });
    const occurrence = store.collect({ ...collectInput(book.id), language: 'en' } as CollectInput);
    expect(book).toMatchObject({ language: 'ja', languageSource: 'metadata' });
    expect(occurrence.language).toBe('ja');
    expect(store.claim()?.occurrence.language).toBe('ja');
    expect(store.addBook(new Uint8Array([1]), { title: 'Duplicate', author: '', fileName: 'duplicate.epub', language: 'en' }).id).toBe(book.id);
    expect(store.getBook(book.id).language).toBe('ja');
  });

  it('changing one book only affects future occurrences and keeps old completed/queued English records', () => {
    const store = openStore();
    const book = store.addBook(new Uint8Array([1]), { title: 'English', author: '', fileName: 'en.epub' });
    const other = store.addBook(new Uint8Array([2]), { title: 'Other', author: '', fileName: 'other.epub' });
    const completed = store.collect(collectInput(book.id, 2));
    const analysis: AnalysisResult = { kind: 'word', targetText: 'AI', meaningZh: '人工智能', definitionEn: 'Artificial intelligence.', usage: 'Used as an abbreviation.', example: 'AI is useful.' };
    store.complete(completed.id, analysis);
    const queued = store.collect(collectInput(book.id, 4));
    expect(store.updateBook(book.id, validBookPatch({ language: 'ja' }))).toMatchObject({ language: 'ja', languageSource: 'manual' });
    expect(store.getBook(other.id).language).toBe('en');
    expect(store.getOccurrence(completed.id)).toMatchObject({ language: 'en', status: 'completed', analysis });
    expect(store.getOccurrence(queued.id)?.language).toBe('en');
    expect(store.claim()?.occurrence.language).toBe('en');
    expect(store.collect(collectInput(book.id, 6)).language).toBe('ja');
    expect(store.collect(collectInput(book.id, 2)).language).toBe('en');
  });

  it('preserves English vocabulary identities while separating later Japanese readings of the same term', () => {
    const store = openStore(); const book = store.addBook(new Uint8Array([1]), { title: 'Mixed', author: '', fileName: 'mixed.epub' });
    store.collect(collectInput(book.id, 2));
    store.updateBook(book.id, { language: 'ja' });
    store.collect(collectInput(book.id, 4));
    const entries = store.listEntries(book.id);
    expect(entries).toHaveLength(2);
    expect(entries.find(entry => entry.language === 'en')).toMatchObject({ id: 'word:ai', term: 'AI' });
    expect(entries.find(entry => entry.language === 'ja')).toMatchObject({ id: 'ja:word:ai', term: 'AI' });
  });

  it('migrates legacy JSON idempotently without changing translations, book settings or task state', () => {
    const root = directory(); const book: BookRecord = { id: randomUUID(), title: 'Legacy', author: 'Writer', fileName: 'old.epub', importedAt: '2026-11-26T00:00:00Z', lastLocation: 'epubcfi(/6/2!/4/2/1:4)', progress: .3, fontSize: 24, theme: 'calm' };
    const input = collectInput(book.id); const analysis: AnalysisResult = { kind: 'word', targetText: 'AI', meaningZh: '旧中文释义', definitionEn: 'Old explanation.', usage: 'Old usage.', example: 'Old example.' };
    const occurrence: Occurrence = { id: randomUUID(), bookId: book.id, selectedText: input.text, targetText: input.text, kind: 'word', context: input.context, chapterTitle: input.chapterTitle, anchor: input.anchor, originalAnchor: input.anchor, collectedAt: book.importedAt, status: 'completed', error: null, analysis };
    const legacy = new DatabaseSync(path.join(root, 'reader.sqlite'));
    legacy.exec('CREATE TABLE books (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL); CREATE TABLE occurrences (id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id), source_cfi TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, UNIQUE(book_id, source_cfi));');
    legacy.prepare('INSERT INTO books VALUES (?, ?, ?)').run(book.id, 'old-hash', JSON.stringify(book));
    legacy.prepare('INSERT INTO occurrences(id, book_id, source_cfi, data, status, attempts) VALUES (?, ?, ?, ?, ?, ?)').run(occurrence.id, book.id, input.anchor.cfi, JSON.stringify(occurrence), 'completed', 2);
    legacy.close();
    const first = openStore(root);
    expect(first.getBook(book.id)).toEqual({ ...book, language: 'en', languageSource: 'legacy' });
    expect(first.getOccurrence(occurrence.id)).toEqual({ ...occurrence, language: 'en' });
    expect(first.claim()).toBeUndefined();
    first.close();
    const second = openStore(root);
    expect(second.getBook(book.id)).toEqual({ ...book, language: 'en', languageSource: 'legacy' });
    expect(second.getOccurrence(occurrence.id)).toEqual({ ...occurrence, language: 'en' });
    second.updateBook(book.id, { language: 'ja' }); second.close();
    const third = openStore(root);
    expect(third.getBook(book.id)).toMatchObject({ language: 'ja', languageSource: 'manual', lastLocation: book.lastLocation, theme: 'calm' });
    expect(third.getOccurrence(occurrence.id)).toMatchObject({ language: 'en', analysis });
    const persisted = new DatabaseSync(path.join(root, 'reader.sqlite'));
    try { expect(persisted.prepare('SELECT attempts FROM occurrences WHERE id = ?').get(occurrence.id)).toEqual({ attempts: 2 }); }
    finally { persisted.close(); }
  });

  it('filters language input and never retries a rejected language change behind the reader', async () => {
    expect(validBookPatch({ language: 'ja', languageSource: 'metadata' })).toEqual({ language: 'ja' });
    for (const language of [null, undefined, 'zh', 'ja-JP', 0]) expect(() => validBookPatch({ language })).toThrow('书籍语言');
    const store = openStore(); const book = store.addBook(new Uint8Array([1]), { title: 'A', author: '', fileName: 'a.epub' });
    expect(validCollect({ ...collectInput(book.id), language: 'ja' })).not.toHaveProperty('language');
    let attempts = 0;
    const persist = vi.fn(async (id: string, patch: Parameters<ReaderStore['updateBook']>[1]) => { if (++attempts === 1) throw new Error('temporary write failure'); return store.updateBook(id, patch); });
    const buffer = new BookWriteBuffer(persist);
    await expect(buffer.save(book.id, { language: 'ja' })).rejects.toThrow('temporary');
    await buffer.save(book.id, { lastLocation: 'epubcfi(/6/2!/4/2/1:7)', progress: .4 });
    await buffer.flush();
    expect(store.getBook(book.id)).toMatchObject({ language: 'en', languageSource: 'legacy', progress: .4 });
    expect(persist.mock.calls[1]?.[1]).not.toHaveProperty('language');
    expect(persist).toHaveBeenCalledTimes(2);
  });
});
