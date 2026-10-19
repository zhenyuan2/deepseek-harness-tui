import { stripVTControlCharacters } from 'node:util';

/** Untrusted output never controls cursor position, terminal modes, or links. */
export function plain(text: string): string {
  return stripVTControlCharacters(text.replace(/\r\n?/g, '\n'))
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\t/g, '  ');
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function graphemes(text: string): string[] {
  return [...segmenter.segment(text)].map(part => part.segment);
}
export function width(char: string): number {
  if (/^[\p{Mark}\p{Cf}]+$/u.test(char)) return 0;
  if (/[\u{1f1e6}-\u{1f1ff}\u20e3\ufe0f\u{20000}-\u{3fffd}]/u.test(char)) return 2;
  return /[\p{Extended_Pictographic}\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1;
}
export const cellWidth = (text: string): number => graphemes(stripVTControlCharacters(text)).reduce((sum, char) => sum + width(char), 0);

/** Wrap only our generated SGR styling. Reset every physical line. */
export function wrapStyled(text: string, columns: number): string[] {
  columns = Math.max(1, columns);
  const lines: string[] = [];
  let line = ''; let cells = 0; let style = '';
  const flush = (): void => { lines.push(line + (style ? '\x1b[0m' : '')); line = style; cells = 0; };
  for (const part of text.split(/(\x1b\[[0-9;]*m)/g)) {
    if (/^\x1b\[[0-9;]*m$/.test(part)) {
      line += part; style = part === '\x1b[0m' ? '' : style + part;
      continue;
    }
    for (const char of graphemes(part)) {
      if (char === '\n') { flush(); continue; }
      const size = width(char);
      if (cells + size > columns && cells) flush();
      line += size > columns ? '?' : char; cells += Math.min(size, columns);
    }
  }
  lines.push(line + (style ? '\x1b[0m' : ''));
  return lines;
}
export const wrap = (text: string, columns: number): string[] => wrapStyled(plain(text), columns);
export function truncate(text: string, columns: number): string {
  const lines = wrapStyled(text, columns);
  return lines[0] ?? '';
}
