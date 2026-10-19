import type { PreviewViewport } from './Conversation.js';
import { truncate, wrapStyled } from './text.js';
import type { Theme } from './theme.js';

/** Retain rendered history for application scrolling; publish each durable line once. */
export class Transcript {
  private lines: string[] = [];
  private published = 0;
  private pending: string[] = [];
  private columns = 0;
  private wrapped: string[][] = [];
  constructor(private readonly limit = 10_000) {}
  clear(): void {
    this.lines = []; this.published = 0; this.pending = []; this.wrapped = []; this.columns = 0;
  }
  append(lines: string[]): void { this.lines.push(...lines); }
  takePublished(): string[] { const lines = this.pending; this.pending = []; return lines; }
  frame(active: string[], height: number, columns: number, theme: Theme, viewport: PreviewViewport): string[] {
    if (columns !== this.columns) { this.columns = columns; this.wrapped = []; }
    for (let i = this.wrapped.length; i < this.lines.length; i++) this.wrapped.push(wrapStyled(this.lines[i]!, columns));
    const history = this.wrapped.flat();
    const all = [...history, ...active];
    while (all.at(-1) === '') all.pop();
    viewport.previewTotal = all.length;
    viewport.previewLines = Math.max(1, height - 1);
    if (height <= 0) return [];
    // Only committed lines may enter native scrollback. Previews remain erasable.
    const budget = Math.max(0, height - active.length);
    let remaining = this.wrapped.slice(this.published).reduce((sum, lines) => sum + lines.length, 0);
    while (remaining > budget && this.published < this.lines.length) {
      const lines = this.wrapped[this.published++]!;
      this.pending.push(...lines); remaining -= lines.length;
    }
    let shown: string[];
    if (viewport.previewStart !== undefined && all.length > height) {
      const start = Math.max(0, Math.min(viewport.previewStart, all.length - viewport.previewLines));
      viewport.previewStart = start;
      shown = [truncate(theme.paint('muted', `  ↑ History ${start + 1}–${start + viewport.previewLines}/${all.length} · PgDn follow`), columns),
        ...all.slice(start, start + viewport.previewLines)];
    } else {
      viewport.previewStart = undefined;
      shown = [...this.wrapped.slice(this.published).flat(), ...active];
      if (shown.length > height) shown = [truncate(theme.paint('muted', '  … live · PgUp / wheel to read earlier'), columns), ...shown.slice(-Math.max(1, height - 1))].slice(0, height);
    }
    // Bound the application's review cache, retaining all not-yet-published lines.
    const drop = Math.min(this.published, Math.max(0, this.lines.length - this.limit));
    if (drop) {
      const removed = this.wrapped.slice(0, drop).reduce((sum, lines) => sum + lines.length, 0);
      this.lines.splice(0, drop); this.wrapped.splice(0, drop); this.published -= drop;
      viewport.previewTotal -= removed;
      if (viewport.previewStart !== undefined) viewport.previewStart = Math.max(0, viewport.previewStart - removed);
    }
    return [...shown, ...Array<string>(Math.max(0, height - shown.length)).fill('')];
  }
  finish(columns: number): string[] {
    return [...this.takePublished(), ...this.lines.slice(this.published).flatMap(line => wrapStyled(line, columns))];
  }
}
