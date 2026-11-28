// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  boundsOfRange, findPhraseBounds, indexText, inferSelectionKind,
  offsetOfPoint, rangeFromOffsets, wordAtOffset,
} from '../src/renderer/reader/text';

describe('Japanese word selection', () => {
  it('selects a Japanese word inside unspaced prose', () => {
    const text = '昨日は図書館で本を読んだ。';
    const start = text.indexOf('図書館');
    expect(wordAtOffset(text, start + 1, 'ja')).toEqual({ start, end: start + 3 });
    const book = text.indexOf('本');
    expect(wordAtOffset(text, book, 'ja')).toEqual({ start: book, end: book + 1 });
  });

  it('does not select the previous word when the caret is on punctuation or space', () => {
    const text = '本、 猫。😀';
    for (const offset of [1, 2, 4, 5, 6, text.length, -1, Number.NaN, .5]) {
      expect(wordAtOffset(text, offset, 'ja')).toBeNull();
    }
  });

  it('retains UTF-16 and decomposed dakuten offsets without normalizing prose', () => {
    const text = '😀ハ\u309Aンを食べた。';
    expect(wordAtOffset(text, 3, 'ja')).toEqual({ start: 2, end: 5 });
    expect(text.slice(2, 5)).toBe('ハ\u309Aン');
  });

  it('supports Latin words in a Japanese book', () => {
    const text = '私はDeepSeekを使う。';
    const start = text.indexOf('DeepSeek');
    expect(wordAtOffset(text, start + 2, 'ja')).toEqual({ start, end: start + 8 });
  });

  it('recognizes Japanese sentence punctuation and closing quotes', () => {
    expect(inferSelectionKind('図書館', 'ja')).toBe('word');
    expect(inferSelectionKind('静かな部屋', 'ja')).toBe('phrase');
    for (const text of ['今日は雨です。', '「本を読みます！」', '『どこですか？』', '本？', '「どうした？\n」']) {
      expect(inferSelectionKind(text, 'ja')).toBe('sentence');
    }
  });

  it('keeps the English default behavior unchanged', () => {
    expect(inferSelectionKind('図書館へ行きました。')).toBe('word');
    expect(wordAtOffset('図書館へ行きました。', 1)).toEqual({ start: 0, end: 9 });
    expect(inferSelectionKind('give up')).toBe('phrase');
    expect(wordAtOffset("can't", 2)).toEqual({ start: 0, end: 5 });
  });
});

describe('Japanese phrase anchors', () => {
  it('finds a phrase in unspaced Japanese while retaining its surrounding prose', () => {
    const text = '今日は図書館へ行った。';
    const start = text.indexOf('図書館');
    expect(findPhraseBounds(text, '図書館', { start, end: start + 3 }, 'ja'))
      .toEqual({ start, end: start + 3 });
  });

  it('expands inflected text only around the selected occurrence', () => {
    const text = '昨日は本を読んでいた。今日も本を読んでいた。';
    const selected = text.lastIndexOf('読ん');
    const start = text.lastIndexOf('本');
    expect(findPhraseBounds(text, '本を読んでいた', { start: selected, end: selected + 2 }, 'ja'))
      .toEqual({ start, end: start + '本を読んでいた'.length });
    expect(findPhraseBounds(text, '昨日', { start: selected, end: selected + 2 }, 'ja')).toBeNull();
    expect(findPhraseBounds(text, '読む', { start: selected, end: selected + 2 }, 'ja')).toBeNull();
  });

  it('allows layout whitespace while preserving the actual DOM offsets', () => {
    const text = '彼は本を\n読んでいた。';
    const start = text.indexOf('本');
    expect(findPhraseBounds(text, '本を 読んでいた', { start, end: start + 1 }, 'ja'))
      .toEqual({ start, end: text.indexOf('。') });
  });

  it('does not match partial Latin words or cut a combining character', () => {
    expect(findPhraseBounds('forgive up', 'give up', { start: 3, end: 7 }, 'ja')).toBeNull();
    const text = '😀ハ\u309Aンを買う。';
    expect(findPhraseBounds(text, 'ハ', { start: 2, end: 3 }, 'ja')).toBeNull();
    expect(findPhraseBounds(text, 'ハ\u309Aン', { start: 2, end: 5 }, 'ja'))
      .toEqual({ start: 2, end: 5 });
  });
});

describe('Japanese ruby text indexes', () => {
  it('excludes ruby readings only for Japanese, retaining the existing English index', () => {
    document.body.innerHTML = '<p>😀<ruby>漢字<rp>（</rp><rt>かんじ</rt><rp>）</rp></ruby>の本。</p>';
    const japanese = indexText(document.body, 'ja');
    expect(japanese.text).toBe('😀漢字の本。');
    expect(indexText(document.body).text).toBe(document.body.textContent);
    const start = japanese.text.indexOf('漢字');
    const range = rangeFromOffsets(japanese, start, start + 2)!;
    expect(range.toString()).toBe('漢字');
    expect(boundsOfRange(japanese, range)).toEqual({ start, end: start + 2 });
    expect(offsetOfPoint(japanese, document.querySelector('rt')!.firstChild!, 1)).toBeNull();
  });

  it('maps element boundaries across ruby annotations to the same prose offsets', () => {
    document.body.innerHTML = '<p><ruby>漢字<rt>かんじ</rt></ruby>の本。</p><p>次の段落。</p>';
    const index = indexText(document.body, 'ja');
    const first = document.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(first);
    expect(boundsOfRange(index, range)).toEqual({ start: 0, end: '漢字の本。'.length });
    expect(offsetOfPoint(index, document.body, 1)).toBe('漢字の本。'.length);
    expect(offsetOfPoint(index, document.body, 2)).toBe(index.text.length);
    expect(offsetOfPoint(index, document.querySelector('rt')!, 0)).toBeNull();
  });
});
