// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  boundsOfRange, findPhraseBounds, indexText, inferSelectionKind,
  rangeFromOffsets, sameChapter, selectionContext, wordAtOffset,
} from '../src/renderer/reader/text';

describe('persistent chapter text anchors', () => {
  it('retains whitespace and offsets across nested inline elements and UTF-16 characters', () => {
    document.body.innerHTML = '<p> A 😀 <em>give</em> up\n now.</p><p>Afterwards.</p>';
    const index = indexText(document.body);
    expect(index.text).toBe(document.body.textContent);
    const start = index.text.indexOf('give');
    const end = index.text.indexOf('now') + 3;
    const range = rangeFromOffsets(index, start, end)!;
    expect(range.toString()).toBe('give up\n now');
    expect(boundsOfRange(index, range)).toEqual({ start, end });
  });

  it('recreates the same logical range after markup changes without relying on page pixels', () => {
    document.body.innerHTML = '<p>Never <em>give up</em> hope.</p>';
    const first = indexText(document.body);
    const start = first.text.indexOf('give');
    document.body.innerHTML = '<p>Never <span>give</span> <b>up</b> hope.</p>';
    const second = indexText(document.body);
    expect(rangeFromOffsets(second, start, start + 7)!.toString()).toBe('give up');
  });

  it('finds only the phrase containing the selected occurrence', () => {
    const text = 'They give up early. We do not give up now.';
    const start = text.lastIndexOf('give');
    expect(findPhraseBounds(text, 'give up', { start, end: start + 4 }))
      .toEqual({ start, end: start + 7 });
    expect(findPhraseBounds(text, 'not give', { start, end: start + 4 }))
      .toEqual({ start: start - 4, end: start + 4 });
    expect(findPhraseBounds(text, 'early', { start, end: start + 4 })).toBeNull();
  });

  it('handles layout whitespace without expanding into part of another word', () => {
    const text = 'A forgiven upbringing. Never give \n up.';
    const start = text.lastIndexOf('give');
    expect(findPhraseBounds(text, 'give up', { start, end: start + 4 }))
      .toEqual({ start, end: text.lastIndexOf('.') });
    expect(findPhraseBounds('forgive up', 'give up', { start: 3, end: 7 })).toBeNull();
  });

  it('creates context whose start offset maps back exactly to the chapter', () => {
    const text = ' \n'.repeat(600) + 'give up' + '\n More.';
    const start = text.indexOf('give');
    const context = selectionContext(text, start, start + 4);
    expect(text.slice(context.startOffset, context.startOffset + context.text.length)).toBe(context.text);
    expect(context.text.slice(start - context.startOffset, start - context.startOffset + 4)).toBe('give');
  });
});

describe('word selection', () => {
  it('includes apostrophes and hyphens, without collecting punctuation or whitespace', () => {
    const text = "We can't forget a well-known name.";
    const start = text.indexOf("can't");
    expect(wordAtOffset(text, start + 2)).toEqual({ start, end: start + 5 });
    const other = text.indexOf('well');
    expect(wordAtOffset(text, other + 5)).toEqual({ start: other, end: other + 10 });
    expect(wordAtOffset(text, text.length)).toBeNull();
  });
  it('separates words, short expressions and complete sentences', () => {
    expect(inferSelectionKind('reader')).toBe('word');
    expect(inferSelectionKind('give up')).toBe('phrase');
    expect(inferSelectionKind('Never give up.')).toBe('sentence');
  });
  it('compares chapter hrefs independently of fragments', () => {
    expect(sameChapter('./Text/part%20one.xhtml#p1', 'Text/part one.xhtml')).toBe(true);
    expect(sameChapter('one.xhtml', 'two.xhtml')).toBe(false);
  });
});
