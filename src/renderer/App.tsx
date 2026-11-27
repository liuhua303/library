import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, CircleAlert, Clock3, Eye, EyeOff, KeyRound, LoaderCircle, Plus, Settings, Trash2, WifiOff, X } from 'lucide-react';
import type { AppSettings, BookRecord, CollectInput, DataChange, Occurrence, ReaderTheme, TaskStatus, VocabularyEntry } from '../shared/types';
import { EpubReader } from './components/EpubReader';
import { findPhraseBounds } from './reader/text';

const KIND_LABEL = { word: '单词', phrase: '短语', sentence: '句子' };

interface ThemeSaveState {
  confirmedTheme: ReaderTheme;
  confirmedVersion: number;
  latestVersion: number;
  latestFailed: boolean;
}

function BookCover({ book, onOpen }: { book: BookRecord; onOpen: () => void }) {
  const [cover, setCover] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setCover(null);
    if (typeof window.readerApi?.getBookCover === 'function') {
      void window.readerApi.getBookCover(book.id).then(image => {
        if (!cancelled) setCover(image);
      }).catch(() => { /* A missing cover must not prevent opening a book. */ });
    }
    return () => { cancelled = true; };
  }, [book.id]);

  const percentage = Math.round(Math.min(1, Math.max(0, Number.isFinite(book.progress) ? book.progress : 0)) * 100);

  return <button className="book-cover-button" onClick={onOpen} aria-label={`阅读 ${book.title}`} title={book.title}>
    <span className="book-cover-slot"><span className="book-cover-object">
      {cover ? <img className="book-cover-image" src={cover} alt="" draggable={false} onError={() => setCover(null)} />
        : <span className="book-cover-fallback"><span>{book.title}</span></span>}
    </span></span>
    <span className="book-progress" aria-label={`已读 ${percentage}%`}>{percentage}%</span>
  </button>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error);
}

function collectionDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function normalizedSource(value: string) {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function sourceExcerpt(occurrence: Occurrence): { text: string; markStart: number; markEnd: number } {
  const context = occurrence.context;
  const target = occurrence.targetText || occurrence.selectedText;
  // Context is a slice of the original chapter, so its origin stays the original anchor's offset.
  const contextOrigin = occurrence.originalAnchor.contextStartOffset;
  const relative = (anchor: Occurrence['anchor']) => ({
    start: anchor.startOffset - contextOrigin,
    end: anchor.endOffset - contextOrigin,
  });
  const valid = (bounds: { start: number; end: number }, expected: string) =>
    Number.isInteger(bounds.start) && Number.isInteger(bounds.end)
    && bounds.start >= 0 && bounds.end > bounds.start && bounds.end <= context.length
    && normalizedSource(context.slice(bounds.start, bounds.end)) === normalizedSource(expected);

  const original = relative(occurrence.originalAnchor);
  const resolved = relative(occurrence.anchor);
  const originalValid = valid(original, occurrence.selectedText);
  const resolvedValid = valid(resolved, target)
    && (!originalValid || (resolved.start <= original.start && resolved.end >= original.end));
  const bounds = resolvedValid ? resolved : originalValid
    ? findPhraseBounds(context, target, original) || original
    : null;

  // A stale or unavailable anchor must not highlight an unrelated occurrence in the paragraph.
  if (!bounds) return { text: occurrence.selectedText, markStart: 0, markEnd: occurrence.selectedText.length };
  if (occurrence.kind === 'sentence') {
    const text = context.slice(bounds.start, bounds.end);
    return { text, markStart: 0, markEnd: text.length };
  }
  let start = context.length <= 320 ? 0 : Math.max(0, bounds.start - 100);
  let end = context.length <= 320 ? context.length : Math.min(context.length, bounds.end + 190);
  const clippedStart = start > 0;
  const clippedEnd = end < context.length;
  // Trim only outside the marked span, preserving the exact relationship to source offsets.
  while (start < bounds.start && /\s/u.test(context[start])) start++;
  while (end > bounds.end && /\s/u.test(context[end - 1])) end--;
  const prefix = clippedStart ? '…' : '';
  return {
    text: `${prefix}${context.slice(start, end)}${clippedEnd ? '…' : ''}`,
    markStart: prefix.length + bounds.start - start,
    markEnd: prefix.length + bounds.end - start,
  };
}

function SourceText({ occurrence }: { occurrence: Occurrence }) {
  const { text, markStart, markEnd } = sourceExcerpt(occurrence);
  return <>{text.slice(0, markStart)}<mark>{text.slice(markStart, markEnd)}</mark>{text.slice(markEnd)}</>;
}

function mergeOccurrence(entries: VocabularyEntry[], occurrence: Occurrence) {
  const normalized = occurrence.targetText.trim().toLocaleLowerCase();
  const without = entries.map(entry => ({ ...entry, occurrences: entry.occurrences.filter(item => item.id !== occurrence.id) })).filter(entry => entry.occurrences.length);
  const existing = without.find(entry => entry.kind === occurrence.kind && entry.term.trim().toLocaleLowerCase() === normalized);
  if (existing) {
    existing.occurrences = [occurrence, ...existing.occurrences];
    existing.latestCollectedAt = [existing.latestCollectedAt, occurrence.collectedAt].sort().at(-1)!;
  } else {
    without.push({ id: `local:${occurrence.id}`, term: occurrence.targetText, kind: occurrence.kind, latestCollectedAt: occurrence.collectedAt, occurrences: [occurrence] });
  }
  return without.sort((a, b) => b.latestCollectedAt.localeCompare(a.latestCollectedAt));
}

function Status({ status, error }: { status: TaskStatus; error: string | null }) {
  const labels: Record<TaskStatus, string> = { pending: '等待解析', processing: '正在解析', waiting_network: '等待联网', needs_key: '等待配置密钥', failed: '解析未完成', completed: '已解析' };
  const Icon = status === 'processing' ? LoaderCircle : status === 'waiting_network' ? WifiOff : status === 'needs_key' ? KeyRound : status === 'failed' ? CircleAlert : status === 'completed' ? Check : Clock3;
  return <div className={`task-status task-status--${status}`} role="status"><Icon size={14} className={status === 'processing' ? 'spinning' : ''} /><span>{labels[status]}</span>{error && <p className="task-error">{error}</p>}</div>;
}

function SettingsDialog({ settings, onClose, onSaved }: { settings: AppSettings; onClose: () => void; onSaved: (settings: AppSettings) => void }) {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(settings.model || 'deepseek-flash');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLInputElement>('input')?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab' && dialog) {
        const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]')];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); triggerRef.current?.focus(); };
  }, [onClose]);

  async function save(clear = false) {
    setSaving(true); setError(''); setSaved(false);
    try {
      const next = await window.readerApi.saveSettings({ model: model.trim() || 'deepseek-flash', ...(clear ? { apiKey: '' } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      onSaved(next); setApiKey(''); setSaved(true);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setSaving(false); }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <div className="settings-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="dialog-top"><h2 id="settings-title">设置</h2><button className="icon-button" aria-label="关闭设置" onClick={onClose}><X size={20} /></button></div>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <label className="field-label" htmlFor="api-key">DeepSeek API 密钥 <span className={settings.hasApiKey ? 'key-saved' : 'muted'}>{settings.hasApiKey ? '已保存' : '尚未配置'}</span></label>
        <div className="password-field"><input id="api-key" autoComplete="off" spellCheck={false} type={showKey ? 'text' : 'password'} value={apiKey} onChange={event => { setApiKey(event.target.value); setSaved(false); }} placeholder={settings.hasApiKey ? '输入新密钥以替换，留空则保留' : '粘贴你的 API 密钥'} /><button type="button" className="icon-button" aria-label={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
        <label className="field-label model-label" htmlFor="model-name">模型名称</label>
        <input id="model-name" className="text-input" value={model} spellCheck={false} onChange={event => { setModel(event.target.value); setSaved(false); }} placeholder="deepseek-flash" />
        {error && <div className="inline-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
        {saved && <p className="settings-success" role="status"><Check size={16} />已保存</p>}
        <div className="dialog-actions">{settings.hasApiKey && <button className="text-button delete-key" type="button" disabled={saving} onClick={() => void save(true)}>移除密钥</button>}<button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle size={16} className="spinning" /> : <Check size={16} />}{saving ? '正在保存' : '保存设置'}</button></div>
      </form>
    </div>
  </div>;
}

export function App() {
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [entries, setEntries] = useState<VocabularyEntry[]>([]);
  const [settings, setSettings] = useState<AppSettings>({ hasApiKey: false, model: 'deepseek-flash' });
  const [initializing, setInitializing] = useState(true);
  const [importing, setImporting] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [error, setError] = useState('');
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());
  const [viewRequest, setViewRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [readerFocus, setReaderFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const currentBookId = useRef<string | null>(null);
  const entryRequest = useRef(0);
  const scrolledView = useRef(0);
  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPosition = useRef<{ bookId: string; cfi: string; progress: number } | null>(null);
  const alive = useRef(true);
  const notebookRef = useRef<HTMLElement>(null);
  // All book writes originate here. Keep the latest local fields authoritative over
  // older list/write responses, including while the reader is temporarily unmounted.
  const localBookUpdates = useRef(new Map<string, Partial<Pick<BookRecord, 'lastLocation' | 'progress' | 'fontSize' | 'theme'>>>());
  const themeSaveStates = useRef(new Map<string, ThemeSaveState>());
  const mergeBookSnapshot = useCallback((book: BookRecord): BookRecord => ({ ...book, ...localBookUpdates.current.get(book.id) }), []);
  const activeBook = books.find(book => book.id === selectedBookId) || null;
  const occurrences = useMemo(() => entries.flatMap(entry => entry.occurrences), [entries]);
  const bridgeAvailable = typeof window.readerApi !== 'undefined';

  const refreshEntries = useCallback(async (bookId: string) => {
    const request = ++entryRequest.current;
    try {
      const next = await window.readerApi.listEntries(bookId);
      if (alive.current && request === entryRequest.current && currentBookId.current === bookId) setEntries(next);
      return next;
    } catch (reason) { if (alive.current && currentBookId.current === bookId) setError(errorMessage(reason)); return []; }
  }, []);

  const flushPosition = useCallback(() => {
    if (positionTimer.current) { clearTimeout(positionTimer.current); positionTimer.current = null; }
    const pending = pendingPosition.current;
    if (!pending || !window.readerApi) return;
    pendingPosition.current = null;
    setBooks(current => current.map(book => book.id === pending.bookId
      ? { ...book, lastLocation: pending.cfi, progress: pending.progress } : book));
    void window.readerApi.updateBook(pending.bookId, { lastLocation: pending.cfi, progress: pending.progress }).then(next => {
      if (alive.current) setBooks(current => current.map(book => book.id === next.id ? mergeBookSnapshot({ ...book, lastLocation: next.lastLocation, progress: next.progress }) : book));
    }).catch(reason => { if (alive.current) setError(errorMessage(reason)); });
  }, [mergeBookSnapshot]);

  useEffect(() => {
    alive.current = true;
    if (!window.readerApi) { setInitializing(false); setError('请从阅间桌面应用打开。'); return; }
    void Promise.all([window.readerApi.listBooks(), window.readerApi.getSettings()]).then(([nextBooks, nextSettings]) => {
      if (!alive.current) return;
      setBooks(nextBooks.map(mergeBookSnapshot)); setSettings(nextSettings);
    }).catch(reason => { if (alive.current) setError(errorMessage(reason)); }).finally(() => { if (alive.current) setInitializing(false); });
    const handleConnectivity = () => { setOnline(navigator.onLine); window.readerApi.setOnline(navigator.onLine); };
    handleConnectivity();
    window.addEventListener('online', handleConnectivity); window.addEventListener('offline', handleConnectivity);
    let changeTimer: ReturnType<typeof setTimeout> | undefined;
    const dirtyReasons = new Set<DataChange['reason']>();
    const dirtyVocabularyBooks = new Set<string>();
    let allVocabularyBooksDirty = false;
    const unsubscribe = window.readerApi.onDataChanged(change => {
      dirtyReasons.add(change.reason);
      if (change.reason === 'vocabulary') {
        if (change.bookId) dirtyVocabularyBooks.add(change.bookId);
        else allVocabularyBooksDirty = true;
      }
      // Keep every event kind within the batch; a busy queue must not postpone the flush.
      if (changeTimer !== undefined) return;
      changeTimer = setTimeout(() => {
        changeTimer = undefined;
        const refreshBooks = dirtyReasons.has('books');
        const refreshSettings = dirtyReasons.has('settings');
        const bookId = currentBookId.current;
        const refreshVocabulary = dirtyReasons.has('vocabulary') && bookId
          && (allVocabularyBooksDirty || dirtyVocabularyBooks.has(bookId));
        dirtyReasons.clear(); dirtyVocabularyBooks.clear(); allVocabularyBooksDirty = false;
        if (!alive.current) return;
        if (refreshBooks) void window.readerApi.listBooks().then(next => { if (alive.current) setBooks(next.map(mergeBookSnapshot)); }).catch(reason => { if (alive.current) setError(errorMessage(reason)); });
        if (refreshSettings) void window.readerApi.getSettings().then(next => { if (alive.current) setSettings(next); }).catch(() => undefined);
        if (refreshVocabulary && bookId) void refreshEntries(bookId);
      }, 60);
    });
    const visibility = () => { if (document.visibilityState === 'hidden') flushPosition(); };
    window.addEventListener('beforeunload', flushPosition); document.addEventListener('visibilitychange', visibility);
    return () => {
      flushPosition(); alive.current = false;
      if (changeTimer) clearTimeout(changeTimer);
      unsubscribe(); window.removeEventListener('online', handleConnectivity); window.removeEventListener('offline', handleConnectivity);
      window.removeEventListener('beforeunload', flushPosition); document.removeEventListener('visibilitychange', visibility);
    };
  }, [flushPosition, refreshEntries, mergeBookSnapshot]);

  useEffect(() => {
    currentBookId.current = selectedBookId;
    setEntries([]); setExpandedEntries(new Set()); setViewRequest(null); setReaderFocus(null);
    if (selectedBookId && window.readerApi) {
      void refreshEntries(selectedBookId);
    }
  }, [selectedBookId, refreshEntries]);

  useEffect(() => { document.title = activeBook ? `${activeBook.title} · 阅间` : '阅间 · 英语阅读器'; }, [activeBook?.title]);

  useEffect(() => {
    if (!sidebarOpen || !viewRequest || viewRequest.nonce === scrolledView.current) return;
    const entry = entries.find(item => item.occurrences.some(occurrence => occurrence.id === viewRequest.id));
    if (!entry) return;
    if (!expandedEntries.has(entry.id)) {
      setExpandedEntries(previous => new Set([...previous, entry.id])); return;
    }
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(`occurrence-${viewRequest.id}`);
      if (element) { element.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); scrolledView.current = viewRequest.nonce; }
    });
    return () => cancelAnimationFrame(frame);
  }, [entries, sidebarOpen, viewRequest, expandedEntries]);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openSettings = useCallback(() => { if (!currentBookId.current) setSettingsOpen(true); }, []);
  const toggleNotebook = useCallback(() => setSidebarOpen(value => !value), []);

  useEffect(() => {
    if (!sidebarOpen || settingsOpen) return;
    const frame = requestAnimationFrame(() => notebookRef.current?.querySelector<HTMLButtonElement>('[aria-label="关闭单词本"]')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [sidebarOpen, settingsOpen]);

  async function importBook() {
    if (!window.readerApi || importing) return;
    setImporting(true); setError('');
    try {
      flushPosition();
      const imported = await window.readerApi.importBook();
      if (!imported) return;
      setBooks(current => [mergeBookSnapshot(imported), ...current.filter(book => book.id !== imported.id)]);
      setSettingsOpen(false);
      setSidebarOpen(false);
      currentBookId.current = imported.id; setSelectedBookId(imported.id);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setImporting(false); }
  }

  function selectBook(bookId: string) {
    if (bookId === selectedBookId) return;
    flushPosition(); setError(''); setSidebarOpen(false); setSettingsOpen(false); currentBookId.current = bookId; setSelectedBookId(bookId);
  }

  function returnToShelf() {
    flushPosition(); setSidebarOpen(false); setError(''); currentBookId.current = null; setSelectedBookId(null);
  }

  const handleCollect = useCallback(async (input: CollectInput) => {
    const occurrence = await window.readerApi.collect(input);
    if (currentBookId.current === input.bookId) setEntries(current => mergeOccurrence(current, occurrence));
    return occurrence;
  }, []);

  const handleRemove = useCallback(async (id: string) => {
    await window.readerApi.removeOccurrence(id);
    setEntries(current => current.map(entry => ({ ...entry, occurrences: entry.occurrences.filter(item => item.id !== id) })).filter(entry => entry.occurrences.length));
    if (currentBookId.current) void refreshEntries(currentBookId.current);
  }, [refreshEntries]);

  const handleView = useCallback((id: string) => {
    setSidebarOpen(true); setViewRequest({ id, nonce: Date.now() });
    if (currentBookId.current) void refreshEntries(currentBookId.current);
  }, [refreshEntries]);

  const handleLocation = useCallback((location: { cfi: string; progress: number }) => {
    const bookId = currentBookId.current;
    if (!bookId || !location.cfi) return;
    localBookUpdates.current.set(bookId, { ...localBookUpdates.current.get(bookId), lastLocation: location.cfi, progress: location.progress });
    pendingPosition.current = { bookId, ...location };
    if (positionTimer.current) clearTimeout(positionTimer.current);
    positionTimer.current = setTimeout(flushPosition, 250);
  }, [flushPosition]);

  async function changeFontSize(delta: number) {
    if (!activeBook) return;
    const bookId = activeBook.id;
    const previousSize = activeBook.fontSize;
    const size = Math.min(34, Math.max(14, activeBook.fontSize + delta));
    localBookUpdates.current.set(bookId, { ...localBookUpdates.current.get(bookId), fontSize: size });
    setBooks(current => current.map(book => book.id === bookId ? { ...book, fontSize: size } : book));
    try { await window.readerApi.updateBook(bookId, { fontSize: size }); }
    catch (reason) {
      if (localBookUpdates.current.get(bookId)?.fontSize === size) {
        localBookUpdates.current.set(bookId, { ...localBookUpdates.current.get(bookId), fontSize: previousSize });
        setBooks(current => current.map(book => book.id === bookId ? { ...book, fontSize: previousSize } : book));
      }
      setError(errorMessage(reason));
    }
  }

  async function changeTheme(theme: ReaderTheme) {
    if (!activeBook || theme === (activeBook.theme ?? 'original')) return;
    const bookId = activeBook.id;
    const saveState = themeSaveStates.current.get(bookId) ?? {
      confirmedTheme: activeBook.theme ?? 'original', confirmedVersion: 0, latestVersion: 0, latestFailed: false,
    };
    themeSaveStates.current.set(bookId, saveState);
    const version = ++saveState.latestVersion;
    saveState.latestFailed = false;
    const restoreConfirmedTheme = () => {
      const confirmedTheme = saveState.confirmedTheme;
      localBookUpdates.current.set(bookId, { ...localBookUpdates.current.get(bookId), theme: confirmedTheme });
      if (alive.current) setBooks(current => current.map(book => book.id === bookId ? { ...book, theme: confirmedTheme } : book));
    };
    localBookUpdates.current.set(bookId, { ...localBookUpdates.current.get(bookId), theme });
    setBooks(current => current.map(book => book.id === bookId ? { ...book, theme } : book));
    try {
      const saved = await window.readerApi.updateBook(bookId, { theme });
      if (version > saveState.confirmedVersion) {
        saveState.confirmedVersion = version;
        saveState.confirmedTheme = saved.theme ?? 'original';
      }
      // A late success may be the valid fallback for a newer failed choice.
      // Older acknowledgements cannot replace a newer successful theme.
      if (version === saveState.latestVersion || saveState.latestFailed) restoreConfirmedTheme();
    }
    catch (reason) {
      if (saveState.latestVersion === version) {
        saveState.latestFailed = true;
        restoreConfirmedTheme();
      }
      if (alive.current) setError(errorMessage(reason));
    }
  }

  async function retry(id: string) {
    setRetryingIds(previous => new Set([...previous, id]));
    try { await window.readerApi.retryOccurrence(id); if (currentBookId.current) await refreshEntries(currentBookId.current); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setRetryingIds(previous => { const next = new Set(previous); next.delete(id); return next; }); }
  }

  function toggleEntry(id: string) {
    setExpandedEntries(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  return <div className="app-shell" data-reader-theme={activeBook ? activeBook.theme ?? 'original' : undefined}>
    {error && <div className="app-error" role="alert"><CircleAlert size={18} /><span>{error}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setError('')}><X size={18} /></button></div>}
    {initializing ? <main className="app-loading" role="status"><LoaderCircle size={24} className="spinning" /><span>正在加载</span></main>
      : !activeBook ? <main className="shelf-page" data-testid="bookshelf">
        <header className="shelf-header"><h1>书架</h1><div className="shelf-actions">
          {books.length > 0 && <button className="icon-button shelf-import" aria-label="导入 EPUB" title="导入 EPUB" onClick={() => void importBook()} disabled={importing || !bridgeAvailable}>{importing ? <LoaderCircle size={20} className="spinning" /> : <Plus size={22} />}</button>}
          <button className="icon-button" aria-label="设置" title="设置" onClick={openSettings} disabled={!bridgeAvailable}><Settings size={21} /></button>
        </div></header>
        {books.length ? <nav className="cover-grid" aria-label="我的书籍">{books.map(book => <BookCover key={book.id} book={book} onOpen={() => selectBook(book.id)} />)}</nav>
          : <div className="shelf-empty"><button className="primary-button" aria-label="导入 EPUB" onClick={() => void importBook()} disabled={importing || !bridgeAvailable}>{importing ? <LoaderCircle size={18} className="spinning" /> : <Plus size={20} />}{importing ? '正在导入' : '导入 EPUB'}</button></div>}
      </main> : <main className="reading-layout" data-reader-theme={activeBook.theme ?? 'original'}>
        <section className="reading-space" aria-label="阅读区">
          <EpubReader book={activeBook} occurrences={occurrences} focusOccurrenceId={readerFocus?.id} focusNonce={readerFocus?.nonce}
            onCollect={handleCollect} onView={handleView} onRemove={handleRemove} onLocationChange={handleLocation} onError={setError}
            onBack={returnToShelf} onFontSizeChange={delta => void changeFontSize(delta)} onThemeChange={theme => void changeTheme(theme)}
            onToggleNotebook={toggleNotebook} notebookOpen={sidebarOpen} shortcutsDisabled={settingsOpen} />
        </section>
        {sidebarOpen && <aside className="vocabulary-sidebar" ref={notebookRef} data-testid="vocabulary-sidebar" aria-label="本书单词本">
          <header className="vocabulary-header"><h2>单词本</h2><div className="notebook-actions">
            {!online && <span className="notebook-offline" title="离线"><WifiOff size={16} aria-label="离线" /></span>}
            <button className="icon-button" aria-label="关闭单词本" onClick={() => setSidebarOpen(false)}><X size={21} /></button>
          </div></header>
          {!settings.hasApiKey && entries.length > 0 && <p className="configure-notice"><KeyRound size={16} /><span>返回书架配置密钥</span></p>}
          <div className="vocabulary-scroll">
            {!entries.length ? <p className="vocabulary-empty">暂无收录</p> : entries.map(entry => {
              const expanded = expandedEntries.has(entry.id);
              const latest = entry.occurrences[0];
              return <article key={entry.id} className={`vocabulary-entry${expanded ? ' vocabulary-entry--expanded' : ''}`} data-testid={`entry-${entry.id}`}>
                <button className="entry-heading" aria-expanded={expanded} aria-controls={`entry-body-${entry.id}`} onClick={() => toggleEntry(entry.id)}>
                  <span className="entry-heading-main"><span className={`entry-term${entry.kind === 'sentence' ? ' entry-term--sentence' : ''}`} lang="en">{entry.term}</span>
                    {!expanded && latest?.analysis && latest.status === 'completed' && <span className="entry-preview">{latest.analysis.meaningZh}</span>}
                    {!expanded && latest && latest.status !== 'completed' && <span className="entry-pending">{latest.status === 'processing' ? '正在解析' : latest.status === 'failed' ? '解析未完成' : latest.status === 'needs_key' ? '等待配置密钥' : latest.status === 'waiting_network' ? '等待联网' : '等待解析'}</span>}
                  </span><ChevronDown size={17} className="entry-chevron" />
                </button>
                {expanded && <div className="entry-body" id={`entry-body-${entry.id}`}>{entry.occurrences.map((occurrence, index) => <section className={`occurrence-card${viewRequest?.id === occurrence.id ? ' occurrence-card--focused' : ''}`} key={occurrence.id} id={`occurrence-${occurrence.id}`} data-testid={`occurrence-${occurrence.id}`}>
                  {entry.occurrences.length > 1 && <span className="context-number">语境 {index + 1}</span>}
                  {occurrence.analysis && occurrence.status === 'completed' ? <div className="analysis-content">
                    <p className="meaning-zh">{occurrence.analysis.meaningZh}</p>
                    {occurrence.kind !== 'sentence' && <>
                      {occurrence.analysis.definitionEn && <p className="definition-en" lang="en">{occurrence.analysis.definitionEn}</p>}
                      {(occurrence.analysis.usage || occurrence.analysis.example) && <details className="analysis-details"><summary>用法与例句</summary>
                        {occurrence.analysis.usage && <div className="analysis-field"><span>用法</span><p>{occurrence.analysis.usage}</p></div>}
                        {occurrence.analysis.example && <div className="analysis-field"><span>例句</span><p lang="en">{occurrence.analysis.example}</p></div>}
                      </details>}
                    </>}
                  </div> : <div className="pending-analysis"><Status status={occurrence.status} error={occurrence.error} />
                    {occurrence.status === 'failed' && <button className="small-button" onClick={() => void retry(occurrence.id)} disabled={retryingIds.has(occurrence.id)}>{retryingIds.has(occurrence.id) ? '正在重试' : '重新解析'}</button>}
                  </div>}
                  <details className="source-details"><summary>原文</summary><p className="source-caption">{occurrence.chapterTitle || activeBook.title}</p><blockquote className="source-context" lang="en"><SourceText occurrence={occurrence} /></blockquote></details>
                  <div className="occurrence-actions"><button className="source-jump" aria-label="返回原文" onClick={() => { setSidebarOpen(false); setReaderFocus({ id: occurrence.id, nonce: Date.now() }); }}>返回原文<ArrowUpRight size={14} /></button>
                    <button className="remove-occurrence icon-button" aria-label="取消收录" title={`取消这处收录：${occurrence.targetText}`} onClick={() => void handleRemove(occurrence.id).catch(reason => setError(errorMessage(reason)))}><Trash2 size={15} /></button>
                  </div>
                  <div className="occurrence-footer"><span>{KIND_LABEL[occurrence.kind]}</span><time dateTime={occurrence.collectedAt}>{collectionDate(occurrence.collectedAt)}</time></div>
                </section>)}</div>}
              </article>;
            })}
          </div>
        </aside>}
      </main>}
    {settingsOpen && !activeBook && <SettingsDialog settings={settings} onClose={closeSettings} onSaved={setSettings} />}
  </div>;
}

export default App;
