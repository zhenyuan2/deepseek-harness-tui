import type { MouseReport } from './mouse.js';
import { graphemes, plain, width } from './text.js';

interface Point { column: number; row: number }
const before = (a: Point, b: Point): boolean => a.row < b.row || (a.row === b.row && a.column < b.column);

/** Application selection keeps wheel navigation available in the alternate screen. */
export class TextSelection {
  private frame: string[] = [];
  private columns = 0;
  private anchor?: Point;
  private focus?: Point;
  private dragging = false;
  private moved = false;

  clear(): void { this.anchor = this.focus = undefined; this.dragging = this.moved = false; }
  get active(): boolean { return this.anchor !== undefined && this.focus !== undefined && this.moved; }

  /** Invalidate if layout or the text under a stationary selection changes. */
  update(frame: string[], columns: number): void {
    const previous = this.text();
    const resized = this.frame.length !== frame.length || this.columns !== columns;
    this.frame = [...frame]; this.columns = columns;
    if (resized || (this.active && previous !== this.text())) this.clear();
  }

  pointer(report: MouseReport): string | undefined {
    // Ignore right/middle buttons and no-button motion.
    if ((report.button & 3) !== 0 || !this.frame.length) return;
    const point = { column: Math.max(0, Math.min(this.columns - 1, report.column)),
      row: Math.max(0, Math.min(this.frame.length - 1, report.row)) };
    if (report.release) {
      if (!this.dragging) return;
      this.move(point); this.dragging = false;
      return this.active ? this.text() : undefined;
    }
    if (report.button & 32) { if (this.dragging) this.move(point); }
    else { this.clear(); this.anchor = this.focus = point; this.dragging = true; }
  }

  private move(point: Point): void {
    this.focus = point;
    if (this.anchor && (point.column !== this.anchor.column || point.row !== this.anchor.row)) this.moved = true;
  }

  private bounds(row: number): [number, number] | undefined {
    if (!this.active) return;
    const [start, end] = before(this.anchor!, this.focus!) ? [this.anchor!, this.focus!] : [this.focus!, this.anchor!];
    if (row < start.row || row > end.row) return;
    return [row === start.row ? start.column : 0, row === end.row ? end.column : this.columns - 1];
  }

  text(): string {
    const result: string[] = [];
    this.frame.forEach((line, row) => {
      const bounds = this.bounds(row); if (!bounds) return;
      let column = 0; let text = '';
      for (const char of graphemes(plain(line))) {
        const size = width(char);
        if (column <= bounds[1] && column + size > bounds[0]) text += char;
        column += size;
      }
      result.push(text.trimEnd());
    });
    return result.join('\n');
  }

  overlay(): string[] {
    return this.frame.map((line, row) => {
      const bounds = this.bounds(row); if (!bounds) return line;
      let column = 0;
      return line.split(/(\x1b\[[0-9;]*m)/g).map(part => {
        if (/^\x1b\[[0-9;]*m$/.test(part)) return part;
        return graphemes(part).map(char => {
          const size = width(char);
          const selected = column <= bounds[1] && column + size > bounds[0];
          column += size;
          return selected ? `\x1b[7m${char}\x1b[27m` : char;
        }).join('');
      }).join('');
    });
  }
}
