import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createJapaneseSampleBook, japaneseSample } from './create-japanese-sample.mjs';
import { closeTools, importAndOpenBook, openBookFromShelf, openNotebook, openTools } from './reader-test-ui.mjs';
import { packageExecutablePath } from './package-paths.mjs';

const artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'yuejian-language-recovery-'));
const userData = join(temporary, 'data');
const sample = await createJapaneseSampleBook(join(temporary, 'japanese.epub'));
const input = process.argv[2];
const executablePath = input ? packageExecutablePath(input) : electronPath;
const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const env = { ...process.env, APP_TEST_MODE: '1', READER_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const checks = [], errors = [], requests = [];
const startedAt = new Date().toISOString();
let app, page, bookId, runtime;
const books = () => page.evaluate(() => window.readerApi.listBooks());
const occurrences = async () => (await page.evaluate(id => window.readerApi.listEntries(id), bookId)).flatMap(entry => entry.occurrences);
async function waitFor(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error('语言恢复检查等待超时');
}
async function launch() {
  app = await electron.launch({ executablePath, args: input ? [] : ['app/main.cjs'], env, timeout: 30000 });
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), userData);
  runtime = await app.evaluate(({ app }) => ({ version: app.getVersion(), platform: process.platform, arch: process.arch }));
  if (input) assert.equal(runtime.version, metadata.version);
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '书架', exact: true }).waitFor();
}
async function frame() {
  return waitFor(async () => {
    for (const candidate of page.frames().filter(item => item !== page.mainFrame())) {
      if (await candidate.locator('#ruby-sentence').count().catch(() => 0)) return candidate;
    }
    return null;
  });
}
async function drag(text, selector) {
  const source = await frame();
  const points = await source.evaluate(({ text, selector }) => {
    const root = document.querySelector(selector);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node, prose = '';
    const runs = [];
    while ((node = walker.nextNode())) {
      if (node.parentElement.closest('rt,rp')) continue;
      runs.push({ node, start: prose.length, end: prose.length + node.length });
      prose += node.textContent;
    }
    const start = prose.indexOf(text), end = start + text.length;
    if (start < 0) throw new Error('缺少测试文字');
    const a = runs.find(run => run.start <= start && run.end > start);
    const b = runs.find(run => run.start < end && run.end >= end);
    const first = document.createRange(), last = document.createRange();
    first.setStart(a.node, start - a.start); first.setEnd(a.node, start - a.start + 1);
    last.setStart(b.node, end - b.start - 1); last.setEnd(b.node, end - b.start);
    const left = first.getBoundingClientRect(), right = last.getBoundingClientRect();
    return { x1: left.left + .25, y1: left.top + left.height / 2, x2: right.right - .25, y2: right.top + right.height / 2 };
  }, { text, selector });
  const box = await (await source.frameElement()).boundingBox();
  await page.mouse.move(box.x + points.x1, box.y + points.y1);
  await page.mouse.down();
  const moving = page.mouse.move(box.x + points.x2, box.y + points.y2);
  await new Promise(done => setTimeout(done, 120));
  await page.mouse.up(); await moving;
  await page.locator('.reader-selection-summary').getByRole('button', { name: '收录', exact: true }).click();
}
async function show(item) {
  await openNotebook(page);
  const entry = (await page.evaluate(id => window.readerApi.listEntries(id), bookId)).find(entry => entry.occurrences.some(value => value.id === item.id));
  const heading = page.getByTestId('entry-' + entry.id).locator('.entry-heading');
  if (await heading.getAttribute('aria-expanded') !== 'true') await heading.click();
  const card = page.getByTestId('occurrence-' + item.id);
  await card.waitFor(); return card;
}
try {
  await launch();
  await importAndOpenBook(app, page, sample, japaneseSample.title);
  bookId = (await books())[0].id;
  await openTools(page);
  await page.getByRole('button', { name: '主题与设置', exact: true }).click();
  await page.getByLabel('LANGUAGE', { exact: true }).selectOption('en');
  await waitFor(async () => (await books())[0].language === 'en');
  await page.waitForFunction(() => document.querySelector('#book-language')?.value === 'en' && !document.querySelector('#book-language').disabled);
  await page.getByRole('button', { name: '关闭阅读设置', exact: true }).click();
  await closeTools(page);
  await drag('物語', '#word-line');
  await waitFor(async () => (await occurrences()).length === 1);
  await drag(japaneseSample.sentence, '#ruby-sentence');
  await waitFor(async () => (await occurrences()).length === 2);
  await drag('部屋', '#word-line');
  await waitFor(async () => (await occurrences()).length === 3);
  await app.close(); app = null;

  // Construct only this isolated fixture as it appeared before language support.
  const database = new DatabaseSync(join(userData, 'reader.sqlite'));
  let failedWord, failedSentence, preserved;
  try {
    const book = JSON.parse(database.prepare('SELECT data FROM books WHERE id=?').get(bookId).data);
    book.language = 'en'; book.languageSource = 'legacy';
    database.prepare('UPDATE books SET data=? WHERE id=?').run(JSON.stringify(book), bookId);
    for (const row of database.prepare('SELECT id,data FROM occurrences').all()) {
      const occurrence = JSON.parse(row.data);
      occurrence.language = 'en'; occurrence.error = '解析结果缺少有效的英文解释，请重试。'; occurrence.status = 'failed';
      if (occurrence.selectedText === '部屋') {
        occurrence.status = 'completed'; occurrence.error = null;
        occurrence.analysis = { kind: 'word', targetText: occurrence.selectedText, meaningZh: '原有释义保留', definitionEn: 'An existing completed explanation.', usage: '旧用法', example: 'Old example.' };
        preserved = occurrence;
      } else if (occurrence.selectedText === '物語') failedWord = occurrence;
      else failedSentence = occurrence;
      database.prepare('UPDATE occurrences SET data=?,status=?,attempts=3 WHERE id=?').run(JSON.stringify(occurrence), occurrence.status, row.id);
    }
  } finally { database.close(); }
  assert.ok(failedWord && failedSentence && preserved);
  assert.ok(failedSentence.selectedText.includes('としょかん'));

  await launch();
  const upgraded = (await books())[0];
  assert.equal(upgraded.id, bookId);
  assert.equal(upgraded.language, 'ja'); assert.equal(upgraded.languageSource, 'metadata');
  assert.deepEqual((await occurrences()).find(item => item.id === preserved.id), preserved);
  assert.equal((await occurrences()).find(item => item.id === failedWord.id).language, 'en');
  checks.push('旧日文书从 legacy/en 升级为 ja，保留已完成释义和旧任务，启动不自动重译');
  await openBookFromShelf(page, japaneseSample.title);
  await app.evaluate(() => {
    globalThis.__recoveryFetch = globalThis.fetch;
    globalThis.__recoveryRequests = [];
    globalThis.fetch = async (url, init) => {
      if (String(url) !== 'https://api.deepseek.com/chat/completions') throw new Error('测试禁止外部请求');
      const payload = JSON.parse(init.body);
      const source = JSON.parse(payload.messages[1].content);
      if (source.sourceLanguage !== 'ja') throw new Error('恢复任务必须使用日语请求');
      globalThis.__recoveryRequests.push(source);
      const value = source.kind === 'sentence'
        ? { kind: 'sentence', targetText: source.selection, meaningZh: '今天我在图书馆读了书。' }
        : { kind: 'word', targetText: source.selection, meaningZh: '故事；叙事作品。', reading: 'ものがたり', usage: '名词，作読む的宾语。', example: '短い物語を読みます。' };
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }), { status: 200 });
    };
  });
  await page.evaluate(() => window.readerApi.saveSettings({ apiKey: 'sk-recovery-synthetic-test-only' }));
  for (const original of [failedWord, failedSentence]) {
    const card = await show(original);
    await card.getByRole('button', { name: '重新解析', exact: true }).click();
    const restored = await waitFor(async () => (await occurrences()).find(item => item.id === original.id && item.status === 'completed'));
    assert.equal(restored.language, 'ja'); assert.equal(restored.collectedAt, original.collectedAt);
    assert.equal(restored.originalAnchor.cfi, original.originalAnchor.cfi);
    assert.ok(!restored.context.includes('としょかん'));
    assert.equal(restored.analysis.definitionEn, undefined);
    const currentCard = await show(restored);
    await currentCard.locator('.meaning-zh').waitFor();
    if (original.id === failedWord.id) {
      assert.ok(restored.anchor.startOffset < original.anchor.startOffset, 'ruby 前文应重新计算偏移');
      await currentCard.locator('.entry-reading').waitFor();
    } else {
      assert.equal(restored.kind, 'sentence'); assert.equal(restored.selectedText, japaneseSample.sentence);
      assert.deepEqual(Object.keys(restored.analysis).sort(), ['kind', 'meaningZh', 'targetText']);
    }
    await currentCard.getByRole('button', { name: '返回原文', exact: true }).click();
    await page.locator('.reader-focus-rect').first().waitFor({ state: 'attached' });
  }
  checks.push('真实点击失败项重新解析，经原 CFI 重建 ruby 前后偏移与原文，日语词和整句都不要求英文解释');
  assert.deepEqual((await occurrences()).find(item => item.id === preserved.id), preserved);
  await page.evaluate(() => window.readerApi.saveSettings({ apiKey: '' }));
  requests.push(...await app.evaluate(() => {
    globalThis.fetch = globalThis.__recoveryFetch;
    return globalThis.__recoveryRequests;
  }));
  assert.equal(requests.length, 2);
  assert.ok(requests.every(item => item.sourceLanguage === 'ja' && !item.context.includes('としょかん')));
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('.app-error').count(), 0);
  await page.screenshot({ path: join(artifacts, 'language-recovery-source.png'), animations: 'disabled' });
  await writeFile(join(artifacts, 'language-recovery-result.json'), JSON.stringify({ passed: true, version: metadata.version, runtime, startedAt, recordedAt: new Date().toISOString(), checks, errors, requests }, null, 2));
  console.log(JSON.stringify({ passed: true, runtime, checks, errors }, null, 2));
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: join(artifacts, 'language-recovery-failure.png') }).catch(() => {});
  await writeFile(join(artifacts, 'language-recovery-result.json'), JSON.stringify({ passed: false, version: metadata.version, runtime, startedAt, checks, errors, message: String(error) }, null, 2));
  process.exitCode = 1;
} finally { if (app) await app.close(); }
