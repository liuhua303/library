import type { ReaderTheme } from '../../shared/types';

export interface ReaderThemeStyle {
  id: ReaderTheme;
  label: string;
  english: string;
  paper: string;
  ink: string;
  fontFamily: string;
  weight: number;
}

// Project palettes calibrated from the reference, not official Apple color tokens.
export const READER_THEMES: ReaderThemeStyle[] = [
  { id: 'original', label: '原色', english: 'Original', paper: '#ffffff', ink: '#000000', fontFamily: 'Georgia, "Times New Roman", serif', weight: 400 },
  { id: 'quiet', label: '静谧', english: 'Quiet', paper: '#414144', ink: '#e5e4e1', fontFamily: 'Georgia, "Times New Roman", serif', weight: 400 },
  { id: 'paper', label: '纸张', english: 'Paper', paper: '#eeede9', ink: '#292824', fontFamily: 'Georgia, "Times New Roman", serif', weight: 400 },
  { id: 'bold', label: '醒目', english: 'Bold', paper: '#ffffff', ink: '#121212', fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif', weight: 600 },
  { id: 'calm', label: '舒缓', english: 'Calm', paper: '#f2e4c8', ink: '#3e3425', fontFamily: 'Georgia, "Times New Roman", serif', weight: 400 },
  { id: 'focus', label: '专注', english: 'Focus', paper: '#fffbf2', ink: '#292820', fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif', weight: 400 },
];

export function readerTheme(id: ReaderTheme = 'original'): ReaderThemeStyle {
  return READER_THEMES.find(theme => theme.id === id) ?? READER_THEMES[0]!;
}
