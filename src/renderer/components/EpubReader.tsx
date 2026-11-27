import { useCallback, useEffect, useRef, useState } from 'react';
import ePub, { EpubCFI, type Book, type Contents, type Location, type NavItem, type Rendition } from 'epubjs';
import { ArrowLeft, Bookmark, BookmarkCheck, BookMarked, Check, Copy, List, LoaderCircle, SlidersHorizontal, Trash2, X } from 'lucide-react';
import type { BookmarkRecord, BookRecord, CollectInput, Occurrence, ReaderTheme, TextAnchor } from '../../shared/types';
import { applyReaderStyles, setReaderCursorHidden } from '../reader/styles';
import { READER_THEMES } from '../reader/themes';
import { textClientRects, unionRects, type TextRect } from '../reader/geometry';
import '../reader/reader.css';
import {
  boundsOfRange, caretOffsetAtPoint, findPhraseBounds, indexText, inferSelectionKind,
  rangeFromOffsets, sameChapter, selectionContext, trimBounds, wordAtOffset,
  type TextBounds, type TextIndex,
} from '../reader/text';

export interface EpubReaderProps {
  book: BookRecord;
  occurrences: Occurrence[];
  focusOccurrenceId?: string | null;
  focusNonce?: number;
  onCollect: (input: CollectInput) => Promise<Occurrence>;
  onView: (occurrenceId: string) => void;
  onRemove: (occurrenceId: string) => Promise<void>;
  onLocationChange: (location: { cfi: string; progress: number }) => void;
  onError: (message: string) => void;
  onBack: () => void;
  onFontSizeChange: (delta: number) => void;
  onSettings?: () => void;
  onThemeChange: (theme: ReaderTheme) => void;
  onToggleNotebook: () => void;
  notebookOpen: boolean;
  shortcutsDisabled: boolean;
}

interface Draft extends TextBounds {
  chapterHref: string;
  chapterTitle: string;
  text: string;
}

type Rect = TextRect;

interface MarkRect extends Rect {
  id: string;
  focus?: boolean;
}

interface HandlePoint {
  left: number;
  top: number;
  offscreen: boolean;
}

interface TocEntry { href: string; label: string; depth: number }
type Menu = { type: 'selection'; left: number; top: number }
  | { type: 'saved'; id: string; left: number; top: number };

function visibleContents(rendition: Rendition | null): Contents[] {
  if (!rendition) return [];
  const contents = rendition.getContents() as unknown as Contents[] | Contents;
  return Array.isArray(contents) ? contents : contents ? [contents] : [];
}

function frameFor(contents: Contents): HTMLIFrameElement | null {
  return contents.document.defaultView?.frameElement as HTMLIFrameElement | null;
}

function chapterOf(book: Book, contents: Contents): string {
  return book.spine.get(contents.sectionIndex)?.href ?? '';
}

function flattenToc(items: NavItem[], depth = 0): TocEntry[] {
  return items.flatMap((item) => [
    { href: item.href, label: item.label.trim(), depth },
    ...flattenToc(item.subitems ?? [], depth + 1),
  ]);
}

function rootFor(doc: Document): Element | null {
  return doc.body ?? doc.querySelector('body') ?? doc.documentElement;
}

function localRect(rect: TextRect, frame: DOMRect, viewport: DOMRect): Rect {
  return {
    left: rect.left + frame.left - viewport.left,
    top: rect.top + frame.top - viewport.top,
    width: rect.width,
    height: rect.height,
  };
}

function clippedRects(rects: TextRect[], frame: DOMRect, viewport: DOMRect): Rect[] {
  return rects.map((rect) => localRect(rect, frame, viewport))
    .filter((rect) => rect.width > 0 && rect.height > 0 && rect.left < viewport.width
      && rect.left + rect.width > 0 && rect.top < viewport.height && rect.top + rect.height > 0)
    .map((rect) => ({
      left: Math.max(0, rect.left),
      top: Math.max(0, rect.top),
      width: Math.min(viewport.width, rect.left + rect.width) - Math.max(0, rect.left),
      height: Math.min(viewport.height, rect.top + rect.height) - Math.max(0, rect.top),
    }));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function EpubReader(props: EpubReaderProps) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const loadedBookIdRef = useRef(props.book.id);
  const generationRef = useRef(0);
  const draftRef = useRef<Draft | null>(null);
  const pointerActiveRef = useRef(false);
  const adjustRef = useRef<'start' | 'end' | null>(null);
  const anchorsRef = useRef(new Map<string, TextAnchor>());
  const expansionAttempts = useRef(new Set<string>());
  const nextPageRef = useRef<(direction: -1 | 1) => void>(() => undefined);
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const toolsRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const appearanceRef = useRef<HTMLDivElement>(null);
  const bookmarkRequest = useRef(0);
  const notebookWasOpen = useRef(props.notebookOpen);
  const lastLocation = useRef('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [navigationTab, setNavigationTab] = useState<'chapters' | 'bookmarks'>('chapters');
  const [bookmarks, setBookmarks] = useState<BookmarkRecord[]>([]);
  const [bookmarkBusy, setBookmarkBusy] = useState(false);
  const [readingProgress, setReadingProgress] = useState(props.book.progress);
  const [location, setLocation] = useState<Location | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [adjusting, setAdjusting] = useState<'start' | 'end' | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [hint, setHint] = useState('');
  const [version, setVersion] = useState(0);
  const [marks, setMarks] = useState<MarkRect[]>([]);
  const [selectionRects, setSelectionRects] = useState<Rect[]>([]);
  const [handles, setHandles] = useState<{ start: HandlePoint; end: HandlePoint } | null>(null);
  const [optimistic, setOptimistic] = useState<Occurrence[]>([]);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [readingFocused, setReadingFocused] = useState(false);
  const readingFocusedRef = useRef(false);
  const focusPointerRef = useRef({ x: 0, y: 0 });
  const readerReadyRef = useRef(false);
  readerReadyRef.current = !loading && !error;
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const panelsRef = useRef(false);
  panelsRef.current = toolsOpen || tocOpen || appearanceOpen || props.notebookOpen;
  const wheelHandlerRef = useRef<(event: WheelEvent) => void>(() => undefined);
  const wheelState = useRef({ delta: 0, lastEvent: 0, lastTurn: Number.NEGATIVE_INFINITY });
  const appearanceOpenRef = useRef(appearanceOpen);
  appearanceOpenRef.current = appearanceOpen;

  const restoreReadingUI = useCallback(() => {
    if (!readingFocusedRef.current) return;
    readingFocusedRef.current = false;
    setReadingFocused(false);
    for (const contents of visibleContents(renditionRef.current)) setReaderCursorHidden(contents.document, false);
  }, []);

  const restoreOnPointerMove = useCallback((x: number, y: number) => {
    if (readingFocusedRef.current && Math.hypot(x - focusPointerRef.current.x, y - focusPointerRef.current.y) > 3) restoreReadingUI();
  }, [restoreReadingUI]);

  const focusReading = useCallback((x: number, y: number) => {
    if (!readerReadyRef.current || propsRef.current.shortcutsDisabled) return;
    focusPointerRef.current = { x, y };
    readingFocusedRef.current = true;
    setReadingFocused(true);
    for (const contents of visibleContents(renditionRef.current)) setReaderCursorHidden(contents.document, true);
    viewportRef.current?.focus({ preventScroll: true });
  }, []);

  const redraw = useCallback(() => setVersion((value) => value + 1), []);
  const refreshBookmarks = useCallback(async () => {
    const request = ++bookmarkRequest.current;
    const bookId = props.book.id;
    try {
      const next = await window.readerApi.listBookmarks(bookId);
      if (request === bookmarkRequest.current && propsRef.current.book.id === bookId) {
        const comparator = new EpubCFI();
        setBookmarks([...next].sort((first, second) => {
          try { return comparator.compare(first.cfi, second.cfi); }
          catch { return first.progress - second.progress; }
        }));
      }
    } catch (cause) {
      if (request === bookmarkRequest.current && propsRef.current.book.id === bookId) propsRef.current.onError('读取书签失败：' + errorText(cause));
    }
  }, [props.book.id]);

  useEffect(() => {
    setBookmarks([]);
    setBookmarkBusy(false);
    void refreshBookmarks();
    const unsubscribe = window.readerApi.onDataChanged(change => {
      if (change.reason === 'bookmarks' && (!change.bookId || change.bookId === props.book.id)) void refreshBookmarks();
    });
    return () => { bookmarkRequest.current++; unsubscribe(); };
  }, [props.book.id, refreshBookmarks]);
  const setSelectionDraft = useCallback((next: Draft | null) => {
    draftRef.current = next;
    setDraft(next);
    redraw();
  }, [redraw]);

  const setAdjustment = useCallback((edge: 'start' | 'end' | null) => {
    adjustRef.current = edge;
    setAdjusting(edge);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectionDraft(null);
    setAdjustment(null);
    setMenu(null);
    setHint('');
    for (const contents of visibleContents(renditionRef.current)) {
      contents.document.getSelection()?.removeAllRanges();
    }
  }, [setSelectionDraft, setAdjustment]);

  const menuPoint = useCallback((clientX: number, clientY: number) => {
    const viewport = viewportRef.current?.getBoundingClientRect();
    if (!viewport) return { left: 20, top: 20 };
    return {
      left: Math.max(10, Math.min(clientX - viewport.left, viewport.width - 190)),
      top: Math.max(10, Math.min(clientY - viewport.top + 12, viewport.height - 54)),
    };
  }, []);

  const titleFor = useCallback((href: string) => {
    return toc.find((item) => sameChapter(item.href, href))?.label ?? propsRef.current.book.title;
  }, [toc]);
  const titleForRef = useRef(titleFor);
  titleForRef.current = titleFor;

  const inputFor = useCallback((selection: Draft): CollectInput | null => {
    const currentBook = bookRef.current;
    if (!currentBook || loadedBookIdRef.current !== propsRef.current.book.id) return null;
    const contents = visibleContents(renditionRef.current)
      .find((item) => sameChapter(chapterOf(currentBook, item), selection.chapterHref));
    if (!contents) return null;
    const root = rootFor(contents.document);
    if (!root) return null;
    const index = indexText(root);
    const bounds = trimBounds(index.text, selection);
    if (!bounds) return null;
    const range = rangeFromOffsets(index, bounds.start, bounds.end);
    if (!range) return null;
    const context = selectionContext(index.text, bounds.start, bounds.end);
    const text = index.text.slice(bounds.start, bounds.end);
    return {
      bookId: propsRef.current.book.id,
      text,
      kind: inferSelectionKind(text),
      context: context.text,
      chapterTitle: selection.chapterTitle,
      anchor: {
        cfi: contents.cfiFromRange(range),
        chapterHref: selection.chapterHref,
        startOffset: bounds.start,
        endOffset: bounds.end,
        contextStartOffset: context.startOffset,
      },
    };
  }, []);

  const collectDraft = useCallback(async (selection: Draft) => {
    const input = inputFor(selection);
    if (!input) return;
    const generation = generationRef.current;
    const temporary: Occurrence = {
      id: 'optimistic-' + crypto.randomUUID(),
      bookId: input.bookId,
      selectedText: input.text,
      targetText: input.text,
      kind: input.kind,
      anchor: input.anchor,
      originalAnchor: input.anchor,
      context: input.context,
      chapterTitle: input.chapterTitle,
      collectedAt: new Date().toISOString(),
      status: 'pending',
      error: null,
      analysis: null,
    };
    setOptimistic((items) => [...items, temporary]);
    clearSelection();
    try {
      const saved = await propsRef.current.onCollect(input);
      if (generation !== generationRef.current) return;
      setOptimistic((items) => items.map((item) => item.id === temporary.id ? saved : item));
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setOptimistic((items) => items.filter((item) => item.id !== temporary.id));
      propsRef.current.onError('收录失败：' + errorText(cause));
    }
  }, [clearSelection, inputFor]);
  const collectDraftRef = useRef(collectDraft);
  collectDraftRef.current = collectDraft;

  const installContents = useCallback((contents: Contents, currentBook: Book) => {
    const doc = contents.document;
    const root = rootFor(doc);
    if (!root) return;
    const href = chapterOf(currentBook, contents);
    const loadedBookId = loadedBookIdRef.current;
    applyReaderStyles(doc, propsRef.current.book.theme ?? 'original');
    setReaderCursorHidden(doc, readingFocusedRef.current);
    let down: { x: number; y: number; offset: number | null; hadInteraction: boolean } | null = null;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      restoreReadingUI();
      if (appearanceOpenRef.current) {
        setAppearanceOpen(false);
        event.preventDefault();
        down = null;
        return;
      }
      const target = event.target as Element | null;
      if (target?.closest?.('a[href]')) return;
      setToolsOpen(false);
      setTocOpen(false);
      pointerActiveRef.current = true;
      event.preventDefault();
      doc.getSelection()?.removeAllRanges();
      const index = indexText(root);
      down = { x: event.clientX, y: event.clientY,
        offset: caretOffsetAtPoint(doc, index, event.clientX, event.clientY),
        hadInteraction: panelsRef.current || Boolean(draftRef.current || menuRef.current) };
      try { root.setPointerCapture(event.pointerId); } catch { /* A removed frame cannot capture a pointer. */ }
      setMenu(null);
    };
    const onMove = (event: PointerEvent) => {
      const frame = frameFor(contents)?.getBoundingClientRect();
      if (frame) restoreOnPointerMove(event.clientX + frame.left, event.clientY + frame.top);
      if (!down || down.offset === null || adjustRef.current) return;
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) <= 4) return;
      if (propsRef.current.book.id !== loadedBookId || bookRef.current !== currentBook) return;
      event.preventDefault();
      const index = indexText(root);
      const offset = caretOffsetAtPoint(doc, index, event.clientX, event.clientY);
      if (offset === null) return;
      const bounds = trimBounds(index.text, {
        start: Math.min(down.offset, offset), end: Math.max(down.offset, offset),
      });
      if (!bounds) return;
      setSelectionDraft({
        ...bounds, chapterHref: href, chapterTitle: titleForRef.current(href),
        text: index.text.slice(bounds.start, bounds.end),
      });
    };
    const onUp = (event: PointerEvent) => {
      pointerActiveRef.current = false;
      if (event.button !== 0 || !down) return;
      if (propsRef.current.book.id !== loadedBookId || bookRef.current !== currentBook) return;
      const pointerDown = down;
      down = null;
      try { if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId); } catch { /* Frame closed. */ }
      const frame = frameFor(contents)?.getBoundingClientRect();
      if (!frame) return;
      const point = menuPoint(event.clientX + frame.left, event.clientY + frame.top);
      const index = indexText(root);
      const offset = caretOffsetAtPoint(doc, index, event.clientX, event.clientY);
      const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 4;
      const nativeSelection = doc.getSelection();
      const nativeRange = nativeSelection?.rangeCount ? nativeSelection.getRangeAt(0).cloneRange() : null;
      nativeSelection?.removeAllRanges();
      const currentDraft = draftRef.current;
      const edge = adjustRef.current;
      const onBlank = () => {
        clearSelection();
        if (propsRef.current.notebookOpen) propsRef.current.onToggleNotebook();
        if (!pointerDown.hadInteraction) focusReading(event.clientX + frame.left, event.clientY + frame.top);
      };

      if (edge && currentDraft && sameChapter(currentDraft.chapterHref, href) && offset !== null) {
        const word = wordAtOffset(index.text, offset);
        const changed = edge === 'start'
          ? { start: Math.min(word?.start ?? offset, currentDraft.end - 1), end: currentDraft.end }
          : { start: currentDraft.start, end: Math.max(word?.end ?? offset, currentDraft.start + 1) };
        const trimmed = trimBounds(index.text, changed);
        if (trimmed) {
          setSelectionDraft({ ...currentDraft, ...trimmed, text: index.text.slice(trimmed.start, trimmed.end) });
          setMenu({ type: 'selection', ...point });
          setAdjustment(null);
        }
        return;
      }

      if (moved && pointerDown.offset !== null && offset !== null) {
        const bounds = trimBounds(index.text, {
          start: Math.min(pointerDown.offset, offset), end: Math.max(pointerDown.offset, offset),
        });
        if (bounds) {
          setSelectionDraft({
            ...bounds, chapterHref: href, chapterTitle: titleForRef.current(href),
            text: index.text.slice(bounds.start, bounds.end),
          });
          setMenu({ type: 'selection', ...point });
          setAdjustment(null);
          return;
        }
      }

      if (nativeRange && !nativeRange.collapsed && moved) {
        const bounds = boundsOfRange(index, nativeRange);
        if (bounds) {
          setSelectionDraft({
            ...bounds, chapterHref: href, chapterTitle: titleForRef.current(href),
            text: index.text.slice(bounds.start, bounds.end),
          });
          setMenu({ type: 'selection', ...point });
          setAdjustment(null);
          return;
        }
      }
      if (moved) return;
      if (offset !== null) {
        const saved = [...propsRef.current.occurrences, ...optimisticRef.current].find((occurrence) => {
          const anchor = anchorsRef.current.get(occurrence.id) ?? occurrence.anchor;
          return sameChapter(anchor.chapterHref, href)
            && offset >= anchor.startOffset && offset <= anchor.endOffset;
        });
        if (saved) {
          const range = rangeFromOffsets(index, (anchorsRef.current.get(saved.id) ?? saved.anchor).startOffset,
            (anchorsRef.current.get(saved.id) ?? saved.anchor).endOffset);
          const actualHit = range && Array.from(range.getClientRects()).some((rect) =>
            event.clientX >= rect.left - 2 && event.clientX <= rect.right + 2
            && event.clientY >= rect.top && event.clientY <= rect.bottom);
          if (actualHit) {
            clearSelection();
            setMenu({ type: 'saved', id: saved.id, ...point });
            return;
          }
        }
      }
      if (currentDraft) { clearSelection(); return; }
      const target = event.target as Element | null;
      if (target?.closest?.('a[href]')) { clearSelection(); return; }
      if (offset === null) { onBlank(); return; }
      const word = wordAtOffset(index.text, offset);
      const wordRange = word ? rangeFromOffsets(index, word.start, word.end) : null;
      if (!word || !wordRange) { onBlank(); return; }
      const hit = Array.from(wordRange.getClientRects()).some((rect) =>
        event.clientX >= rect.left - 1 && event.clientX <= rect.right + 1
        && event.clientY >= rect.top && event.clientY <= rect.bottom);
      if (!hit) { onBlank(); return; }
      void collectDraftRef.current({
        ...word, chapterHref: href, chapterTitle: titleForRef.current(href),
        text: index.text.slice(word.start, word.end),
      });
    };
    const onKey = (event: KeyboardEvent) => keyHandlerRef.current(event);
    const onScroll = () => redraw();
    doc.addEventListener('pointerdown', onDown);
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
    doc.addEventListener('pointercancel', () => { down = null; pointerActiveRef.current = false; });
    doc.addEventListener('dragstart', (event) => event.preventDefault());
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('wheel', (event) => wheelHandlerRef.current(event), { passive: false });
    contents.window.addEventListener('scroll', onScroll);
    // Contents are destroyed with their iframe; no listeners are attached to a global document here.
    redraw();
  }, [clearSelection, menuPoint, redraw, setAdjustment, setSelectionDraft, restoreReadingUI, restoreOnPointerMove, focusReading]);
  const optimisticRef = useRef(optimistic);
  optimisticRef.current = optimistic;

  useEffect(() => {
    const generation = ++generationRef.current;
    const loadedBookId = props.book.id;
    loadedBookIdRef.current = loadedBookId;
    let destroyed = false;
    let currentBook: Book | null = null;
    let rendition: Rendition | null = null;
    let observer: ResizeObserver | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError(null);
    setToc([]);
    setTocOpen(false);
    setToolsOpen(false);
    setAppearanceOpen(false);
    restoreReadingUI();
    setNavigationTab('chapters');
    setReadingProgress(props.book.progress);
    setLocation(null);
    setOptimistic([]);
    setHint('');
    pointerActiveRef.current = false;
    clearSelection();
    anchorsRef.current.clear();
    expansionAttempts.current.clear();
    lastLocation.current = props.book.lastLocation ?? '';

    void (async () => {
      try {
        const bytes = await window.readerApi.getBookData(props.book.id);
        if (destroyed) return;
        const buffer = new Uint8Array(bytes).buffer;
        currentBook = ePub(buffer);
        bookRef.current = currentBook;
        await currentBook.ready;
        if (destroyed || !canvasRef.current) return;
        const options = {
          width: '100%', height: '100%', flow: 'paginated', spread: 'none',
          minSpreadWidth: 99999, gap: 48, manager: 'default',
          allowScriptedContent: false, allowPopups: false,
        };
        rendition = currentBook.renderTo(canvasRef.current, options);
        renditionRef.current = rendition;
        rendition.themes.fontSize(propsRef.current.book.fontSize + 'px');
        rendition.hooks.content.register((contents: Contents) => {
          if (!destroyed && currentBook) installContents(contents, currentBook);
        });
        rendition.on('relocated', (next: Location) => {
          if (destroyed || generation !== generationRef.current || propsRef.current.book.id !== loadedBookId) return;
          setLocation(next);
          lastLocation.current = next.start.cfi;
          const sections = Math.max(1, (currentBook?.spine as unknown as { length: number }).length || 1);
          const inChapter = next.start.displayed.total
            ? (next.start.displayed.page - 1) / next.start.displayed.total : 0;
          const progress = next.atEnd ? 1 : Math.min(1, Math.max(0, (next.start.index + inChapter) / sections));
          setReadingProgress(progress);
          propsRef.current.onLocationChange({ cfi: next.start.cfi, progress });
          // A passive reflow can arrive after the user has opened either menu.
          // Keep it open; explicit page turns, jumps, outside clicks and font changes
          // close menus at their own interaction boundary instead.
          redraw();
        });
        rendition.on('rendered', redraw);
        rendition.on('resized', redraw);
        const navigation = await currentBook.loaded.navigation;
        if (!destroyed) setToc(flattenToc(navigation.toc));
        try { await rendition.display(props.book.lastLocation ?? undefined); }
        catch {
          if (props.book.lastLocation) await rendition.display();
          else throw new Error('无法显示这本 EPUB 的正文。');
        }
        if (destroyed) return;
        setLoading(false);
        redraw();
        if (viewportRef.current) {
          let lastWidth = 0;
          let lastHeight = 0;
          observer = new ResizeObserver(([entry]) => {
            const width = Math.round(entry.contentRect.width);
            const height = Math.round(entry.contentRect.height);
            if (!rendition || width < 20 || height < 20 || (width === lastWidth && height === lastHeight)) return;
            lastWidth = width;
            lastHeight = height;
            clearTimeout(resizeTimer);
            const applyResize = () => {
              if (destroyed || !rendition) return;
              // A new selection toolbar changes the viewport height while the pointer
              // is still down. Do not replace/reflow its iframe until that drag ends.
              if (pointerActiveRef.current) {
                resizeTimer = setTimeout(applyResize, 60);
                return;
              }
              const position = lastLocation.current;
              // EPUB.js already queues display() from its resized handler. Supplying
              // the CFI there preserves content without scheduling a second display.
              // Its bundled declaration omits the supported third parameter.
              const resize = rendition.resize as (width: number, height: number, cfi?: string) => void;
              resize.call(rendition, width, height, position || undefined);
            };
            resizeTimer = setTimeout(applyResize, 90);
          });
          observer.observe(viewportRef.current);
        }
      } catch (cause) {
        if (destroyed) return;
        setError(errorText(cause));
        setLoading(false);
      }
    })();
    return () => {
      destroyed = true;
      clearTimeout(resizeTimer);
      observer?.disconnect();
      renditionRef.current = null;
      bookRef.current = null;
      // Book.destroy also destroys its rendition; running both would tear down the stage twice.
      if (currentBook) currentBook.destroy();
      else rendition?.destroy();
      if (canvasRef.current) canvasRef.current.innerHTML = '';
    };
    // A book's font or saved progress changes should not reload its entire archive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.book.id]);

  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition || loading) return;
    setMenu(null);
    const position = lastLocation.current;
    rendition.themes.fontSize(props.book.fontSize + 'px');
    if (position) void rendition.display(position).then(redraw).catch(() => undefined);
  }, [props.book.fontSize, loading, redraw]);

  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition || loading) return;
    const position = lastLocation.current;
    for (const contents of visibleContents(rendition)) applyReaderStyles(contents.document, props.book.theme ?? 'original');
    // Preserve the content anchor when a theme changes font family or weight.
    if (position) void rendition.display(position).then(redraw).catch(() => undefined);
  }, [props.book.theme, loading, redraw]);

  useEffect(() => {
    setOptimistic((items) => items.filter((item) => !props.occurrences.some((saved) => saved.id === item.id)));
  }, [props.occurrences]);

  useEffect(() => {
    const currentBook = bookRef.current;
    if (!currentBook || loading || loadedBookIdRef.current !== props.book.id) return;
    const generation = generationRef.current;
    for (const occurrence of props.occurrences) {
      if (!occurrence.analysis || occurrence.targetText === occurrence.selectedText) continue;
      const attemptKey = occurrence.id + ':' + occurrence.targetText;
      if (expansionAttempts.current.has(attemptKey)) continue;
      expansionAttempts.current.add(attemptKey);
      void (async () => {
        try {
          const sourceRange = await currentBook.getRange(occurrence.originalAnchor.cfi);
          if (generation !== generationRef.current) return;
          const doc = sourceRange.startContainer.ownerDocument;
          const root = doc && rootFor(doc);
          if (!root) return;
          const index = indexText(root);
          const bounds = findPhraseBounds(index.text, occurrence.targetText, {
            start: occurrence.originalAnchor.startOffset,
            end: occurrence.originalAnchor.endOffset,
          });
          if (!bounds) return;
          const range = rangeFromOffsets(index, bounds.start, bounds.end);
          const section = currentBook.spine.get(occurrence.originalAnchor.cfi);
          if (!range || !section) return;
          const anchor: TextAnchor = {
            ...occurrence.originalAnchor, cfi: section.cfiFromRange(range),
            startOffset: bounds.start, endOffset: bounds.end,
          };
          anchorsRef.current.set(occurrence.id, anchor);
          redraw();
          if (anchor.cfi !== occurrence.anchor.cfi || anchor.startOffset !== occurrence.anchor.startOffset
            || anchor.endOffset !== occurrence.anchor.endOffset) {
            await window.readerApi.updateAnchor(occurrence.id, anchor);
          }
        } catch {
          // Keep the original, reliable mark when a book cannot resolve an expanded phrase.
        }
      })();
    }
  }, [props.occurrences, loading, redraw]);

  useEffect(() => {
    if (!props.focusOccurrenceId || loading) return;
    const occurrence = props.occurrences.find((item) => item.id === props.focusOccurrenceId);
    if (!occurrence || !renditionRef.current) return;
    const generation = generationRef.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    clearSelection();
    void renditionRef.current.display((anchorsRef.current.get(occurrence.id) ?? occurrence.anchor).cfi)
      .then(() => {
        if (cancelled || generation !== generationRef.current) return;
        setFlashId(occurrence.id);
        redraw();
        timer = setTimeout(() => setFlashId(null), 850);
      }).catch(() => propsRef.current.onError('暂时无法定位到这条记录的原文。'));
    return () => { cancelled = true; clearTimeout(timer); };
  }, [props.focusOccurrenceId, props.focusNonce, loading, clearSelection, redraw]);

  useEffect(() => {
    const viewport = viewportRef.current?.getBoundingClientRect();
    const currentBook = bookRef.current;
    if (!viewport || !currentBook || loading) { setMarks([]); setSelectionRects([]); setHandles(null); return; }
    const nextMarks: MarkRect[] = [];
    const nextSelection: Rect[] = [];
    let nextHandles: { start: HandlePoint; end: HandlePoint } | null = null;
    const allOccurrences = [...props.occurrences, ...optimistic]
      .filter((item, index, items) => items.findIndex((other) => other.id === item.id) === index);
    for (const contents of visibleContents(renditionRef.current)) {
      const frame = frameFor(contents)?.getBoundingClientRect();
      const root = rootFor(contents.document);
      if (!frame || !root) continue;
      const href = chapterOf(currentBook, contents);
      const index = indexText(root);
      for (const occurrence of allOccurrences) {
        const anchor = anchorsRef.current.get(occurrence.id) ?? occurrence.anchor;
        if (!sameChapter(anchor.chapterHref, href)) continue;
        const rects = textClientRects(index, anchor.startOffset, anchor.endOffset);
        nextMarks.push(...clippedRects(rects, frame, viewport).map((rect) => ({
          ...rect, id: occurrence.id, focus: occurrence.id === flashId,
        })));
      }
      if (draft && sameChapter(draft.chapterHref, href)) {
        const rects = textClientRects(index, draft.start, draft.end);
        nextSelection.push(...clippedRects(rects, frame, viewport));
        const first = rects[0];
        const last = rects.at(-1);
        const makeHandle = (rect: TextRect, end: boolean): HandlePoint => {
          const point = localRect(rect, frame, viewport);
          const x = point.left + (end ? point.width : 0);
          const y = point.top + point.height;
          return {
            left: Math.max(12, Math.min(x, viewport.width - 12)),
            top: Math.max(12, Math.min(y, viewport.height - 18)),
            offscreen: x < 0 || x > viewport.width || y < 0 || y > viewport.height,
          };
        };
        if (first && last) nextHandles = { start: makeHandle(first, false), end: makeHandle(last, true) };
      }
    }
    setMarks(nextMarks);
    setSelectionRects(unionRects(nextSelection));
    setHandles(nextHandles);
  }, [version, props.occurrences, optimistic, draft, flashId, loading]);

  const turnPage = useCallback((direction: -1 | 1) => {
    const rendition = renditionRef.current;
    if (!rendition || loading || pointerActiveRef.current) return;
    const current = rendition.location;
    const selection = draftRef.current;
    if (selection && current && sameChapter(selection.chapterHref, current.start.href)) {
      const atBoundary = direction === -1 ? current.start.displayed.page <= 1
        : current.end.displayed.page >= current.end.displayed.total;
      if (atBoundary) {
        setHint('请先收录或取消选区，再切换章节。');
        return;
      }
    }
    setMenu(null);
    setToolsOpen(false);
    setTocOpen(false);
    setAppearanceOpen(false);
    setHint('');
    void (direction === 1 ? rendition.next() : rendition.prev()).then(redraw)
      .catch((cause) => propsRef.current.onError('翻页失败：' + errorText(cause)));
  }, [loading, redraw]);
  nextPageRef.current = turnPage;

  const percentage = Math.round(Math.max(0, Math.min(1, readingProgress || 0)) * 100);
  const activeBookmark = bookmarks.find(bookmark => {
    if (!location) return false;
    try {
      const cfi = new EpubCFI();
      return cfi.compare(bookmark.cfi, location.start.cfi) >= 0 && cfi.compare(bookmark.cfi, location.end.cfi) <= 0;
    } catch { return bookmark.cfi === location.start.cfi; }
  });

  const removeBookmark = async (bookmark: BookmarkRecord) => {
    const bookId = props.book.id;
    setBookmarkBusy(true);
    bookmarkRequest.current++;
    try {
      await window.readerApi.removeBookmark(bookmark.id);
      if (propsRef.current.book.id === bookId) await refreshBookmarks();
    } catch (cause) { propsRef.current.onError('移除书签失败：' + errorText(cause)); }
    finally { if (propsRef.current.book.id === bookId) setBookmarkBusy(false); }
  };

  const toggleBookmark = async () => {
    if (bookmarkBusy || loading || !location || !bookRef.current) return;
    if (activeBookmark) { await removeBookmark(activeBookmark); return; }
    const bookId = props.book.id;
    const cfi = location.start.cfi;
    const chapterTitle = titleFor(location.start.href);
    const progress = readingProgress;
    const currentBook = bookRef.current;
    setBookmarkBusy(true);
    bookmarkRequest.current++;
    try {
      let excerpt = '';
      try {
        const range = await currentBook.getRange(cfi);
        const preview = range.cloneRange();
        const body = rootFor(range.startContainer.ownerDocument!);
        if (body) preview.setEnd(body, body.childNodes.length);
        const fragment = preview.cloneContents();
        for (const block of fragment.querySelectorAll('p, div, section, h1, h2, h3, h4, h5, h6, li, blockquote, br')) {
          block.after(range.startContainer.ownerDocument!.createTextNode(' '));
        }
        excerpt = (fragment.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
      } catch { /* A chapter title still makes the saved location usable. */ }
      await window.readerApi.addBookmark({ bookId, cfi, chapterTitle, excerpt, progress });
      if (propsRef.current.book.id === bookId) await refreshBookmarks();
    } catch (cause) { propsRef.current.onError('添加书签失败：' + errorText(cause)); }
    finally { if (propsRef.current.book.id === bookId) setBookmarkBusy(false); }
  };

  const closeAppearance = () => {
    setAppearanceOpen(false);
    toolsRef.current?.querySelector<HTMLButtonElement>('.reader-tools-toggle')?.focus();
  };

  keyHandlerRef.current = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || propsRef.current.shortcutsDisabled) return;
    const target = event.target as Element | null;
    if (target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (readingFocusedRef.current && (event.key === 'Escape' || event.key === 'Tab')) {
      restoreReadingUI();
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); return; }
    }
    if (appearanceOpen) {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeAppearance();
      } else if (event.key === 'Tab') {
        const buttons = appearanceRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (buttons?.length) {
          const first = buttons[0], last = buttons[buttons.length - 1];
          if (event.shiftKey && event.target === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && event.target === last) { event.preventDefault(); first.focus(); }
        }
      }
      return;
    }
    if (event.key.toLowerCase() === 'j') {
      if (event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      restoreReadingUI();
      setToolsOpen(false);
      setTocOpen(false);
      propsRef.current.onToggleNotebook();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (toolsOpen || tocOpen) {
        setToolsOpen(false); setTocOpen(false);
        toolsRef.current?.querySelector<HTMLButtonElement>('.reader-tools-toggle')?.focus();
      } else if (propsRef.current.notebookOpen) propsRef.current.onToggleNotebook();
      else clearSelection();
      return;
    }
    if (target?.closest?.('.vocabulary-sidebar, .reader-tools-menu, .reader-toc, .selection-menu, .reader-selection-summary, .settings-dialog')) return;
    if (['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp'].includes(event.key)) {
      event.preventDefault();
      nextPageRef.current(event.key === 'ArrowRight' || event.key === 'PageDown' ? 1 : -1);
    }
  };

  wheelHandlerRef.current = (event: WheelEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !readerReadyRef.current
      || propsRef.current.shortcutsDisabled || panelsRef.current || pointerActiveRef.current) return;
    const target = event.target as Element | null;
    if (target?.closest?.('.vocabulary-sidebar, .reader-tools, .reader-toc, .reader-appearance, .selection-menu, .reader-selection-summary, .settings-dialog, input, textarea, select, [contenteditable]')) return;
    const raw = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!raw) return;
    event.preventDefault();
    const now = performance.now();
    const state = wheelState.current;
    const delta = raw * (event.deltaMode === 1 ? 36 : event.deltaMode === 2 ? 600 : 1);
    if (now - state.lastEvent > 250 || Math.sign(delta) !== Math.sign(state.delta)) state.delta = 0;
    state.lastEvent = now;
    if (now - state.lastTurn < 450) return;
    state.delta += delta;
    if (Math.abs(state.delta) >= 55) {
      state.lastTurn = now;
      nextPageRef.current(state.delta > 0 ? 1 : -1);
      state.delta = 0;
    }
  };

  useEffect(() => {
    if (notebookWasOpen.current && !props.notebookOpen && !props.shortcutsDisabled) {
      const frame = visibleContents(renditionRef.current).map(frameFor).find(Boolean);
      if (frame) frame.focus();
      else viewportRef.current?.focus();
    }
    notebookWasOpen.current = props.notebookOpen;
  }, [props.notebookOpen, props.shortcutsDisabled]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyHandlerRef.current(event);
    let blankPress: { x: number; y: number; eligible: boolean } | null = null;
    const interactive = '.selection-menu, .selection-handle, .reader-selection-summary, .reader-back, .reader-tools, .reader-toc, .reader-appearance, .vocabulary-sidebar, .modal-backdrop, .app-error, .reader-book-title, .reader-page-position, button, a, input, textarea, select, [contenteditable]';
    const onOutside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const inside = target?.closest('.epub-reader');
      const hadInteraction = panelsRef.current || Boolean(draftRef.current || menuRef.current);
      blankPress = event.button === 0 && inside && !target?.closest(interactive)
        ? { x: event.clientX, y: event.clientY, eligible: !hadInteraction } : null;
      if (!inside) restoreReadingUI();
      if (!target?.closest('.reader-tools')) setToolsOpen(false);
      if (!target?.closest('.reader-toc, .reader-tools')) setTocOpen(false);
      if (!target?.closest('.reader-appearance, .reader-tools')) setAppearanceOpen(false);
      if (target?.closest('.selection-menu, .selection-handle, .reader-selection-summary, .reader-toolbar, .reader-tools, .reader-toc, .reader-appearance, .vocabulary-sidebar, .modal-backdrop, .app-error')) return;
      if (inside && propsRef.current.notebookOpen) propsRef.current.onToggleNotebook();
      if (draftRef.current || menu) clearSelection();
    };
    const onUp = (event: PointerEvent) => {
      const press = blankPress;
      blankPress = null;
      if (press?.eligible && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 4) focusReading(event.clientX, event.clientY);
    };
    const onMove = (event: PointerEvent) => restoreOnPointerMove(event.clientX, event.clientY);
    const onWheel = (event: WheelEvent) => {
      if ((event.target as Element | null)?.closest('.epub-reader')) wheelHandlerRef.current(event);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('pointerup', onUp); document.removeEventListener('pointermove', onMove); document.removeEventListener('wheel', onWheel);
    };
  }, [clearSelection, menu, focusReading, restoreReadingUI, restoreOnPointerMove]);

  useEffect(() => {
    if (toolsOpen) toolsRef.current?.querySelector<HTMLButtonElement>('.reader-tools-menu button')?.focus();
  }, [toolsOpen]);

  useEffect(() => {
    if (appearanceOpen) appearanceRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [appearanceOpen]);

  useEffect(() => {
    if (tocOpen) navigationRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [tocOpen, navigationTab]);

  const dragHandle = (edge: 'start' | 'end', event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    pointerActiveRef.current = true;
    setAdjustment(edge);
    setMenu(null);
    const move = (pointer: PointerEvent) => {
      const currentBook = bookRef.current;
      const current = draftRef.current;
      if (!currentBook || !current) return;
      for (const contents of visibleContents(renditionRef.current)) {
        if (!sameChapter(chapterOf(currentBook, contents), current.chapterHref)) continue;
        const frame = frameFor(contents)?.getBoundingClientRect();
        const root = rootFor(contents.document);
        if (!frame || !root) continue;
        const index = indexText(root);
        const offset = caretOffsetAtPoint(contents.document, index, pointer.clientX - frame.left, pointer.clientY - frame.top);
        if (offset === null) continue;
        const bounds = edge === 'start'
          ? { start: Math.min(offset, current.end - 1), end: current.end }
          : { start: current.start, end: Math.max(offset, current.start + 1) };
        setSelectionDraft({ ...current, ...bounds, text: index.text.slice(bounds.start, bounds.end) });
      }
    };
    const finish = (pointer: PointerEvent) => {
      pointerActiveRef.current = false;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      if (handle.hasPointerCapture(pointer.pointerId)) handle.releasePointerCapture(pointer.pointerId);
      setAdjustment(null);
      setMenu({ type: 'selection', ...menuPoint(pointer.clientX, pointer.clientY) });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  };

  const copySelection = async () => {
    if (!draftRef.current) return;
    try { await window.readerApi.copyText(draftRef.current.text); clearSelection(); }
    catch { propsRef.current.onError('复制失败，请重试。'); }
  };
  const currentChapter = location ? titleFor(location.start.href) : props.book.title;
  const pageLabel = location ? location.start.displayed.page + ' / ' + location.start.displayed.total : '';

  return (
    <section className="epub-reader" data-reader-theme={props.book.theme ?? 'original'} data-reading-focused={readingFocused} aria-label="书籍阅读区" tabIndex={-1}>
      <header className="reader-toolbar">
        <button className="reader-back" aria-label="返回书架" onClick={props.onBack}><ArrowLeft size={19} /></button>
        {draft ? <div className="reader-selection-summary">
          <span title={draft.text}>{draft.text.length > 65 ? draft.text.slice(0, 65) + '…' : draft.text}</span>
          <button className={adjusting === 'start' ? 'is-active' : ''} onClick={() => setAdjustment(adjusting === 'start' ? null : 'start')}>调整起点</button>
          <button className={adjusting === 'end' ? 'is-active' : ''} onClick={() => setAdjustment(adjusting === 'end' ? null : 'end')}>调整终点</button>
          <button onClick={() => void copySelection()}>复制</button>
          <button onClick={() => { if (draftRef.current) void collectDraft(draftRef.current); }}>收录</button>
          <button aria-label="取消选区" onClick={clearSelection}><X size={15} /></button>
        </div> : <h1 className="reader-book-title" title={currentChapter}>{props.book.title}</h1>}
      </header>
      {tocOpen && (
        <nav className="reader-toc" aria-label="书籍目录" ref={navigationRef}>
          <div className="reader-toc-heading"><div><strong>{props.book.title}</strong><span>已读 {percentage}%{pageLabel ? ` · 本章 ${pageLabel}` : ''}</span></div><button aria-label="关闭目录" onClick={() => { setTocOpen(false); toolsRef.current?.querySelector<HTMLButtonElement>('.reader-tools-toggle')?.focus(); }}><Check size={20} /></button></div>
          <div className="reader-navigation-tabs" role="tablist" aria-label="书籍导航" onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            setNavigationTab(event.key === 'Home' ? 'chapters' : event.key === 'End' ? 'bookmarks' : navigationTab === 'chapters' ? 'bookmarks' : 'chapters');
          }}>
            <button id="chapters-tab" role="tab" aria-selected={navigationTab === 'chapters'} aria-controls="chapters-panel" tabIndex={navigationTab === 'chapters' ? 0 : -1} onClick={() => setNavigationTab('chapters')}>目录</button>
            <button id="bookmarks-tab" role="tab" aria-selected={navigationTab === 'bookmarks'} aria-controls="bookmarks-panel" tabIndex={navigationTab === 'bookmarks' ? 0 : -1} onClick={() => setNavigationTab('bookmarks')}>书签{bookmarks.length > 0 && <span>{bookmarks.length}</span>}</button>
          </div>
          {navigationTab === 'chapters' ? <div className="reader-navigation-list" id="chapters-panel" role="tabpanel" aria-labelledby="chapters-tab">
            {toc.map((entry, index) => <button key={entry.href + index} style={{ paddingLeft: 16 + entry.depth * 16 }}
              className={location && sameChapter(entry.href, location.start.href) ? 'is-current' : ''}
              onClick={() => {
                clearSelection(); setTocOpen(false);
                void renditionRef.current?.display(entry.href).catch(() => propsRef.current.onError('无法跳转到该章节。'));
              }}><span>{entry.label}</span>{location && sameChapter(entry.href, location.start.href) && <span className="reader-chapter-current">正在阅读</span>}</button>)}
            {!toc.length && <p className="reader-panel-empty">这本书没有目录。</p>}
          </div> : <div className="reader-navigation-list" id="bookmarks-panel" role="tabpanel" aria-labelledby="bookmarks-tab">
            {bookmarks.map(bookmark => <div key={bookmark.id} className="reader-bookmark-row">
              <button className="reader-bookmark-jump" aria-label={`跳转书签 ${bookmark.chapterTitle || props.book.title}`} onClick={() => {
                clearSelection(); setTocOpen(false);
                void renditionRef.current?.display(bookmark.cfi).catch(() => propsRef.current.onError('无法跳转到该书签。'));
              }}><span className="reader-bookmark-title">{bookmark.chapterTitle || props.book.title}<span>{Math.round(bookmark.progress * 100)}%</span></span>{bookmark.excerpt && <span className="reader-bookmark-excerpt" lang="en">{bookmark.excerpt}</span>}</button>
              <button className="reader-bookmark-remove" aria-label={`删除书签 ${bookmark.chapterTitle || props.book.title}`} title="删除书签" disabled={bookmarkBusy} onClick={() => void removeBookmark(bookmark)}><Trash2 size={16} /></button>
            </div>)}
            {!bookmarks.length && <div className="reader-panel-empty"><Bookmark size={27} strokeWidth={1.3} /><p>暂无书签</p><span>在阅读工具中添加书签</span></div>}
          </div>}
        </nav>
      )}
      {appearanceOpen && <div className="reader-appearance" ref={appearanceRef} role="dialog" aria-label="主题与设置" aria-modal="false">
        <div className="reader-appearance-heading"><button aria-label="关闭阅读设置" onClick={closeAppearance}><X size={23} /></button><h2>主题与设置</h2></div>
        <div className="reader-font-controls" role="group" aria-label="字号">
          <button aria-label="减小字号" disabled={props.book.fontSize <= 14} onClick={() => props.onFontSizeChange(-2)}><span className="reader-small-a">A</span></button>
          <button aria-label="增大字号" disabled={props.book.fontSize >= 34} onClick={() => props.onFontSizeChange(2)}><span className="reader-large-a">A</span></button>
        </div>
        <div className="reader-theme-grid" role="group" aria-label="阅读主题">
          {READER_THEMES.map(theme => <button key={theme.id} className="reader-theme-option" data-theme={theme.id} aria-label={`${theme.label}主题`} aria-pressed={(props.book.theme ?? 'original') === theme.id}
            style={{ background: theme.paper, color: theme.ink, fontFamily: theme.fontFamily }} onClick={() => props.onThemeChange(theme.id)}>
            <span className="reader-theme-sample" style={{ fontWeight: theme.weight }}>Aa</span><span className="reader-theme-label">{theme.label}</span><span className="reader-theme-english">{theme.english}</span>
          </button>)}
        </div>
      </div>}
      <div className="reader-viewport" data-testid="epub-viewport" ref={viewportRef} tabIndex={-1}
        style={{ maxWidth: Math.min(1200, Math.max(760, props.book.fontSize * 36)) }}>
        <div className="reader-canvas" ref={canvasRef} />
        <div className="reader-overlay" aria-hidden="true">
          {selectionRects.map((rect, index) => <span key={'selection-' + index} className="reader-selection-rect"
            style={{ position: 'absolute', ...rect }} />)}
          {marks.map((rect, index) => <span key={rect.id + '-' + index} data-occurrence-id={rect.id}
            data-testid="reader-mark" className={'reader-mark' + (rect.focus ? ' reader-mark-flash' : '')}
            style={{ position: 'absolute', left: rect.left, top: rect.top + rect.height - 2, width: rect.width, height: 2, pointerEvents: 'none' }} />)}
          {marks.filter((rect) => rect.focus).map((rect, index) => <span key={'focus-' + index}
            className="reader-focus-rect" style={{ position: 'absolute', ...rect }} />)}
        </div>
        {draft && handles && (['start', 'end'] as const).map((edge) => <button key={edge}
          className={'selection-handle' + (handles[edge].offscreen ? ' is-offscreen' : '')}
          aria-label={edge === 'start' ? '调整选区起点' : '调整选区终点'}
          title={edge === 'start' ? '拖动调整起点' : '拖动调整终点'}
          style={{ position: 'absolute', left: handles[edge].left, top: handles[edge].top - 2, touchAction: 'none' }}
          onPointerDown={(event) => dragHandle(edge, event)} />)}
        {menu && <div className="selection-menu" style={{ left: menu.left, top: menu.top }} role="toolbar" aria-label="选词操作">
          {menu.type === 'selection' ? <>
            <button onClick={() => void copySelection()}><Copy size={15} />复制</button>
            <button onClick={() => { if (draftRef.current) void collectDraft(draftRef.current); }}><Check size={15} />收录</button>
          </> : <>
            <button onClick={() => { propsRef.current.onView(menu.id); setMenu(null); }}>查看</button>
            <button onClick={() => {
              const id = menu.id;
              setMenu(null);
              setOptimistic((items) => items.filter((item) => item.id !== id));
              void propsRef.current.onRemove(id).catch((cause) => propsRef.current.onError('取消失败：' + errorText(cause)));
            }}>取消收录</button>
          </>}
        </div>}
        {loading && <div className="reader-loading" role="status"><LoaderCircle size={24} className="spinning" /><span>正在加载</span></div>}
        {error && <div className="reader-error" role="alert"><strong>无法打开书籍</strong><p>{error}</p></div>}
      </div>
      {hint && <div className="reader-hint" role="status">{hint}</div>}
      <footer className="reader-footer">
        <span className="reader-page-position" title={currentChapter}>{pageLabel}</span>
      </footer>
      <div className="reader-tools" ref={toolsRef}>
        {toolsOpen && <div className="reader-tools-menu" role="group" aria-label="阅读工具菜单">
          <button className="reader-tool-row reader-progress-row" aria-label="目录" aria-expanded={tocOpen} onClick={() => { setNavigationTab('chapters'); setTocOpen(true); setToolsOpen(false); setAppearanceOpen(false); }}><span>目录 · {percentage}%</span><List size={22} /></button>
          <button className="reader-tool-row" aria-label="书签" onClick={() => { setNavigationTab('bookmarks'); setTocOpen(true); setToolsOpen(false); setAppearanceOpen(false); }}><span>书签</span><span className="reader-tool-count">{bookmarks.length}</span></button>
          <button className="reader-tool-row" aria-label={props.notebookOpen ? '关闭单词本' : '打开单词本'} aria-expanded={props.notebookOpen} onClick={() => { props.onToggleNotebook(); setToolsOpen(false); }}><span><BookMarked size={18} />单词本</span><kbd>J</kbd></button>
          <button className="reader-tool-row" aria-label="主题与设置" onClick={() => { setToolsOpen(false); setTocOpen(false); setAppearanceOpen(true); }}><span>主题与设置</span><span className="reader-tool-aa">aA</span></button>
          <div className="reader-tool-actions"><button aria-label={activeBookmark ? '移除书签' : '添加书签'} aria-pressed={Boolean(activeBookmark)} disabled={loading || !location || bookmarkBusy} onClick={() => void toggleBookmark()}>{bookmarkBusy ? <LoaderCircle size={21} className="spinning" /> : activeBookmark ? <BookmarkCheck size={21} /> : <Bookmark size={21} />}</button></div>
        </div>}
        <button className="reader-tools-toggle" aria-label="阅读工具" aria-expanded={toolsOpen} onClick={() => { setToolsOpen(value => !value); setTocOpen(false); setAppearanceOpen(false); }}><SlidersHorizontal size={21} /></button>
      </div>
    </section>
  );
}
