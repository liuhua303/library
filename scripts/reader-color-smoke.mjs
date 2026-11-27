import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import JSZip from 'jszip';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createSampleBook } from './create-sample.mjs';
import { importAndOpenBook, openToc, turnPage } from './reader-test-ui.mjs';

const artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'yuejian-color-'));
const sample = await createSampleBook(join(temporary, 'colors.epub'), { title: 'Reader color regression' });
const archive = await JSZip.loadAsync(await readFile(sample));
const expectedColor = 'rgb(0, 0, 0)';
const checks = [];
const measurements = [];
const errors = [];
let app;
let page;

function testChapter(chapter, heading) {
  const blocks = [];
  for (let group = 0; group < 12; group++) {
    const sentence = `Clara continued reading chapter ${chapter}, passage ${group + 1}, while keeping her attention on the story. Every ordinary sentence should retain the same comfortable text color.`;
    blocks.push(
      `<p data-color-probe="ordinary-${group}" style="color:black">${sentence}</p>`,
      `<a id="self-closing-page-${group}"/><p data-color-probe="self-closing-anchor-${group}">${sentence}</p><p data-color-probe="self-closing-following-${group}">${sentence}</p>`,
      `<a id="location-${group}"><p data-color-probe="id-anchor-${group}">${sentence}</p></a>`,
      `<a name="named-${group}"><p data-color-probe="name-anchor-${group}">${sentence}</p></a>`,
      `<p><a data-color-probe="real-link-${group}" href="#location-${group}">${sentence}</a></p>`,
      `<p><span data-color-probe="inline-color-${group}" style="color:green !important">${sentence}</span></p>`,
      `<p><span data-color-probe="text-fill-${group}" style="-webkit-text-fill-color:green !important">${sentence}</span></p>`,
      `<p class="author-color"><em data-color-probe="nested-${group}" style="color:#376b58 !important">${sentence}</em></p>`,
    );
  }
  // Legacy EPUB chapters without the XHTML namespace preserve self-closing anchors
  // through XML serialization; srcdoc then interprets them as open HTML anchors.
  const namespace = chapter === '1' ? '' : ' xmlns="http://www.w3.org/1999/xhtml"';
  return `<?xml version="1.0" encoding="utf-8"?><html${namespace}><head><title>${heading}</title><style>body{font-family:Georgia,serif;line-height:1.85;margin:0;padding:20px 30px;color:black}p{margin:0 0 1.2em}a{color:#376b58}body .author-color em{color:green !important;-webkit-text-fill-color:#376b58 !important}</style></head><body data-color-chapter="${chapter}"><h1>${heading}</h1>${blocks.join('')}</body></html>`;
}
archive.file('OEBPS/chapter1.xhtml', testChapter('1', 'A quiet beginning'));
archive.file('OEBPS/chapter2.xhtml', testChapter('2', 'Another morning'));
await writeFile(sample, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

async function chapterFrame(chapter) {
  for (let attempt = 0; attempt < 120; attempt++) {
    for (const frame of page.frames().filter(frame => frame !== page.mainFrame())) {
      if (await frame.locator(`body[data-color-chapter="${chapter}"]`).count().catch(() => 0)) return frame;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`测试 EPUB 的第 ${chapter} 章未显示`);
}

async function checkCurrentPage(chapter, stage) {
  const frame = await chapterFrame(chapter);
  const viewport = await page.getByTestId('epub-viewport').boundingBox();
  const frameBox = await (await frame.frameElement()).boundingBox();
  const results = await frame.evaluate(({ viewport, frameBox }) => {
    return Array.from(document.querySelectorAll('[data-color-probe]')).map(element => {
      const style = getComputedStyle(element);
      const visible = Array.from(element.getClientRects()).some(rect => {
        const left = frameBox.x + rect.left;
        const top = frameBox.y + rect.top;
        return rect.width > 0 && rect.height > 0 && left < viewport.x + viewport.width
          && left + rect.width > viewport.x && top < viewport.y + viewport.height && top + rect.height > viewport.y;
      });
      return { case: element.getAttribute('data-color-probe'), color: style.color, textFillColor: style.webkitTextFillColor, visible };
    });
  }, { viewport, frameBox });
  assert.ok(results.some(result => result.visible), `${stage} 必须有可见测试正文`);
  measurements.push({ stage, chapter, totalCases: results.length, visibleCases: results.filter(result => result.visible).map(result => result.case), colors: [...new Set(results.map(result => result.color))], textFillColors: [...new Set(results.map(result => result.textFillColor))], mismatchedExamples: results.filter(result => result.color !== expectedColor || result.textFillColor !== expectedColor).slice(0, 10) });
  for (const result of results) {
    assert.equal(result.color, expectedColor, `${stage}: ${result.case} 的正文颜色`);
    assert.equal(result.textFillColor, expectedColor, `${stage}: ${result.case} 的实际文字填充色`);
  }
  assert.equal(await page.getByTestId('reader-mark').count(), 0, '未收录正文不能出现收录标记');
}

async function turnForward(chapter, number) {
  const position = await page.locator('.reader-page-position').innerText();
  await turnPage(page, 1);
  await page.waitForFunction(previous => document.querySelector('.reader-page-position')?.textContent !== previous, position);
  await page.waitForTimeout(180);
  await checkCurrentPage(chapter, `第 ${chapter} 章翻页 ${number}`);
}

const env = { ...process.env, APP_TEST_MODE: '1', READER_USER_DATA: join(temporary, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
try {
  console.log('reader-color: 启动隔离的测试阅读器');
  app = await electron.launch({ executablePath: electronPath, args: ['app/main.cjs'], env, timeout: 30000 });
  page = await app.firstWindow({ timeout: 15000 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await importAndOpenBook(app, page, sample);
  await chapterFrame('1');
  await page.locator('.reader-loading').waitFor({ state: 'hidden' });
  await page.waitForTimeout(250);
  await checkCurrentPage('1', '第一章初次显示');
  checks.push('普通正文、id/name 定位锚点、真实链接、内联颜色和文字填充色保持统一');
  for (let number = 1; number <= 3; number++) await turnForward('1', number);
  checks.push('连续翻过三页，正文颜色仍然一致且未产生收录标记');
  await openToc(page);
  await page.getByRole('navigation', { name: '书籍目录' }).getByRole('button', { name: 'Another morning', exact: true }).click();
  await chapterFrame('2');
  await page.waitForTimeout(250);
  await checkCurrentPage('2', '第二章初次显示');
  for (let number = 1; number <= 3; number++) await turnForward('2', number);
  checks.push('切换章节后重新注入样式，并连续翻页保持正确颜色');
  const books = await page.evaluate(() => window.readerApi.listBooks());
  assert.equal((await page.evaluate(id => window.readerApi.listEntries(id), books[0].id)).length, 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(artifacts, 'reader-color.png') });
  const result = { passed: true, expectedColor, checks, measurements, errors };
  await writeFile(join(artifacts, 'reader-color-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: join(artifacts, 'reader-color-failure.png') }).catch(() => {});
  await writeFile(join(artifacts, 'reader-color-result.json'), JSON.stringify({ passed: false, expectedColor, checks, measurements, errors, message: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  if (app) await app.close();
}
