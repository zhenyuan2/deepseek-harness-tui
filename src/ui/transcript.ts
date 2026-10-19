import type { PreviewViewport } from './Conversation.js';
import { truncate, wrapStyled } from './text.js';
import type { Theme } from './theme.js';
import type { SelectionViewport } from './selection.js';

/** Retain review history and stage each durable line once for export on exit. */
export class Transcript {
  private lines: string[] = [];
  private published = 0;
  private pending: string[] = [];
  private columns = 0;
  private wrapped: string[][] = [];
  private revision = 0;
  selectionViewport?: SelectionViewport;
  constructor(private readonly limit = 10_000) {}
  clear(): void {
    this.revision++; this.selectionViewport = undefined;
    this.lines = []; this.published = 0; this.pending = []; this.wrapped = []; this.columns = 0;
  }
  append(lines: string[]): void { this.lines.push(...lines); }
  takePublished(): string[] { const lines = this.pending; this.pending = []; return lines; }
  frame(active: string[], height: number, columns: number, theme: Theme, viewport: PreviewViewport): string[] {
    this.selectionViewport = undefined;
    if (columns !== this.columns) { this.columns = columns; this.wrapped = []; }
    for (let i = this.wrapped.length; i < this.lines.length; i++) this.wrapped.push(wrapStyled(this.lines[i]!, columns));
    const history = this.wrapped.flat();
    const all = [...history, ...active];
    while (all.at(-1) === '') all.pop();
    viewport.previewTotal = all.length;
    viewport.previewLines = Math.max(1, height - 1);
    if (height <= 0) return [];
    // Stage only committed lines for export; previews remain erasable.
    const budget = Math.max(0, height - active.length);
    let remaining = this.wrapped.slice(this.published).reduce((sum, lines) => sum + lines.length, 0);
    while (remaining > budget && this.published < this.lines.length) {
      const lines = this.wrapped[this.published++]!;
      this.pending.push(...lines); remaining -= lines.length;
    }
    let shown: string[];
    let contentStart: number;
    let heading = 0;
    if (viewport.previewStart !== undefined && all.length > height) {
      const start = Math.max(0, Math.min(viewport.previewStart, all.length - viewport.previewLines));
      viewport.previewStart = start;
      contentStart = start; heading = 1;
      shown = [truncate(theme.paint('muted', `  ↑ History ${start + 1}–${start + viewport.previewLines}/${all.length} · PgDn follow`), columns),
        ...all.slice(start, start + viewport.previewLines)];
    } else {
      viewport.previewStart = undefined;
      // Refill from retained history when the viewport grows. Publication does
      // not remove lines from the live viewport.
      shown = all.slice(-height);
      contentStart = Math.max(0, all.length - height);
    }
    // Bound the application's review cache, retaining all not-yet-published lines.
    const drop = Math.min(this.published, Math.max(0, this.lines.length - this.limit));
    if (drop) {
      this.revision++;
      const removed = this.wrapped.slice(0, drop).reduce((sum, lines) => sum + lines.length, 0);
      this.lines.splice(0, drop); this.wrapped.splice(0, drop); this.published -= drop;
      viewport.previewTotal -= removed;
      if (viewport.previewStart !== undefined) viewport.previewStart = Math.max(0, viewport.previewStart - removed);
      // Selection starts fresh on the next frame after cache eviction.
    } else {
      this.selectionViewport = { top: Math.max(0, height - shown.length) + heading,
        start: contentStart, height: shown.length - heading, lines: all, revision: this.revision };
    }
    return [...Array<string>(Math.max(0, height - shown.length)).fill(''), ...shown];
  }
  finish(columns: number): string[] {
    return [...this.takePublished(), ...this.lines.slice(this.published).flatMap(line => wrapStyled(line, columns))];
  }
}
