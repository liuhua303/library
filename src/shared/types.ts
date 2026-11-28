export type SelectionKind = 'word' | 'phrase' | 'sentence';
export type TaskStatus = 'pending' | 'processing' | 'waiting_network' | 'needs_key' | 'failed' | 'completed';
export type ReaderTheme = 'original' | 'quiet' | 'paper' | 'bold' | 'calm' | 'focus';
export type SourceLanguage = 'en' | 'ja';
export type BookLanguageSource = 'metadata' | 'content' | 'manual' | 'legacy' | 'unknown';

export interface BookRecord {
  id: string;
  title: string;
  author: string;
  fileName: string;
  importedAt: string;
  lastLocation: string | null;
  progress: number;
  fontSize: number;
  theme?: ReaderTheme;
  language?: SourceLanguage;
  languageSource?: BookLanguageSource;
}

export interface BookmarkInput {
  bookId: string;
  cfi: string;
  chapterTitle: string;
  excerpt: string;
  progress: number;
}

export interface BookmarkRecord extends BookmarkInput {
  id: string;
  createdAt: string;
}

export interface TextAnchor {
  cfi: string;
  chapterHref: string;
  startOffset: number;
  endOffset: number;
  contextStartOffset: number;
}

export interface AnalysisResult {
  kind: SelectionKind;
  targetText: string;
  meaningZh: string;
  definitionEn?: string;
  reading?: string;
  usage?: string;
  example?: string;
}

export interface CollectInput {
  bookId: string;
  text: string;
  kind: SelectionKind;
  anchor: TextAnchor;
  context: string;
  chapterTitle: string;
}

export interface Occurrence {
  id: string;
  bookId: string;
  selectedText: string;
  targetText: string;
  kind: SelectionKind;
  anchor: TextAnchor;
  originalAnchor: TextAnchor;
  language?: SourceLanguage;
  context: string;
  chapterTitle: string;
  collectedAt: string;
  status: TaskStatus;
  error: string | null;
  analysis: AnalysisResult | null;
}

export interface VocabularyEntry {
  id: string;
  term: string;
  kind: SelectionKind;
  language?: SourceLanguage;
  latestCollectedAt: string;
  occurrences: Occurrence[];
}

export interface AppSettings {
  hasApiKey: boolean;
  model: string;
}

export interface DataChange {
  bookId?: string;
  reason: 'books' | 'vocabulary' | 'settings' | 'bookmarks';
}

export interface ReaderApi {
  listBooks(): Promise<BookRecord[]>;
  importBook(): Promise<BookRecord | null>;
  copyText(text: string): Promise<void>;
  getBookData(bookId: string): Promise<Uint8Array>;
  getBookCover(bookId: string): Promise<string | null>;
  updateBook(bookId: string, patch: Partial<Pick<BookRecord, 'lastLocation' | 'progress' | 'fontSize' | 'theme' | 'language'>>): Promise<BookRecord>;
  listBookmarks(bookId: string): Promise<BookmarkRecord[]>;
  addBookmark(input: BookmarkInput): Promise<BookmarkRecord>;
  removeBookmark(id: string): Promise<void>;
  listEntries(bookId: string): Promise<VocabularyEntry[]>;
  collect(input: CollectInput): Promise<Occurrence>;
  removeOccurrence(id: string): Promise<void>;
  retryOccurrence(id: string): Promise<void>;
  updateAnchor(id: string, anchor: TextAnchor): Promise<void>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: { apiKey?: string; model?: string }): Promise<AppSettings>;
  setOnline(online: boolean): void;
  onDataChanged(listener: (change: DataChange) => void): () => void;
}

declare global {
  interface Window {
    readerApi: ReaderApi;
  }
}
