import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { extractEpubCover } from '../src/main/epub';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const expectedPng = `data:image/png;base64,${png.toString('base64')}`;

async function epub(options: { metadata?: string; manifest?: string; guide?: string; files?: Record<string, string | Uint8Array>; packagePath?: string } = {}) {
  const archive = new JSZip();
  const packagePath = options.packagePath ?? 'OPS/content.opf';
  archive.file('mimetype', 'application/epub+zip');
  archive.file('META-INF/container.xml', `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${packagePath}" media-type="application/oebps-package+xml" /></rootfiles></container>`);
  archive.file(packagePath, `<package xmlns="http://www.idpf.org/2007/opf"><metadata>${options.metadata ?? ''}</metadata><manifest>${options.manifest ?? ''}</manifest><spine/>${options.guide ?? ''}</package>`);
  for (const [filePath, content] of Object.entries(options.files ?? {})) archive.file(filePath, content);
  return archive.generateAsync({ type:'uint8array' });
}

describe('embedded EPUB covers', () => {
  it('returns the original EPUB3 cover bytes, resolving encoded paths relative to the package', async () => {
    const bytes = await epub({
      packagePath:'OPS/Package/content.opf',
      manifest:'<item id="art" href="../Images/%E5%B0%81%E9%9D%A2%20one.png" media-type="image/png" properties="cover-image remote-resources"/>',
      files:{ 'OPS/Images/封面 one.png':png },
    });
    expect(await extractEpubCover(bytes)).toBe(expectedPng);
  });

  it('finds EPUB2 metadata cover IDs without requiring a particular file name', async () => {
    const bytes = await epub({
      metadata:'<meta name="cover" content="jacket"/>',
      manifest:'<item id="jacket" href="Images/1324.bin" media-type="image/jpeg"/>',
      files:{ 'OPS/Images/1324.bin':png },
    });
    expect(await extractEpubCover(bytes)).toBe(expectedPng);
  });

  it('uses the real image inside a guide cover XHTML/SVG wrapper', async () => {
    const bytes = await epub({
      manifest:'<item id="front" href="Text/front.xhtml" media-type="application/xhtml+xml"/>',
      guide:'<guide><reference type="cover" href="Text/front.xhtml#front"/></guide>',
      files:{
        'OPS/Text/front.xhtml':'<html xmlns="http://www.w3.org/1999/xhtml"><body><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="../Images/jacket.png"/></svg></body></html>',
        'OPS/Images/jacket.png':png,
      },
    });
    expect(await extractEpubCover(bytes)).toBe(expectedPng);
  });

  it('handles an ordinary image cover page and named cover manifest fallback', async () => {
    const bytes = await epub({
      manifest:'<item id="coverpage" href="cover.xhtml" media-type="application/xhtml+xml"/>',
      files:{ 'OPS/cover.xhtml':'<html><body><img src="image&amp;front.png"/></body></html>', 'OPS/image&front.png':png },
    });
    expect(await extractEpubCover(bytes)).toBe(expectedPng);
  });

  it('retains self-contained static vector covers as image sources', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="150"><rect width="100" height="150" fill="#000"/><text x="10" y="30" fill="#fff">A Book</text></svg>';
    const bytes = await epub({ manifest:'<item id="front" href="front.svg" properties="cover-image"/>', files:{'OPS/front.svg':svg} });
    expect(await extractEpubCover(bytes)).toBe(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="100"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="https://example.com"/></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://example.com/pixel)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/art.svg#art"/></svg>',
    '<!DOCTYPE svg [<!ENTITY external SYSTEM "file:///secret">]><svg xmlns="http://www.w3.org/2000/svg"><text>&external;</text></svg>',
  ])('does not expose active or externally linked SVG markup (%#)', async svg => {
    const bytes = await epub({ manifest:'<item id="front" href="front.svg" properties="cover-image"/>', files:{'OPS/front.svg':svg} });
    expect(await extractEpubCover(bytes)).toBeNull();
  });

  it.each(['https://example.com/cover.png', 'file:///cover.png', '//example.com/cover.png', '../../cover.png', '..\\cover.png'])('ignores non-archive or escaping cover references: %s', async href => {
    const bytes = await epub({ manifest:`<item id="front" href="${href}" properties="cover-image"/>`, files:{'cover.png':png} });
    expect(await extractEpubCover(bytes)).toBeNull();
  });

  it('does not mistake external images on a cover page for local cover data', async () => {
    const bytes = await epub({
      manifest:'<item id="cover" href="cover.xhtml"/>',
      files:{'OPS/cover.xhtml':'<html><body><img src="https://example.com/cover.png"/></body></html>'},
    });
    expect(await extractEpubCover(bytes)).toBeNull();
  });

  it('returns null for absent, broken or oversized covers without breaking the book', async () => {
    expect(await extractEpubCover(await epub())).toBeNull();
    expect(await extractEpubCover(new Uint8Array([1,2,3]))).toBeNull();
    const oversized = new Uint8Array(12 * 1024 * 1024 + 1);
    oversized.set(png);
    const bytes = await epub({manifest:'<item id="front" href="front.png" properties="cover-image"/>', files:{'OPS/front.png':oversized}});
    expect(await extractEpubCover(bytes)).toBeNull();
  });
});
