import { structuredPatch } from 'diff';
import type { FileDiff } from '../model.js';
import { plain } from './text.js';

export interface DiffLine { text: string; number?: number }
export interface DiffPreview { added: number; removed: number; lines: DiffLine[]; unavailable: boolean }
const cache = new WeakMap<FileDiff, DiffPreview>();

/** File metadata is immutable after tool completion; compute each patch only once. */
export function fileDiff(diff: FileDiff): DiffPreview {
  const cached = cache.get(diff);
  if (cached) return cached;
  const patch = structuredPatch(diff.path, diff.path, plain(diff.oldText ?? ''), plain(diff.newText), undefined, undefined,
    { context: 2, timeout: 100 });
  const preview: DiffPreview = { added: 0, removed: 0, lines: [], unavailable: !patch };
  for (const hunk of patch?.hunks ?? []) {
    preview.lines.push({ text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` });
    let oldLine = hunk.oldStart; let newLine = hunk.newStart;
    for (const text of hunk.lines) {
      const marker = text[0];
      if (marker === '+') { preview.added++; preview.lines.push({ text, number: newLine++ }); }
      else if (marker === '-') { preview.removed++; preview.lines.push({ text, number: oldLine++ }); }
      else if (marker === ' ') { preview.lines.push({ text, number: newLine++ }); oldLine++; }
      else preview.lines.push({ text });
    }
  }
  cache.set(diff, preview);
  return preview;
}
