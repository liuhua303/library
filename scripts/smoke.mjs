import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createSampleBook } from './create-sample.mjs';
import { closeNotebook, importAndOpenBook, openBookFromShelf, openNotebook, turnPage } from './reader-test-ui.mjs';

const artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const userData = await mkdtemp(join(tmpdir(), 'yuejian-smoke-'));
const sample = await createSampleBook(join(userData, 'sample.epub'));
const env = { ...process.env, APP_TEST_MODE: '1', READER_USER_DATA: join(userData, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
let app;
const failures = [];
const checks = [];
async function launch() {
  app = await electron.launch({ executablePath: electronPath, args: ['app/main.cjs'], env, timeout: 30000 });
  app.process().stderr?.on('data', chunk => process.stderr.write(chunk));
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('console', message => { if (message.type() === 'error') console.error('renderer:', message.text()); });
  page.on('pageerror', error => failures.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  return page;
}
async function readingFrame(page) {
  await page.getByTestId('epub-viewport').locator('iframe').first().waitFor({ timeout: 20000 });
  for (let count = 0; count < 100; count++) {
    for (const frame of page.frames().filter(frame => frame !== page.mainFrame())) {
      if ((await frame.locator('body').textContent().catch(() => ''))?.includes('Clara')) return frame;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('EPUB 正文未渲染');
}
async function wordPosition(page, frame, word, end = false) {
  const position = await frame.evaluate(({ word, end }) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const offset = node.textContent.indexOf(word);
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset + (end ? word.length - 1 : 0));
      range.setEnd(node, offset + (end ? word.length : 1));
      const rect = range.getBoundingClientRect();
      if (rect.x >= 0 && rect.right <= innerWidth && rect.y >= 0 && rect.bottom <= innerHeight) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    throw new Error(`可见页没有 ${word}`);
  }, { word, end });
  const iframe = await frame.frameElement();
  const box = await iframe.boundingBox();
  return { x: box.x + position.x, y: box.y + position.y };
}
try {
  let page = await launch();
  await page.getByRole('button', { name: '导入 EPUB', exact: true }).first().waitFor();
  await page.screenshot({ path: join(artifacts, 'empty-library.png') });
  await importAndOpenBook(app, page, sample);
  let frame = await readingFrame(page);
  checks.push('真实 EPUB 导入并分页渲染');
  const position = await wordPosition(page, frame, 'peculiar');
  await page.evaluate(() => {
    const viewport = document.querySelector('[data-testid="epub-viewport"]');
    const frame = viewport.querySelector('iframe');
    let began = 0;
    frame.contentDocument.addEventListener('pointerdown', () => { began = performance.now(); }, { once: true, capture: true });
    const observer = new MutationObserver(() => {
      if (began && viewport.querySelector('[data-testid="reader-mark"]')) {
        window.__feedbackMs = performance.now() - began;
        observer.disconnect();
      }
    });
    observer.observe(viewport, { childList: true, subtree: true });
  });
  await page.mouse.click(position.x, position.y);
  await page.waitForFunction(async () => {
    const books = await window.readerApi.listBooks();
    const entries = await window.readerApi.listEntries(books[0].id);
    return entries.some(entry => entry.term === 'peculiar');
  });
  const book = (await page.evaluate(() => window.readerApi.listBooks()))[0];
  let entries = await page.evaluate(id => window.readerApi.listEntries(id), book.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].occurrences.length, 1);
  await page.waitForFunction(() => typeof window.__feedbackMs === 'number');
  const feedbackMs = await page.evaluate(() => window.__feedbackMs);
  assert.ok(feedbackMs < 200, `收录下划线反馈 ${feedbackMs}ms 应小于200ms`);
  checks.push('单击收录且无 API 密钥仍可保存');
  await openNotebook(page);
  await page.getByTestId('vocabulary-sidebar').getByText('peculiar', { exact: true }).first().waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(artifacts, 'reader-with-notebook.png') });
  checks.push('右侧书籍单词本');
  await closeNotebook(page);
  await app.evaluate(() => {
    let call = 0;
    globalThis.fetch = async () => {
      const targetText = call++ === 0 ? 'peculiar' : 'give up';
      const result = { kind: targetText === 'give up' ? 'phrase' : 'word', targetText, meaningZh: targetText === 'give up' ? '放弃；在这里指停止寻找。' : '奇特的；在这里形容房间里不同寻常的寂静。', definitionEn: 'Unusual or distinctive in this context.', usage: '结合当前原句理解该表达。', example: 'She did not give up reading.' };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  });
  await page.evaluate(() => window.readerApi.saveSettings({ apiKey: 'sk-local-smoke-test-only' }));
  await page.waitForFunction(async id => (await window.readerApi.listEntries(id)).some(entry => entry.occurrences.some(item => item.status === 'completed')), book.id);
  frame = await readingFrame(page);
  const give = await wordPosition(page, frame, 'give');
  await page.mouse.click(give.x, give.y);
  await page.waitForFunction(async id => (await window.readerApi.listEntries(id)).some(entry => entry.term === 'give up' && entry.occurrences[0].status === 'completed'), book.id);
  await page.waitForFunction(async id => {
    const entry = (await window.readerApi.listEntries(id)).find(entry => entry.term === 'give up');
    return entry && entry.occurrences[0].anchor.endOffset - entry.occurrences[0].anchor.startOffset === 7;
  }, book.id);
  checks.push('模型返回落库及完整短语标记扩展（模拟 API 响应）');
  await openNotebook(page);
  await page.getByTestId('vocabulary-sidebar').getByRole('button', { name: /give up/ }).click();
  await page.getByText('放弃；在这里指停止寻找。', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.configure-notice'));
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(artifacts, 'analysis-result.png') });
  entries = await page.evaluate(id => window.readerApi.listEntries(id), book.id);
  const savedCount = entries.flatMap(entry => entry.occurrences).length;
  const beforeLocation = (await page.evaluate(() => window.readerApi.listBooks()))[0].lastLocation;
  const beforePage = await page.locator('.reader-page-position').innerText();
  await turnPage(page, 1);
  await page.waitForFunction(previous => document.querySelector('.reader-page-position')?.textContent !== previous, beforePage);
  await app.close();
  app = null;
  page = await launch();
  await page.waitForFunction(async () => (await window.readerApi.listBooks()).length === 1);
  const restored = await page.evaluate(id => window.readerApi.listEntries(id), book.id);
  const restoredBook = (await page.evaluate(() => window.readerApi.listBooks()))[0];
  assert.equal(await page.getByTestId('epub-viewport').count(), 0, '重启后首先进入书架');
  assert.ok(restoredBook.lastLocation && restoredBook.lastLocation !== beforeLocation, '翻页后立即关闭也应保存最后位置');
  assert.equal(restored.flatMap(entry => entry.occurrences).length, savedCount);
  assert.ok(restored.every(entry => entry.occurrences.every(item => item.status === 'completed')));
  await openBookFromShelf(page, restoredBook.title);
  await readingFrame(page);
  checks.push('翻页后立即关闭，重启后阅读位置、词条与解析仍然保留');
  assert.deepEqual(failures, [], '渲染进程不得出现未处理错误');
  const result = { passed: true, checks, feedbackMs, userData, runtime: await app.evaluate(() => process.versions) };
  await writeFile(join(artifacts, 'smoke-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error);
  if (app) {
    const windows = app.windows();
    if (windows[0]) {
      await windows[0].screenshot({ path: join(artifacts, 'smoke-failure.png') }).catch(() => {});
      console.error((await windows[0].locator('body').innerText().catch(() => '')).slice(0, 5000));
    }
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
}
