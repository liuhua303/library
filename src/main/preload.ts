import { contextBridge, ipcRenderer } from 'electron';
import type { DataChange, ReaderApi } from '../shared/types';
import { BookWriteBuffer } from './book-write-buffer';

const bookWrites = new BookWriteBuffer((bookId, patch) => ipcRenderer.invoke('reader:update-book', bookId, patch));

ipcRenderer.on('reader:prepare-close', async (_event, requestId: unknown) => {
  if (typeof requestId !== 'string' || requestId.length > 100) return;
  try {
    // Reuse the app's existing position flush listener, then await its actual IPC save.
    window.dispatchEvent(new Event('beforeunload'));
    await bookWrites.flush();
    // Cover a relocation that settled while the previous save was being acknowledged.
    window.dispatchEvent(new Event('beforeunload'));
    await bookWrites.flush();
    ipcRenderer.send('reader:close-ready', requestId, null);
  } catch (error) {
    ipcRenderer.send('reader:close-ready', requestId, error instanceof Error ? error.message : '阅读位置保存失败。');
  }
});

const api: ReaderApi = {
  listBooks: () => ipcRenderer.invoke('reader:list-books'),
  importBook: () => ipcRenderer.invoke('reader:import-book'),
  copyText: text => ipcRenderer.invoke('reader:copy-text', text),
  getBookData: bookId => ipcRenderer.invoke('reader:book-data', bookId),
  getBookCover: bookId => ipcRenderer.invoke('reader:book-cover', bookId),
  updateBook: (bookId, patch) => bookWrites.save(bookId, patch),
  listBookmarks: bookId => ipcRenderer.invoke('reader:list-bookmarks', bookId),
  addBookmark: input => ipcRenderer.invoke('reader:add-bookmark', input),
  removeBookmark: id => ipcRenderer.invoke('reader:remove-bookmark', id),
  listEntries: bookId => ipcRenderer.invoke('reader:list-entries', bookId),
  collect: input => ipcRenderer.invoke('reader:collect', input),
  removeOccurrence: id => ipcRenderer.invoke('reader:remove-occurrence', id),
  retryOccurrence: (id, replacement) => ipcRenderer.invoke('reader:retry-occurrence', id, replacement),
  updateAnchor: (id, anchor) => ipcRenderer.invoke('reader:update-anchor', id, anchor),
  getSettings: () => ipcRenderer.invoke('reader:get-settings'),
  saveSettings: settings => ipcRenderer.invoke('reader:save-settings', settings),
  setOnline: online => ipcRenderer.send('reader:set-online', online),
  onDataChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, change: DataChange) => listener(change);
    ipcRenderer.on('reader:data-changed', handler);
    return () => ipcRenderer.removeListener('reader:data-changed', handler);
  },
};

contextBridge.exposeInMainWorld('readerApi', api);
