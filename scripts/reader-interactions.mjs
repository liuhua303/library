import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createSampleBook } from './create-sample.mjs';
import { changeFont, closeTools, importAndOpenBook, openNotebook, turnPage } from './reader-test-ui.mjs';

const artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const userData = await mkdtemp(join(tmpdir(), 'yuejian-interactions-'));
const sample = await createSampleBook(join(userData, 'interactions.epub'));
const env = { ...process.env, APP_TEST_MODE: '1', READER_USER_DATA: join(userData, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const checks = [];
const errors = [];
let app;
let page;
let bookId;
function step(name) {
  console.log('reader-interactions: ' + name);
  writeFileSync(join(artifacts, 'reader-interactions-progress.txt'), name);
}

async function entries() {
  return page.evaluate(id => window.readerApi.listEntries(id), bookId);
}

async function frameWithText() {
  for (let attempt = 0; attempt < 150; attempt++) {
    for (const frame of page.frames().filter(item => item !== page.mainFrame())) {
      if ((await frame.locator('body').textContent().catch(() => ''))?.includes('Clara')) return frame;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('没有找到 EPUB 正文 iframe');
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
      for (const match of text.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rect = range.getBoundingClientRect();
        const x = frameBox.x + rect.x;
        const y = frameBox.y + rect.y;
        if (rect.width < 1 || x < viewport.x + 2 || x + rect.width > viewport.x + viewport.width - 2
          || y < viewport.y + 2 || y + rect.height > viewport.y + viewport.height - 2) continue;
        result.push({
          text: match[0], start: base + match.index, end: base + match.index + match[0].length,
          x: x + rect.width / 2, y: y + rect.height / 2,
          before: { x: x + 0.25, y: y + rect.height / 2 },
          after: { x: x + rect.width - 0.25, y: y + rect.height / 2 },
        });
      }
      base += text.length;
    }
    return result;
  }, { viewport, frameBox });
}

async function word(name, last = false) {
  const words = (await visibleWords()).filter(item => item.text === name);
  assert.ok(words.length, '当前页没有可见单词 ' + name);
  return last ? words.at(-1) : words[0];
}

async function dragBetween(first, last) {
  await page.mouse.move(first.before.x, first.before.y);
  await page.mouse.down();
  // In hidden Windows Electron, acknowledge the pressed move and release concurrently.
  // Waiting for the move ACK before releasing can enter a Win32 drag feedback loop.
  const moving = page.mouse.move(last.after.x, last.after.y);
  await new Promise(resolve => setTimeout(resolve, 120));
  await page.mouse.up();
  await moving;
  await page.locator('.reader-selection-summary').waitFor();
  await page.waitForTimeout(220);
}

async function selectionText() {
  return page.locator('.reader-selection-summary > span').getAttribute('title');
}

async function dragHandle(edge, destination) {
  const handle = page.getByRole('button', { name: edge === 'start' ? '调整选区起点' : '调整选区终点', exact: true });
  const box = await handle.boundingBox();
  assert.ok(box, '选区手柄可见');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const target = edge === 'start' ? destination.before : destination.after;
  const moving = page.mouse.move(target.x, target.y);
  await new Promise(resolve => setTimeout(resolve, 120));
  await page.mouse.up();
  await moving;
  await page.waitForTimeout(160);
}

try {
  step('launch');
  app = await electron.launch({ executablePath: electronPath, args: ['app/main.cjs'], env, timeout: 30000 });
  step('first window');
  app.process().stderr?.on('data', chunk => process.stderr.write(chunk));
  page = await app.firstWindow({ timeout: 15000 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  await importAndOpenBook(app, page, sample);
  step('imported');
  await frameWithText();
  await page.locator('.reader-loading').waitFor({ state: 'hidden' });
  await page.waitForTimeout(450);
  bookId = (await page.evaluate(() => window.readerApi.listBooks()))[0].id;

  step('controlled pointer selection');
  const initialViewport = await page.getByTestId('epub-viewport').boundingBox();
  await dragBetween(await word('Clara'), await word('bookshop'));
  assert.equal((await page.getByTestId('epub-viewport').boundingBox()).height, initialViewport.height,
    '选区工具条不能改变正文视口高度并触发重排');
  assert.equal((await entries()).length, 0, '拖选不应自动收录');
  assert.ok((await selectionText()).includes('Clara opened the little bookshop'));
  checks.push('真实鼠标拖选保留文本，未确认前不收录');
  checks.push('选区工具条保持固定阅读视口，复制后可立即继续选择');

  const selectedForCopy = await selectionText();
  step('copy');
  await page.locator('.selection-menu').getByRole('button', { name: '复制', exact: true }).click();
  await page.locator('.reader-selection-summary').waitFor({ state: 'hidden' });
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), selectedForCopy, '复制应写入实际系统剪贴板');
  assert.equal((await entries()).length, 0);
  checks.push('复制写入系统剪贴板并取消选区，不误收录');

  step('handles');
  await dragBetween(await word('Clara'), await word('bookshop'));
  await dragHandle('start', await word('opened'));
  assert.ok((await selectionText()).startsWith('opened'), '起点手柄应改变选区起点');
  await dragHandle('end', await word('room'));
  assert.ok((await selectionText()).includes('silence filled the room'), '终点手柄应扩展选区终点');
  checks.push('首尾手柄真实拖动均能调整选择范围');
  await page.getByRole('button', { name: '取消选区', exact: true }).click();
  assert.equal((await entries()).length, 0);

  step('cross page');
  await dragBetween(await word('When'), await word('bookshop'));
  const original = await selectionText();
  const beforePage = await page.locator('.reader-page-position').innerText();
  await turnPage(page, 1);
  await page.waitForFunction(previous => document.querySelector('.reader-page-position')?.textContent !== previous, beforePage);
  await page.waitForTimeout(250);
  assert.equal(await selectionText(), original, '翻页后原始选择必须保留');
  const nextPageWords = await visibleWords();
  assert.ok(nextPageWords.length > 10);
  const newEnd = nextPageWords[8];
  await page.getByRole('button', { name: '调整终点', exact: true }).click();
  await page.mouse.click(newEnd.x, newEnd.y);
  const crossPageText = await selectionText();
  assert.ok(crossPageText.length > original.length + 40, '跨页终点应包含两页之间的文本');
  assert.ok(crossPageText.startsWith('When Clara'));
  assert.ok(crossPageText.trimEnd().endsWith(newEnd.text));
  const selectedPage = await page.locator('.reader-page-position').innerText();
  await page.locator('.reader-selection-summary').getByRole('button', { name: '收录', exact: true }).click();
  await page.waitForFunction(async id => (await window.readerApi.listEntries(id)).length === 1, bookId);
  const occurrence = (await entries())[0].occurrences[0];
  assert.equal(occurrence.selectedText, crossPageText.trim());
  assert.ok(occurrence.anchor.endOffset - occurrence.anchor.startOffset > original.length + 40);
  checks.push('跨页保留选区、在下一页调整终点并完整收录');

  step('view saved selection');
  // Saved text is currently visible on the second page. Its menu should resolve the same occurrence.
  const savedPoint = (await visibleWords()).find(item => item.start >= occurrence.anchor.startOffset && item.end <= occurrence.anchor.endOffset);
  assert.ok(savedPoint);
  await page.mouse.click(savedPoint.x, savedPoint.y);
  // Click immediately after collecting. Selection controls must keep a fixed reading
  // viewport, and any late passive relocation must not dismiss the saved-word menu.
  await page.locator('.selection-menu').getByRole('button', { name: '查看', exact: true }).waitFor();
  await page.waitForTimeout(240);
  assert.equal(await page.locator('.reader-page-position').innerText(), selectedPage,
    '收录并关闭选区工具条后不能改变当前阅读页');
  await page.locator('.selection-menu').getByRole('button', { name: '查看', exact: true }).click();
  await page.getByTestId('occurrence-' + occurrence.id).waitFor();
  checks.push('点击已标记内容通过小菜单在右侧定位对应记录');

  step('jump and font resize');
  const card = page.getByTestId('occurrence-' + occurrence.id);
  await card.getByRole('button', { name: '返回原文', exact: true }).click();
  await page.locator('.reader-focus-rect').first().waitFor({ state: 'attached' });
  assert.equal(await page.locator('.reader-focus-rect').first().evaluate(element => getComputedStyle(element).animationIterationCount), '2');
  await page.waitForTimeout(1000);
  await changeFont(page, 1);
  await closeTools(page);
  await page.waitForTimeout(450);
  await openNotebook(page);
  await card.getByRole('button', { name: '返回原文', exact: true }).click();
  await page.locator('.reader-focus-rect').first().waitFor({ state: 'attached' });
  assert.ok((await visibleWords()).some(item => item.start >= occurrence.anchor.startOffset && item.start < occurrence.anchor.startOffset + 80));
  checks.push('回跳原文闪烁两次，调整字号后仍能定位同一内容');

  step('cancel collection');
  await page.waitForTimeout(1000);
  const cancelPoint = (await visibleWords()).find(item => item.start >= occurrence.anchor.startOffset && item.end <= occurrence.anchor.endOffset);
  assert.ok(cancelPoint);
  await page.mouse.click(cancelPoint.x, cancelPoint.y);
  await page.locator('.selection-menu').getByRole('button', { name: '取消收录', exact: true }).click();
  await page.waitForFunction(async id => (await window.readerApi.listEntries(id)).length === 0, bookId);
  await page.waitForTimeout(200);
  assert.equal(await page.getByTestId('reader-mark').count(), 0);
  checks.push('原文小菜单取消收录并移除下划线及词条');
  assert.deepEqual(errors, [], '真实交互不应出现渲染进程未处理错误');
  await page.screenshot({ path: join(artifacts, 'reader-interactions.png') });
  const result = { passed: true, checks, userData, errors };
  await writeFile(join(artifacts, 'reader-interactions-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  step('passed');
} catch (error) {
  console.error(error);
  if (page) {
    await page.screenshot({ path: join(artifacts, 'reader-interactions-failure.png') }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 4500));
  }
  await writeFile(join(artifacts, 'reader-interactions-result.json'), JSON.stringify({ passed: false, checks, errors, message: String(error), userData }, null, 2));
  process.exitCode = 1;
} finally {
  if (app) await app.close();
}
