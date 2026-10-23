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
  private chars = 0;
  private revision = 0;
  selectionViewport?: SelectionViewport;
  constructor(private readonly maxLines = 20_000, private readonly maxChars = 4_000_000) {}
  clear(): void {
    this.revision++; this.selectionViewport = undefined;
    this.lines = []; this.published = 0; this.pending = []; this.wrapped = []; this.columns = 0; this.chars = 0;
  }
  append(lines: string[]): void {
    for (const line of lines) { this.lines.push(line); this.chars += line.length; }
  }
  takePublished(): string[] { const lines = this.pending; this.pending = []; return lines; }
  get retainedLines(): number { return this.lines.length; }
  get retainedChars(): number { return this.chars; }
  frame(active: string[], height: number, columns: number, theme: Theme, viewport: PreviewViewport, alignTop = false): string[] {
    this.selectionViewport = undefined;
    if (columns !== this.columns) { this.columns = columns; this.wrapped = []; }
    for (let i = this.wrapped.length; i < this.lines.length; i++) this.wrapped.push(wrapStyled(this.lines[i]!, columns));
    const history = this.wrapped.flat();
    const all = history.concat(active);
    while (all.at(-1) === '') all.pop();
    viewport.previewTotal = all.length;
    viewport.previewLines = Math.max(1, height - 1);
    if (height <= 0) return [];
    // Stage only committed lines for export; previews remain erasable.
    const budget = Math.max(0, height - active.length);
    let remaining = this.wrapped.slice(this.published).reduce((sum, lines) => sum + lines.length, 0);
    while (remaining > budget && this.published < this.lines.length) {
      const lines = this.wrapped[this.published++]!;
      for (const line of lines) this.pending.push(line);
      remaining -= lines.length;
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
      shown = alignTop ? all.slice(0, height) : all.slice(-height);
      contentStart = alignTop ? 0 : Math.max(0, all.length - height);
    }
    // Bound the review cache by both lines and characters, retaining every
    // not-yet-published row (the live window cannot be evicted).
    let drop = 0;
    let removed = 0;
    let removedChars = 0;
    while (drop < this.published) {
      const currentLines = this.lines.length - drop;
      const currentChars = this.chars - removedChars;
      if (currentLines <= this.maxLines && currentChars <= this.maxChars) break;
      removedChars += this.lines[drop]!.length;
      removed += this.wrapped[drop]?.length ?? 0;
      drop++;
    }
    if (drop) {
      this.revision++;
      this.lines.splice(0, drop); this.wrapped.splice(0, drop); this.published -= drop;
      this.chars -= removedChars;
      viewport.previewTotal = Math.max(0, viewport.previewTotal - removed);
      if (viewport.previewStart !== undefined) viewport.previewStart = Math.max(0, viewport.previewStart - removed);
      // Selection starts fresh on the next frame after cache eviction.
    } else {
      this.selectionViewport = { top: (alignTop ? 0 : Math.max(0, height - shown.length)) + heading,
        start: contentStart, height: shown.length - heading, lines: all, revision: this.revision };
    }
    const padding = Array<string>(Math.max(0, height - shown.length)).fill('');
    return alignTop ? [...shown, ...padding] : [...padding, ...shown];
  }
  finish(columns: number): string[] {
    return this.takePublished().concat(this.lines.slice(this.published).flatMap(line => wrapStyled(line, columns)));
  }
}
