import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSampleBook } from './create-sample.mjs';
import { createJapaneseSampleBook, japaneseSample } from './create-japanese-sample.mjs';
import { packageExecutablePath } from './package-paths.mjs';
import { closeNotebook, closeTools, importAndOpenBook, openBookFromShelf, openNotebook, openTools, turnPage } from './reader-test-ui.mjs';

const artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const startedAt = new Date();
const packagedInput = process.env.APP_EXECUTABLE_PATH || process.argv[2];
const executablePath = packagedInput ? packageExecutablePath(packagedInput) : electronPath;
const mode = packagedInput ? 'packaged' : 'development-build';
const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'yuejian-japanese-'));
const dataDirectory = join(temporary, 'data');
const japaneseFile = await createJapaneseSampleBook(join(temporary, 'japanese.epub'));
const englishTitle = 'English language regression';
const englishFile = await createSampleBook(join(temporary, 'english.epub'), { title: englishTitle, identifier: 'yuejian-japanese-english' });
const env = { ...process.env, APP_TEST_MODE: '1', READER_USER_DATA: dataDirectory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const checks = [], errors = [], requests = [], measurements = [];
let app, page, runtime = null, japaneseId, englishId;

const step = value => console.log('japanese-smoke: ' + value);
const report = (passed, message) => ({
  passed, version: metadata.version, runtime, startedAt: startedAt.toISOString(),
  recordedAt: new Date().toISOString(), timeZone: 'Asia/Shanghai', mode,
  executablePath, userData: dataDirectory, checks, errors, requests, measurements,
  ...(message ? { message } : {}),
});

async function launch() {
  app = await electron.launch({ executablePath, args: mode === 'packaged' ? [] : ['app/main.cjs'], env, timeout: 30000 });
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), dataDirectory, '必须隔离真实用户数据');
  runtime = await app.evaluate(({ app }) => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, versions: process.versions }));
  if (mode === 'packaged') assert.equal(runtime.version, metadata.version, '打包运行版本应与源码版本相同');
  page = await app.firstWindow({ timeout: 15000 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '书架', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.readerApi.getSettings())).hasApiKey, false, '不得使用真实密钥');
}

async function book(id) {
  return page.evaluate(id => window.readerApi.listBooks().then(books => books.find(item => item.id === id)), id);
}

async function entries(id = japaneseId) {
  return page.evaluate(id => window.readerApi.listEntries(id), id);
}

async function occurrence(text, id = japaneseId) {
  return (await entries(id)).flatMap(entry => entry.occurrences).find(item => item.selectedText === text);
}

// waitForFunction treats a returned Promise as truthy. Await IPC results in Node
// before deciding whether to poll again, so a false result really keeps waiting.
async function waitForApi(predicate, argument) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await page.evaluate(predicate, argument);
    if (result) return result;
    await page.waitForTimeout(50);
  }
  throw new Error('等待本机数据保存或解析完成超时');
}

async function completed(text, id = japaneseId) {
  await waitForApi(async ({ id, text }) => (await window.readerApi.listEntries(id))
    .flatMap(entry => entry.occurrences).some(item => item.selectedText === text && item.status === 'completed'), { id, text });
  return occurrence(text, id);
}

async function waitBook(id, expected) {
  await waitForApi(async ({ id, expected }) => {
    const found = (await window.readerApi.listBooks()).find(item => item.id === id);
    return found && Object.entries(expected).every(([key, value]) => found[key] === value);
  }, { id, expected });
}

async function readingFrame(marker) {
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const frame of page.frames().filter(item => item !== page.mainFrame())) {
      if ((await frame.locator('body').textContent().catch(() => ''))?.includes(marker)) return frame;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('未找到 EPUB 正文：' + marker);
}

async function settingsDialog() {
  await openTools(page);
  await page.getByRole('button', { name: '主题与设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '主题与设置', exact: true });
  await dialog.waitFor();
  return dialog;
}

async function closeSettings() {
  const dialog = page.getByRole('dialog', { name: '主题与设置', exact: true });
  await dialog.getByRole('button', { name: '关闭阅读设置', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await closeTools(page);
}

async function selectLanguage(language, id = japaneseId) {
  const dialog = await settingsDialog();
  await dialog.locator('#book-language').selectOption(language);
  await waitBook(id, { language, languageSource: 'manual' });
  await page.waitForFunction(language => {
    const select = document.querySelector('#book-language');
    return select?.value === language && !select.disabled;
  }, language);
  assert.equal(await dialog.locator('#book-language').inputValue(), language);
  await closeSettings();
}

async function toShelf() {
  await closeNotebook(page);
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await page.getByRole('heading', { name: '书架', exact: true }).waitFor();
}

async function installMock() {
  await app.evaluate(() => {
    if (globalThis.__japaneseSmokeFetch) throw new Error('重复安装 mock');
    globalThis.__japaneseSmokeFetch = globalThis.fetch;
    globalThis.__japaneseSmokeRequests = [];
    globalThis.fetch = async (input, init) => {
      if (String(input) !== 'https://api.deepseek.com/chat/completions') throw new Error('禁止测试外部网络请求：' + String(input));
      const body = JSON.parse(init.body);
      const context = JSON.parse(body.messages.find(message => message.role === 'user').content);
      globalThis.__japaneseSmokeRequests.push({ selection: context.selection, kind: context.kind, sourceLanguage: context.sourceLanguage ?? 'en', context: context.context, selectedOffset: context.selectedOffset });
      const analysis = context.sourceLanguage === 'ja'
        ? context.kind === 'sentence'
          ? { kind: 'sentence', targetText: context.selection, meaningZh: '今天我在图书馆读了书。' }
          : { kind: context.kind, targetText: context.selection, meaningZh: '在这里指阅读的故事或叙事作品。', reading: 'ものがたり', usage: '名词，在句中作「読む」的宾语。', example: '毎晩、子どもに短い物語を読みます。' }
        : { kind: context.kind, targetText: context.selection, meaningZh: '在这里表示不同寻常、奇特的。', definitionEn: 'Unusual or strange in this situation.', usage: 'An adjective describing the silence in the room.', example: 'A peculiar silence filled the room.' };
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(analysis) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  });
  await page.evaluate(() => window.readerApi.saveSettings({ apiKey: 'sk-japanese-smoke-synthetic-test-only' }));
}

async function clearMock() {
  await page.evaluate(() => window.readerApi.saveSettings({ apiKey: '' }));
  requests.push(...await app.evaluate(() => {
    const captured = globalThis.__japaneseSmokeRequests ?? [];
    if (globalThis.__japaneseSmokeFetch) globalThis.fetch = globalThis.__japaneseSmokeFetch;
    delete globalThis.__japaneseSmokeFetch;
    delete globalThis.__japaneseSmokeRequests;
    return captured;
  }));
  assert.equal((await page.evaluate(() => window.readerApi.getSettings())).hasApiKey, false);
}

// Return glyph edges from a base-text-only DOM index. No synthetic selections or
// collection IPC calls: all collection below uses real Playwright pointer events.
async function pointsForText(frame, needle, selector = 'body') {
  const points = await frame.evaluate(({ needle, selector }) => {
    const root = document.querySelector(selector);
    if (!root) throw new Error('找不到样本节点：' + selector);
    const runs = [];
    let text = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('rt,rp,script,style')) continue;
      runs.push({ node, start: text.length, end: text.length + node.textContent.length });
      text += node.textContent;
    }
    let start = text.indexOf(needle);
    while (start >= 0) {
      const end = start + needle.length;
      const first = runs.find(run => run.start <= start && run.end > start);
      const last = runs.find(run => run.start < end && run.end >= end);
      const glyph = (run, offset) => {
        const range = document.createRange();
        range.setStart(run.node, offset - run.start);
        range.setEnd(run.node, offset - run.start + 1);
        return range.getBoundingClientRect();
      };
      const firstRect = glyph(first, start), lastRect = glyph(last, end - 1);
      const visible = rect => rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
      if (visible(firstRect) && visible(lastRect)) return {
        before: { x: firstRect.left + .25, y: firstRect.top + firstRect.height / 2 },
        after: { x: lastRect.right - .25, y: lastRect.top + lastRect.height / 2 },
        click: { x: firstRect.left + firstRect.width / 2, y: firstRect.top + firstRect.height / 2 },
        lastRight: { x: lastRect.left + lastRect.width * .75, y: lastRect.top + lastRect.height / 2 },
        logicalText: text,
      };
      start = text.indexOf(needle, start + 1);
    }
    throw new Error('当前页未显示测试文本：' + needle);
  }, { needle, selector });
  const frameBox = await (await frame.frameElement()).boundingBox();
  assert.ok(frameBox, 'EPUB iframe 应可见');
  for (const key of ['before', 'after', 'click', 'lastRight']) {
    points[key].x += frameBox.x;
    points[key].y += frameBox.y;
  }
  return points;
}

async function dragText(frame, text, selector) {
  const points = await pointsForText(frame, text, selector);
  await page.mouse.move(points.before.x, points.before.y);
  await page.mouse.down();
  // A pressed move can wait for Win32 drag feedback in a hidden test window.
  const moving = page.mouse.move(points.after.x, points.after.y);
  await new Promise(resolve => setTimeout(resolve, 120));
  await page.mouse.up();
  await moving;
  await page.locator('.reader-selection-summary').waitFor();
  assert.equal(await page.locator('.reader-selection-summary > span').getAttribute('title'), text);
}

async function showOccurrence(item, id = japaneseId) {
  await openNotebook(page);
  const entry = (await entries(id)).find(entry => entry.occurrences.some(occurrence => occurrence.id === item.id));
  assert.ok(entry, '单词本应有此收录');
  const heading = page.getByTestId('entry-' + entry.id).locator('.entry-heading');
  if (await heading.getAttribute('aria-expanded') !== 'true') await heading.click();
  const card = page.getByTestId('occurrence-' + item.id);
  await card.waitFor();
  return card;
}

async function assertJapaneseWord(item) {
  assert.equal(item.language, 'ja');
  assert.equal(item.kind, 'word');
  assert.equal(item.analysis.reading, japaneseSample.reading);
  assert.equal(item.analysis.example, japaneseSample.example);
  assert.ok(item.analysis.meaningZh.includes('故事'));
  assert.equal(item.analysis.definitionEn, undefined);
  assert.ok(!item.context.includes('としょかん') && !item.context.includes('（'), '日语语境必须只含 ruby 基础文字');
  const card = await showOccurrence(item);
  assert.ok((await card.locator('.meaning-zh').innerText()).includes('故事'));
  assert.equal(await card.locator('.entry-reading').getAttribute('lang'), 'ja');
  assert.ok((await card.locator('.entry-reading').innerText()).includes(japaneseSample.reading));
  assert.equal(await card.locator('.definition-en').count(), 0);
  await card.locator('.analysis-details summary').click();
  assert.equal(await card.locator('.analysis-field p[lang="ja"]').innerText(), japaneseSample.example);
  return card;
}

try {
  step('隔离启动、自动识别和手动语言保存');
  await launch();
  await importAndOpenBook(app, page, japaneseFile, japaneseSample.title);
  japaneseId = (await page.evaluate(() => window.readerApi.listBooks())).find(item => item.title === japaneseSample.title).id;
  assert.equal((await book(japaneseId)).language, 'ja');
  assert.equal((await book(japaneseId)).languageSource, 'metadata');
  await readingFrame('今日は');
  let dialog = await settingsDialog();
  assert.equal(await dialog.locator('#book-language').inputValue(), 'ja');
  await page.screenshot({ path: join(artifacts, 'japanese-language.png'), animations: 'disabled' });
  await closeSettings();
  await selectLanguage('en');
  await toShelf();
  await openBookFromShelf(page, japaneseSample.title);
  dialog = await settingsDialog();
  assert.equal(await dialog.locator('#book-language').inputValue(), 'en', '重新打开书籍应恢复手动语言');
  await closeSettings();
  await selectLanguage('ja');
  checks.push('ja-JP 元数据自动识别日语；设置中切换英语、重开保留，再切回日语');

  step('真实点击无空格日语词语和日语释义展示');
  await installMock();
  const frame = await readingFrame('今日は');
  const wordPoints = await pointsForText(frame, japaneseSample.word, '#word-line');
  // The last glyph's right half yields a caret at the following segment. This
  // catches a boundary hit being mistaken for a click on blank paper.
  await page.mouse.click(wordPoints.lastRight.x, wordPoints.lastRight.y);
  const word = await completed(japaneseSample.word);
  let card = await assertJapaneseWord(word);
  await card.locator('.source-details summary').click();
  assert.equal(await card.locator('.source-context').getAttribute('lang'), 'ja');
  assert.equal(await card.locator('.source-context mark').innerText(), japaneseSample.word);
  await page.screenshot({ path: join(artifacts, 'japanese-word.png'), animations: 'disabled' });
  await closeNotebook(page);
  const themeDialog = await settingsDialog();
  await themeDialog.getByRole('button', { name: '静谧主题', exact: true }).click();
  await waitBook(japaneseId, { theme: 'quiet' });
  await closeSettings();
  card = await showOccurrence(word);
  const quiet = await card.locator('.entry-reading').evaluate(element => {
    const panel = element.closest('.vocabulary-sidebar');
    const style = getComputedStyle(element);
    return { background: getComputedStyle(panel).backgroundColor, color: style.color, opacity: style.opacity, filter: style.filter, textShadow: style.textShadow };
  });
  assert.deepEqual(quiet, { background: 'rgb(75, 75, 78)', color: 'rgb(197, 196, 192)', opacity: '1', filter: 'none', textShadow: 'none' });
  measurements.push({ japaneseReadingQuiet: quiet });
  await page.screenshot({ path: join(artifacts, 'japanese-quiet.png'), animations: 'disabled' });
  await closeNotebook(page);
  await page.locator(`[data-testid="reader-mark"][data-occurrence-id="${word.id}"]`).first().waitFor();
  checks.push('真实点击无空格日语词末字右半侧，按 ja 收录；展示中文义、假名、日文例句，无英文解释');
  checks.push('日语读音在 Quiet 单词本使用对应深色面板和清晰的实色文字，无模糊滤镜或文字阴影');

  step('跨 ruby 真实拖选整句和原文回跳');
  await dragText(await readingFrame('今日は'), japaneseSample.sentence, '#ruby-sentence');
  assert.equal((await entries()).flatMap(entry => entry.occurrences).length, 1, '拖选确认前不应收录');
  await page.locator('.reader-selection-summary').getByRole('button', { name: '收录', exact: true }).click();
  const sentence = await completed(japaneseSample.sentence);
  assert.equal(sentence.language, 'ja');
  assert.equal(sentence.kind, 'sentence');
  assert.equal(sentence.selectedText, japaneseSample.sentence);
  assert.equal(sentence.anchor.endOffset - sentence.anchor.startOffset, japaneseSample.sentence.length);
  assert.ok(!sentence.context.includes('としょかん'));
  assert.deepEqual(Object.keys(sentence.analysis).sort(), ['kind', 'meaningZh', 'targetText']);
  assert.equal(sentence.analysis.meaningZh, '今天我在图书馆读了书。');
  card = await showOccurrence(sentence);
  assert.equal(await card.locator('.meaning-zh').innerText(), sentence.analysis.meaningZh);
  assert.equal(await card.locator('.entry-reading, .definition-en, .analysis-details').count(), 0);
  await card.getByRole('button', { name: '返回原文', exact: true }).click();
  await page.getByTestId('vocabulary-sidebar').waitFor({ state: 'hidden' });
  await page.locator('.reader-focus-rect').first().waitFor({ state: 'attached' });
  await page.locator(`[data-testid="reader-mark"][data-occurrence-id="${sentence.id}"]`).first().waitFor();
  await page.screenshot({ path: join(artifacts, 'japanese-sentence-source.png'), animations: 'disabled' });
  const markedPoints = await pointsForText(await readingFrame('今日は'), '図書館', '#ruby-sentence');
  await page.mouse.click(markedPoints.click.x, markedPoints.click.y);
  await page.locator('.selection-menu').getByRole('button', { name: '查看', exact: true }).click();
  await page.getByTestId('occurrence-' + sentence.id).waitFor();
  await closeNotebook(page);
  checks.push('跨 ruby 拖选整句不混入 rt/rp，整句只显示中文翻译；标记可查看并返回原文');

  step('旧释义语言快照、阅读位置和重启恢复');
  const beforeLanguageChange = await entries();
  await selectLanguage('en');
  assert.deepEqual(await entries(), beforeLanguageChange, '切换语言不得改变已有日语释义');
  await selectLanguage('ja');
  await clearMock();
  const positionBefore = (await book(japaneseId)).lastLocation;
  await turnPage(page, 1);
  await waitForApi(async ({ id, previous }) => {
    const found = (await window.readerApi.listBooks()).find(item => item.id === id);
    return found?.lastLocation && found.lastLocation !== previous && found.progress > 0;
  }, { id: japaneseId, previous: positionBefore });
  const saved = await book(japaneseId);
  assert.ok(saved.progress > 0);
  const savedEntries = await entries();
  measurements.push({ savedLocation: saved.lastLocation, savedProgress: saved.progress, japaneseWord: word.selectedText, japaneseSentence: sentence.selectedText });
  await toShelf();
  await app.close(); app = null;
  await launch();
  assert.deepEqual(await entries(), savedEntries, '重启应保留语言快照、读音和释义字段');
  assert.equal((await book(japaneseId)).language, 'ja');
  assert.equal((await book(japaneseId)).lastLocation, saved.lastLocation);
  await openBookFromShelf(page, japaneseSample.title);
  await readingFrame('読書の記録');
  await page.waitForTimeout(400);
  assert.equal((await book(japaneseId)).lastLocation, saved.lastLocation, '打开后续读位置应保持');
  card = await assertJapaneseWord(await occurrence(japaneseSample.word));
  await page.screenshot({ path: join(artifacts, 'japanese-restored.png'), animations: 'disabled' });
  await card.getByRole('button', { name: '返回原文', exact: true }).click();
  await page.locator('.reader-focus-rect').first().waitFor({ state: 'attached' });
  await pointsForText(await readingFrame('今日は'), japaneseSample.word, '#word-line');
  checks.push('切换书籍语言保留已有释义；重启恢复日语字段、语言和阅读位置，原文仍可回跳');

  step('英文导入和英文解析回归');
  const japanesePreserved = await entries();
  await toShelf();
  await importAndOpenBook(app, page, englishFile, englishTitle);
  englishId = (await page.evaluate(() => window.readerApi.listBooks())).find(item => item.title === englishTitle).id;
  assert.equal((await book(englishId)).language, 'en');
  await installMock();
  const englishPoints = await pointsForText(await readingFrame('Clara'), 'peculiar');
  await page.mouse.click(englishPoints.click.x, englishPoints.click.y);
  const english = await completed('peculiar', englishId);
  assert.equal(english.language, 'en');
  assert.equal(english.kind, 'word');
  assert.equal(english.analysis.definitionEn, 'Unusual or strange in this situation.');
  assert.equal(english.analysis.reading, undefined);
  const englishCard = await showOccurrence(english, englishId);
  assert.equal(await englishCard.locator('.definition-en').innerText(), english.analysis.definitionEn);
  assert.equal(await englishCard.locator('.entry-reading').count(), 0);
  assert.deepEqual(await entries(japaneseId), japanesePreserved, '英文收录不得重写已有日语释义');
  await page.screenshot({ path: join(artifacts, 'japanese-english-regression.png'), animations: 'disabled' });
  await clearMock();
  assert.equal(requests.length, 3, '仅进行两个日语和一个英文模拟请求');
  assert.deepEqual(requests.map(request => request.sourceLanguage), ['ja', 'ja', 'en']);
  assert.equal(requests[0].selection, japaneseSample.word);
  assert.equal(requests[1].selection, japaneseSample.sentence);
  assert.ok(requests.filter(request => request.sourceLanguage === 'ja').every(request => !request.context.includes('としょかん')));
  checks.push('英文书仍按 en 收录并保留 definitionEn；日语和英语请求分流，已有日语释义保持');
  assert.deepEqual(errors, [], '不应出现渲染器异常');
  assert.equal(await page.locator('.app-error').count(), 0);
  await writeFile(join(artifacts, 'japanese-result.json'), JSON.stringify(report(true), null, 2));
  console.log(JSON.stringify({ passed: true, runtime, checks, errors }, null, 2));
} catch (error) {
  console.error(error);
  if (page) {
    await page.screenshot({ path: join(artifacts, 'japanese-failure.png'), animations: 'disabled' }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 4000));
  }
  await writeFile(join(artifacts, 'japanese-result.json'), JSON.stringify(report(false, String(error)), null, 2));
  process.exitCode = 1;
} finally { if (app) await app.close(); }
