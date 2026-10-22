import { cellWidth, graphemes, plain, width, truncate } from './text.js';
import type { Theme } from './theme.js';
import { commands } from './commands.js';
import { DEFAULT_IMAGE_LIMITS, validateImages, type ImageLimits, type PendingImage } from './clipboard-image.js';
export { commands } from './commands.js';
/** Zero-based cell position of the composer caret in the frame returned by App. */
export interface CaretPosition { row: number; column: number }
/** Visible placeholder for an image whose bytes are still being read. */
export interface PendingImageSlot { readonly pending: true; readonly path: string }
export type EditorToken = string | PendingImage | PendingImageSlot;
const isPendingImageSlot = (token: EditorToken): token is PendingImageSlot =>
  typeof token !== 'string' && 'pending' in token;
const isPendingImage = (token: EditorToken): token is PendingImage =>
  typeof token !== 'string' && 'data' in token;
export class Editor {
  constructor(private readonly readImageLimits: () => ImageLimits | undefined = () => undefined,
    private readonly noticeChanged: () => void = () => {}) {}
  get imageLimits(): ImageLimits { return this.readImageLimits() ?? DEFAULT_IMAGE_LIMITS; }
  submitting = false;
  buffer: EditorToken[] = [];
  cursor = 0;
  /** Set by Composer/App so the terminal can anchor the IME near the caret. */
  caret?: CaretPosition;
  /** Input history includes image tokens so unsuccessful sends can be recalled. */
  history: EditorToken[][] = [];
  historyIndex = 0;
  private draftBuffer?: EditorToken[];
  selection = 0;
  pastedLines = 0;
  /** Images occupy one editable position, just like a text grapheme. */
  get attachments(): PendingImage[] { return this.buffer.filter(isPendingImage); }
  /** Pending placeholders are visible and editable but are not attachments yet. */
  get pendingImages(): PendingImageSlot[] { return this.buffer.filter(isPendingImageSlot); }
  /** Identity of the clipboard read belonging to this draft. Clearing invalidates it. */
  clipboardRead?: symbol;
  /** Also identifies the asynchronous file read owned by the current draft. */
  droppedRead?: AbortController;
  private noticeText?: string;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private noticeVersion = 0;
  get notice(): string | undefined { return this.noticeText; }
  /** Feedback expires by default; progress uses null and ends with its operation. */
  notify(message: string, ttlMs: number | null = 4_000): void {
    this.clearNotice();
    const version = this.noticeVersion;
    this.noticeText = message;
    if (ttlMs !== null) {
      this.noticeTimer = setTimeout(() => { if (this.noticeVersion === version) this.clearNotice(); }, ttlMs);
      this.noticeTimer.unref();
    }
    this.noticeChanged();
  }
  clearNotice(): void {
    this.noticeVersion++;
    if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer);
    this.noticeTimer = undefined;
    if (this.noticeText !== undefined) { this.noticeText = undefined; this.noticeChanged(); }
  }
  /** Edits invalidate feedback, but must not hide progress for an active read. */
  clearFeedback(): void { if (this.noticeTimer !== undefined) this.clearNotice(); }
  approvalPage = 0;
  approvalSelection = 0;
  /** Last rendered welcome mode; prevents notice scrolling from leaking into chat history. */
  welcome?: boolean;
  previewStart?: number;
  previewTotal = 0;
  previewLines = 1;
  previewAnchor?: number;
  contentRows = 0;
  get text(): string { return this.buffer.filter(token => typeof token === 'string').join(''); }
  get browsingHistory(): boolean {
    const entry = this.history[this.historyIndex];
    return entry !== undefined && entry.length === this.buffer.length && entry.every((token, index) => token === this.buffer[index]);
  }
  /** A recalled multiline entry leaves history only from its first/last line. */
  get atFirstLine(): boolean { return this.lineBoundary(false) === 0; }
  get atLastLine(): boolean { return this.lineBoundary(true) === this.buffer.length; }
  get suggestions(): typeof commands {
    return !this.attachments.length && this.text.startsWith('/') && !/\s/.test(this.text)
      ? commands.filter(item => item.name.startsWith(this.text)) : [];
  }
  replace(text: string): void { this.cancelImageReads(); this.buffer = graphemes(text); this.cursor = this.buffer.length; this.selection = 0; this.pastedLines = 0; }
  cancelImageReads(): void {
    this.clipboardRead = undefined;
    this.droppedRead?.abort(); this.droppedRead = undefined;
    this.removePendingImages();
    this.clearNotice();
  }
  private removePendingImages(): void {
    const before = this.buffer.slice(0, this.cursor).filter(isPendingImageSlot).length;
    this.buffer = this.buffer.filter(token => !isPendingImageSlot(token));
    this.cursor = Math.max(0, this.cursor - before);
  }
  addAttachment(image: PendingImage): boolean {
    try { validateImages([...this.attachments, image], this.imageLimits); }
    catch (error) { this.notify(error instanceof Error ? error.message : String(error)); return false; }
    this.buffer.splice(this.cursor++, 0, image); this.clearNotice(); this.pastedLines = 0; return true;
  }
  insertPendingImage(path: string): PendingImageSlot {
    const slot: PendingImageSlot = { pending: true, path };
    this.buffer.splice(this.cursor++, 0, slot);
    this.clearNotice(); this.pastedLines = 0;
    return slot;
  }
  resolvePendingImage(slot: PendingImageSlot, images: readonly PendingImage[]): boolean {
    const index = this.buffer.indexOf(slot);
    if (index < 0) return false;
    if (images.length) validateImages([...this.attachments, ...images], this.imageLimits);
    this.replacePendingImage(index, images);
    this.clearNotice();
    return true;
  }
  failPendingImage(slot: PendingImageSlot, text: string): boolean {
    const index = this.buffer.indexOf(slot);
    if (index < 0) return false;
    this.replacePendingImage(index, graphemes(plain(text)));
    return true;
  }
  private replacePendingImage(index: number, tokens: readonly EditorToken[]): void {
    const after = this.cursor > index;
    this.buffer.splice(index, 1, ...tokens);
    if (after) this.cursor += tokens.length - 1;
    this.cursor = Math.max(0, Math.min(this.cursor, this.buffer.length));
  }
  clearAttachments(): void {
    this.cursor = this.buffer.slice(0, this.cursor).filter(token => typeof token === 'string').length;
    this.buffer = this.buffer.filter(token => typeof token === 'string');
    // Explicit clearing leaves history browsing and discards its saved draft,
    // so Down cannot resurrect images the user has already removed.
    this.draftBuffer = undefined; this.historyIndex = this.history.length;
    this.cancelImageReads();
  }
  /** Preserve image positions without placing display labels in the model's text. */
  submissionImages(): PendingImage[] {
    const text = this.text;
    const leading = text.length - text.trimStart().length;
    const length = text.trim().length;
    let offset = 0;
    return this.buffer.flatMap(token => {
      if (typeof token === 'string') { offset += token.length; return []; }
      if (isPendingImageSlot(token)) return [];
      const position = Math.min(length, Math.max(0, offset - leading));
      const { textOffset: _, ...image } = token;
      return [position < length ? { ...image, textOffset: position } : image];
    });
  }
  insert(text: string): void {
    this.clearFeedback();
    // Segment only the surrounding text run so combining characters stay
    // intact without flattening images into strings.
    let start = this.cursor, end = this.cursor;
    while (start > 0 && typeof this.buffer[start - 1] === 'string') start--;
    while (end < this.buffer.length && typeof this.buffer[end] === 'string') end++;
    const prefix = this.buffer.slice(start, this.cursor).join('') + plain(text);
    const suffix = this.buffer.slice(this.cursor, end).join('');
    this.buffer = [...this.buffer.slice(0, start), ...graphemes(prefix + suffix), ...this.buffer.slice(end)];
    this.cursor = start + graphemes(prefix).length; this.selection = 0;
  }
  lineBoundary(end: boolean): number {
    let position = this.cursor;
    if (end) while (position < this.buffer.length && this.buffer[position] !== '\n') position++;
    else while (position > 0 && this.buffer[position - 1] !== '\n') position--;
    return position;
  }
  wordBoundary(direction: number): number {
    let position = this.cursor;
    const space = (index: number): boolean => {
      const token = this.buffer[index];
      return typeof token !== 'string' || /\s/u.test(token);
    };
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
    this.cancelImageReads();
    if (this.historyIndex === this.history.length) this.draftBuffer = this.buffer.slice();
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction));
    this.buffer = (this.history[this.historyIndex] ?? this.draftBuffer ?? []).slice();
    this.cursor = this.buffer.length; this.selection = 0; this.pastedLines = 0;
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
    this.clearFeedback();
    const value = this.text.trim();
    // Record attempted sends, including image-only messages, independently of
    // admission outcome. Clear the composer so a failure can be recalled with Up.
    if (value || this.attachments.length) {
      this.history.push(this.attachments.length ? this.buffer.slice() : graphemes(value));
      this.history = this.history.slice(-100);
      // Bound retained image bytes as well as entry count. Keep at least the
      // most recent input intact even if deployment limits have since changed.
      const bytes = (tokens: readonly EditorToken[]): number => tokens.reduce((sum, token) =>
        sum + (typeof token === 'string' || isPendingImageSlot(token) ? 0 : token.data.byteLength), 0);
      let retained = this.history.reduce((sum, entry) => sum + bytes(entry), 0);
      const budget = Math.max(this.imageLimits.maxMessageImageBytes, bytes(this.history.at(-1)!));
      while (retained > budget && this.history.length > 1) retained -= bytes(this.history.shift()!);
      this.draftBuffer = undefined;
      this.replace(''); this.clearAttachments();
    }
    return value;
  }
}

export function Composer(editor: Editor, columns: number, theme: Theme, maxLines = 4): string[] {
  const available = Math.max(1, columns - 4);
  const lines: string[] = [];
  let line = ''; let cells = 0; let cursorLine = 0; let cursorCell = 0;
  const flush = (): void => { lines.push(line); line = ''; cells = 0; };
  let imageNumber = 0;
  for (let index = 0; index <= editor.buffer.length; index++) {
    const token = editor.buffer[index] ?? ' ';
    if (typeof token !== 'string') {
      const pending = isPendingImageSlot(token);
      const name = pending
        ? available >= 36 ? ` ${truncate(plain(token.path.split(/[\\/]/).at(-1) ?? '').replace(/\n/g, ' '), 21)}` : ''
        : token.name && available >= 36 ? ` ${truncate(plain(token.name).replace(/\n/g, ' '), 21)}` : '';
      const label = pending ? `[Image …${name}]` : `[Image #${++imageNumber}${name}]`;
      if (cellWidth(label) <= available && cells + cellWidth(label) > available && cells > 0) flush();
      for (const [part, char] of graphemes(label).entries()) {
        const size = width(char);
        if (cells + size > available && cells > 0) flush();
        if (part === 0 && index === editor.cursor) { cursorLine = lines.length; cursorCell = cells; }
        line += theme.paint(pending ? 'muted' : 'accent', char); cells += size;
      }
      continue;
    }
    const char = token;
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
  if (!editor.buffer.length) lines[0] = ' ' + theme.paint('muted', ' Ask anything, or / for commands · Ctrl+V image');
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
