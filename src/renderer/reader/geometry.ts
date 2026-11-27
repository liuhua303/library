import type { TextIndex } from './text';

export interface TextRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Measure selected characters, never a selected element's padding or border box. */
export function textClientRects(index: TextIndex, start: number, end: number): TextRect[] {
  if (start < 0 || end <= start || end > index.text.length) return [];
  const rects: TextRect[] = [];
  for (const run of index.runs) {
    if (run.end <= start) continue;
    if (run.start >= end) break;
    const range = run.node.ownerDocument.createRange();
    range.setStart(run.node, Math.max(start, run.start) - run.start);
    range.setEnd(run.node, Math.min(end, run.end) - run.start);
    for (const rect of range.getClientRects()) {
      if (rect.width > 0 && rect.height > 0) {
        rects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      }
    }
  }
  return rects;
}

/** Exact union in horizontal bands: translucent selection pixels are painted once. */
export function unionRects(input: TextRect[]): TextRect[] {
  const rects = input.filter(rect => Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0);
  const edges = [...new Set(rects.flatMap(rect => [rect.top, rect.top + rect.height]))].sort((a, b) => a - b);
  const result: TextRect[] = [];
  let previous = new Map<string, TextRect>();
  for (let index = 0; index + 1 < edges.length; index++) {
    const top = edges[index];
    const bottom = edges[index + 1];
    const spans = rects.filter(rect => rect.top < bottom && rect.top + rect.height > top)
      .map(rect => ({ left: rect.left, right: rect.left + rect.width }))
      .sort((a, b) => a.left - b.left || a.right - b.right);
    const intervals: { left: number; right: number }[] = [];
    for (const span of spans) {
      const last = intervals.at(-1);
      if (last && span.left <= last.right) last.right = Math.max(last.right, span.right);
      else intervals.push({ ...span });
    }
    const current = new Map<string, TextRect>();
    for (const span of intervals) {
      const key = `${span.left}:${span.right}`;
      let rect = previous.get(key);
      if (rect && rect.top + rect.height === top) rect.height = bottom - rect.top;
      else {
        rect = { left: span.left, top, width: span.right - span.left, height: bottom - top };
        result.push(rect);
      }
      current.set(key, rect);
    }
    previous = current;
  }
  return result;
}
