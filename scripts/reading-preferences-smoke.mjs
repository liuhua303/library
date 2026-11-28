import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import JSZip from 'jszip';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSampleBook } from './create-sample.mjs';
import { closeNotebook, closeTools, importAndOpenBook, openBookFromShelf, openNotebook, openTools, turnPage } from './reader-test-ui.mjs';

const artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const startedAt = new Date();
const executablePath = process.argv[2] ? resolve(process.argv[2]) : electronPath;
const mode = process.argv[2] ? 'packaged' : 'development-build';
const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'yuejian-preferences-'));
const dataDirectory = join(temporary, 'data');
const title = '阅读偏好与书签验收';
const otherTitle = '独立书籍验收';
const sample = await createSampleBook(join(temporary, 'preferences.epub'), { title, identifier: 'yuejian-preferences-smoke' });
const otherSample = await createSampleBook(join(temporary, 'other.epub'), { title: otherTitle, identifier: 'yuejian-preferences-other', alternate: true });
const archive = await JSZip.loadAsync(await readFile(sample));
let opening = await archive.file('OEBPS/chapter1.xhtml').async('string');
opening = opening.replace('<html ', '<html style="color:#00ff00 !important;background:#ff00ff !important" ')
  .replace('<body>', '<body style="color:#ff0000 !important;background-color:#00ff00 !important">')
  .replace('<p>When Clara', '<p data-theme-probe="paragraph" style="color:#00ff00 !important;background-color:#ff00ff !important">When Clara')
  .replace('a peculiar silence', 'a <span data-theme-probe="inline" style="color:#ff0000 !important;-webkit-text-fill-color:#ff0000 !important;background:#00ff00 !important;font-family:monospace !important;font-weight:normal !important">peculiar</span> silence');
archive.file('OEBPS/chapter1.xhtml', opening);
archive.file('OEBPS/cover.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="540" viewBox="0 0 360 540"><rect width="360" height="540" fill="#b2b443"/><text x="35" y="105" fill="#fff9dd" font-family="Georgia" font-size="43">ROOM</text><text x="35" y="164" fill="#fff9dd" font-family="Georgia" font-size="43">TO READ</text><path d="M65 285 L175 250 L290 285 L175 327 Z M175 250 L175 327 M65 285 L65 299 L175 341 L290 299 L290 285" fill="none" stroke="#39423c" stroke-width="5"/><text x="35" y="475" fill="#fff9dd" font-family="Georgia" font-size="23" letter-spacing="5">YUEJIAN</text></svg>');
const packageXml = await archive.file('OEBPS/package.opf').async('string');
archive.file('OEBPS/package.opf', packageXml.replace('<manifest>', '<manifest><item id="cover" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>'));
await writeFile(sample, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

const env = { ...process.env, APP_TEST_MODE: '1', READER_USER_DATA: dataDirectory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const checks = [], measurements = [], errors = [];
const themes = [
  { id: 'original', label: '原色', paper: 'rgb(255, 255, 255)', panel: 'rgb(255, 255, 255)', ink: 'rgb(0, 0, 0)', fontFamily: 'Georgia, "Times New Roman", serif' },
  { id: 'quiet', label: '静谧', paper: 'rgb(65, 65, 68)', panel: 'rgb(75, 75, 78)', ink: 'rgb(229, 228, 225)', fontFamily: 'Georgia, "Times New Roman", serif' },
  { id: 'paper', label: '纸张', paper: 'rgb(238, 237, 233)', panel: 'rgb(246, 245, 241)', ink: 'rgb(41, 40, 36)', fontFamily: 'Georgia, "Times New Roman", serif' },
  { id: 'bold', label: '醒目', paper: 'rgb(255, 255, 255)', panel: 'rgb(255, 255, 255)', ink: 'rgb(18, 18, 18)', fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif' },
  { id: 'calm', label: '舒缓', paper: 'rgb(242, 228, 200)', panel: 'rgb(249, 239, 217)', ink: 'rgb(62, 52, 37)', fontFamily: 'Georgia, "Times New Roman", serif' },
  { id: 'focus', label: '专注', paper: 'rgb(255, 251, 242)', panel: 'rgb(255, 253, 247)', ink: 'rgb(41, 40, 32)', fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif' },
];
let app, page, bookId, bookmark, runtimeAppVersion = null;
const step = name => console.log('reading-preferences: ' + name);
const report = (passed, message) => ({ passed, version: packageMetadata.version, runtimeAppVersion, startedAt: startedAt.toISOString(), recordedAt: new Date().toISOString(), timeZone: 'Asia/Shanghai', mode, executablePath, checks, measurements, errors, ...(message ? { message } : {}), userData: temporary });

async function launch() {
  app = await electron.launch({ executablePath, args: mode === 'packaged' ? [] : ['app/main.cjs'], env, timeout: 30000 });
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), dataDirectory);
  runtimeAppVersion = await app.evaluate(({ app }) => app.getVersion());
  if (mode === 'packaged') assert.equal(runtimeAppVersion, packageMetadata.version, '打包程序运行时版本必须与项目应用版本一致');
  page = await app.firstWindow({ timeout: 15000 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '书架', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.readerApi.getSettings())).hasApiKey, false, '测试数据目录不得有真实密钥');
}

async function readingFrame() {
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const frame of page.frames().filter(frame => frame !== page.mainFrame())) {
      if ((await frame.locator('body').textContent().catch(() => ''))?.includes('Clara')) return frame;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('测试 EPUB 正文未显示');
}

async function savedBook() {
  return page.evaluate(id => window.readerApi.listBooks().then(books => books.find(book => book.id === id)), bookId);
}

async function waitSaved(expected) {
  await page.waitForFunction(async ({ id, expected }) => {
    const book = (await window.readerApi.listBooks()).find(book => book.id === id);
    return book && Object.entries(expected).every(([key, value]) => book[key] === value);
  }, { id: bookId, expected });
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
}

async function assertTheme(theme) {
  let latest;
  for (let attempt = 0; attempt < 100; attempt++) {
    const frame = await readingFrame();
    latest = await frame.evaluate(() => ({
      paper: getComputedStyle(document.documentElement).backgroundColor,
      htmlInk: getComputedStyle(document.documentElement).color,
      bodyInk: getComputedStyle(document.body).color,
      bodyPaper: getComputedStyle(document.body).backgroundColor,
      fontSize: getComputedStyle(document.body).fontSize,
      probes: [...document.querySelectorAll('[data-theme-probe]')].map(element => ({
        name: element.getAttribute('data-theme-probe'), color: getComputedStyle(element).color,
        textFill: getComputedStyle(element).webkitTextFillColor, background: getComputedStyle(element).backgroundColor,
        fontFamily: getComputedStyle(element).fontFamily, fontWeight: getComputedStyle(element).fontWeight,
      })),
    })).catch(() => null);
    if (latest?.paper === theme.paper && latest.probes.length === 2
      && latest.probes.every(probe => probe.color === theme.ink && probe.textFill === theme.ink)) break;
    await page.waitForTimeout(100);
  }
  assert.equal(latest?.paper, theme.paper, theme.label + '应应用到 EPUB 页面背景');
  assert.equal(latest.htmlInk, theme.ink, 'html 内联重要级文字颜色应被主题覆盖');
  assert.equal(latest.bodyInk, theme.ink, 'body 内联重要级文字颜色应被主题覆盖');
  assert.ok([theme.paper, 'rgba(0, 0, 0, 0)'].includes(latest.bodyPaper), 'body 原书背景应被主题纸张或透明覆盖');
  assert.equal(latest.probes.length, 2);
  for (const probe of latest.probes) {
    assert.equal(probe.color, theme.ink, theme.label + '应覆盖原书 inline !important 文字颜色');
    assert.equal(probe.textFill, theme.ink, theme.label + '应覆盖原书 text-fill 颜色');
    assert.equal(probe.background, 'rgba(0, 0, 0, 0)', '原书重要级背景不得覆盖阅读纸张');
    assert.equal(probe.fontFamily, theme.fontFamily, '主题字体应覆盖原书显式字体');
    assert.equal(probe.fontWeight, theme.id === 'bold' ? '600' : '400', '主题字重应覆盖原书显式 normal，并可恢复');
  }
  assert.equal(await page.getByTestId('epub-viewport').evaluate(element => getComputedStyle(element).backgroundColor), theme.paper);
  measurements.push({ theme: theme.id, ...latest });
}

async function selectTheme(dialog, theme) {
  const option = dialog.getByRole('button', { name: theme.label + '主题', exact: true });
  await option.click();
  await page.waitForFunction(id => document.querySelector('.epub-reader')?.getAttribute('data-reader-theme') === id, theme.id);
  assert.equal(await option.getAttribute('aria-pressed'), 'true');
  assert.equal(await dialog.locator('[aria-pressed="true"]').count(), 1);
  await page.waitForFunction(async ({ id, theme }) => {
    const book = (await window.readerApi.listBooks()).find(book => book.id === id);
    return (book?.theme ?? 'original') === theme;
  }, { id: bookId, theme: theme.id });
  await assertTheme(theme);
}

function rgba(value) {
  assert.match(value, /^rgba?\(/, '颜色测量必须是浏览器解析后的 RGB 值');
  const numbers = value.match(/[\d.]+/g).map(Number);
  return [...numbers.slice(0, 3), numbers[3] ?? 1];
}

function blend(front, back) {
  return [...front.slice(0, 3).map((channel, index) => channel * front[3] + back[index] * (1 - front[3])), 1];
}

function contrast(front, back) {
  const luminance = color => color.slice(0, 3).map(channel => {
    const srgb = channel / 255;
    return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  const values = [luminance(front), luminance(back)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}

async function assertNotebookTheme(theme, stage = '切换后重开') {
  const notebook = page.getByTestId('vocabulary-sidebar');
  await notebook.waitFor();
  await notebook.locator('.meaning-zh').waitFor();
  for (const selector of ['.analysis-details', '.source-details']) {
    const details = notebook.locator(selector).first();
    if (!(await details.evaluate(element => element.open))) await details.locator('summary').click();
  }
  const snapshot = await notebook.evaluate(panel => {
    const style = getComputedStyle(panel);
    const scroll = panel.querySelector('.vocabulary-scroll');
    const thumb = getComputedStyle(scroll, '::-webkit-scrollbar-thumb');
    const selectors = ['.vocabulary-header h2', '.configure-notice', '.entry-term', '.meaning-zh', '.definition-en', '.analysis-details summary', '.analysis-field > span', '.analysis-field > p', '.source-details summary', '.source-caption', '.source-context', '.source-context mark', '.source-jump', '.occurrence-footer', '.vocabulary-header .icon-button', '.remove-occurrence'];
    return {
      background: style.backgroundColor, color: style.color, border: style.borderColor, borderWidth: style.borderTopWidth, shadow: style.boxShadow,
      scrollbar: { color: thumb.backgroundColor, width: getComputedStyle(scroll, '::-webkit-scrollbar').width, clientHeight: scroll.clientHeight, scrollHeight: scroll.scrollHeight },
      sourceBorder: getComputedStyle(panel.querySelector('.source-context')).borderLeftColor,
      text: selectors.map(selector => {
        const element = panel.querySelector(selector);
        if (!element) return { selector, missing: true };
        const own = getComputedStyle(element);
        const ancestry = [];
        for (let node = element; node; node = node.parentElement) {
          const computed = getComputedStyle(node);
          ancestry.push({ background: computed.backgroundColor, opacity: Number(computed.opacity), filter: computed.filter, backdrop: computed.backdropFilter || computed.webkitBackdropFilter || 'none' });
        }
        const box = element.getBoundingClientRect();
        return { selector, color: own.color, textShadow: own.textShadow, display: own.display, visibility: own.visibility, width: box.width, height: box.height, ancestry };
      }),
    };
  });
  assert.equal(snapshot.background, theme.panel, theme.label + '的非空单词本必须使用该主题面板底色');
  assert.equal(snapshot.color, theme.ink, '单词本主体文字必须跟随主题');
  assert.ok(parseFloat(snapshot.borderWidth) > 0 && rgba(snapshot.border)[3] > 0 || snapshot.shadow !== 'none', '面板须有可辨认的边界或阴影');
  assert.ok(contrast(blend(rgba(snapshot.sourceBorder), rgba(theme.panel)), rgba(theme.panel)) >= 3, '原文左边界应在主题面板上可见');
  assert.ok(parseFloat(snapshot.scrollbar.width) >= 4, '单词本滚动条需保留可见宽度');
  snapshot.scrollbar.contrast = contrast(blend(rgba(snapshot.scrollbar.color), rgba(theme.panel)), rgba(theme.panel));
  assert.ok(snapshot.scrollbar.contrast >= 3, theme.label + '滚动条应在面板上清晰可辨');
  for (const text of snapshot.text) {
    assert.ok(!text.missing, '非空单词本缺少测试内容：' + text.selector);
    assert.ok(text.width > 0 && text.height > 0 && text.display !== 'none' && text.visibility === 'visible', text.selector + '应实际参与显示');
    const opacity = text.ancestry.reduce((product, ancestor) => product * ancestor.opacity, 1);
    assert.equal(opacity, 1, text.selector + '不应通过透明度淡化，次要信息使用主题实色');
    assert.ok(text.ancestry.every(ancestor => ancestor.filter === 'none' && ancestor.backdrop === 'none'), text.selector + '及祖先不得添加模糊滤镜');
    assert.equal(text.textShadow, 'none', text.selector + '不应有模糊文字阴影');
    let background = [255, 255, 255, 1];
    for (const ancestor of [...text.ancestry].reverse()) background = blend(rgba(ancestor.background), background);
    const ink = rgba(text.color); ink[3] *= opacity;
    text.contrast = contrast(blend(ink, background), background);
    assert.ok(text.contrast >= 4.5, `${theme.label} ${text.selector} 实际文字对比度 ${text.contrast.toFixed(2)} 应至少为 4.5:1`);
    delete text.ancestry;
  }
  measurements.push({ notebookTheme: theme.id, stage, ...snapshot });
  await notebook.locator('.vocabulary-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: join(artifacts, `preferences-notebook-${theme.id}.png`), animations: 'disabled' });
}

async function nextPage() {
  const before = await page.locator('.reader-page-position').innerText();
  await turnPage(page, 1);
  await page.waitForFunction(previous => document.querySelector('.reader-page-position')?.textContent !== previous, before);
}

async function bookmarkList() {
  await openTools(page);
  await page.getByRole('button', { name: '书签', exact: true }).click();
  const nav = page.getByRole('navigation', { name: '书籍目录', exact: true });
  await nav.waitFor();
  assert.equal(await nav.getByRole('tab', { name: /^书签/ }).getAttribute('aria-selected'), 'true');
  assert.equal(await nav.getByRole('tab', { name: '目录', exact: true }).count(), 1);
  return nav;
}

async function assertBookmarkOnPage() {
  await openTools(page);
  await page.getByRole('button', { name: '移除书签', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '移除书签', exact: true }).getAttribute('aria-pressed'), 'true');
  await closeTools(page);
}

async function clickWord(word) {
  const frame = await readingFrame();
  const point = await frame.evaluate(word => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const offset = node.textContent.indexOf(word);
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset); range.setEnd(node, offset + word.length);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    throw new Error('当前页未找到测试单词：' + word);
  }, word);
  const frameBox = await (await frame.frameElement()).boundingBox();
  await page.mouse.click(frameBox.x + point.x, frameBox.y + point.y);
}

try {
  step('独立数据启动、导入与阅读设置');
  await launch();
  await importAndOpenBook(app, page, sample, title);
  bookId = (await page.evaluate(() => window.readerApi.listBooks())).find(book => book.title === title).id;
  await readingFrame();
  const initialFont = (await savedBook()).fontSize;
  const dialog = await settingsDialog();
  assert.equal(await dialog.getByRole('heading', { name: '主题与设置', exact: true }).count(), 1);
  assert.equal(await dialog.locator('input, #api-key, #model-name').count(), 0);
  assert.ok(!/API|DeepSeek|密钥|\d/.test(await dialog.innerText()), '阅读设置不应出现 API 配置或字号数值');
  await dialog.getByRole('button', { name: '增大字号', exact: true }).click();
  await waitSaved({ fontSize: initialFont + 2 });
  await dialog.getByRole('button', { name: '减小字号', exact: true }).click();
  await waitSaved({ fontSize: initialFont });
  await dialog.getByRole('button', { name: '增大字号', exact: true }).click();
  await waitSaved({ fontSize: initialFont + 2 });
  await (await readingFrame()).waitForFunction(size => getComputedStyle(document.body).fontSize === size + 'px', initialFont + 2);
  assert.equal(await dialog.getByRole('button').count(), 9, '阅读设置仅包含关闭、两个字号按钮和六种主题');
  assert.equal(await dialog.getByLabel('书籍语言', { exact: true }).inputValue(), 'en');
  await page.screenshot({ path: join(artifacts, 'preferences-settings.png'), animations: 'disabled' });
  await dialog.screenshot({ path: join(artifacts, 'preferences-settings-panel.png'), animations: 'disabled' });
  checks.push('阅读设置提供小/大 A、六种主题和每书语言选择，不显示字号数值和 API 配置；字号按步长保存');

  step('六种主题真实正文配色与原书颜色覆盖');
  for (const theme of themes) await selectTheme(dialog, theme);
  await selectTheme(dialog, themes.find(theme => theme.id === 'quiet'));
  await closeSettings();
  await clickWord('peculiar');
  await page.waitForFunction(async id => (await window.readerApi.listEntries(id)).some(entry => entry.term === 'peculiar'), bookId);
  await page.getByTestId('reader-mark').first().waitFor();
  const mark = await page.getByTestId('reader-mark').first().evaluate(element => ({ color: getComputedStyle(element).backgroundColor, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, blend: getComputedStyle(element.parentElement).mixBlendMode }));
  assert.equal(mark.color, 'rgb(229, 228, 225)', '暗色主题下收录下划线应为亮色');
  assert.ok(mark.width > 0 && mark.height >= 2);
  assert.notEqual(mark.blend, 'multiply', '暗色下不能用正片叠底隐藏浅色下划线');
  measurements.push({ darkMark: mark });
  await page.screenshot({ path: join(artifacts, 'preferences-quiet.png'), animations: 'disabled' });
  checks.push('六种主题的页面背景、正文颜色与选择状态正确；覆盖原书 inline !important，暗色正文与下划线可见');

  step('六主题非空单词本、实际文字对比与清晰度');
  // Complete a real collected occurrence through a mocked model response, then
  // remove the synthetic key. No paid API or personal data is used by this test.
  await app.evaluate(() => {
    globalThis.__themeSmokeOriginalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const analysis = { kind: 'word', targetText: 'peculiar', meaningZh: '奇特的；这里形容房间里不同寻常的寂静。', definitionEn: 'Unusual or distinctive in this context.', usage: '用于描述不同寻常的事物或感受。', example: 'There was a peculiar silence in the room.' };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis) }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  });
  await page.evaluate(() => window.readerApi.saveSettings({ apiKey: 'sk-theme-smoke-synthetic-test-only' }));
  await page.waitForFunction(async id => (await window.readerApi.listEntries(id)).some(entry => entry.term === 'peculiar' && entry.occurrences[0].status === 'completed'), bookId);
  await page.evaluate(() => window.readerApi.saveSettings({ apiKey: '' }));
  await app.evaluate(() => { globalThis.fetch = globalThis.__themeSmokeOriginalFetch; delete globalThis.__themeSmokeOriginalFetch; });
  assert.equal((await page.evaluate(() => window.readerApi.getSettings())).hasApiKey, false);
  await openNotebook(page);
  const entryHeading = page.getByTestId('vocabulary-sidebar').locator('.entry-heading').first();
  await entryHeading.click();
  await page.getByTestId('vocabulary-sidebar').locator('.configure-notice').waitFor();
  await assertNotebookTheme(themes.find(theme => theme.id === 'quiet'), 'Quiet 首次打开');
  await closeNotebook(page);
  for (const theme of themes) {
    const notebookSettings = await settingsDialog();
    await selectTheme(notebookSettings, theme);
    await closeSettings();
    await openNotebook(page);
    await assertNotebookTheme(theme);
    await closeNotebook(page);
  }
  const restoreQuiet = await settingsDialog();
  await selectTheme(restoreQuiet, themes.find(theme => theme.id === 'quiet'));
  await closeSettings();
  checks.push('六主题非空单词本底色与文字跟随主题，词条、释义、原文与次要信息实际对比度≥4.5:1；边界/滚动条可见且无透明淡化或模糊滤镜');

  step('添加书签、导航与字号变化后的回跳');
  await openTools(page);
  await page.getByRole('button', { name: '添加书签', exact: true }).click();
  await page.getByRole('button', { name: '移除书签', exact: true }).waitFor();
  const firstBookmarks = await page.evaluate(id => window.readerApi.listBookmarks(id), bookId);
  assert.equal(firstBookmarks.length, 1);
  bookmark = firstBookmarks[0];
  assert.ok(bookmark.cfi.startsWith('epubcfi('));
  assert.ok(bookmark.excerpt.length > 0);
  assert.ok(!bookmark.excerpt.includes('beginningWhen'), '书签摘录跨标题与段落应有分隔空格');
  assert.ok(bookmark.excerpt.includes('A quiet beginning When Clara'), '书签摘录应保留标题与段落间的空格');
  await closeTools(page);
  await nextPage();
  const nav = await bookmarkList();
  assert.equal(await nav.locator('.reader-bookmark-row').count(), 1);
  await nav.getByRole('tab', { name: '目录', exact: true }).click();
  assert.equal(await nav.getByRole('tab', { name: '目录', exact: true }).getAttribute('aria-selected'), 'true');
  assert.ok(await nav.locator('#chapters-panel button').count() >= 2);
  await nav.getByRole('tab', { name: /^书签/ }).click();
  await page.screenshot({ path: join(artifacts, 'preferences-navigation.png'), animations: 'disabled' });
  await nav.getByRole('button', { name: /^跳转书签/ }).click();
  await nav.waitFor({ state: 'hidden' });
  await assertBookmarkOnPage();
  const appearance = await settingsDialog();
  await appearance.getByRole('button', { name: '增大字号', exact: true }).click();
  await waitSaved({ fontSize: initialFont + 4 });
  await closeSettings();
  await nextPage();
  const changedFontNav = await bookmarkList();
  await changedFontNav.getByRole('button', { name: /^跳转书签/ }).click();
  await changedFontNav.waitFor({ state: 'hidden' });
  await assertBookmarkOnPage();
  assert.equal((await page.evaluate(id => window.readerApi.listBookmarks(id), bookId))[0].cfi, bookmark.cfi);
  checks.push('工具栏添加当前页书签，目录/书签分段导航、书签回跳及调整字号后回跳正确');

  step('真实阅读百分比、书架展示与按书隔离');
  await nextPage();
  await openTools(page);
  const progressText = await page.getByRole('button', { name: '目录', exact: true }).innerText();
  const match = progressText.match(/(\d+)%/);
  assert.ok(match, '目录入口应包含已读百分比');
  const readerPercentage = Number(match[1]);
  assert.ok(readerPercentage > 0 && readerPercentage < 100, '翻页后应显示真实中途进度');
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  const shelfBook = page.getByRole('button', { name: `阅读 ${title}`, exact: true });
  await shelfBook.waitFor();
  assert.equal(await shelfBook.locator('.book-progress').innerText(), readerPercentage + '%');
  assert.equal(Math.round((await savedBook()).progress * 100), readerPercentage);
  assert.equal(await shelfBook.locator('.book-cover-object').count(), 1);
  await shelfBook.locator('.book-cover-image').waitFor();
  assert.equal(await shelfBook.locator('.book-cover-image').count(), 1);
  const shelfGeometry = await shelfBook.evaluate(element => {
    const cover = element.querySelector('.book-cover-slot').getBoundingClientRect();
    const progress = element.querySelector('.book-progress').getBoundingClientRect();
    const object = element.querySelector('.book-cover-object');
    return { coverLeft: cover.left, progressLeft: progress.left, coverBottom: cover.bottom, progressTop: progress.top, shadow: getComputedStyle(object).boxShadow };
  });
  assert.ok(Math.abs(shelfGeometry.coverLeft - shelfGeometry.progressLeft) <= 2 && shelfGeometry.progressTop > shelfGeometry.coverBottom);
  assert.notEqual(shelfGeometry.shadow, 'none');
  measurements.push({ readerPercentage, shelfGeometry });
  await importAndOpenBook(app, page, otherSample, otherTitle);
  const otherBook = (await page.evaluate(() => window.readerApi.listBooks())).find(book => book.title === otherTitle);
  assert.ok(!otherBook.theme || otherBook.theme === 'original');
  assert.equal(otherBook.fontSize, initialFont);
  const otherNav = await bookmarkList();
  assert.equal(await otherNav.locator('.reader-bookmark-row').count(), 0);
  assert.ok((await otherNav.innerText()).includes('暂无书签'));
  assert.equal((await page.evaluate(id => window.readerApi.listBookmarks(id), bookId)).length, 1);
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await page.screenshot({ path: join(artifacts, 'preferences-shelf.png'), animations: 'disabled' });
  checks.push('阅读菜单与书架显示相同真实进度，书架采用书本外观且进度在左下；书签和阅读偏好按书隔离');

  step('重启恢复与删除后不复现');
  await app.close(); app = null;
  await launch();
  const restored = await savedBook();
  assert.equal(restored.theme, 'quiet');
  assert.equal(restored.fontSize, initialFont + 4);
  assert.equal((await page.evaluate(id => window.readerApi.listBookmarks(id), bookId))[0].id, bookmark.id);
  await openBookFromShelf(page, title);
  await assertTheme(themes.find(theme => theme.id === 'quiet'));
  const restoredNav = await bookmarkList();
  assert.equal(await restoredNav.locator('.reader-bookmark-row').count(), 1);
  await restoredNav.getByRole('button', { name: /^删除书签/ }).click();
  await page.waitForFunction(async id => (await window.readerApi.listBookmarks(id)).length === 0, bookId);
  await restoredNav.locator('.reader-bookmark-row').waitFor({ state: 'hidden' });
  assert.ok((await restoredNav.innerText()).includes('暂无书签'));
  await app.close(); app = null;
  await launch();
  assert.equal((await page.evaluate(id => window.readerApi.listBookmarks(id), bookId)).length, 0);
  await openBookFromShelf(page, title);
  const finalNav = await bookmarkList();
  assert.equal(await finalNav.locator('.reader-bookmark-row').count(), 0);
  checks.push('重启后主题、字号与书签保留；列表删除后再次重启书签不复现');
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('.app-error').count(), 0);
  await writeFile(join(artifacts, 'reading-preferences-result.json'), JSON.stringify(report(true), null, 2));
  console.log(JSON.stringify({ passed: true, checks, measurements, errors }, null, 2));
} catch (error) {
  console.error(error);
  if (page) {
    await page.screenshot({ path: join(artifacts, 'reading-preferences-failure.png'), animations: 'disabled' }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 4000));
  }
  await writeFile(join(artifacts, 'reading-preferences-result.json'), JSON.stringify(report(false, String(error)), null, 2));
  process.exitCode = 1;
} finally { if (app) await app.close(); }
