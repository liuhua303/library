// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookRecord, DataChange, ReaderApi } from '../src/shared/types';
import type { EpubReaderProps } from '../src/renderer/components/EpubReader';

const reader = vi.hoisted(() => ({ props: null as EpubReaderProps | null }));
vi.mock('../src/renderer/components/EpubReader', () => ({
  EpubReader: (props: EpubReaderProps) => {
    reader.props = props;
    return <section data-testid="reader-mock">
      <button aria-label="返回书架" onClick={props.onBack}>返回书架</button>
      <button aria-label="增大字号" onClick={() => props.onFontSizeChange(2)}>增大字号</button>
      <button aria-label="主题 paper" onClick={() => props.onThemeChange('paper')}>paper</button>
      <button aria-label="主题 quiet" onClick={() => props.onThemeChange('quiet')}>quiet</button>
    </section>;
  },
}));

import { App } from '../src/renderer/App';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const initialBook: BookRecord = {
  id: 'navigation-book', title: 'Navigation Sample', author: 'Test', fileName: 'sample.epub',
  importedAt: '2026-11-26T00:00:00.000Z', lastLocation: 'page-1', progress: 0.1, fontSize: 20,
};

let host: HTMLDivElement;
let root: Root;
let persisted: BookRecord;
let notify: (change: DataChange) => void;
let api: ReaderApi;

async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.getAttribute('aria-label') === label);
  expect(button, `Missing button: ${label}`).toBeDefined();
  await act(async () => { button!.click(); });
}

async function openFromShelf() {
  expect(host.querySelector('[data-testid="bookshelf"]')).not.toBeNull();
  await click('阅读 Navigation Sample');
  expect(host.querySelector('[data-testid="reader-mock"]')).not.toBeNull();
}

async function reopenFromShelf() {
  await click('返回书架');
  await openFromShelf();
}

async function relocate(cfi: string, progress: number) {
  await act(async () => {
    reader.props!.onLocationChange({ cfi, progress });
    await vi.advanceTimersByTimeAsync(250);
  });
}

async function requestStaleSnapshot() {
  const response = deferred<BookRecord[]>();
  vi.mocked(api.listBooks).mockReturnValueOnce(response.promise);
  await act(async () => {
    notify({ reason: 'books' });
    await vi.advanceTimersByTimeAsync(60);
  });
  expect(api.listBooks).toHaveBeenCalledTimes(2);
  return response;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  reader.props = null;
  persisted = { ...initialBook };
  notify = () => {};
  api = {
    listBooks: vi.fn(async () => [{ ...persisted }]),
    importBook: vi.fn(async () => null),
    getBookCover: vi.fn(async () => null),
    getBookData: vi.fn(async () => new Uint8Array()),
    updateBook: vi.fn(async (_id, patch) => { persisted = { ...persisted, ...patch }; return { ...persisted }; }),
    listBookmarks: vi.fn(async () => []), addBookmark: vi.fn(), removeBookmark: vi.fn(async () => {}),
    listEntries: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({ hasApiKey: false, model: 'test-model' })),
    onDataChanged: vi.fn(listener => { notify = listener; return () => {}; }),
    setOnline: vi.fn(), copyText: vi.fn(async () => {}),
    collect: vi.fn(), removeOccurrence: vi.fn(async () => {}), retryOccurrence: vi.fn(async () => {}),
    updateAnchor: vi.fn(async () => {}), saveSettings: vi.fn(),
  };
  window.readerApi = api;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<App />); });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('bookshelf navigation with asynchronous book updates', () => {
  it('keeps a saved language correction when an earlier library snapshot arrives', async () => {
    await openFromShelf();
    const stale = await requestStaleSnapshot();
    await act(async () => { await reader.props!.onLanguageChange('ja'); });
    expect(api.updateBook).toHaveBeenCalledWith(initialBook.id, { language: 'ja' });
    await act(async () => { stale.resolve([{ ...initialBook }]); });
    await reopenFromShelf();
    expect(reader.props!.book).toMatchObject({ language: 'ja', languageSource: 'manual', lastLocation: initialBook.lastLocation });
  });

  it('continues using the saved language when a language correction fails', async () => {
    await openFromShelf();
    vi.mocked(api.updateBook).mockRejectedValueOnce(new Error('Language save failed'));
    await act(async () => { await reader.props!.onLanguageChange('ja'); });
    expect(reader.props!.book.language ?? 'en').toBe('en');
    expect(host.querySelector('.app-error')?.textContent).toContain('Language save failed');
    await reopenFromShelf();
    expect(reader.props!.book.language ?? 'en').toBe('en');
  });

  it('resumes the newest saved location after an older library snapshot returns', async () => {
    await openFromShelf();
    const stale = await requestStaleSnapshot();
    await relocate('page-2', 0.2);
    expect(persisted.lastLocation).toBe('page-2');

    await act(async () => { stale.resolve([{ ...initialBook }]); });
    await reopenFromShelf();

    expect(reader.props!.book).toMatchObject({ lastLocation: 'page-2', progress: 0.2 });
  });

  it('does not resume an old page when its write acknowledgement arrives after a newer write', async () => {
    await openFromShelf();
    const oldWrite = deferred<BookRecord>();
    vi.mocked(api.updateBook).mockImplementationOnce(async (_id, patch) => {
      persisted = { ...persisted, ...patch };
      return oldWrite.promise;
    });
    await relocate('page-2', 0.2);
    await relocate('page-3', 0.3);
    expect(persisted.lastLocation).toBe('page-3');

    await act(async () => { oldWrite.resolve({ ...initialBook, lastLocation: 'page-2', progress: 0.2 }); });
    await reopenFromShelf();

    expect(reader.props!.book).toMatchObject({ lastLocation: 'page-3', progress: 0.3 });
    expect(api.updateBook).toHaveBeenCalledTimes(2);
  });

  it('preserves the chosen font when a library snapshot predating that choice returns', async () => {
    await openFromShelf();
    const stale = await requestStaleSnapshot();
    await click('增大字号');
    expect(persisted.fontSize).toBe(22);

    await act(async () => { stale.resolve([{ ...initialBook }]); });
    await reopenFromShelf();

    expect(reader.props!.book.fontSize).toBe(22);
  });

  it('saves a book theme and restores it when the app is mounted again', async () => {
    await openFromShelf();
    await click('主题 paper');
    expect(api.updateBook).toHaveBeenCalledWith(initialBook.id, { theme: 'paper' });
    expect(persisted.theme).toBe('paper');

    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await act(async () => { root.render(<App />); });
    await openFromShelf();

    expect(reader.props!.book.theme).toBe('paper');
    expect(host.querySelector('.reading-layout')?.getAttribute('data-reader-theme')).toBe('paper');
  });

  it('preserves the chosen theme when an older library snapshot returns', async () => {
    await openFromShelf();
    const stale = await requestStaleSnapshot();
    await click('主题 quiet');
    expect(persisted.theme).toBe('quiet');

    await act(async () => { stale.resolve([{ ...initialBook }]); });
    await reopenFromShelf();

    expect(reader.props!.book.theme).toBe('quiet');
  });

  it('does not roll back a newer theme selection when an older request for that same theme fails', async () => {
    await openFromShelf();
    const oldWrite = deferred<BookRecord>();
    vi.mocked(api.updateBook).mockImplementationOnce(() => oldWrite.promise);
    await click('主题 paper');
    await click('主题 quiet');
    await click('主题 paper');
    expect(persisted.theme).toBe('paper');

    await act(async () => { oldWrite.reject(new Error('Earlier theme write failed')); });
    await reopenFromShelf();

    expect(reader.props!.book.theme).toBe('paper');
    expect(api.updateBook).toHaveBeenCalledTimes(3);
  });

  it('restores the previous theme when the latest save fails', async () => {
    await openFromShelf();
    await click('主题 paper');
    vi.mocked(api.updateBook).mockRejectedValueOnce(new Error('Theme save failed'));
    await click('主题 quiet');

    expect(reader.props!.book.theme).toBe('paper');
    expect(persisted.theme).toBe('paper');
    await reopenFromShelf();
    expect(reader.props!.book.theme).toBe('paper');
  });

  it('returns to the last saved theme when two rapid theme selections both fail', async () => {
    await openFromShelf();
    const firstWrite = deferred<BookRecord>();
    const latestWrite = deferred<BookRecord>();
    vi.mocked(api.updateBook).mockImplementationOnce(() => firstWrite.promise).mockImplementationOnce(() => latestWrite.promise);
    await click('主题 paper');
    await click('主题 quiet');
    expect(reader.props!.book.theme).toBe('quiet');

    await act(async () => { firstWrite.reject(new Error('First theme save failed')); });
    expect(reader.props!.book.theme).toBe('quiet');
    await act(async () => { latestWrite.reject(new Error('Latest theme save failed')); });
    await reopenFromShelf();

    expect(reader.props!.book.theme).toBe('original');
    expect(persisted.theme).toBeUndefined();
    expect(host.querySelector('.app-shell')?.getAttribute('data-reader-theme')).toBe('original');
  });

  it('uses an earlier successful save as fallback when its acknowledgement arrives after the latest failure', async () => {
    await openFromShelf();
    const firstWrite = deferred<BookRecord>();
    const latestWrite = deferred<BookRecord>();
    vi.mocked(api.updateBook).mockImplementationOnce(async (_id, patch) => {
      persisted = { ...persisted, ...patch };
      return firstWrite.promise;
    }).mockImplementationOnce(() => latestWrite.promise);
    await click('主题 paper');
    await click('主题 quiet');

    await act(async () => { latestWrite.reject(new Error('Latest theme save failed')); });
    await act(async () => { firstWrite.resolve({ ...persisted }); });
    await reopenFromShelf();

    expect(reader.props!.book.theme).toBe('paper');
    expect(persisted.theme).toBe('paper');
  });

  it('keeps the newer successful theme when an older success acknowledgement arrives later', async () => {
    await openFromShelf();
    const firstWrite = deferred<BookRecord>();
    vi.mocked(api.updateBook).mockImplementationOnce(async (_id, patch) => {
      persisted = { ...persisted, ...patch };
      return firstWrite.promise;
    });
    await click('主题 paper');
    await click('主题 quiet');
    await act(async () => { firstWrite.resolve({ ...initialBook, theme: 'paper' }); });
    await reopenFromShelf();

    expect(reader.props!.book.theme).toBe('quiet');
    expect(persisted.theme).toBe('quiet');
  });
});
