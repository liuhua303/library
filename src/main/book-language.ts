import { XMLParser } from 'fast-xml-parser';
import type { BookLanguageSource, SourceLanguage } from '../shared/types';

export interface ChapterLanguageSample {
  language?: SourceLanguage;
  text: string;
}

export interface BookLanguageDetection {
  language: SourceLanguage;
  languageSource: Extract<BookLanguageSource, 'metadata' | 'content' | 'unknown'>;
}

const sampleParser = new XMLParser({
  ignoreAttributes: false, removeNSPrefix: true, processEntities: false, trimValues: false,
});
const nonProseTypes = new Set(['toc', 'landmarks', 'page-list', 'copyright-page', 'titlepage', 'halftitlepage', 'cover', 'colophon']);

function isNonProse(node: unknown): boolean {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const attributes = node as Record<string, unknown>;
  return String(attributes['@_type'] ?? '').split(/\s+/u).some(type => nonProseTypes.has(type)) ||
    String(attributes['@_role'] ?? '').split(/\s+/u).some(role => ['doc-toc', 'doc-cover', 'doc-colophon', 'doc-credit', 'doc-copyright'].includes(role));
}

export function sourceLanguageTag(value: unknown): SourceLanguage | undefined {
  if (typeof value !== 'string') return undefined;
  const tag = value.trim().replace(/_/gu, '-').toLowerCase();
  if (/^(?:ja|jpn)(?:-|$)/u.test(tag)) return 'ja';
  if (/^(?:en|eng)(?:-|$)/u.test(tag)) return 'en';
  return undefined;
}

function plainText(value: string): string {
  return value.replace(/&#(?:x([a-f\d]+)|(\d+));/giu, (match, hex: string, decimal: string) => {
    const code = Number.parseInt(hex || decimal, hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : match;
  }).replace(/&(?:amp|lt|gt|quot|apos);/gu, ' ');
}

/** Only chapter text is sampled; ruby readings and executable/style content are not evidence. */
export function chapterLanguageSample(source: string): ChapterLanguageSample | undefined {
  try {
    const document = sampleParser.parse(source) as Record<string, any>;
    const root = document.html;
    if (!root || typeof root !== 'object') return undefined;
    const body = root.body;
    if (body === undefined || isNonProse(body)) return undefined;
    const fragments: string[] = [];
    let sampled = 0;
    const visit = (node: unknown): void => {
      if (sampled >= 20_000 || isNonProse(node)) return;
      if (typeof node === 'string' || typeof node === 'number') {
        const fragment = plainText(String(node)).slice(0, 20_000 - sampled);
        fragments.push(fragment); sampled += fragment.length;
      } else if (Array.isArray(node)) {
        for (const child of node) visit(child);
      } else if (node && typeof node === 'object') {
        for (const [name, child] of Object.entries(node)) {
          if (name.startsWith('@_') || ['script', 'style', 'rt', 'rp', 'nav'].includes(name.toLowerCase())) continue;
          visit(child);
        }
      }
    };
    visit(body);
    if (!fragments.some(fragment => fragment.trim())) return undefined;
    const language = sourceLanguageTag(body?.['@_lang']) ?? sourceLanguageTag(root['@_lang']);
    return { ...(language ? { language } : {}), text: fragments.join(' ') };
  } catch {
    // Missing/broken chapter metadata must not turn language detection into an import failure.
    return undefined;
  }
}

function textLanguage(text: string, conservative = false): SourceLanguage | undefined {
  const kana = (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length;
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
  const total = kana + han + latin;
  if (kana >= (conservative ? 20 : 8) && kana + han >= (conservative ? 80 : 20) &&
      (kana + han) / Math.max(1, total) >= (conservative ? .7 : .2) && kana / Math.max(1, total) >= (conservative ? .2 : .08)) return 'ja';
  // Latin letters alone do not establish English (e.g. a French book or romaji).
  const englishWords = text.toLowerCase().match(/\b(?:the|and|of|is|to|in|was|with|that|for|her|his|she|he|they|there)\b/gu) ?? [];
  if (latin >= (conservative ? 200 : 40) && kana === 0 && han / Math.max(1, total) < .03 &&
      englishWords.length >= (conservative ? 12 : 3) && new Set(englishWords).size >= (conservative ? 5 : 2)) return 'en';
  return undefined;
}

export function detectBookLanguage(metadataLanguages: readonly unknown[], chapters: readonly ChapterLanguageSample[]): BookLanguageDetection {
  // EPUB's first dc:language is the publication's primary language.
  const declared = sourceLanguageTag(metadataLanguages[0]);
  const text = chapters.map(chapter => chapter.text).join(' ');
  const detected = textLanguage(text);
  if (declared) {
    // Correct publication metadata should survive quotations and isolated English
    // copyright pages. Overriding Japanese metadata requires two prose samples.
    const strong = detected !== declared ? textLanguage(text, true) : undefined;
    if (strong && (strong === 'ja' || chapters.filter(chapter => textLanguage(chapter.text, true) === 'en').length >= 2)) {
      return { language: strong, languageSource: 'content' };
    }
    return { language: declared, languageSource: 'metadata' };
  }
  if (detected) return { language: detected, languageSource: 'content' };
  const tagged = chapters.find(chapter => chapter.language)?.language;
  if (tagged) return { language: tagged, languageSource: 'content' };
  return { language: 'en', languageSource: 'unknown' };
}
