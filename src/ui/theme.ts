export type Tone = 'accent' | 'muted' | 'border' | 'success' | 'error' | 'warning' | 'code' | 'bold' | 'italic' | 'cursor';
export interface Theme { paint(tone: Tone, text: string): string }
// Claude Code inspired, restrained ANSI-256 palette. Body text and background
// inherit the terminal theme, so we never repaint the user's whole terminal.
const codes: Record<Tone, string> = {
  accent: '38;5;173',    // terracotta: brand, active prompts, selected items
  muted: '38;5;245',     // readable secondary text
  border: '38;5;240',    // quieter separators and code frames
  success: '38;5;108',   // sage green
  error: '38;5;167',     // soft red
  warning: '38;5;179',   // muted amber
  code: '38;5;146',      // soft lavender, separate from UI emphasis
  bold: '1', italic: '3', cursor: '7',
};
export function createTheme(color = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb'): Theme {
  return { paint: (tone, text) => color || tone === 'cursor' ? `\x1b[${codes[tone]}m${text}\x1b[0m` : text };
}
