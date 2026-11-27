import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import JSZip from 'jszip';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSampleBook } from './create-sample.mjs';
import { changeFont, closeTools, importAndOpenBook, turnPage } from './reader-test-ui.mjs';

const artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const userData = await mkdtemp(join(tmpdir(), 'yuejian-selection-'));
const sample = await createSampleBook(join(userData, 'selection.epub'), { title: 'Selection geometry regression', identifier: 'yuejian-selection-geometry' });
const zip = await JSZip.loadAsync(await readFile(sample));
const first = 'BeforeStart SelectionStart Clara opened her notebook beside a quiet window and began to read a story about a distant town where familiar voices carried across the square.';
const middle = 'Every line should have one calm highlight, even when the words cross an inline element.\nThe next line includes a deliberate line break and continues inside nested formatting.';
const last = 'The story continued through another paragraph with a small first line indent, until the reader reached SelectionEnd and then kept reading toward AdjustedEnd without losing the place.';
const filler = Array.from({ length: 35 }, (_, i) => `<p>Passage ${i + 1}: Clara returned to the notebook and read another page. A careful reader can move between lines, adjust a selection, and return to the story without seeing duplicate highlights. The afternoon remained quiet, and the next paragraph offered another detail.</p>`).join('');
zip.file('OEBPS/chapter1.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Selection geometry</title><style>body{margin:0;padding:12px 24px}h1{font-size:1em;font-weight:normal;margin:0 0 .5em}p{margin:0 0 .65em;text-indent:1em}.block{padding:5px 18px}.outer{font-style:normal}</style></head><body><h1>Selection geometry</h1><p id="first">${first}</p><a id="page-marker"/><div class="block"><p id="middle"><span class="outer"><em><span>${middle.split('\n')[0]}</span><br/><span>${middle.split('\n')[1]}</span></em></span></p></div><p id="last"><span>${last}</span></p>${filler}</body></html>`);
await writeFile(sample, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

const env = { ...process.env, APP_TEST_MODE: '1', READER_USER_DATA: join(userData, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const checks = [];
const measurements = [];
const errors = [];
let app;
let page;
let bookId;
const step = name => console.log('reader-selection: ' + name);

async function frameWithText() {
  for (let i = 0; i < 100; i++) {
    for (const frame of page.frames().filter(frame => frame !== page.mainFrame())) {
      if (await frame.locator('#first').count().catch(() => 0)) return frame;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('未找到测试读物正文');
}

async function visibleWords() {
  const frame = await frameWithText();
  const viewport = await page.getByTestId('epub-viewport').boundingBox();
  const frameBox = await (await frame.frameElement()).boundingBox();
  return frame.evaluate(({ viewport, frameBox }) => {
    const result = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    let base = 0;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      for (const match of text.matchAll(/[A-Za-z]+/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rect = range.getBoundingClientRect();
        const x = frameBox.x + rect.x;
        const y = frameBox.y + rect.y;
        if (rect.width < 1 || x < viewport.x + 1 || x + rect.width > viewport.x + viewport.width - 1 || y < viewport.y + 1 || y + rect.height > viewport.y + viewport.height - 1) continue;
        result.push({ text: match[0], start: base + match.index, end: base + match.index + match[0].length,
          x: x + rect.width / 2, y: y + rect.height / 2,
          before: { x: x + .1, y: y + rect.height / 2 }, after: { x: x + rect.width - .1, y: y + rect.height / 2 } });
      }
      base += text.length;
    }
    return result;
  }, { viewport, frameBox });
}

async function word(text) {
  const result = (await visibleWords()).find(word => word.text === text);
  assert.ok(result, '当前页应有可见标记词 ' + text);
  return result;
}

async function selectedText() { return page.locator('.reader-selection-summary > span').getAttribute('title'); }

async function dragBetween(first, last) {
  await page.mouse.move(first.before.x, first.before.y);
  await page.mouse.down();
  const moving = page.mouse.move(last.after.x, last.after.y);
  await new Promise(resolve => setTimeout(resolve, 120));
  await page.mouse.up();
  await moving;
  await page.locator('.reader-selection-summary').waitFor();
}

function area(rects) {
  const xs = [...new Set(rects.flatMap(rect => [rect.x, rect.x + rect.width]))].sort((a, b) => a - b);
  let sum = 0;
  for (let i = 1; i < xs.length; i++) {
    const left = xs[i - 1], right = xs[i];
    if (right <= left) continue;
    const spans = rects.filter(rect => rect.x < right && rect.x + rect.width > left).map(rect => [rect.y, rect.y + rect.height]).sort((a, b) => a[0] - b[0]);
    let start, end, height = 0;
    for (const span of spans) {
      if (end === undefined || span[0] > end) { if (end !== undefined) height += end - start; [start, end] = span; }
      else end = Math.max(end, span[1]);
    }
    if (end !== undefined) height += end - start;
    sum += (right - left) * height;
  }
  return sum;
}

function intersection(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

async function checkGeometry(stage, expectedText) {
  await page.waitForTimeout(160);
  const text = await selectedText();
  assert.equal(text, expectedText, stage + '选中的逻辑文本应准确');
  const frame = await frameWithText();
  const viewport = await page.getByTestId('epub-viewport').boundingBox();
  const frameBox = await (await frame.frameElement()).boundingBox();
  const reference = await frame.evaluate(({ text, viewport, frameBox }) => {
    const all = document.body.textContent;
    const start = all.indexOf(text);
    if (start < 0) throw new Error('选中文字不能映射回正文');
    const end = start + text.length;
    const result = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node, base = 0;
    while ((node = walker.nextNode())) {
      const limit = base + node.textContent.length;
      if (limit > start && base < end) {
        const range = document.createRange();
        range.setStart(node, Math.max(0, start - base));
        range.setEnd(node, Math.min(node.textContent.length, end - base));
        for (const rect of range.getClientRects()) {
          const x = Math.max(viewport.x, frameBox.x + rect.x), y = Math.max(viewport.y, frameBox.y + rect.y);
          const right = Math.min(viewport.x + viewport.width, frameBox.x + rect.right), bottom = Math.min(viewport.y + viewport.height, frameBox.y + rect.bottom);
          if (right - x > .1 && bottom - y > .1) result.push({ x, y, width: right - x, height: bottom - y });
        }
      }
      base = limit;
    }
    return { rects: result, nativeEmpty: !document.getSelection()?.toString() };
  }, { text, viewport, frameBox });
  const actual = await page.locator('.reader-selection-rect').evaluateAll(elements => elements.map(element => {
    const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  }));
  assert.ok(actual.length && reference.rects.length, stage + '应绘制当前页可见选区');
  const overlaps = [];
  for (let i = 0; i < actual.length; i++) for (let j = i + 1; j < actual.length; j++) {
    const overlap = intersection(actual[i], actual[j]);
    if (overlap && overlap.width > 1 && overlap.height > 1) overlaps.push({ first: i, second: j, area: overlap.width * overlap.height, width: overlap.width, height: overlap.height });
  }
  const referenceExpanded = reference.rects.map(r => ({ x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2 }));
  let extraArea = 0;
  for (const rect of actual) extraArea += Math.max(0, rect.width * rect.height - area(referenceExpanded.map(item => intersection(rect, item)).filter(Boolean)));
  const actualExpanded = actual.map(r => ({ x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2 }));
  let missingArea = 0;
  for (const rect of reference.rects) missingArea += Math.max(0, rect.width * rect.height - area(actualExpanded.map(item => intersection(rect, item)).filter(Boolean)));
  const maximumTextHeight = Math.max(...reference.rects.map(rect => rect.height));
  const tooTall = actual.filter(rect => rect.height > maximumTextHeight * 1.35 + 1);
  const handleCount = await page.locator('.selection-handle').count();
  const measurement = { stage, overlayCount: actual.length, leafRectCount: reference.rects.length, overlapCount: overlaps.length, overlapExamples: overlaps.slice(0, 5), extraArea, missingArea, maximumTextHeight, tooTall: tooTall.slice(0, 5), handleCount, nativeEmpty: reference.nativeEmpty };
  measurements.push(measurement);
  if (stage === '跨段选中') await page.screenshot({ path: join(artifacts, 'reader-selection.png') });
  if (stage === '跨页扩展后') await page.screenshot({ path: join(artifacts, 'reader-selection-cross-page.png') });
  assert.equal(overlaps.length, 0, stage + '高亮矩形之间不得有重复叠加的面积');
  assert.ok(extraArea < 2, stage + '不得高亮段落空白、缩进或行间空白，额外面积=' + extraArea);
  assert.ok(missingArea < 2, stage + '不得漏画选中文字，遗漏面积=' + missingArea);
  assert.equal(tooTall.length, 0, stage + '不得绘制跨多行的段落容器背景');
  assert.equal(handleCount, 2, stage + '仅显示首尾两个选区手柄');
  assert.ok(reference.nativeEmpty, stage + '不应叠加浏览器原生选区');
}

try {
  step('launch');
  app = await electron.launch({ executablePath: electronPath, args: ['app/main.cjs'], env, timeout: 30000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1700, 1200));
  page = await app.firstWindow({ timeout: 15000 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await importAndOpenBook(app, page, sample);
  await frameWithText();
  await page.locator('.reader-loading').waitFor({ state: 'hidden' });
  bookId = (await page.evaluate(() => window.readerApi.listBooks()))[0].id;
  for (let i = 0; i < 7; i++) await changeFont(page, 1);
  await closeTools(page);
  await page.waitForTimeout(400);
  const start = await word('SelectionStart'), end = await word('SelectionEnd');
  const frame = await frameWithText();
  let expected = await frame.evaluate(({ start, end }) => document.body.textContent.slice(start, end), { start: start.start, end: end.end });
  step('跨多行和段落拖选');
  await dragBetween(start, end);
  await checkGeometry('跨段选中', expected);
  checks.push('嵌套行内元素、缩进、显式换行和跨段选中不重复绘制高亮');

  step('调整终点');
  const adjusted = await word('AdjustedEnd');
  await page.getByRole('button', { name: '调整终点', exact: true }).click();
  await page.mouse.click(adjusted.x, adjusted.y);
  expected = await frame.evaluate(({ start, end }) => document.body.textContent.slice(start, end), { start: start.start, end: adjusted.end });
  await checkGeometry('调整终点后', expected);
  checks.push('调整选区终点后高亮仍只覆盖文字且不叠加');

  step('字号变化');
  await changeFont(page, -1);
  await closeTools(page);
  await page.waitForTimeout(350);
  // A font change may preserve or dismiss the draft. Either way its rectangles
  // must match the new layout, without stale geometry from the old font size.
  if (!(await page.locator('.reader-selection-summary').count())) {
    assert.equal(await page.locator('.reader-selection-rect').count(), 0, '字号变化取消选区后不得残留旧高亮');
    assert.equal(await page.locator('.selection-handle').count(), 0, '取消后不得残留选区手柄');
    await dragBetween(await word('SelectionStart'), await word('AdjustedEnd'));
  }
  await checkGeometry('字号变化后', expected);
  checks.push('字号变化后跨段选择无旧高亮残留或重复绘制');

  step('跨页继续选择');
  const previousPage = await page.locator('.reader-page-position').innerText();
  await turnPage(page, 1);
  await page.waitForFunction(previous => document.querySelector('.reader-page-position')?.textContent !== previous, previousPage);
  assert.equal(await selectedText(), expected, '翻页前后的逻辑选区应保留');
  await page.waitForTimeout(200);
  const nextEnd = (await visibleWords())[12];
  assert.ok(nextEnd && nextEnd.end > adjusted.end, '下一页应提供更后的终点');
  await page.getByRole('button', { name: '调整终点', exact: true }).click();
  await page.mouse.click(nextEnd.x, nextEnd.y);
  expected = await (await frameWithText()).evaluate(({ start, end }) => document.body.textContent.slice(start, end), { start: start.start, end: nextEnd.end });
  await checkGeometry('跨页扩展后', expected);
  checks.push('跨页保留并扩展选区后可见高亮不叠加');
  assert.equal((await page.evaluate(id => window.readerApi.listEntries(id), bookId)).length, 0, '选区操作不应自动收录');
  assert.deepEqual(errors, []);
  await writeFile(join(artifacts, 'reader-selection-result.json'), JSON.stringify({ passed: true, checks, measurements, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, measurements, errors }, null, 2));
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: join(artifacts, 'reader-selection-failure.png') }).catch(() => {});
  await writeFile(join(artifacts, 'reader-selection-result.json'), JSON.stringify({ passed: false, checks, measurements, errors, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally { if (app) await app.close(); }
