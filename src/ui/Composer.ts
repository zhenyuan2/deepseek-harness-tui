import { cellWidth, graphemes, plain, width, truncate } from './text.js';
import type { Theme } from './theme.js';
import { commands } from './commands.js';
import { DEFAULT_IMAGE_LIMITS, validateImages, type ImageLimits, type PendingImage } from './clipboard-image.js';
export { commands } from './commands.js';
/** Zero-based cell position of the composer caret in the frame returned by App. */
export interface CaretPosition { row: number; column: number }
interface LayoutPosition extends CaretPosition {
  /** Logical cell column used as the goal for the next vertical move. */
  goalColumn: number;
  /** The caret is drawn on the next row after a full-width line break. */
  continuation: boolean;
}
/** Visible placeholder for an image whose bytes are still being read. */
export interface PendingImageSlot { readonly pending: true; readonly path: string }
export type EditorToken = string | PendingImage | PendingImageSlot;
interface InputSnapshot { buffer: EditorToken[]; cursor: number; pastedLines: number }
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
  /** Last viewport width; navigation and painting share the same wrapping. */
  composerColumns?: number;
  composerStart = 0;
  private preferredColumn?: number;
  resetVerticalMotion(): void { this.preferredColumn = undefined; }
  /** Input history includes image tokens so unsuccessful sends can be recalled. */
  history: EditorToken[][] = [];
  historyIndex = 0;
  private draft?: InputSnapshot;
  /** Unsaved edits belong to this browsing session, never to sent history. */
  private historyEdits = new Map<number, InputSnapshot>();
  private historyEditBytes = 0;
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
    return this.historyIndex < this.history.length;
  }
  /** Ordinary multiline drafts enter history only at their line boundaries. */
  get atFirstLine(): boolean {
    return this.composerColumns === undefined ? this.lineBoundary(false) === 0
      : composerLayout(this, this.composerColumns).positions[this.cursor]!.row === 0;
  }
  get atLastLine(): boolean {
    if (this.composerColumns === undefined) return this.lineBoundary(true) === this.buffer.length;
    const { positions, lines } = composerLayout(this, this.composerColumns);
    // The end sentinel is always the bottom of the draft, even when it is
    // drawn on a new row after a full-width line. A newline that wrapped,
    // however, still has the following line on its visual row.
    if (this.cursor === this.buffer.length) return true;
    const position = positions[this.cursor]!;
    if (position.continuation) return false;
    return position.row === lines.length - 1;
  }
  get suggestions(): typeof commands {
    return !this.attachments.length && this.text.startsWith('/') && !/\s/.test(this.text)
      ? commands.filter(item => item.name.startsWith(this.text)) : [];
  }
  replace(text: string): void { this.resetVerticalMotion(); this.composerStart = 0; this.cancelImageReads(); this.buffer = graphemes(text); this.cursor = this.buffer.length; this.selection = 0; this.pastedLines = 0; }
  cancelImageReads(): void {
    this.resetVerticalMotion();
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
    this.resetVerticalMotion();
    this.buffer.splice(this.cursor++, 0, image); this.clearNotice(); this.pastedLines = 0; return true;
  }
  insertPendingImage(path: string): PendingImageSlot {
    this.resetVerticalMotion();
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
    this.resetVerticalMotion();
    const after = this.cursor > index;
    this.buffer.splice(index, 1, ...tokens);
    if (after) this.cursor += tokens.length - 1;
    this.cursor = Math.max(0, Math.min(this.cursor, this.buffer.length));
  }
  clearAttachments(): void {
    this.resetVerticalMotion();
    this.cursor = this.buffer.slice(0, this.cursor).filter(token => typeof token === 'string').length;
    this.buffer = this.buffer.filter(token => typeof token === 'string');
    // Explicit clearing leaves history browsing and discards its saved draft,
    // so Down cannot resurrect images the user has already removed.
    this.draft = undefined; this.historyEdits.clear(); this.historyEditBytes = 0;
    this.historyIndex = this.history.length;
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
    this.resetVerticalMotion();
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
  /** Move by visual rows; returns false when no row exists in that direction. */
  moveLine(direction: number): boolean {
    if (this.composerColumns !== undefined) {
      const { positions, lines } = composerLayout(this, this.composerColumns);
      const current = positions[this.cursor]!;
      const column = this.preferredColumn ?? current.goalColumn;
      this.preferredColumn = column;
      const targetOnRow = (row: number, from = 0): number | undefined => {
        let target: number | undefined;
        for (let index = from; index < positions.length; index++) {
          const position = positions[index]!;
          if (position.row !== row) continue;
          // Target columns are visual: a break at the end of a full row is
          // drawn at column 0 even though its goal column is one cell further.
          if (target === undefined || (position.column <= column && position.column >= positions[target]!.column)) target = index;
        }
        return target;
      };
      // A newline at the end of a full row shares its visual row with the next
      // line. Down must search the rest of that row before moving below it.
      if (direction > 0 && current.continuation) {
        const sameRow = targetOnRow(current.row, this.cursor + 1);
        if (sameRow !== undefined) { this.cursor = sameRow; return true; }
      }
      // An image is atomic and can span rows without editable positions.
      for (let row = current.row + direction; row >= 0 && row < lines.length; row += direction) {
        const target = targetOnRow(row);
        if (target !== undefined) { this.cursor = target; return true; }
      }
      return false;
    }
    let start = this.cursor;
    while (start > 0 && this.buffer[start - 1] !== '\n') start--;
    const column = this.cursor - start;
    let nextStart: number;
    if (direction < 0) {
      if (start === 0) return false;
      nextStart = start - 1;
      while (nextStart > 0 && this.buffer[nextStart - 1] !== '\n') nextStart--;
      this.cursor = Math.min(start - 1, nextStart + column);
    } else {
      nextStart = this.cursor;
      while (nextStart < this.buffer.length && this.buffer[nextStart] !== '\n') nextStart++;
      if (nextStart === this.buffer.length) return false;
      nextStart++;
      let end = nextStart;
      while (end < this.buffer.length && this.buffer[end] !== '\n') end++;
      this.cursor = Math.min(end, nextStart + column);
    }
    return true;
  }
  private snapshotImageBytes(snapshot: InputSnapshot): number {
    return snapshot.buffer.reduce((sum, token) =>
      sum + (typeof token === 'string' || isPendingImageSlot(token) ? 0 : token.data.byteLength), 0);
  }
  private rememberHistoryEdit(index: number, snapshot: InputSnapshot): void {
    const previous = this.historyEdits.get(index);
    if (previous) this.historyEditBytes -= this.snapshotImageBytes(previous);
    this.historyEdits.set(index, snapshot);
    const bytes = this.snapshotImageBytes(snapshot);
    this.historyEditBytes += bytes;
    // History edits keep image tokens alive outside the history budget. Keep
    // the current entry and evict older snapshots until the same byte cap fits.
    const budget = Math.max(this.imageLimits.maxMessageImageBytes, bytes);
    for (const [key, value] of [...this.historyEdits]) {
      if (this.historyEditBytes <= budget) break;
      if (key === index) continue;
      this.historyEdits.delete(key);
      this.historyEditBytes -= this.snapshotImageBytes(value);
    }
  }
  recall(direction: number): void {
    const next = Math.max(0, Math.min(this.history.length, this.historyIndex + Math.sign(direction)));
    // At either boundary this is a true no-op, including pending image reads
    // and the cursor position within the current draft or history entry.
    if (next === this.historyIndex) return;
    this.resetVerticalMotion(); this.composerStart = 0;
    this.cancelImageReads();
    const snapshot = { buffer: this.buffer.slice(), cursor: this.cursor, pastedLines: this.pastedLines };
    if (this.browsingHistory) this.rememberHistoryEdit(this.historyIndex, snapshot);
    else this.draft = snapshot;
    this.historyIndex = next;
    const saved = this.browsingHistory ? this.historyEdits.get(next) : this.draft;
    this.buffer = (saved?.buffer ?? this.history[next] ?? []).slice();
    this.cursor = Math.max(0, Math.min(this.buffer.length, saved?.cursor ?? this.buffer.length));
    this.pastedLines = saved?.pastedLines ?? 0; this.selection = 0;
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
      this.replace(''); this.clearAttachments();
    }
    return value;
  }
}

/** Token positions are measured in terminal cells, including atomic image labels. */
function composerLayout(editor: Editor, columns: number, theme?: Theme): { lines: string[]; positions: LayoutPosition[] } {
  const available = Math.max(1, columns - 4);
  const lines: string[] = [];
  const positions: LayoutPosition[] = [];
  let line = ''; let cells = 0;
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
        if (part === 0) positions[index] = {
          row: lines.length,
          column: Math.min(cells, available - 1),
          goalColumn: Math.min(cells, available - 1),
          continuation: false,
        };
        line += theme ? theme.paint(pending ? 'muted' : 'accent', char) : char; cells += size;
      }
      continue;
    }
    const char = token;
    if (char === '\n') {
      // A newline after a full row starts its caret on the next row, but its
      // logical goal remains the end of the previous row.
      positions[index] = cells === available
        ? { row: lines.length + 1, column: 0, goalColumn: available, continuation: true }
        : { row: lines.length, column: Math.min(cells, available - 1), goalColumn: Math.min(cells, available), continuation: false };
      if (cells < available) line += ' ';
      flush(); continue;
    }
    const size = width(char);
    const willWrap = cells + size > available && cells > 0;
    const wrappedEnd = index === editor.buffer.length && cells === available && willWrap;
    if (willWrap) flush();
    const column = Math.min(cells, available - 1);
    positions[index] = wrappedEnd
      ? { row: lines.length, column: 0, goalColumn: available, continuation: true }
      : { row: lines.length, column, goalColumn: column, continuation: false };
    // The terminal draws the caret itself at editor.caret. Painting an inverse
    // cell here would duplicate it and, worse, hide the real cursor that IME
    // preedit and candidate windows anchor to.
    line += size > available ? '?' : char; cells += Math.min(size, available);
  }
  lines.push(line);
  return { lines, positions };
}

export function Composer(editor: Editor, columns: number, theme: Theme, maxLines = 4): string[] {
  if (editor.composerColumns !== columns) editor.resetVerticalMotion();
  editor.composerColumns = columns;
  const available = Math.max(1, columns - 4);
  const { lines, positions } = composerLayout(editor, columns, theme);
  const cursor = positions[editor.cursor]!;
  maxLines = Math.max(1, maxLines);
  let start = Math.max(0, Math.min(editor.composerStart, lines.length - maxLines));
  if (cursor.row < start) start = cursor.row;
  else if (cursor.row >= start + maxLines) start = cursor.row - maxLines + 1;
  editor.composerStart = start;
  if (!editor.buffer.length) lines[0] = ' ' + theme.paint('muted', ' Ask anything, or / for commands · Ctrl+V image');
  // The terminal's real cursor is parked on this cell every frame; keeping the
  // cell blank lets IME preedit render inline instead of overwriting text.
  editor.caret = { row: cursor.row - start, column: 4 + Math.min(cursor.column, available - 1) };
  return lines.slice(start, start + maxLines).map((line, i, visible) => {
    const above = i === 0 && start > 0;
    const below = i === visible.length - 1 && start + visible.length < lines.length;
    const indicator = above && below ? '↕' : above ? '↑' : below ? '↓' : ' ';
    return truncate(`${theme.paint('muted', indicator)} ${theme.paint('accent', start + i === 0 ? '❯' : '·')} ${line}`, columns);
  });
}

export function CommandMenu(editor: Editor, columns: number, theme: Theme): string[] {
  const suggestions = editor.suggestions;
  const selected = editor.selection % Math.max(1, suggestions.length);
  const start = Math.max(0, selected - 2);
  return suggestions.slice(start, start + 3).map((command, i) => truncate(
    `  ${i + start === selected ? theme.paint('accent', '›') : ' '} ${command.name}  ${theme.paint('muted', command.description)}`, columns));
}
