import assert from 'node:assert/strict';

export async function turnPage(page, direction) {
  assert.ok(direction === 1 || direction === -1);
  await page.locator('.epub-reader').focus();
  await page.keyboard.press(direction === 1 ? 'ArrowRight' : 'ArrowLeft');
}

export async function openBookFromShelf(page, title) {
  const button = title ? page.getByRole('button', { name: `阅读 ${title}`, exact: true }) : page.locator('.book-cover-button').first();
  await button.waitFor();
  await button.click();
  await page.getByTestId('epub-viewport').waitFor();
  await page.locator('.reader-loading').waitFor({ state: 'hidden' });
}

export async function importAndOpenBook(app, page, file, title) {
  const existingLabels = await page.locator('.book-cover-button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, file);
  await page.getByRole('button', { name: '导入 EPUB', exact: true }).first().click();
  // An old cover is still present while the native import request is pending.
  // Wait for the imported book or reader, rather than treating that cover as completion.
  await page.waitForFunction(({ title, existingLabels }) => {
    if (document.querySelector('[data-testid="epub-viewport"]')) return true;
    return [...document.querySelectorAll('.book-cover-button')].some(button => title
      ? button.getAttribute('aria-label') === `阅读 ${title}`
      : !existingLabels.includes(button.getAttribute('aria-label')));
  }, { title, existingLabels });
  if (!(await page.getByTestId('epub-viewport').count())) await openBookFromShelf(page, title);
  await page.locator('.reader-loading').waitFor({ state: 'hidden' });
}

export async function openTools(page) {
  const toggle = page.getByRole('button', { name: '阅读工具', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

export async function openNotebook(page) {
  if (await page.getByTestId('vocabulary-sidebar').isVisible()) return;
  await openTools(page);
  await page.getByRole('button', { name: '打开单词本', exact: true }).click();
  await page.getByTestId('vocabulary-sidebar').waitFor();
}

export async function closeNotebook(page) {
  const sidebar = page.getByTestId('vocabulary-sidebar');
  if (!(await sidebar.isVisible())) return;
  await sidebar.getByRole('button', { name: '关闭单词本', exact: true }).click();
  await sidebar.waitFor({ state: 'hidden' });
}

export async function changeFont(page, direction) {
  assert.ok(direction === 1 || direction === -1);
  const toolsWereOpen = await page.getByRole('button', { name: '阅读工具', exact: true }).getAttribute('aria-expanded') === 'true';
  await openTools(page);
  await page.getByRole('button', { name: '主题与设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: direction === 1 ? '增大字号' : '减小字号', exact: true }).click();
  await dialog.getByRole('button', { name: '关闭阅读设置', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  if (toolsWereOpen) await openTools(page);
}

export async function closeTools(page) {
  const toggle = page.getByRole('button', { name: '阅读工具', exact: true });
  if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
}

export async function openToc(page) {
  await openTools(page);
  await page.getByRole('button', { name: '目录', exact: true }).click();
  await page.getByRole('navigation', { name: '书籍目录' }).waitFor();
}
