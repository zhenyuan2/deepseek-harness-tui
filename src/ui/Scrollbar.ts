import type { MouseReport } from './mouse.js';
import type { Theme } from './theme.js';
import { cellWidth } from './text.js';

interface Track {
  column: number;
  height: number;
  last: number;
  size: number;
  offset: number;
}

/** The spare terminal column is UI chrome, outside selectable/exported text. */
export class Scrollbar {
  private track?: Track;
  private grab?: number;

  cancel(): void { this.grab = undefined; }

  update(column: number, height: number, total: number, visible: number, start: number): void {
    const previous = this.track;
    this.track = undefined;
    if (height >= 2 && total > visible && visible > 0) {
      const size = Math.max(1, Math.min(height - 1, Math.round(height * visible / total)));
      const last = total - visible;
      const offset = Math.round(Math.max(0, Math.min(last, start)) / last * (height - size));
      this.track = { column, height, last, size, offset };
    }
    if (!this.track || previous?.column !== column || previous?.height !== height) this.cancel();
  }

  overlay(frame: string[], theme: Theme): string[] {
    const track = this.track;
    if (!track) return frame;
    return frame.map((line, row) => {
      if (row >= track.height) return line;
      const thumb = row >= track.offset && row < track.offset + track.size;
      return line + '\x1b[0m' + ' '.repeat(Math.max(0, track.column - cellWidth(line))) +
        theme.paint(thumb ? 'accent' : 'border', thumb ? '█' : '│');
    });
  }

  /** Capture the whole drag, including release outside the track. */
  pointer(report: MouseReport, seek: (start: number, last: number) => void): boolean {
    const track = this.track;
    const move = (grab: number): void => {
      if (!track) return;
      const offset = Math.max(0, Math.min(track.height - track.size, report.row - grab));
      seek(Math.round(offset / (track.height - track.size) * track.last), track.last);
    };
    // Some terminals report release with button 3 rather than the held button.
    if (report.release) {
      const grab = this.grab;
      this.cancel();
      if (grab === undefined) return false;
      move(grab);
      return true;
    }
    if (!track || (report.button & 3) !== 0) { this.cancel(); return false; }
    if (this.grab === undefined) {
      if ((report.button & 32) || report.column !== track.column ||
        report.row < 0 || report.row >= track.height) return false;
      const onThumb = report.row >= track.offset && report.row < track.offset + track.size;
      this.grab = onThumb ? report.row - track.offset : Math.floor(track.size / 2);
      if (onThumb) return true;
    }
    move(this.grab);
    return true;
  }
}
