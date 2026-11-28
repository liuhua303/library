import JSZip from 'jszip';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const escapeXml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const japaneseSample = {
  title: '日語の読書テスト',
  sentence: '今日は図書館で本を読みました。',
  word: '物語',
  reading: 'ものがたり',
  example: '毎晩、子どもに短い物語を読みます。',
};

// Self-authored, horizontal, reflowable EPUB. Ruby deliberately splits the first
// sentence into multiple text nodes so a real drag exercises base-text indexing.
export async function createJapaneseSampleBook(output, { title = japaneseSample.title } = {}) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/package.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">yuejian-japanese-smoke</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:creator>Yuejian self-authored test fixture</dc:creator><dc:language>ja-JP</dc:language><meta property="dcterms:modified">2026-11-28T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter1"/><itemref idref="chapter2"/></spine></package>`);
  zip.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja"><head><title>目次</title></head><body><nav epub:type="toc"><h1>目次</h1><ol><li><a href="chapter1.xhtml">静かな朝</a></li><li><a href="chapter2.xhtml">次の日</a></li></ol></nav></body></html>');
  const paragraphs = [
    '<p id="ruby-sentence">今日は<ruby>図書館<rp>（</rp><rt>としょかん</rt><rp>）</rp></ruby>で本を読みました。</p>',
    '<p id="word-line">私は静かな部屋で物語を読みます。</p>',
    '<p>「明日も来ます！」と彼女は言いました。窓の外では小鳥が歌っています。</p>',
    ...Array.from({ length: 45 }, (_, index) => `<p>読書の記録${index + 1}。朝の光が机の上に広がっています。ページをゆっくりめくると、知らなかった町や人々の姿が見えてきます。私は気になった言葉を書き留め、物語の続きを楽しみにしています。本を閉じた後も、登場人物の声が心に残っています。</p>`),
  ];
  const chapter = (name, body) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" lang="ja"><head><title>${name}</title><style>body{line-height:1.85;margin:0;padding:20px 30px;writing-mode:horizontal-tb}h1{font-size:1.5em;font-weight:normal}p{margin:0 0 1em}rt{font-size:.5em}</style></head><body><h1>${name}</h1>${body.join('')}</body></html>`;
  zip.file('OEBPS/chapter1.xhtml', chapter('静かな朝', paragraphs));
  zip.file('OEBPS/chapter2.xhtml', chapter('次の日', ['<p>次の日も図書館に来ました。新しい物語が待っています。</p>', ...paragraphs.slice(3, 12)]));
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await createJapaneseSampleBook(resolve(process.argv[2] || 'samples/japanese-demo.epub')));
}
