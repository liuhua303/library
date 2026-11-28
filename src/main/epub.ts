import JSZip from 'jszip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import path from 'node:path';
import { chapterLanguageSample, detectBookLanguage, type BookLanguageDetection } from './book-language';

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false });
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const asText = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  if (value && typeof value === 'object') return asText((value as Record<string, unknown>)['#text']);
  return '';
};

export async function inspectEpub(bytes: Uint8Array): Promise<{ title: string; author: string } & BookLanguageDetection> {
  if (bytes.length > 100 * 1024 * 1024) throw new Error('首版支持 100 MB 以内的 EPUB，请选择较小的文件。');
  let archive: JSZip;
  try { archive = await JSZip.loadAsync(bytes); } catch { throw new Error('这个文件不是可读取的 EPUB，或文件已损坏。'); }
  let totalExpanded = 0;
  for (const file of Object.values(archive.files)) {
    totalExpanded += (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (totalExpanded > 400 * 1024 * 1024) throw new Error('这本 EPUB 解压后的内容过大，首版暂不支持。');
  }
  const mime = await archive.file('mimetype')?.async('string');
  if (mime?.trim() !== 'application/epub+zip') throw new Error('文件缺少有效的 EPUB 格式标识。');
  const container = await archive.file('META-INF/container.xml')?.async('string');
  if (!container || XMLValidator.validate(container) !== true) throw new Error('EPUB 缺少有效的书籍目录信息。');
  const rootFiles = array(parser.parse(container).container?.rootfiles?.rootfile) as Record<string, unknown>[];
  const root = rootFiles.find(file => file['@_media-type'] === 'application/oebps-package+xml') ?? rootFiles[0];
  const packagePath = root?.['@_full-path'];
  if (typeof packagePath !== 'string' || packagePath.startsWith('/') || packagePath.split('/').includes('..')) throw new Error('EPUB 主文件位置无效。');
  const packageSource = await archive.file(packagePath)?.async('string');
  if (!packageSource || XMLValidator.validate(packageSource) !== true) throw new Error('EPUB 书籍信息已损坏。');
  const packageData = parser.parse(packageSource).package;
  if (!packageData?.manifest || !packageData?.spine) throw new Error('EPUB 缺少可阅读的正文。');
  const meta = array(packageData.metadata?.meta) as Record<string, unknown>[];
  if (meta.some(item => item['@_property'] === 'rendition:layout' && asText(item) === 'pre-paginated') ||
      meta.some(item => item['@_name'] === 'fixed-layout' && String(item['@_content']).toLowerCase() === 'true')) {
    throw new Error('这本书是固定版式 EPUB，首版支持可随字号重新排版的 EPUB。');
  }
  const encryption = await archive.file('META-INF/encryption.xml')?.async('string');
  if (encryption) {
    if (XMLValidator.validate(encryption) !== true) throw new Error('EPUB 的保护信息已损坏。');
    const encrypted = array(parser.parse(encryption).encryption?.EncryptedData) as Record<string, any>[];
    const allowedFonts = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);
    for (const resource of encrypted) {
      const algorithm = resource.EncryptionMethod?.['@_Algorithm'];
      const uri = resource.CipherData?.CipherReference?.['@_URI'];
      if (!allowedFonts.has(algorithm) || typeof uri !== 'string' || !/\.(otf|ttf|woff2?)$/i.test(uri)) {
        throw new Error('这本 EPUB 含有受保护的内容，首版暂不支持。请选择普通 EPUB 文件。');
      }
    }
  }
  const spineItems = array(packageData.spine.itemref) as Record<string, unknown>[];
  if (spineItems.some(item => String(item['@_properties'] ?? '').includes('rendition:layout-pre-paginated'))) throw new Error('这本 EPUB 含有固定版式章节，首版暂不支持。');
  const manifest = array(packageData.manifest.item) as Record<string, unknown>[];
  const hasText = manifest.some(item => item['@_media-type'] === 'application/xhtml+xml' || item['@_media-type'] === 'text/html');
  if (!hasText) throw new Error('这本 EPUB 中没有可以选择的正文文本。');
  const samples = [];
  const resources = new Map(manifest.map(item => [item['@_id'], item]));
  let inspected = 0;
  for (const item of spineItems) {
    if (samples.length >= 4 || inspected >= 8) break;
    if (item['@_linear'] === 'no') continue;
    const resource = resources.get(item['@_idref']);
    if (!resource || !['application/xhtml+xml', 'text/html'].includes(String(resource['@_media-type'])) || String(resource['@_properties'] ?? '').split(/\s+/u).includes('nav')) continue;
    inspected++;
    const chapterPath = archiveReference(packagePath, resource['@_href']);
    const chapterSource = chapterPath ? await archiveText(archive, chapterPath, 512 * 1024) : null;
    const sample = chapterSource ? chapterLanguageSample(chapterSource) : undefined;
    if (sample) samples.push(sample);
  }
  const language = detectBookLanguage(array(packageData.metadata?.language).map(asText), samples);
  // Do not extract archive paths to disk. Only the original archive is saved.
  return { title: asText(array(packageData.metadata?.title)[0]), author: array(packageData.metadata?.creator).map(asText).filter(Boolean).join('、'), ...language };
}

const MAX_COVER_BYTES = 12 * 1024 * 1024;
const MAX_COVER_DOCUMENT_BYTES = 2 * 1024 * 1024;
type XmlObject = Record<string, unknown>;

function archiveReference(base: string, reference: unknown): string | null {
  if (typeof reference !== 'string') return null;
  let href = asText(reference).trim().split(/[?#]/u)[0];
  try { href = decodeURIComponent(href); } catch { return null; }
  if (!href || /[\\\u0000-\u001f]/u.test(href) || /^[a-z][a-z\d+.-]*:/iu.test(href) || href.startsWith('/')) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(base), href));
  return resolved === '..' || resolved.startsWith('../') ? null : resolved;
}

async function archiveText(archive: JSZip, filePath: string, limit = MAX_COVER_DOCUMENT_BYTES): Promise<string | null> {
  const file = archive.file(filePath);
  if (!file || ((file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0) > limit) return null;
  const bytes = await file.async('uint8array');
  return bytes.length <= limit ? new TextDecoder().decode(bytes) : null;
}

function xmlDocument(source: string): XmlObject | null {
  if (/<!DOCTYPE|<!ENTITY/iu.test(source) || XMLValidator.validate(source) !== true) return null;
  try { return parser.parse(source) as XmlObject; } catch { return null; }
}

function descendants(node: unknown, names: Set<string>, found: XmlObject[] = []): XmlObject[] {
  if (!node || typeof node !== 'object') return found;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') || key.startsWith('#')) continue;
    for (const child of array(value)) {
      if (names.has(key.toLowerCase()) && child && typeof child === 'object') found.push(child as XmlObject);
      descendants(child, names, found);
    }
  }
  return found;
}

function rasterMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  const signature = Buffer.from(bytes.subarray(0, 12)).toString('ascii');
  if (signature.startsWith('GIF87a') || signature.startsWith('GIF89a')) return 'image/gif';
  if (signature.startsWith('RIFF') && signature.slice(8) === 'WEBP') return 'image/webp';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (signature.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(signature.slice(8, 12))) return 'image/avif';
  return null;
}

// Only self-contained static SVGs are passed through. This is an image source,
// never injected markup; the allowlist also excludes scripts, CSS and external resources.
function staticSvg(document: XmlObject): boolean {
  const root = document.svg;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return false;
  const tags = new Set(['svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'text', 'tspan', 'textpath', 'use', 'symbol', 'view', 'title', 'desc', 'lineargradient', 'radialgradient',
    'stop', 'clippath', 'mask', 'pattern', 'marker']);
  const safe = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return true;
    if (Array.isArray(node)) return node.every(safe);
    return Object.entries(node).every(([key, value]) => {
      if (key === '#text' || key === '#comment') return true;
      if (!key.startsWith('@_')) return tags.has(key.toLowerCase()) && safe(value);
      const name = key.slice(2).toLowerCase();
      const text = String(value);
      if (name.startsWith('on') || ['style', 'base', 'src'].includes(name)) return false;
      if (name === 'href' && !/^#[\w:.-]+$/u.test(text)) return false;
      if (name === 'xmlns') return text === 'http://www.w3.org/2000/svg';
      const withoutLocalPaint = text.replace(/url\(\s*(['"]?)#[\w:.-]+\1\s*\)/giu, '');
      return !/(?:url|expression)\s*\(|(?:javascript|data|https?|file):/iu.test(withoutLocalPaint);
    });
  };
  return safe(root);
}

/** Extract the book's actual embedded cover; missing/unsupported covers never block reading. */
export async function extractEpubCover(bytes: Uint8Array): Promise<string | null> {
  if (bytes.length > 100 * 1024 * 1024) return null;
  try {
    const archive = await JSZip.loadAsync(bytes);
    let expanded = 0;
    for (const file of Object.values(archive.files)) {
      expanded += (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
      if (expanded > 400 * 1024 * 1024) return null;
    }
    const containerSource = await archiveText(archive, 'META-INF/container.xml', 128 * 1024);
    const container = containerSource ? xmlDocument(containerSource) : null;
    const rootFiles = array((container?.container as any)?.rootfiles?.rootfile) as XmlObject[];
    const root = rootFiles.find(file => file['@_media-type'] === 'application/oebps-package+xml') ?? rootFiles[0];
    const packagePath = archiveReference('container.xml', root?.['@_full-path']);
    if (!packagePath) return null;
    const packageSource = await archiveText(archive, packagePath);
    const packageData = (packageSource ? xmlDocument(packageSource)?.package : null) as XmlObject | null;
    if (!packageData || typeof packageData !== 'object') return null;
    const manifest = array((packageData.manifest as any)?.item) as XmlObject[];
    const meta = array((packageData.metadata as any)?.meta) as XmlObject[];
    const coverId = meta.find(item => item['@_name'] === 'cover')?.['@_content'];
    const coverImage = manifest.find(item => String(item['@_properties'] ?? '').split(/\s+/u).includes('cover-image'));
    const legacyCover = manifest.find(item => coverId && item['@_id'] === coverId);
    const guideCover = array((packageData.guide as any)?.reference).find((item: any) => String(item['@_type'] ?? '').split(/\s+/u).includes('cover')) as XmlObject | undefined;
    const namedCover = manifest.find(item => /^(?:cover|cover-image|coverpage)$/iu.test(String(item['@_id'] ?? '')));
    const candidates = [coverImage?.['@_href'], legacyCover?.['@_href'], guideCover?.['@_href'], namedCover?.['@_href']]
      .map(href => archiveReference(packagePath, href)).filter((href): href is string => Boolean(href));
    const visited = new Set<string>();
    const imageFrom = async (filePath: string, depth = 0): Promise<string | null> => {
      if (depth > 2 || visited.has(filePath)) return null;
      visited.add(filePath);
      const file = archive.file(filePath);
      if (!file || ((file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0) > MAX_COVER_BYTES) return null;
      const image = await file.async('uint8array');
      if (image.length > MAX_COVER_BYTES) return null;
      const mime = rasterMime(image);
      if (mime) return `data:${mime};base64,${Buffer.from(image).toString('base64')}`;
      if (image.length > MAX_COVER_DOCUMENT_BYTES) return null;
      const source = new TextDecoder().decode(image);
      const document = xmlDocument(source);
      if (!document) return null;
      if (staticSvg(document)) return `data:image/svg+xml;base64,${Buffer.from(image).toString('base64')}`;
      // EPUB2 guide pages often wrap the actual JPEG in XHTML or an SVG image element.
      const images = descendants(document, new Set(['img', 'image']));
      for (const element of images) {
        const href = archiveReference(filePath, element['@_src'] ?? element['@_href']);
        if (href) {
          const result = await imageFrom(href, depth + 1);
          if (result) return result;
        }
      }
      return null;
    };
    for (const candidate of candidates) {
      const cover = await imageFrom(candidate);
      if (cover) return cover;
    }
    return null;
  } catch { return null; }
}
