import JSZip from 'jszip';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const escapeXml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function createSampleBook(output, { title = 'A Little Room for Reading', identifier = 'yuejian-reading-demo', alternate = false } = {}) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/package.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${identifier}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:creator>Yuejian reading sample</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">2026-11-26T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter1"/><itemref idref="chapter2"/></spine></package>`);
  zip.file('OEBPS/nav.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol><li><a href="chapter1.xhtml">A quiet beginning</a></li><li><a href="chapter2.xhtml">Another morning</a></li></ol></nav></body></html>');
  const opening = alternate
    ? 'A peculiar light shone on the bank of the river. Clara had brought another book with her.'
    : 'When Clara opened the little bookshop, a peculiar silence filled the room. She placed a notebook beside the window and began to read.';
  const paragraphs = [opening, 'She decided to give up the search before sunset. It was a difficult decision, but there were other stories waiting for her.', 'The words in a book can lead us through unfamiliar places. A single expression may mean something quite different when it appears in a new sentence.'];
  const longSentence = 'As the afternoon continued, ' + Array.from({ length: 32 }, (_, index) => `Clara remembered the ${['quiet garden', 'distant station', 'old letter', 'small library'][index % 4]} where she had once stopped to read`).join(', and ') + ', until at last she understood why the story mattered.';
  paragraphs.push(longSentence);
  for (let index = 0; index < 40; index++) paragraphs.push(`On reading day ${index + 1}, she returned to the window. The street outside was full of familiar sounds, yet the pages offered something unexpected. She read without hurry, marked the expressions she wanted to understand, and kept the thread of the story in mind. Later she would return to those expressions and see how the writer had used them.`);
  const chapter = (name, items) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${name}</title><style>body{font-family:Georgia,serif;line-height:1.85;margin:0;padding:20px 30px}h1{font-size:1.7em;font-weight:normal}p{margin:0 0 1.2em}</style></head><body><h1>${name}</h1>${items.map(text => `<p>${escapeXml(text)}</p>`).join('')}</body></html>`;
  zip.file('OEBPS/chapter1.xhtml', chapter('A quiet beginning', paragraphs));
  zip.file('OEBPS/chapter2.xhtml', chapter('Another morning', ['The next morning, Clara did not give up. She opened the notebook and returned to the phrases she had collected.', ...paragraphs.slice(4, 12)]));
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const output = resolve('samples/reading-demo.epub');
  await createSampleBook(output);
  console.log(output);
}
