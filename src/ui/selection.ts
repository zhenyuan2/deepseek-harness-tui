import type { MouseReport } from './mouse.js';
import { graphemes, plain, width } from './text.js';

interface Point { column: number; row: number }
export interface SelectionViewport {
  top: number;
  start: number;
  height: number;
  lines: readonly string[];
  revision: number;
}
const before = (a: Point, b: Point): boolean => a.row < b.row || (a.row === b.row && a.column < b.column);

/** Application selection keeps wheel navigation available in the alternate screen. */
export class TextSelection {
  private frame: string[] = [];
  private columns = 0;
  private anchor?: Point;
  private focus?: Point;
  private dragging = false;
  private moved = false;
  private viewport?: SelectionViewport;
  private conversation = false;
  private pointerPosition?: Point;

  clear(): void {
    this.anchor = this.focus = this.pointerPosition = undefined;
    this.dragging = this.moved = this.conversation = false;
  }
  get active(): boolean { return this.anchor !== undefined && this.focus !== undefined && this.moved; }
  // A press alone must not turn wheel navigation or redraws into a text drag.
  get reviewing(): boolean { return this.dragging && this.conversation && this.moved; }
  get scrollDirection(): number {
    if (!this.reviewing || !this.viewport || !this.pointerPosition) return 0;
    if (this.pointerPosition.row <= this.viewport.top) return -1;
    if (this.pointerPosition.row >= this.viewport.top + this.viewport.height - 1) return 1;
    return 0;
  }

  /** Invalidate if layout or the text under a stationary selection changes. */
  update(frame: string[], columns: number, viewport?: SelectionViewport): void {
    const previous = this.text();
    const resized = this.frame.length !== frame.length || this.columns !== columns;
    const changedDocument = this.conversation && (!viewport || viewport.revision !== this.viewport?.revision);
    this.frame = [...frame]; this.columns = columns;
    this.viewport = viewport;
    if (resized || changedDocument || (this.active && previous !== this.text())) this.clear();
    // The anchor stays in document coordinates; focus follows the held pointer.
    if (this.reviewing && this.pointerPosition) this.move(this.point(this.pointerPosition));
  }

  pointer(report: MouseReport): string | undefined {
    // Accept button 3 releases (no button held), but ignore no-button motion
    // and right/middle buttons.
    const button = report.button & 3;
    if (!this.frame.length || (button !== 0 && !(report.release && button === 3))) return;
    const position = { column: Math.max(0, Math.min(this.columns - 1, report.column)),
      row: Math.max(0, Math.min(this.frame.length - 1, report.row)) };
    if (report.release) {
      if (!this.dragging) return;
      this.move(this.point(position)); this.dragging = false;
      return this.active ? this.text() : undefined;
    }
    if (report.button & 32) {
      if (this.dragging) { this.pointerPosition = position; this.move(this.point(position)); }
    } else {
      this.clear();
      this.conversation = !!this.viewport && position.row >= this.viewport.top && position.row < this.viewport.top + this.viewport.height;
      this.pointerPosition = position;
      this.anchor = this.focus = this.point(position); this.dragging = true;
    }
  }

  private point(position: Point): Point {
    if (!this.conversation || !this.viewport) return position;
    const { top, start, height } = this.viewport;
    const row = Math.max(top, Math.min(top + height - 1, position.row));
    const column = position.row < top ? 0 : position.row >= top + height ? this.columns - 1 : position.column;
    return { column, row: start + row - top };
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
    const lines = this.conversation ? this.viewport?.lines ?? [] : this.frame;
    lines.forEach((line, row) => {
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
      if (this.conversation) {
        if (!this.viewport || row < this.viewport.top || row >= this.viewport.top + this.viewport.height) return line;
        row += this.viewport.start - this.viewport.top;
      }
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
