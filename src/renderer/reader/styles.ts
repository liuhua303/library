import type { ReaderTheme } from '../../shared/types';
import { readerTheme } from './themes';

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const originalFontWeights = new WeakMap<HTMLElement, { value: string; priority: string }>();

export function setReaderCursorHidden(doc: Document, hidden: boolean): void {
  doc.documentElement.toggleAttribute('data-yuejian-cursor-hidden', hidden);
  if (doc.querySelector('style[data-yuejian-reader-cursor]')) return;
  const style = doc.createElement('style');
  style.setAttribute('data-yuejian-reader-cursor', '');
  style.textContent = '@layer yuejian-reader { html[data-yuejian-cursor-hidden], html[data-yuejian-cursor-hidden] * { cursor: none !important; } }';
  (doc.head ?? doc.documentElement).appendChild(style);
}

// The first cascade layer gives reader !important rules priority over book stylesheets.
// Only presentation changes: body text and element positions remain stable for saved CFIs.
function readerStyles(themeId: ReaderTheme): string {
  const theme = readerTheme(themeId);
  return `
@layer yuejian-reader {
  html, body { background: ${theme.paper} !important; color-scheme: ${themeId === 'quiet' ? 'dark' : 'light'}; }
  body, body :not(svg, svg *) {
    color: ${theme.ink} !important;
    background-color: transparent !important;
    -webkit-text-fill-color: currentColor !important;
    font-family: ${theme.fontFamily} !important;
  }
  body {
    font-family: ${theme.fontFamily} !important;
    font-weight: ${theme.weight} !important;
    line-height: 1.75 !important;
    user-select: none !important;
    -webkit-user-select: none !important;
  }
  p { line-height: 1.75 !important; }
  ${themeId === 'bold' ? `body :not(svg, svg *) { font-weight: 600 !important; }
  body :is(strong, b, h1, h2, h3, h4, h5, h6), body :is(strong, b, h1, h2, h3, h4, h5, h6) * { font-weight: 700 !important; }` : ''}
  ::selection { background: #D8EAFE; }
  img { max-width: 100%; object-fit: contain; }
}`;
}

export function applyReaderStyles(doc: Document, themeId: ReaderTheme = 'original'): void {
  const theme = readerTheme(themeId);
  const styles = readerStyles(themeId);
  const head = doc.head ?? doc.querySelector('head');
  if (!head) return;
  let style = head.querySelector<HTMLStyleElement>('style[data-yuejian-reader-styles]');
  if (!style) {
    style = doc.createElement('style');
    style.setAttribute('data-yuejian-reader-styles', '');
  }
  if (style.textContent !== styles) style.textContent = styles;
  if (head.firstChild !== style) head.insertBefore(style, head.firstChild);

  // Inline !important declarations outrank stylesheet layers. Normalize just those
  // declarations, without replacing anchors, unwrapping elements, or changing text.
  for (const element of doc.querySelectorAll<HTMLElement>('html, body, body [style]')) {
    if (element.namespaceURI !== HTML_NAMESPACE || !element.style) continue;
    if (element.style.getPropertyPriority('color') === 'important') {
      element.style.setProperty('color', theme.ink, 'important');
    }
    if (element.style.getPropertyPriority('-webkit-text-fill-color') === 'important') {
      element.style.setProperty('-webkit-text-fill-color', 'currentColor', 'important');
    }
    if (element.style.getPropertyPriority('font-family') === 'important') element.style.setProperty('font-family', theme.fontFamily, 'important');
    if (element.style.getPropertyPriority('font-weight') === 'important') {
      if (!originalFontWeights.has(element)) originalFontWeights.set(element, { value: element.style.getPropertyValue('font-weight'), priority: 'important' });
      if (themeId === 'bold') element.style.setProperty('font-weight', element.closest('strong, b, h1, h2, h3, h4, h5, h6') ? '700' : '600', 'important');
      else {
        const original = originalFontWeights.get(element)!;
        element.style.setProperty('font-weight', original.value, original.priority);
      }
    }
    for (const property of ['background', 'background-color']) {
      if (element.style.getPropertyPriority(property) === 'important') element.style.setProperty(property, element === doc.documentElement ? theme.paper : 'transparent', 'important');
    }
  }
}
