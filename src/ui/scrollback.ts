import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** Keep small histories in memory; spill longer ones to a private temp file. */
const MEMORY_HISTORY_LINES = 2_000;
const MEMORY_HISTORY_CHARS = 1_000_000;
const SPOOL_CHUNK_LINES = 256;
const SPOOL_READ_BYTES = 64 * 1024;
const HISTORY_WRITE_CHARS = 8 * 1024;

interface HistorySpool { readonly directory: string; readonly path: string; readonly fd: number }

/** Paint an alternate-screen viewport and export only durable output on exit. */
export class ScrollbackRenderer {
  private screen: string[] = [];
  private history: string[] = [];
  private historyChars = 0;
  private spool?: HistorySpool;
  private columns = 0;
  private rows = 0;
  private mounted = false;
  private caret?: { row: number; column: number };
  private caretVisible = false;
  constructor(private readonly write: (text: string) => unknown) {}
  invalidate(): void { this.screen = []; }
  clear(): void {
    // Clear the normal buffer as well for an explicit Ctrl+L / clear chat.
    this.write('\x1b[?25l\x1b[?1049l\x1b[r\x1b[2J\x1b[3J\x1b[H');
    this.discardSpool();
    this.history = []; this.historyChars = 0;
    this.screen = []; this.columns = 0; this.rows = 0; this.mounted = false;
    this.caret = undefined; this.caretVisible = false;
  }
  render(completed: string[], frame: string[], columns: number, rows: number, _contentRows = Math.max(1, rows - 5), caret?: { row: number; column: number }): void {
    const resized = columns !== this.columns || rows !== this.rows;
    const target = caret ? {
      row: Math.max(0, Math.min(rows - 1, Math.trunc(caret.row))),
      column: Math.max(0, Math.min(columns - 1, Math.trunc(caret.column)))
    } : undefined;
    let output = '';
    if (!this.mounted) output += '\x1b[?1049h\x1b[r';
    this.appendHistory(completed);
    const screen = [...frame, ...Array<string>(Math.max(0, rows - frame.length)).fill('')].slice(0, rows);
    let painted = resized || !this.mounted;
    for (let i = 0; i < screen.length; i++) {
      if (resized || screen[i] !== this.screen[i]) {
        output += `\x1b[${i + 1};1H\x1b[2K${screen[i]}`; painted = true;
      }
    }
    const caretMoved = target !== undefined && (this.caret === undefined ||
      target.row !== this.caret.row || target.column !== this.caret.column);
    const caretChanged = (target !== undefined) !== this.caretVisible;
    if (!painted && !caretMoved && !caretChanged) {
      this.screen = screen; this.columns = columns; this.rows = rows; this.mounted = true;
      return;
    }
    // Hide only while repainting. Pure caret moves stay visible so terminal
    // cursor animations (and IME preedit) are not interrupted every keystroke.
    if (painted) output = '\x1b[?25l' + output;
    // Terminals anchor IME preedit/candidate windows to the visible hardware
    // cursor. Park it on the composer caret, and show it so terminals that
    // ignore a hidden cursor's position still place the IME correctly. With
    // no editable caret (picker/approval), restore a hidden cursor at home.
    const row = target?.row ?? 0; const column = target?.column ?? 0;
    output += `\x1b[${row + 1};${column + 1}H`;
    if (target) {
      if (!this.caretVisible || painted) output += '\x1b[?25h';
    } else {
      if (this.caretVisible || painted) output += '\x1b[?25l';
    }
    this.write(output);
    this.screen = screen; this.columns = columns; this.rows = rows; this.mounted = true;
    this.caret = target; this.caretVisible = target !== undefined;
  }
  close(completed: string[], _columns: number, _rows: number): void {
    try {
      // Restore the shell before publishing; preview and footer never enter history.
      if (this.mounted) this.write('\x1b[r\x1b[?1049l');
      if (this.spool) {
        this.writeSpooledHistory();
        this.writeHistory(completed);
      } else {
        this.writeHistory(this.history.concat(completed));
      }
      this.write('\x1b[0m\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25h');
    } finally {
      this.discardSpool();
      this.history = []; this.historyChars = 0;
      this.screen = []; this.mounted = false;
      this.caret = undefined; this.caretVisible = false;
    }
  }

  private appendHistory(lines: readonly string[]): void {
    if (!lines.length) return;
    if (!this.spool) {
      let incoming = 0;
      for (const line of lines) incoming += line.length;
      if (this.history.length + lines.length > MEMORY_HISTORY_LINES
        || this.historyChars + incoming > MEMORY_HISTORY_CHARS) {
        this.spillHistory();
      }
    }
    if (this.spool) {
      this.writeSpool(lines);
      return;
    }
    for (const line of lines) { this.history.push(line); this.historyChars += line.length; }
  }

  /** Move the in-memory history into a private temp file before it grows. */
  private spillHistory(): void {
    if (this.spool) return;
    let directory: string | undefined;
    let fd: number | undefined;
    try {
      directory = mkdtempSync(join(tmpdir(), 'dsh-tui-history-'));
      const path = join(directory, 'history.log');
      fd = openSync(path, 'w', 0o600);
      const spool: HistorySpool = { directory, path, fd };
      this.spool = spool;
      if (this.history.length) {
        for (let index = 0; index < this.history.length; index += SPOOL_CHUNK_LINES) {
          const chunk = this.history.slice(index, index + SPOOL_CHUNK_LINES);
          writeSync(fd, chunk.join('\r\n') + '\r\n');
        }
      }
      this.history = []; this.historyChars = 0;
    } catch {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
      if (directory !== undefined) { try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ } }
      this.spool = undefined;
    }
  }

  private writeSpool(lines: readonly string[]): void {
    const spool = this.spool;
    if (!spool) return;
    for (let index = 0; index < lines.length; index += SPOOL_CHUNK_LINES) {
      const chunk = lines.slice(index, index + SPOOL_CHUNK_LINES);
      writeSync(spool.fd, chunk.join('\r\n') + '\r\n');
    }
  }

  private writeSpooledHistory(): void {
    const spool = this.spool;
    if (!spool) return;
    const fd = openSync(spool.path, 'r');
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(SPOOL_READ_BYTES);
    try {
      let bytes = 0;
      while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        const text = decoder.write(buffer.subarray(0, bytes));
        if (text) this.writeChunked(text);
      }
      const tail = decoder.end();
      if (tail) this.writeChunked(tail);
    } finally {
      closeSync(fd);
    }
  }

  /** Keep terminal writes bounded so a slow consumer still shows progress. */
  private writeChunked(text: string): void {
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(text.length, offset + HISTORY_WRITE_CHARS);
      if (end < text.length) {
        // Never split a UTF-16 surrogate pair across two writes.
        const code = text.charCodeAt(end - 1);
        if (code >= 0xD800 && code <= 0xDBFF) end--;
      }
      this.write(text.slice(offset, end));
      offset = end;
    }
  }

  private writeHistory(lines: readonly string[]): void {
    let chunk: string[] = [];
    let chars = 0;
    const flush = (): void => {
      if (!chunk.length) return;
      this.writeChunked(chunk.join('\r\n') + '\r\n');
      chunk = []; chars = 0;
    };
    for (const line of lines) {
      chunk.push(line);
      chars += line.length + 2;
      if (chars >= HISTORY_WRITE_CHARS) flush();
    }
    flush();
  }

  private discardSpool(): void {
    const spool = this.spool;
    this.spool = undefined;
    if (!spool) return;
    try { closeSync(spool.fd); } catch { /* already closed */ }
    try { rmSync(spool.directory, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
