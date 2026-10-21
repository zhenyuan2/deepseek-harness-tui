import { graphemes, plain, width, truncate } from './text.js';
import type { Theme } from './theme.js';
import { commands } from './commands.js';
export { commands } from './commands.js';
/** Zero-based cell position of the composer caret in the frame returned by App. */
export interface CaretPosition { row: number; column: number }
export class Editor {
  buffer: string[] = [];
  cursor = 0;
  /** Set by Composer/App so the terminal can anchor the IME near the caret. */
  caret?: CaretPosition;
  history: string[] = [];
  historyIndex = 0;
  draft = '';
  selection = 0;
  pastedLines = 0;
  approvalPage = 0;
  approvalSelection = 0;
  /** Last rendered welcome mode; prevents notice scrolling from leaking into chat history. */
  welcome?: boolean;
  previewStart?: number;
  previewTotal = 0;
  previewLines = 1;
  previewAnchor?: number;
  contentRows = 0;
  get text(): string { return this.buffer.join(''); }
  get suggestions(): typeof commands {
    return this.text.startsWith('/') && !/\s/.test(this.text) ? commands.filter(item => item.name.startsWith(this.text)) : [];
  }
  replace(text: string): void { this.buffer = graphemes(text); this.cursor = this.buffer.length; this.selection = 0; this.pastedLines = 0; }
  insert(text: string): void {
    const prefix = this.buffer.slice(0, this.cursor).join('') + plain(text);
    this.buffer = graphemes(prefix + this.buffer.slice(this.cursor).join('')); this.cursor = graphemes(prefix).length; this.selection = 0;
  }
  lineBoundary(end: boolean): number {
    let position = this.cursor;
    if (end) while (position < this.buffer.length && this.buffer[position] !== '\n') position++;
    else while (position > 0 && this.buffer[position - 1] !== '\n') position--;
    return position;
  }
  wordBoundary(direction: number): number {
    let position = this.cursor;
    const space = (index: number): boolean => /\s/u.test(this.buffer[index] ?? '');
    if (direction < 0) {
      while (position > 0 && space(position - 1)) position--;
      while (position > 0 && !space(position - 1)) position--;
    } else {
      while (position < this.buffer.length && space(position)) position++;
      while (position < this.buffer.length && !space(position)) position++;
    }
    return position;
  }
  moveLine(direction: number): void {
    let start = this.cursor;
    while (start > 0 && this.buffer[start - 1] !== '\n') start--;
    const column = this.cursor - start;
    let nextStart: number;
    if (direction < 0) {
      if (start === 0) return;
      nextStart = start - 1;
      while (nextStart > 0 && this.buffer[nextStart - 1] !== '\n') nextStart--;
      this.cursor = Math.min(start - 1, nextStart + column);
    } else {
      nextStart = this.cursor;
      while (nextStart < this.buffer.length && this.buffer[nextStart] !== '\n') nextStart++;
      if (nextStart === this.buffer.length) return;
      nextStart++;
      let end = nextStart;
      while (end < this.buffer.length && this.buffer[end] !== '\n') end++;
      this.cursor = Math.min(end, nextStart + column);
    }
  }
  recall(direction: number): void {
    if (this.historyIndex === this.history.length) this.draft = this.text;
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction));
    this.replace(this.history[this.historyIndex] ?? this.draft);
  }
  /** Conversation previews are bottom-anchored; the welcome/notice viewport is top-anchored. */
  scrollPreview(direction: number, step: number, topAnchored: boolean): void {
    const last = Math.max(0, this.previewTotal - this.previewLines);
    if (!last) { this.previewStart = undefined; return; }
    if (topAnchored) {
      const start = Math.max(0, Math.min(last, (this.previewStart ?? 0) + direction * step));
      this.previewStart = start === 0 ? undefined : start;
      return;
    }
    const start = (this.previewStart ?? last) + direction * step;
    this.previewStart = start >= last ? undefined : Math.max(0, start);
  }
  submit(): string {
    const value = this.text.trim();
    if (value) { this.history.push(value); this.history = this.history.slice(-100); this.historyIndex = this.history.length; this.draft = ''; this.replace(''); }
    return value;
  }
}

export function Composer(editor: Editor, columns: number, theme: Theme, maxLines = 4): string[] {
  const available = Math.max(1, columns - 4);
  const lines: string[] = [];
  let line = ''; let cells = 0; let cursorLine = 0; let cursorCell = 0;
  const flush = (): void => { lines.push(line); line = ''; cells = 0; };
  for (let index = 0; index <= editor.buffer.length; index++) {
    const char = editor.buffer[index] ?? ' ';
    const size = char === '\n' ? index === editor.cursor ? 1 : 0 : width(char);
    if (cells + size > available && cells > 0) flush();
    if (index === editor.cursor) { cursorLine = lines.length; cursorCell = Math.min(cells, available); }
    if (char === '\n') {
      if (index === editor.cursor) { line += ' '; cells++; }
      flush(); continue;
    }
    // The terminal draws the caret itself at editor.caret. Painting an inverse
    // cell here would duplicate it and, worse, hide the real cursor that IME
    // preedit and candidate windows anchor to.
    line += size > available ? '?' : char; cells += Math.min(size, available);
  }
  lines.push(line);
  const start = Math.max(0, Math.min(cursorLine - maxLines + 1, lines.length - maxLines));
  if (editor.text === '') lines[0] = ' ' + theme.paint('muted', ' Ask anything, or / for commands');
  // The terminal's real cursor is parked on this cell every frame; keeping the
  // cell blank lets IME preedit render inline instead of overwriting text.
  editor.caret = { row: cursorLine - start, column: 4 + cursorCell };
  return lines.slice(start, start + maxLines).map((line, i) => truncate(`  ${theme.paint('accent', start + i === 0 ? '❯' : '·')} ${line}`, columns));
}

export function CommandMenu(editor: Editor, columns: number, theme: Theme): string[] {
  const suggestions = editor.suggestions;
  const selected = editor.selection % Math.max(1, suggestions.length);
  const start = Math.max(0, selected - 2);
  return suggestions.slice(start, start + 3).map((command, i) => truncate(
    `  ${i + start === selected ? theme.paint('accent', '›') : ' '} ${command.name}  ${theme.paint('muted', command.description)}`, columns));
}
