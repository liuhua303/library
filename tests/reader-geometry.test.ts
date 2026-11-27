// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { textClientRects, unionRects, type TextRect } from '../src/renderer/reader/geometry';
import { indexText, rangeFromOffsets } from '../src/renderer/reader/text';

const overlapArea = (a: TextRect, b: TextRect) =>
  Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left))
  * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
const contains = (rect: TextRect, x: number, y: number) =>
  x > rect.left && x < rect.left + rect.width && y > rect.top && y < rect.top + rect.height;

describe('non-overlapping selection paint', () => {
  it('paints duplicate and nested fragments once', () => {
    const output = unionRects([
      { left: 12, top: 4, width: 100, height: 20 },
      { left: 12, top: 4, width: 100, height: 20 },
      { left: 20, top: 6, width: 30, height: 15 },
    ]);
    expect(output).toEqual([{ left: 12, top: 4, width: 100, height: 20 }]);
  });

  it('preserves line gaps and paragraph indentation', () => {
    const input = [
      { left: 30, top: 0, width: 70, height: 20 },
      { left: 100, top: 0, width: 45, height: 20 },
      { left: 0, top: 35, width: 120, height: 20 },
      { left: 28, top: 84, width: 90, height: 20 },
    ];
    expect(unionRects(input)).toEqual([
      { left: 30, top: 0, width: 115, height: 20 },
      { left: 0, top: 35, width: 120, height: 20 },
      { left: 28, top: 84, width: 90, height: 20 },
    ]);
  });

  it('keeps exact coverage when different font heights overlap', () => {
    const input = [
      { left: 0, top: 10, width: 70, height: 20 },
      { left: 45, top: 2, width: 55, height: 32 },
      { left: 90, top: 11, width: 60, height: 18 },
      { left: 12, top: 50, width: 65, height: 20 },
    ];
    const output = unionRects(input);
    for (let index = 0; index < output.length; index++) {
      for (let other = index + 1; other < output.length; other++) expect(overlapArea(output[index], output[other])).toBe(0);
    }
    for (let y = 0.5; y < 76; y++) for (let x = 0.5; x < 155; x++) {
      expect(output.some(rect => contains(rect, x, y))).toBe(input.some(rect => contains(rect, x, y)));
    }
  });

  it('ignores empty and invalid rectangles', () => {
    expect(unionRects([
      { left: 0, top: 0, width: 0, height: 20 },
      { left: Number.NaN, top: 0, width: 20, height: 20 },
      { left: 0, top: 0, width: 20, height: -1 },
    ])).toEqual([]);
  });
});

const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
afterEach(() => {
  if (originalRects) Object.defineProperty(Range.prototype, 'getClientRects', originalRects);
  else Reflect.deleteProperty(Range.prototype, 'getClientRects');
});

it('measures only selected characters across nested inline and block elements, without changing anchors', () => {
  document.body.innerHTML = '<p>Skip <span>first <em>line</em></span> ending.</p><p style="text-indent:30px"><a id="page"></a>Second <strong>part</strong> untouched.</p>';
  const before = document.body.innerHTML;
  const index = indexText(document.body);
  const start = index.text.indexOf('first') + 2;
  const end = index.text.indexOf('part') + 2;
  const measured: string[] = [];
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: function (this: Range) {
      expect(this.startContainer.nodeType).toBe(Node.TEXT_NODE);
      expect(this.endContainer).toBe(this.startContainer);
      measured.push(this.toString());
      return [new DOMRect(10, measured.length * 35, this.toString().length * 8, 20)];
    },
  });
  const rects = textClientRects(index, start, end);
  expect(measured.join('')).toBe(index.text.slice(start, end));
  expect(measured[0]).toBe('rst ');
  expect(measured.at(-1)).toBe('pa');
  expect(rects.length).toBe(measured.length);
  expect(document.body.innerHTML).toBe(before);
  expect(rangeFromOffsets(index, start, end)?.toString()).toBe(measured.join(''));
});
