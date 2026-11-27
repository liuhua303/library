import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppSettings, DataChange } from '../shared/types';
import { extractEpubCover, inspectEpub } from './epub';
import { AnalysisQueue } from './queue';
import { ReaderStore } from './store';
import { KeyVault } from './vault';
import { validAnchor, validBookmark, validBookPatch, validCollect, validId, validSettings } from './validation';
import { applicationMenuTemplate, DesktopLifecycle } from './platform';

if ((!app.isPackaged || process.env.APP_TEST_MODE === '1') && process.env.READER_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.READER_USER_DATA));
}
if (process.platform === 'win32') app.setAppUserModelId('com.yuejian.reader');

let mainWindow: BrowserWindow | null = null;
let store: ReaderStore;
let vault: KeyVault;
let queue: AnalysisQueue;
let pendingClose: { id: string; window: BrowserWindow; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
const lifecycle = new DesktopLifecycle<BrowserWindow>({
  platform: process.platform,
  getWindow: () => mainWindow,
  createWindow,
  prepareClose: prepareRendererClose,
  promptCloseFailure: async (window, error) => {
    const choice = await dialog.showMessageBox(window, {
      type: 'error', title: '阅读位置尚未保存', message: '本次阅读位置还没有确认保存。',
      detail: error.message,
      buttons: ['重新保存并退出', '取消退出', '仍然退出'], defaultId: 0, cancelId: 1,
    });
    return choice.response === 0 ? 'retry' : choice.response === 2 ? 'discard' : 'cancel';
  },
  quit: () => app.quit(),
  dispose: () => { queue?.stop(); store?.close(); },
});
const coverCache = new Map<string, string | null>();
const pendingCovers = new Map<string, Promise<string | null>>();
let coverCacheBytes = 0;
let coverWork: Promise<unknown> = Promise.resolve();

function bookCover(id: string): Promise<string | null> {
  store.getBook(id);
  if (coverCache.has(id)) {
    const cached = coverCache.get(id)!;
    coverCache.delete(id); coverCache.set(id, cached);
    return Promise.resolve(cached);
  }
  const pending = pendingCovers.get(id);
  if (pending) return pending;
  // Serialize archive reads so a large shelf cannot decompress many books concurrently.
  const work = coverWork.then(async () => {
    let cover: string | null = null;
    try { cover = await extractEpubCover(store.readBook(id)); } catch { /* A missing cover does not prevent reading. */ }
    coverCache.set(id, cover);
    coverCacheBytes += (cover?.length ?? 0) * 2;
    while (coverCache.size > 96 || coverCacheBytes > 48 * 1024 * 1024) {
      const oldest = coverCache.keys().next().value;
      if (oldest === undefined) break;
      coverCacheBytes -= (coverCache.get(oldest)?.length ?? 0) * 2;
      coverCache.delete(oldest);
    }
    return cover;
  });
  pendingCovers.set(id, work);
  coverWork = work.then(() => undefined, () => undefined);
  void work.finally(() => pendingCovers.delete(id));
  return work;
}

function prepareRendererClose(window: BrowserWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      if (pendingClose?.id === id) pendingClose = undefined;
      reject(new Error('阅读界面暂未确认保存，请重试。'));
    }, 10_000);
    pendingClose = { id, window, resolve, reject, timer };
    window.webContents.send('reader:prepare-close', id);
  });
}

function broadcast(change: DataChange): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('reader:data-changed', change);
}

function assertTrusted(event: IpcMainInvokeEvent | Electron.IpcMainEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('不允许的应用调用。');
}

async function settings(): Promise<AppSettings> {
  return { hasApiKey: Boolean(await vault.get()), model: store.getSetting('model') || 'deepseek-flash' };
}

function registerIpc(): void {
  const handle = (channel: string, listener: (...args: any[]) => unknown) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => { assertTrusted(event); return listener(...args); });
  };
  handle('reader:list-books', () => store.listBooks());
  handle('reader:copy-text', text => {
    if (typeof text !== 'string' || text.length > 50000) throw new Error('请选择合理长度的词句进行复制。');
    clipboard.writeText(text);
  });
  handle('reader:import-book', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: '导入 EPUB 书籍', filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }], properties: ['openFile'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    if (path.extname(filePath).toLowerCase() !== '.epub') throw new Error('请选择 EPUB 文件。');
    const bytes = await readFile(filePath);
    const metadata = await inspectEpub(bytes);
    const book = store.addBook(bytes, { title: metadata.title || path.basename(filePath, path.extname(filePath)), author: metadata.author || '作者未知', fileName: path.basename(filePath) });
    broadcast({ reason: 'books', bookId: book.id });
    return book;
  });
  handle('reader:book-data', id => store.readBook(validId(id)));
  handle('reader:book-cover', id => bookCover(validId(id)));
  handle('reader:update-book', (id, patch) => store.updateBook(validId(id), validBookPatch(patch)));
  handle('reader:list-bookmarks', id => store.listBookmarks(validId(id)));
  handle('reader:add-bookmark', input => {
    const bookmark = store.addBookmark(validBookmark(input));
    broadcast({ reason: 'bookmarks', bookId: bookmark.bookId });
    return bookmark;
  });
  handle('reader:remove-bookmark', id => {
    const bookmark = store.removeBookmark(validId(id));
    if (bookmark) broadcast({ reason: 'bookmarks', bookId: bookmark.bookId });
  });
  handle('reader:list-entries', id => store.listEntries(validId(id)));
  handle('reader:collect', input => {
    const occurrence = store.collect(validCollect(input));
    broadcast({ reason: 'vocabulary', bookId: occurrence.bookId });
    queue.kick();
    return occurrence;
  });
  handle('reader:remove-occurrence', id => {
    const occurrence = store.removeOccurrence(validId(id));
    if (occurrence) broadcast({ reason: 'vocabulary', bookId: occurrence.bookId });
  });
  handle('reader:retry-occurrence', id => {
    const occurrence = store.retry(validId(id));
    if (occurrence) broadcast({ reason: 'vocabulary', bookId: occurrence.bookId });
    queue.resume();
  });
  handle('reader:update-anchor', (id, anchor) => {
    const occurrence = store.updateAnchor(validId(id), validAnchor(anchor));
    if (occurrence) broadcast({ reason: 'vocabulary', bookId: occurrence.bookId });
  });
  handle('reader:get-settings', () => settings());
  handle('reader:save-settings', async input => {
    const update = validSettings(input);
    if (update.apiKey !== undefined) await vault.set(update.apiKey);
    if (update.model !== undefined) store.setSetting('model', update.model);
    queue.resume();
    broadcast({ reason: 'settings' });
    return settings();
  });
  ipcMain.on('reader:set-online', (event, online: unknown) => {
    try { assertTrusted(event); if (typeof online === 'boolean') queue.setOnline(online); } catch { /* Ignore messages from book frames. */ }
  });
  ipcMain.on('reader:close-ready', (event, requestId: unknown, error: unknown) => {
    try { assertTrusted(event); } catch { return; }
    if (!pendingClose || requestId !== pendingClose.id) return;
    const pending = pendingClose;
    pendingClose = undefined;
    clearTimeout(pending.timer);
    if (error) pending.reject(new Error(typeof error === 'string' ? error.slice(0, 2000) : '阅读位置保存失败。'));
    else pending.resolve();
  });
}

async function createWindow(): Promise<void> {
  // A Dock activation must start a fresh save handshake, never reuse one from a
  // destroyed window. The close permission itself is scoped inside lifecycle.
  if (pendingClose) {
    const pending = pendingClose;
    pendingClose = undefined;
    clearTimeout(pending.timer);
    pending.reject(new Error('阅读窗口已重新打开，请重新保存。'));
  }
  const rendererUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  mainWindow = new BrowserWindow({
    width: 1440, height: 960, minWidth: 1050, minHeight: 680,
    title: '阅间 · 英语阅读器', backgroundColor: '#ffffff',
    show: false, autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, offscreen: Boolean(process.env.APP_TEST_MODE), backgroundThrottling: false },
  });
  const window = mainWindow;
  lifecycle.attachWindow(window);
  window.on('close', event => lifecycle.handleClose(window, event));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) console.error(`阅读界面加载失败（${code}）：${description} ${url}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`阅读界面进程已退出：${details.reason}`);
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = rendererUrl ? url.startsWith(`${new URL(rendererUrl).origin}/`) : url === window.webContents.getURL();
    if (!allowed) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const allowed = rendererUrl && new URL(details.url).origin === new URL(rendererUrl).origin;
    callback({ cancel: !allowed });
  });
  window.once('ready-to-show', () => { if (!process.env.APP_TEST_MODE) window.show(); });
  window.on('closed', () => {
    if (pendingClose?.window === window) {
      const pending = pendingClose;
      pendingClose = undefined;
      clearTimeout(pending.timer);
      pending.reject(new Error('阅读窗口已关闭。'));
    }
    if (mainWindow === window) mainWindow = null;
    lifecycle.windowClosed(window);
  });
  if (rendererUrl) {
    await window.loadURL(rendererUrl);
    // A successful development load must not depend on the first paint event to become visible.
    if (!process.env.APP_TEST_MODE && !window.isDestroyed()) {
      window.show();
      window.focus();
      console.log('阅间桌面窗口已打开。');
    }
  } else await window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

const hasLock = process.env.APP_TEST_MODE || app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => {
    if (app.isReady() && store) void lifecycle.activate().catch(error => dialog.showErrorBox('无法打开阅间', String(error)));
  });
  app.on('activate', () => {
    if (app.isReady() && store) void lifecycle.activate().catch(error => dialog.showErrorBox('无法打开阅间', String(error)));
  });
  app.on('before-quit', event => lifecycle.beforeQuit(event));
  app.whenReady().then(async () => {
    store = new ReaderStore(app.getPath('userData'));
    vault = new KeyVault(app.getPath('userData'));
    queue = new AnalysisQueue(store, { getApiKey: () => vault.get(), getModel: () => store.getSetting('model') || 'deepseek-flash', onChange: broadcast });
    const menuTemplate = applicationMenuTemplate(process.platform);
    Menu.setApplicationMenu(menuTemplate ? Menu.buildFromTemplate(menuTemplate) : null);
    registerIpc();
    await createWindow();
    queue.start();
  }).catch(error => {
    dialog.showErrorBox('无法启动阅间', error instanceof Error ? error.message : '本机数据暂时无法打开。');
    lifecycle.abortStartup();
  });
  app.on('window-all-closed', () => lifecycle.allWindowsClosed());
  // Keep SQLite open through the renderer's final flush. will-quit occurs only
  // after the close handshake has completed and all windows have gone away.
  app.on('will-quit', event => lifecycle.willQuit(event));
}
