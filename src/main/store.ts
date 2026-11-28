import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AnalysisResult, BookLanguageSource, BookmarkInput, BookmarkRecord, BookRecord, CollectInput, Occurrence, SourceLanguage, TaskStatus, TextAnchor, VocabularyEntry } from '../shared/types';

type OccurrenceRow = { id: string; book_id: string; data: string; status: TaskStatus; attempts: number; next_attempt_at: number };
type BookRow = { id: string; hash: string; data: string };
type BookmarkRow = { data: string };

export interface QueuedOccurrence { occurrence: Occurrence; attempts: number }

export class ReaderStore {
  readonly directory: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(path.join(directory, 'books'), { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'reader.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS occurrences (
        id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        source_cfi TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE(book_id, source_cfi)
      );
      CREATE INDEX IF NOT EXISTS occurrences_book ON occurrences(book_id);
      CREATE INDEX IF NOT EXISTS occurrences_queue ON occurrences(status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bookmarks (
        id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        cfi TEXT NOT NULL, progress REAL NOT NULL, data TEXT NOT NULL,
        UNIQUE(book_id, cfi)
      );
      CREATE INDEX IF NOT EXISTS bookmarks_book_progress ON bookmarks(book_id, progress);
    `);
    try { this.migrateLanguages(); }
    catch (error) { this.db.close(); throw error; }
    // A process exit interrupts a request, not a durable collection.
    for (const row of this.rows("status = 'processing'")) {
      const occurrence = JSON.parse(row.data) as Occurrence;
      occurrence.status = 'pending';
      occurrence.error = null;
      this.writeOccurrence(occurrence, { attempts: Math.max(0, row.attempts - 1), nextAttemptAt: 0 });
    }
  }

  private migrateLanguages(): void {
    // Existing collections were produced by the English pipeline. Snapshot that
    // fact independently of later manual changes to a book's language.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of this.db.prepare('SELECT * FROM books').all() as unknown as BookRow[]) {
        const book = JSON.parse(row.data) as BookRecord;
        let changed = false;
        if (book.language !== 'en' && book.language !== 'ja') { book.language = 'en'; changed = true; }
        if (!book.languageSource) { book.languageSource = 'legacy'; changed = true; }
        if (changed) this.db.prepare('UPDATE books SET data = ? WHERE id = ?').run(JSON.stringify(book), row.id);
      }
      for (const row of this.rows()) {
        const occurrence = JSON.parse(row.data) as Occurrence;
        if (occurrence.language !== 'en' && occurrence.language !== 'ja') {
          occurrence.language = 'en';
          this.db.prepare('UPDATE occurrences SET data = ? WHERE id = ?').run(JSON.stringify(occurrence), row.id);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (!this.closed) { this.closed = true; this.db.close(); }
  }

  private rows(where = '1=1', parameters: (string | number)[] = []): OccurrenceRow[] {
    return this.db.prepare(`SELECT * FROM occurrences WHERE ${where} ORDER BY rowid`).all(...parameters) as unknown as OccurrenceRow[];
  }

  listBooks(): BookRecord[] {
    return (this.db.prepare('SELECT * FROM books ORDER BY rowid DESC').all() as unknown as BookRow[]).map(row => JSON.parse(row.data));
  }

  getBook(id: string): BookRecord {
    const row = this.db.prepare('SELECT * FROM books WHERE id = ?').get(id) as unknown as BookRow | undefined;
    if (!row) throw new Error('这本书不存在，请重新导入。');
    return JSON.parse(row.data) as BookRecord;
  }

  addBook(bytes: Uint8Array, metadata: { title: string; author: string; fileName: string; language?: SourceLanguage; languageSource?: BookLanguageSource }): BookRecord {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const existing = this.db.prepare('SELECT * FROM books WHERE hash = ?').get(hash) as unknown as BookRow | undefined;
    if (existing) return JSON.parse(existing.data) as BookRecord;
    const id = randomUUID();
    const book: BookRecord = { id, ...metadata, language: metadata.language ?? 'en', languageSource: metadata.languageSource ?? (metadata.language ? 'unknown' : 'legacy'), importedAt: new Date().toISOString(), lastLocation: null, progress: 0, fontSize: 20 };
    const filePath = this.bookPath(id);
    writeFileSync(`${filePath}.tmp`, bytes);
    renameSync(`${filePath}.tmp`, filePath);
    this.db.prepare('INSERT INTO books(id, hash, data) VALUES (?, ?, ?)').run(id, hash, JSON.stringify(book));
    return book;
  }

  private bookPath(id: string): string { return path.join(this.directory, 'books', `${id}.epub`); }

  readBook(id: string): Uint8Array {
    this.getBook(id);
    const filePath = this.bookPath(id);
    if (!existsSync(filePath)) throw new Error('本机书籍文件已丢失，请重新导入原文件。');
    return new Uint8Array(readFileSync(filePath));
  }

  updateBook(id: string, patch: Partial<Pick<BookRecord, 'lastLocation' | 'progress' | 'fontSize' | 'theme' | 'language'>>): BookRecord {
    const book = { ...this.getBook(id), ...patch, ...('language' in patch ? { languageSource: 'manual' as const } : {}) };
    this.db.prepare('UPDATE books SET data = ? WHERE id = ?').run(JSON.stringify(book), id);
    return book;
  }

  listBookmarks(bookId: string): BookmarkRecord[] {
    this.getBook(bookId);
    return (this.db.prepare('SELECT data FROM bookmarks WHERE book_id = ? ORDER BY progress, rowid').all(bookId) as unknown as BookmarkRow[])
      .map(row => JSON.parse(row.data) as BookmarkRecord);
  }

  addBookmark(input: BookmarkInput): BookmarkRecord {
    this.getBook(input.bookId);
    const existing = this.db.prepare('SELECT data FROM bookmarks WHERE book_id = ? AND cfi = ?').get(input.bookId, input.cfi) as BookmarkRow | undefined;
    if (existing) return JSON.parse(existing.data) as BookmarkRecord;
    const bookmark: BookmarkRecord = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO bookmarks(id, book_id, cfi, progress, data) VALUES (?, ?, ?, ?, ?)')
      .run(bookmark.id, bookmark.bookId, bookmark.cfi, bookmark.progress, JSON.stringify(bookmark));
    return bookmark;
  }

  removeBookmark(id: string): BookmarkRecord | undefined {
    const row = this.db.prepare('SELECT data FROM bookmarks WHERE id = ?').get(id) as BookmarkRow | undefined;
    if (!row) return undefined;
    this.db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
    return JSON.parse(row.data) as BookmarkRecord;
  }

  collect(input: CollectInput): Occurrence {
    const book = this.getBook(input.bookId);
    const existing = this.db.prepare('SELECT * FROM occurrences WHERE book_id = ? AND source_cfi = ?').get(input.bookId, input.anchor.cfi) as unknown as OccurrenceRow | undefined;
    if (existing) {
      const occurrence = JSON.parse(existing.data) as Occurrence;
      occurrence.collectedAt = new Date().toISOString();
      this.writeOccurrence(occurrence);
      return occurrence;
    }
    const occurrence: Occurrence = {
      id: randomUUID(), bookId: input.bookId, selectedText: input.text, targetText: input.text,
      kind: input.kind, anchor: { ...input.anchor }, originalAnchor: { ...input.anchor },
      context: input.context, chapterTitle: input.chapterTitle, collectedAt: new Date().toISOString(),
      language: book.language === 'ja' ? 'ja' : 'en',
      status: 'pending', error: null, analysis: null,
    };
    this.db.prepare('INSERT INTO occurrences (id, book_id, source_cfi, data, status) VALUES (?, ?, ?, ?, ?)')
      .run(occurrence.id, occurrence.bookId, occurrence.originalAnchor.cfi, JSON.stringify(occurrence), occurrence.status);
    return occurrence;
  }

  getOccurrence(id: string): Occurrence | undefined {
    const row = this.db.prepare('SELECT * FROM occurrences WHERE id = ?').get(id) as unknown as OccurrenceRow | undefined;
    return row ? JSON.parse(row.data) as Occurrence : undefined;
  }

  listOccurrences(bookId?: string): Occurrence[] {
    return this.rows(bookId ? 'book_id = ?' : '1=1', bookId ? [bookId] : []).map(row => JSON.parse(row.data) as Occurrence);
  }

  listEntries(bookId: string): VocabularyEntry[] {
    this.getBook(bookId);
    const groups = new Map<string, VocabularyEntry>();
    for (const occurrence of this.listOccurrences(bookId)) {
      const language: SourceLanguage = occurrence.language === 'ja' ? 'ja' : 'en';
      const originalKey = `${occurrence.kind}:${occurrence.targetText.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')}`;
      const key = language === 'en' ? originalKey : `ja:${originalKey}`;
      let entry = groups.get(key);
      if (!entry) {
        entry = { id: key, term: occurrence.targetText, kind: occurrence.kind, language, latestCollectedAt: occurrence.collectedAt, occurrences: [] };
        groups.set(key, entry);
      }
      entry.occurrences.push(occurrence);
      if (occurrence.collectedAt > entry.latestCollectedAt) entry.latestCollectedAt = occurrence.collectedAt;
    }
    return [...groups.values()].map(entry => ({ ...entry, occurrences: entry.occurrences.sort((a, b) => b.collectedAt.localeCompare(a.collectedAt)) }))
      .sort((a, b) => b.latestCollectedAt.localeCompare(a.latestCollectedAt));
  }

  removeOccurrence(id: string): Occurrence | undefined {
    const occurrence = this.getOccurrence(id);
    this.db.prepare('DELETE FROM occurrences WHERE id = ?').run(id);
    return occurrence;
  }

  private writeOccurrence(occurrence: Occurrence, options?: { attempts?: number; nextAttemptAt?: number }): void {
    this.db.prepare(`UPDATE occurrences SET data = ?, status = ?, attempts = COALESCE(?, attempts), next_attempt_at = COALESCE(?, next_attempt_at) WHERE id = ?`)
      .run(JSON.stringify(occurrence), occurrence.status, options?.attempts ?? null, options?.nextAttemptAt ?? null, occurrence.id);
  }

  updateAnchor(id: string, anchor: TextAnchor): Occurrence | undefined {
    const occurrence = this.getOccurrence(id);
    if (occurrence) { occurrence.anchor = anchor; this.writeOccurrence(occurrence); }
    return occurrence;
  }

  complete(id: string, analysis: AnalysisResult): Occurrence | undefined {
    const occurrence = this.getOccurrence(id);
    if (!occurrence) return undefined;
    occurrence.analysis = analysis;
    occurrence.targetText = analysis.targetText;
    occurrence.kind = analysis.kind;
    occurrence.status = 'completed';
    occurrence.error = null;
    this.writeOccurrence(occurrence, { nextAttemptAt: 0 });
    return occurrence;
  }

  setTaskState(id: string, status: TaskStatus, error: string | null, nextAttemptAt = 0): Occurrence | undefined {
    const occurrence = this.getOccurrence(id);
    if (!occurrence) return undefined;
    occurrence.status = status;
    occurrence.error = error;
    this.writeOccurrence(occurrence, { nextAttemptAt });
    return occurrence;
  }

  holdPending(status: 'waiting_network' | 'needs_key' | 'failed', error: string): void {
    for (const row of this.rows("status IN ('pending', 'waiting_network', 'needs_key')")) {
      const occurrence = JSON.parse(row.data) as Occurrence;
      occurrence.status = status;
      occurrence.error = error;
      this.writeOccurrence(occurrence);
    }
  }

  releaseHeld(includeAuthFailures = false): void {
    const clause = includeAuthFailures ? "status IN ('waiting_network', 'needs_key') OR (status = 'failed' AND (data LIKE '%API 密钥%' OR data LIKE '%API 余额%'))" : "status IN ('waiting_network', 'needs_key')";
    for (const row of this.rows(clause)) {
      const occurrence = JSON.parse(row.data) as Occurrence;
      occurrence.status = 'pending'; occurrence.error = null;
      this.writeOccurrence(occurrence, { attempts: 0, nextAttemptAt: 0 });
    }
  }

  releaseDueNetwork(now: number): void {
    for (const row of this.rows("status = 'waiting_network' AND next_attempt_at > 0 AND next_attempt_at <= ?", [now])) {
      const occurrence = JSON.parse(row.data) as Occurrence;
      occurrence.status = 'pending';
      this.writeOccurrence(occurrence);
    }
  }

  retry(id: string): Occurrence | undefined {
    const occurrence = this.getOccurrence(id);
    if (!occurrence || occurrence.status === 'processing' || occurrence.status === 'completed') return occurrence;
    occurrence.status = 'pending'; occurrence.error = null;
    this.writeOccurrence(occurrence, { attempts: 0, nextAttemptAt: 0 });
    return occurrence;
  }

  claim(now = Date.now()): QueuedOccurrence | undefined {
    const row = this.db.prepare("SELECT * FROM occurrences WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY rowid LIMIT 1").get(now) as unknown as OccurrenceRow | undefined;
    if (!row) return undefined;
    const occurrence = JSON.parse(row.data) as Occurrence;
    occurrence.status = 'processing'; occurrence.error = null;
    this.writeOccurrence(occurrence, { attempts: row.attempts + 1, nextAttemptAt: 0 });
    return { occurrence, attempts: row.attempts + 1 };
  }

  nextWakeTime(): number | undefined {
    const row = this.db.prepare("SELECT MIN(next_attempt_at) AS wake FROM occurrences WHERE status IN ('pending', 'waiting_network') AND next_attempt_at > 0").get() as { wake: number | null };
    return row.wake ?? undefined;
  }

  getSetting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
}
