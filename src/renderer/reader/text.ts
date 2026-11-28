import type { SelectionKind, SourceLanguage } from '../../shared/types';

export interface TextRun {
  node: Text;
  start: number;
  end: number;
}

export interface TextIndex {
  root: Element;
  text: string;
  runs: TextRun[];
  language?: SourceLanguage;
}

export interface TextBounds {
  start: number;
  end: number;
}

/** Offsets deliberately include original whitespace and use UTF-16, like DOM Range. */
export function indexText(root: Element, language: SourceLanguage = 'en'): TextIndex {
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  const runs: TextRun[] = [];
  let text = '';
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const node = current as Text;
    // Ruby readings annotate their base text; they are not a second occurrence
    // of the prose. Existing English indexes retain their original offset rules.
    if (language === 'ja' && node.parentElement?.closest('rt, rp')) continue;
    const start = text.length;
    text += node.data;
    runs.push({ node, start, end: text.length });
  }
  return language === 'ja' ? { root, text, runs, language } : { root, text, runs };
}

export function offsetOfPoint(index: TextIndex, node: Node, offset: number): number | null {
  if (node !== index.root && !index.root.contains(node)) return null;
  if (index.language === 'ja' && node.nodeType === 1 && (node as Element).closest('rt, rp')) return null;
  if (node.nodeType === 3) {
    const run = index.runs.find((item) => item.node === node);
    return run ? run.start + Math.max(0, Math.min(offset, run.end - run.start)) : null;
  }
  const range = index.root.ownerDocument.createRange();
  range.selectNodeContents(index.root);
  try {
    range.setEnd(node, offset);
    if (index.language === 'ja') {
      // An element boundary lies between complete text runs. DOM Range's string
      // also contains ruby annotations, so count only the indexed prose runs.
      let end = 0;
      for (const run of index.runs) {
        if (range.comparePoint(run.node, run.node.data.length) > 0) break;
        end = run.end;
      }
      return end;
    }
    return range.toString().length;
  } catch {
    return null;
  }
}

export function boundsOfRange(index: TextIndex, range: Range): TextBounds | null {
  const start = offsetOfPoint(index, range.startContainer, range.startOffset);
  const end = offsetOfPoint(index, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  return trimBounds(index.text, { start, end });
}

export function trimBounds(text: string, bounds: TextBounds): TextBounds | null {
  const raw = text.slice(bounds.start, bounds.end);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  const start = bounds.start + leading;
  const end = bounds.end - trailing;
  return end > start ? { start, end } : null;
}

export function rangeFromOffsets(index: TextIndex, start: number, end: number): Range | null {
  if (start < 0 || end < start || end > index.text.length || index.runs.length === 0) return null;
  const first = index.runs.find((run) => start >= run.start && start < run.end)
    ?? (start === index.text.length ? index.runs[index.runs.length - 1] : undefined);
  const last = index.runs.find((run) => end > run.start && end <= run.end)
    ?? (end === 0 ? index.runs[0] : undefined);
  if (!first || !last) return null;
  const range = index.root.ownerDocument.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}

const japaneseWords = new Intl.Segmenter('ja', { granularity: 'word' });
const japaneseGraphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' });

export function wordAtOffset(text: string, offset: number, language: SourceLanguage = 'en'): TextBounds | null {
  if (language === 'ja') {
    if (!Number.isInteger(offset) || offset < 0 || offset >= text.length) return null;
    const segment = japaneseWords.segment(text).containing(offset);
    return segment?.isWordLike ? { start: segment.index, end: segment.index + segment.segment.length } : null;
  }
  const words = text.matchAll(/[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*/gu);
  for (const match of words) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) return { start, end };
    if (start > offset) break;
  }
  return null;
}

export function inferSelectionKind(text: string, language: SourceLanguage = 'en'): SelectionKind {
  if (language === 'ja') {
    const words = [...japaneseWords.segment(text)].filter(segment => segment.isWordLike);
    if (/[。！？.!?][\s」』”"'）)\]】〉》〕〗〙〛]*$/u.test(text) || words.length >= 8) return 'sentence';
    return words.length <= 1 ? 'word' : 'phrase';
  }
  const words = text.match(/[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*/gu) ?? [];
  if (words.length <= 1) return 'word';
  return /[.!?][”"')\]]*\s*$/.test(text) || words.length >= 8 ? 'sentence' : 'phrase';
}

export function selectionContext(text: string, start: number, end: number): { text: string; startOffset: number } {
  const desiredStart = Math.max(0, start - 850);
  const desiredEnd = Math.min(text.length, end + 850);
  return { text: text.slice(desiredStart, desiredEnd), startOffset: desiredStart };
}

export function findPhraseBounds(
  text: string,
  phrase: string,
  original: TextBounds,
  language: SourceLanguage = 'en',
): TextBounds | null {
  const parts = phrase.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const escaped = parts.map((part) => part.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&'));
  const expression = new RegExp(escaped.join('\\s+'), 'giu');
  const graphemes = language === 'ja' ? japaneseGraphemes.segment(text) : null;
  for (const match of text.matchAll(expression)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start > original.start || end < original.end) continue;
    if (graphemes && (graphemes.containing(start)?.index !== start
      || (end < text.length && graphemes.containing(end)?.index !== end))) continue;
    const before = text[start - 1] ?? '';
    const after = text[end] ?? '';
    const boundaryLetters = language === 'ja' ? /\p{Script=Latin}/u : /[\p{L}\p{M}]/u;
    if (boundaryLetters.test(match[0][0] ?? '') && boundaryLetters.test(before)) continue;
    if (boundaryLetters.test(match[0].at(-1) ?? '') && boundaryLetters.test(after)) continue;
    return { start, end };
  }
  return null;
}

export function sameChapter(left: string, right: string): boolean {
  const clean = (href: string) => {
    let value = href.split('#')[0].split('?')[0].replace(/^\.\//, '');
    try { value = decodeURIComponent(value); } catch { /* Preserve malformed original hrefs. */ }
    return value;
  };
  return clean(left) === clean(right);
}

export function caretOffsetAtPoint(doc: Document, index: TextIndex, x: number, y: number): number | null {
  const compatible = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const point = compatible.caretPositionFromPoint?.(x, y);
  if (point) return offsetOfPoint(index, point.offsetNode, point.offset);
  const range = compatible.caretRangeFromPoint?.(x, y);
  return range ? offsetOfPoint(index, range.startContainer, range.startOffset) : null;
}
