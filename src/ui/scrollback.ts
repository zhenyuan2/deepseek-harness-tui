/** Paint a fixed viewport; only committed lines scroll above its pinned footer. */
export class ScrollbackRenderer {
  private screen: string[] = [];
  private columns = 0;
  private rows = 0;
  private mounted = false;
  private caret?: { row: number; column: number };
  private caretVisible = false;
  constructor(private readonly write: (text: string) => unknown) {}
  clear(): void {
    this.write('\x1b[?25l\x1b[r\x1b[2J\x1b[3J\x1b[H');
    this.screen = []; this.columns = 0; this.rows = 0; this.mounted = false;
    this.caret = undefined; this.caretVisible = false;
  }
  render(completed: string[], frame: string[], columns: number, rows: number, contentRows = Math.max(1, rows - 5), caret?: { row: number; column: number }): void {
    const resized = columns !== this.columns || rows !== this.rows;
    const body = Math.max(1, Math.min(rows, contentRows));
    const target = caret ? {
      row: Math.max(0, Math.min(rows - 1, Math.trunc(caret.row))),
      column: Math.max(0, Math.min(columns - 1, Math.trunc(caret.column)))
    } : undefined;
    let output = '';
    if (!this.mounted) output += '\r\n'.repeat(Math.max(0, rows - 1));
    if (resized || completed.length) output += `\x1b[1;${body}r`;
    // Put exactly these durable lines at the region's top before scrolling them
    // into native history; transient preview/footer lines can never be exported.
    for (let start = 0; start < completed.length; start += body) {
      const batch = completed.slice(start, start + body);
      for (let i = 0; i < batch.length; i++) output += `\x1b[${i + 1};1H\x1b[2K${batch[i]}`;
      output += `\x1b[${body};1H` + '\r\n'.repeat(batch.length);
    }
    const screen = [...frame, ...Array<string>(Math.max(0, rows - frame.length)).fill('')].slice(0, rows);
    let painted = resized || !this.mounted || completed.length > 0;
    for (let i = 0; i < screen.length; i++) {
      if (resized || completed.length || screen[i] !== this.screen[i]) {
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
  close(completed: string[], _columns: number, rows: number): void {
    // Remove the application viewport, restore full-screen margins, then append
    // the durable tail once. Previously exported history is left untouched.
    let output = '\x1b[r';
    if (this.mounted) {
      for (let i = 1; i <= rows; i++) output += `\x1b[${i};1H\x1b[2K`;
      output += '\x1b[1;1H';
    }
    output += completed.length ? completed.join('\r\n') + '\r\n' : '';
    this.write(output + '\x1b[0m\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25h');
    this.screen = []; this.mounted = false;
    this.caret = undefined; this.caretVisible = false;
  }
}
