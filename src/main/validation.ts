import type { BookmarkInput, BookRecord, CollectInput, ReaderTheme, SourceLanguage, TextAnchor } from '../shared/types';

export function assertObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('操作参数无效。');
}

export function validId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value)) throw new Error('记录标识无效。');
  return value;
}

function validText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim())) throw new Error(`${label}无效。`);
  return value;
}

export function validAnchor(value: unknown): TextAnchor {
  assertObject(value);
  const cfi = validText(value.cfi, '原文位置', 8000);
  if (!cfi.startsWith('epubcfi(')) throw new Error('原文位置格式无效。');
  const chapterHref = validText(value.chapterHref, '章节位置', 2048);
  const offsets = [value.startOffset, value.endOffset, value.contextStartOffset];
  if (offsets.some(offset => typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)) throw new Error('文字选区无效。');
  const [startOffset, endOffset, contextStartOffset] = offsets as [number, number, number];
  if (endOffset <= startOffset || contextStartOffset > startOffset) throw new Error('文字选区范围无效。');
  return { cfi, chapterHref, startOffset, endOffset, contextStartOffset };
}

export function validCollect(value: unknown): CollectInput {
  assertObject(value);
  const bookId = validId(value.bookId);
  const text = validText(value.text, '收录内容', 8000).trim();
  if (!['word', 'phrase', 'sentence'].includes(String(value.kind))) throw new Error('收录类型无效。');
  const anchor = validAnchor(value.anchor);
  const context = validText(value.context, '上下文', 24_000);
  if (anchor.endOffset - anchor.contextStartOffset > context.length) throw new Error('上下文未包含完整选区。');
  const chapterTitle = validText(value.chapterTitle, '章节名称', 1000, true);
  return { bookId, text, kind: value.kind as CollectInput['kind'], anchor, context, chapterTitle };
}

export function validBookmark(value: unknown): BookmarkInput {
  assertObject(value);
  const bookId = validId(value.bookId);
  const cfi = validText(value.cfi, '书签位置', 8000);
  if (!cfi.startsWith('epubcfi(') || !cfi.endsWith(')')) throw new Error('书签位置格式无效。');
  const chapterTitle = validText(value.chapterTitle, '章节名称', 1000, true).trim();
  const excerpt = validText(value.excerpt, '书签摘录', 2000, true).trim();
  const progress = value.progress;
  if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error('书签进度无效。');
  return { bookId, cfi, chapterTitle, excerpt, progress };
}

export function validBookPatch(value: unknown): Partial<Pick<BookRecord, 'lastLocation' | 'progress' | 'fontSize' | 'theme' | 'language'>> {
  assertObject(value);
  const patch: Partial<Pick<BookRecord, 'lastLocation' | 'progress' | 'fontSize' | 'theme' | 'language'>> = {};
  if ('lastLocation' in value) {
    if (value.lastLocation !== null && (typeof value.lastLocation !== 'string' || !value.lastLocation.startsWith('epubcfi(') || value.lastLocation.length > 8000)) throw new Error('阅读位置无效。');
    patch.lastLocation = value.lastLocation as string | null;
  }
  if ('progress' in value) {
    if (typeof value.progress !== 'number' || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1) throw new Error('阅读进度无效。');
    patch.progress = value.progress;
  }
  if ('fontSize' in value) {
    if (typeof value.fontSize !== 'number' || !Number.isFinite(value.fontSize) || value.fontSize < 14 || value.fontSize > 36) throw new Error('字号应在 14 至 36 之间。');
    patch.fontSize = value.fontSize;
  }
  if ('theme' in value) {
    if (typeof value.theme !== 'string' || !['original', 'quiet', 'paper', 'bold', 'calm', 'focus'].includes(value.theme)) throw new Error('阅读主题无效。');
    patch.theme = value.theme as ReaderTheme;
  }
  if ('language' in value) {
    if (value.language !== 'en' && value.language !== 'ja') throw new Error('书籍语言无效。');
    patch.language = value.language as SourceLanguage;
  }
  return patch;
}

export function validSettings(value: unknown): { apiKey?: string; model?: string } {
  assertObject(value);
  const settings: { apiKey?: string; model?: string } = {};
  if ('apiKey' in value) {
    const key = validText(value.apiKey, 'API 密钥', 512, true).trim();
    if (/[\r\n\s]/.test(key)) throw new Error('API 密钥不能包含空格或换行。');
    settings.apiKey = key;
  }
  if ('model' in value) {
    if (typeof value.model !== 'string' || !/^[a-zA-Z\d._:/-]{1,100}$/.test(value.model)) throw new Error('模型名称无效。');
    settings.model = value.model;
  }
  return settings;
}
