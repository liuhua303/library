import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSampleBook } from './create-sample.mjs';
import { closeNotebook, importAndOpenBook, openBookFromShelf, openNotebook, openToc, openTools, turnPage } from './reader-test-ui.mjs';

const artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const startedAt = new Date();
const mode = process.argv[2] ? 'packaged' : 'development-build';
const executablePath = process.argv[2] ? resolve(process.argv[2]) : electronPath;
const temporary = await mkdtemp(join(tmpdir(), 'yuejian-immersive-'));
const dataDirectory = join(temporary, 'data');
const title = '沉浸阅读交互验收';
const sample = await createSampleBook(join(temporary, 'immersive.epub'), { title, identifier: 'yuejian-immersive-smoke' });
const secondTitle = '第二本焦点边框验收';
const secondSample = await createSampleBook(join(temporary, 'focus-second.epub'), { title: secondTitle, identifier: 'yuejian-focus-second', alternate: true });
const env = { ...process.env, APP_TEST_MODE: '1', READER_USER_DATA: dataDirectory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const checks = [], measurements = [], errors = [];
let app, page, bookId, runtimeAppVersion = null;
const step = name => console.log('immersive-reading: ' + name);
const report = (passed, message) => ({
  passed, version: packageMetadata.version, runtimeAppVersion,
  startedAt: startedAt.toISOString(), recordedAt: new Date().toISOString(), timeZone: 'Asia/Shanghai',
  mode, executablePath, checks, measurements, errors, userData: dataDirectory,
  ...(message ? { message } : {}),
});

async function launch() {
  app = await electron.launch({ executablePath, args: mode === 'packaged' ? [] : ['app/main.cjs'], env, timeout: 30000 });
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), dataDirectory);
  runtimeAppVersion = await app.evaluate(({ app }) => app.getVersion());
  if (mode === 'packaged') assert.equal(runtimeAppVersion, packageMetadata.version, '运行的安装包版本应与项目版本一致');
  page = await app.firstWindow({ timeout: 15000 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '书架', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.readerApi.getSettings())).hasApiKey, false, '必须使用没有真实密钥的隔离目录');
}

async function readingFrame() {
  for (let attempt = 0; attempt < 120; attempt++) {
    for (const frame of page.frames().filter(item => item !== page.mainFrame())) {
      if ((await frame.locator('body').textContent().catch(() => ''))?.includes('Clara')) return frame;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('没有找到自编 EPUB 正文');
}

async function savedBook() {
  return page.evaluate(id => window.readerApi.listBooks().then(books => books.find(book => book.id === id)), bookId);
}

async function occurrences() {
  return page.evaluate(id => window.readerApi.listEntries(id).then(entries => entries.flatMap(entry => entry.occurrences)), bookId);
}

async function visibleWords() {
  const frame = await readingFrame();
  const viewport = await page.getByTestId('epub-viewport').boundingBox();
  const frameBox = await (await frame.frameElement()).boundingBox();
  return frame.evaluate(({ viewport, frameBox }) => {
    const result = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node, base = 0;
    while ((node = walker.nextNode())) {
      for (const match of node.textContent.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)) {
        const range = document.createRange();
        range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
        const rect = range.getBoundingClientRect(), left = frameBox.x + rect.x, top = frameBox.y + rect.y;
        if (rect.width < 1 || left < viewport.x + 1 || top < viewport.y + 1
          || left + rect.width > viewport.x + viewport.width - 1 || top + rect.height > viewport.y + viewport.height - 1) continue;
        result.push({ text: match[0], start: base + match.index, end: base + match.index + match[0].length,
          left, top, width: rect.width, height: rect.height,
          x: left + rect.width / 2, y: top + rect.height / 2 });
      }
      base += node.textContent.length;
    }
    return result;
  }, { viewport, frameBox });
}

async function snapshot() {
  const words = await visibleWords();
  assert.ok(words.length >= 25, '应测量至少 25 个真实可见单词');
  return {
    viewport: await page.getByTestId('epub-viewport').boundingBox(),
    words: words.slice(0, 25), page: await page.locator('.reader-page-position').innerText(),
    cfi: (await savedBook()).lastLocation,
  };
}

async function iframeBlank() {
  const frame = await readingFrame();
  const viewport = await page.getByTestId('epub-viewport').boundingBox();
  const frameBox = await (await frame.frameElement()).boundingBox();
  const point = await frame.evaluate(({ viewport, frameBox }) => {
    const left = Math.max(0, viewport.x - frameBox.x), top = Math.max(0, viewport.y - frameBox.y);
    const right = Math.min(innerWidth, viewport.x + viewport.width - frameBox.x);
    const bottom = Math.min(innerHeight, viewport.y + viewport.height - frameBox.y);
    const rectangles = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const rect of range.getClientRects()) rectangles.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    }
    for (const x of [left + 7, left + 15, right - 7, right - 15, (left + right) / 2]) {
      for (let y = top + 20; y < bottom - 20; y += 17) {
        const element = document.elementFromPoint(x, y);
        if (!element || element.closest('a,button,input,img,svg,video')) continue;
        if (!rectangles.some(rect => x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top - 3 && y <= rect.bottom + 3)) return { x, y };
      }
    }
    throw new Error('找不到经过文字矩形排除的正文留白');
  }, { viewport, frameBox });
  return { x: frameBox.x + point.x, y: frameBox.y + point.y };
}

async function outerBlank() {
  const reader = await page.locator('.epub-reader').boundingBox();
  const viewport = await page.getByTestId('epub-viewport').boundingBox();
  assert.ok(viewport.x - reader.x >= 10, '正文左侧应存在可点击的外层页边');
  const point = { x: (reader.x + viewport.x) / 2, y: viewport.y + viewport.height / 2 };
  assert.equal(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.epub-reader')),
    point), true, '外层留白测试点必须位于阅读区域');
  return point;
}

async function waitFocused(expected) {
  await page.waitForFunction(expected => (document.querySelector('.epub-reader')?.getAttribute('data-reading-focused') === 'true') === expected, expected);
}

async function assertReaderFrames(stage) {
  const frames = await page.locator('.epub-reader,.reader-viewport,.reader-canvas iframe').evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return { tag: element.tagName, className: element.className, active: element === document.activeElement,
      focused: element.matches(':focus'), focusVisible: element.matches(':focus-visible'),
      outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor,
      borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth] };
  }));
  assert.ok(frames.length >= 3, stage + ' 必须实际检查阅读区、正文容器及 iframe');
  for (const frame of frames) {
    assert.ok(frame.borders.every(width => parseFloat(width) === 0), stage + ' 阅读容器不能出现边框：' + JSON.stringify(frame));
    assert.ok(frame.outlineStyle === 'none' || parseFloat(frame.outlineWidth) === 0,
      stage + ' 阅读容器不能出现焦点轮廓：' + JSON.stringify(frame));
  }
  measurements.push({ stage, readerFocusStyles: frames });
}

async function keyboardFocusReader(selector, stage) {
  // Tab puts Chromium into keyboard focus mode before the same programmatic focus
  // used by reader shortcuts. This reproduces the UA :focus-visible outline.
  await page.keyboard.press('Tab');
  const target = page.locator(selector).first();
  await target.focus();
  const focus = await target.evaluate(element => ({ active: element === document.activeElement,
    focused: element.matches(':focus'), focusVisible: element.matches(':focus-visible') }));
  assert.equal(focus.active, true, stage + ' 必须真正获得焦点');
  if (selector !== '.reader-canvas iframe') assert.equal(focus.focusVisible, true, stage + ' 必须实际构造 :focus-visible');
  measurements.push({ stage, selector, keyboardFocus: focus });
  await assertReaderFrames(stage);
}

async function assertVisibleControlFocus(control, stage) {
  const measured = await control.evaluate(element => {
    const style = getComputedStyle(element);
    return { active: element === document.activeElement, focusVisible: element.matches(':focus-visible'),
      outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor };
  });
  assert.equal(measured.active, true, stage + ' 应真正获得焦点');
  assert.equal(measured.focusVisible, true, stage + ' 应匹配 :focus-visible');
  assert.notEqual(measured.outlineStyle, 'none', stage + ' 应保留可见焦点样式');
  assert.equal(parseFloat(measured.outlineWidth), 2, stage + ' 应保留 2px 焦点轮廓');
  assert.ok(!['transparent', 'rgba(0, 0, 0, 0)'].includes(measured.outlineColor));
  measurements.push({ stage, controlFocusStyle: measured });
}

async function assertCursors(hidden, stage) {
  const frame = await readingFrame();
  const inside = await frame.evaluate(() => ({ hiddenAttribute: document.documentElement.hasAttribute('data-yuejian-cursor-hidden'),
    html: getComputedStyle(document.documentElement).cursor, body: getComputedStyle(document.body).cursor,
    paragraph: getComputedStyle(document.querySelector('p') ?? document.body).cursor }));
  const outside = await page.locator('.epub-reader').evaluate(element => getComputedStyle(element).cursor);
  if (hidden) {
    assert.equal(inside.hiddenAttribute, true, stage + ' 正文应有隐藏鼠标属性');
    for (const cursor of [inside.html, inside.body, inside.paragraph, outside]) assert.equal(cursor, 'none', stage + ' 内外层鼠标都应隐藏');
  } else {
    assert.equal(inside.hiddenAttribute, false, stage + ' 应移除正文隐藏鼠标属性');
    for (const cursor of [inside.html, inside.body, inside.paragraph, outside]) assert.notEqual(cursor, 'none', stage + ' 内外层鼠标都应恢复');
  }
  measurements.push({ stage, inside, outside });
  await assertReaderFrames(stage);
}

async function assertFocusedLayout(before, stage) {
  await waitFocused(true);
  await page.waitForTimeout(120);
  assert.deepEqual(await snapshot(), before, stage + ' 不应改变正文矩形、容器、页码或内容位置');
  assert.equal(await page.getByRole('button', { name: '返回书架', exact: true }).isVisible(), false);
  assert.equal(await page.getByRole('button', { name: '阅读工具', exact: true }).isVisible(), false);
  assert.equal(await page.locator('.reader-book-title').isVisible(), true);
  assert.equal(await page.locator('.reader-page-position').isVisible(), true);
  const titleBox = await page.locator('.reader-book-title').boundingBox();
  const readerBox = await page.locator('.epub-reader').boundingBox();
  assert.ok(Math.abs(titleBox.x + titleBox.width / 2 - readerBox.x - readerBox.width / 2) <= 2, '纯阅读时书名应居中');
  await assertCursors(true, stage);
}

async function assertBlankDismisses(panel, stage) {
  assert.equal(await panel.isVisible(), true, stage + ' 前置面板应打开');
  const blank = await outerBlank(), count = (await occurrences()).length;
  await page.mouse.click(blank.x, blank.y);
  await panel.waitFor({ state: 'hidden' });
  await waitFocused(false);
  assert.equal((await occurrences()).length, count, stage + ' 收起面板不能误收录');
}

async function assertPageChanged(action, stage) {
  const before = await page.locator('.reader-page-position').innerText(), cfi = (await savedBook()).lastLocation;
  await action();
  await page.waitForFunction(previous => document.querySelector('.reader-page-position')?.textContent !== previous, before);
  const after = await page.locator('.reader-page-position').innerText();
  let previousCfi = null, stableSamples = 0, actualCfi = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    actualCfi = (await savedBook()).lastLocation;
    const actualPage = await page.locator('.reader-page-position').innerText();
    stableSamples = actualCfi && actualCfi !== cfi && actualCfi === previousCfi && actualPage === after ? stableSamples + 1 : 0;
    if (stableSamples >= 3) break;
    previousCfi = actualCfi;
    await page.waitForTimeout(100);
  }
  assert.ok(stableSamples >= 3, stage + ' 的新页码与保存位置应稳定，不能仅检测到一次瞬态变化');
  measurements.push({ stage, before, after, cfi: actualCfi });
}

try {
  step('隔离启动与删除底部箭头');
  await launch();
  await importAndOpenBook(app, page, sample, title);
  bookId = (await page.evaluate(() => window.readerApi.listBooks()))[0].id;
  await readingFrame(); await page.waitForTimeout(600);
  assert.equal(await page.getByRole('button', { name: '上一页', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).count(), 0);
  assert.equal(await page.locator('.reader-page-button').count(), 0, '底部翻页箭头应从 DOM 移除');
  assert.equal((await occurrences()).length, 0);
  checks.push('使用隔离数据与自编 EPUB，底部上一页/下一页箭头已从 DOM 移除');

  step('键盘模式焦点不为正文绘制黑框');
  await keyboardFocusReader('.epub-reader', '键盘焦点进入阅读区');
  await keyboardFocusReader('.reader-viewport', '键盘焦点进入正文容器');
  await keyboardFocusReader('.reader-canvas iframe', '键盘焦点进入正文 iframe');
  await page.keyboard.press('Tab');
  const toolsToggle = page.getByRole('button', { name: '阅读工具', exact: true });
  await toolsToggle.focus();
  await assertVisibleControlFocus(toolsToggle, '阅读工具按钮保留键盘焦点');
  await keyboardFocusReader('.reader-viewport', '正常阅读时正文容器有键盘焦点');
  await page.screenshot({ path: join(artifacts, 'focus-outline-fixed.png'), animations: 'disabled' });
  await page.keyboard.press('j'); await page.getByTestId('vocabulary-sidebar').waitFor();
  await page.keyboard.press('j'); await page.getByTestId('vocabulary-sidebar').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.tagName === 'IFRAME');
  await assertReaderFrames('J 关闭单词本后焦点回到正文 iframe');
  checks.push('真实键盘模式下阅读区与正文容器匹配 focus-visible，root/viewport/iframe 及 J 返回正文均无边框轮廓，阅读工具仍保留 2px 焦点提示');

  step('iframe 留白隐藏指针和控件且布局不变');
  const initialLayout = await snapshot(), innerBlank = await iframeBlank();
  await page.mouse.click(innerBlank.x, innerBlank.y);
  await assertFocusedLayout(initialLayout, '正文留白');
  assert.equal((await occurrences()).length, 0, '正文留白不能产生收录');
  await page.screenshot({ path: join(artifacts, 'immersive-reading.png'), animations: 'disabled' });
  checks.push('正文 iframe 留白单击进入纯阅读，内外层无鼠标，正文、书名、页数保留且布局位置不变');

  step('真实鼠标移动与 Esc 恢复');
  await page.mouse.move(innerBlank.x + 12, innerBlank.y + 5);
  await waitFocused(false); await assertCursors(false, '真实鼠标移动');
  assert.equal(await page.getByRole('button', { name: '返回书架', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: '阅读工具', exact: true }).isVisible(), true);
  const hostBlank = await outerBlank();
  await page.mouse.click(hostBlank.x, hostBlank.y);
  await assertFocusedLayout(initialLayout, '外层页边留白');
  assert.equal((await occurrences()).length, 0, '外层留白不能产生收录');
  await page.locator('.epub-reader').focus(); await page.keyboard.press('Escape');
  await waitFocused(false); await assertCursors(false, 'Esc 恢复');
  await page.screenshot({ path: join(artifacts, 'immersive-controls.png'), animations: 'disabled' });
  checks.push('外层页边同样可进入纯阅读；真实鼠标移动与 Esc 均恢复控件和指针');

  step('已有面板先收起');
  await openTools(page);
  await assertBlankDismisses(page.locator('.reader-tools-menu'), '阅读工具');
  await openToc(page);
  await assertBlankDismisses(page.getByRole('navigation', { name: '书籍目录', exact: true }), '目录');
  await openTools(page); await page.getByRole('button', { name: '主题与设置', exact: true }).click();
  await assertBlankDismisses(page.getByRole('dialog', { name: '主题与设置', exact: true }), '阅读设置');
  await openNotebook(page);
  await assertBlankDismisses(page.getByTestId('vocabulary-sidebar'), '单词本');
  checks.push('工具、目录、阅读设置或单词本打开时，留白单击只收起面板，本次不进入纯阅读、不误收录');

  step('选区先取消，单词与拖选收录保持');
  const words = await visibleWords(), first = words.find(word => word.text === 'When'), last = words.find(word => word.text === 'bookshop');
  assert.ok(first && last);
  const dragSelection = async () => {
    await page.mouse.move(first.left + 0.3, first.y); await page.mouse.down();
    const moving = page.mouse.move(last.left + last.width - 0.3, last.y);
    await new Promise(resolve => setTimeout(resolve, 120)); await page.mouse.up(); await moving;
    await page.locator('.reader-selection-summary').waitFor();
  };
  await dragSelection();
  assert.ok((await page.locator('.reader-selection-summary > span').getAttribute('title')).includes('Clara'));
  const selectionBlank = await iframeBlank(); await page.mouse.click(selectionBlank.x, selectionBlank.y);
  await page.locator('.reader-selection-summary').waitFor({ state: 'hidden' }); await waitFocused(false);
  assert.equal((await occurrences()).length, 0);
  await page.mouse.click(selectionBlank.x, selectionBlank.y); await waitFocused(true);
  const word = (await visibleWords()).find(item => item.text === 'peculiar'); assert.ok(word);
  await page.mouse.click(word.x, word.y);
  await page.waitForFunction(async id => (await window.readerApi.listEntries(id)).some(entry => entry.term.toLowerCase() === 'peculiar'), bookId);
  await waitFocused(false); await assertCursors(false, '点击单词后');
  await dragSelection();
  await page.locator('.selection-menu').getByRole('button', { name: '收录', exact: true }).click();
  await page.waitForFunction(async id => (await window.readerApi.listEntries(id)).flatMap(entry => entry.occurrences).length === 2, bookId);
  assert.equal(await page.locator('.reader-mark').count() > 0, true);
  checks.push('已有选区先取消而不进入纯阅读；单词点击、真实拖选和菜单收录均保留，产生真实本机记录与下划线');

  step('单词本滚动不穿透');
  const saved = await occurrences(), candidates = await visibleWords(), chosen = new Set();
  const extra = candidates.filter(item => {
    const term = item.text.toLowerCase();
    if (chosen.has(term) || saved.some(occurrence => item.start < occurrence.anchor.endOffset && item.end > occurrence.anchor.startOffset)) return false;
    chosen.add(term); return true;
  }).slice(0, 14);
  assert.equal(extra.length, 14, '自编样本应提供足够的独立单词以产生可滚动单词本');
  let expectedCount = (await occurrences()).length;
  for (const item of extra) {
    await page.mouse.click(item.x, item.y); expectedCount++;
    await page.waitForFunction(async ({ id, count }) => (await window.readerApi.listEntries(id)).flatMap(entry => entry.occurrences).length === count, { id: bookId, count: expectedCount });
  }
  await openNotebook(page);
  const scroll = page.locator('.vocabulary-scroll');
  assert.ok(await scroll.evaluate(element => element.scrollHeight > element.clientHeight), '必须确实存在可滚动内容');
  const pageBeforeScroll = await page.locator('.reader-page-position').innerText(), cfiBeforeScroll = (await savedBook()).lastLocation;
  const scrollBox = await scroll.boundingBox(); await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2);
  await page.mouse.wheel(0, 420); await page.waitForFunction(() => document.querySelector('.vocabulary-scroll')?.scrollTop > 0);
  await page.waitForTimeout(450);
  assert.equal(await page.locator('.reader-page-position').innerText(), pageBeforeScroll);
  assert.equal((await savedBook()).lastLocation, cfiBeforeScroll);
  await closeNotebook(page);
  checks.push('通过真实收录生成可滚动单词本；浮层内部滚轮只滚动词条，不改变正文页码或内容位置');

  step('键盘与真实滚轮翻页');
  await assertPageChanged(() => turnPage(page, 1), 'ArrowRight');
  await assertPageChanged(() => turnPage(page, -1), 'ArrowLeft');
  await page.locator('.epub-reader').focus();
  await assertPageChanged(() => page.keyboard.press('PageDown'), 'PageDown');
  await assertPageChanged(() => page.keyboard.press('PageUp'), 'PageUp');
  await page.waitForTimeout(450);
  const wheelPoint = await iframeBlank(); await page.mouse.move(wheelPoint.x, wheelPoint.y);
  await assertPageChanged(() => page.mouse.wheel(0, 260), '正文向下滚轮');
  await page.waitForTimeout(450);
  await assertPageChanged(() => page.mouse.wheel(0, -260), '正文向上滚轮');
  checks.push('左右方向键、PageDown/PageUp 与正文真实滚轮均可翻页，并保存新的内容位置');

  step('第二本书与重开后无焦点黑框');
  await page.keyboard.press('Escape'); await waitFocused(false);
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await importAndOpenBook(app, page, secondSample, secondTitle);
  await readingFrame(); await page.waitForTimeout(450);
  await keyboardFocusReader('.reader-viewport', '第二本书正文键盘焦点');
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await openBookFromShelf(page, secondTitle);
  await readingFrame(); await page.waitForTimeout(450);
  await keyboardFocusReader('.reader-viewport', '第二本书重开后正文键盘焦点');
  checks.push('第二本自编书及返回书架后重新打开，都在真实 focus-visible 状态下保持正文无边框轮廓');

  step('输入框保持普通输入');
  await page.keyboard.press('Escape'); await waitFocused(false);
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const apiDialog = page.getByRole('dialog'), input = apiDialog.locator('#api-key');
  await input.fill('j'); await input.press('j'); await input.press('ArrowLeft');
  assert.equal(await input.inputValue(), 'jj');
  assert.equal(await input.evaluate(element => element === document.activeElement), true);
  await assertVisibleControlFocus(input, '书架 API 输入保留键盘焦点');
  assert.equal(await page.locator('.epub-reader').count(), 0);
  await apiDialog.getByRole('button', { name: '关闭设置', exact: true }).click();
  assert.equal((await page.evaluate(() => window.readerApi.getSettings())).hasApiKey, false);
  checks.push('书架 API 输入仍接收 J 与光标移动并保留 2px 焦点提示；未保存测试密钥、未调用付费模型');
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('.app-error').count(), 0);
  await writeFile(join(artifacts, 'immersive-reading-result.json'), JSON.stringify(report(true), null, 2));
  console.log(JSON.stringify({ passed: true, checks, measurements, errors }, null, 2));
} catch (error) {
  console.error(error);
  if (page) {
    await page.screenshot({ path: join(artifacts, 'immersive-reading-failure.png'), animations: 'disabled' }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 4000));
  }
  await writeFile(join(artifacts, 'immersive-reading-result.json'), JSON.stringify(report(false, String(error)), null, 2));
  process.exitCode = 1;
} finally { if (app) await app.close(); }
