import type { Row } from '../model.js';
import type { Theme } from './theme.js';
import { plain, truncate, wrap } from './text.js';
import { highlight } from './AssistantMessage.js';
import { fileDiff } from './diff.js';

const SUMMARY_CHARS = 2_048;
const PREVIEW_LINE_CHARS = 4_000;

/** Count normalized output lines without materializing every line. */
function scanOutput(text: string, limit: number, skipEmpty = false): { lines: string[]; total: number } {
  const lines: string[] = [];
  let total = 0; let start = 0;
  const push = (value: string): void => {
    if (lines.length >= limit) return;
    if (skipEmpty && !value.trim()) return;
    lines.push(value);
  };
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 10 && code !== 13) continue;
    total++;
    push(text.slice(start, i));
    if (code === 13 && text.charCodeAt(i + 1) === 10) i++;
    start = i + 1;
  }
  if (start < text.length || total === 0) {
    total++;
    push(text.slice(start));
  }
  return { lines, total };
}

/** First `limit` non-empty output lines plus the total normalized line count. */
export function previewOutput(text: string, limit: number): { lines: string[]; total: number } {
  return scanOutput(text, Math.max(0, limit), true);
}

export function countOutputLines(text: string): number {
  return scanOutput(text, 0).total;
}

export function toolSummary(argumentsText: string): string {
  const clip = (text: string): string => plain(text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}…` : text);
  try {
    const value = JSON.parse(argumentsText);
    if (value && typeof value === 'object') {
      for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url']) {
        if (typeof value[key] === 'string') {
          const range = key === 'file_path' || key === 'path'
            ? [value.offset === undefined ? '' : `from ${value.offset}`, value.limit === undefined ? '' : `${value.limit} lines`].filter(Boolean).join(', ') : '';
          return clip(value[key]) + (range ? ` · ${range}` : '');
        }
      }
      const joined = Object.entries(value).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' ');
      return clip(joined);
    }
  } catch {}
  return clip(String(argumentsText));
}

export function toolFamily(row: Row): 'Read' | 'Search' | undefined {
  if (!row.tool || row.lateResult || row.tool.status !== 'done' || row.expanded || row.tool.diffs?.length) return undefined;
  if (/^(?:read|read_file)$/i.test(row.tool.name)) return 'Read';
  if (/^(?:grep|glob|search|search_files|find_files)$/i.test(row.tool.name)) return 'Search';
  return undefined;
}

/** Compact overview; full parameters and output remain available through /details. */
export function ToolMessage(row: Row, columns: number, theme: Theme, expanded: boolean): string[] {
  const tool = row.tool;
  const state = tool?.status ?? (row.kind === 'error' ? 'failed' : 'done');
  const full = expanded || row.expanded;
  const tone = state === 'failed' ? 'error' : state === 'running' ? 'accent' : state === 'cancelled' ? 'warning' : 'success';
  const symbol = state === 'running' ? '◐' : state === 'failed' ? '✗' : state === 'cancelled' ? '■' : '●';
  const elapsed = tool?.endedAt ? ` · ${((tool.endedAt - tool.startedAt) / 1000).toFixed(1)}s` : '';
  const target = tool ? toolSummary(tool.arguments).replace(/\n/g, ' ') : '';
  const late = row.lateResult ? ` ${theme.paint('warning', '· late result')}` : '';
  const result = [truncate(`  ${theme.paint(tone, symbol)} ${theme.paint('bold', plain(tool?.name ?? 'Tool'))}${late}${target ? `${late ? ' ' : ''}(${theme.paint('muted', target)})` : ''}`, columns)];
  const append = (text: string, error = false): void => {
    result.push(...wrap(text, Math.max(1, columns - 6)).map(line => `    ${theme.paint(error ? 'error' : 'muted', line)}`));
  };
  const rawOutput = tool?.output || (tool ? '' : row.text);
  const family = toolFamily(row);
  if (family && !full) {
    const count = countOutputLines(rawOutput);
    append(`⎿ ${count} ${family === 'Read' ? 'lines' : 'result lines'}${elapsed} · /details ${row.id}`);
    if (row.folded) append('… folded to keep memory bounded');
    return [...result, ''];
  }
  append(`⎿ ${state}${elapsed} · #${row.id}`);
  if (full && tool) append(tool.arguments);
  const limit = full ? Number.POSITIVE_INFINITY : state === 'failed' ? 5 : 2;
  const preview = full
    ? { lines: plain(rawOutput).replace(/\n$/, '').split('\n'), total: 0 }
    : previewOutput(rawOutput, limit);
  let shownRaw = 0; let displayed = 0; let truncated = false;
  for (const line of preview.lines) {
    shownRaw++;
    if (!line.trim()) continue;
    const clipped = line.length > PREVIEW_LINE_CHARS ? `${line.slice(0, PREVIEW_LINE_CHARS)} …` : line;
    const wrapped = wrap(clipped, Math.max(1, columns - 6)).filter(text => text !== '');
    const remaining = full ? wrapped.length : Math.max(0, limit - displayed);
    const take = wrapped.slice(0, remaining);
    result.push(...take.map(text => `    ${theme.paint(state === 'failed' ? 'error' : 'muted', text)}`));
    displayed += take.length;
    if (take.length < wrapped.length) truncated = true;
    if (!full && displayed >= limit) break;
  }
  if (!full && (truncated || shownRaw < preview.total)) append(`… more output · /details ${row.id}`);
  for (const diff of tool?.diffs ?? []) {
    const preview = fileDiff(diff);
    if (plain(diff.path) !== target) append(plain(diff.path));
    if (preview.unavailable) { append(`Diff timed out · inspect ${plain(diff.path)} directly`); continue; }
    append(`+${preview.added} −${preview.removed}`);
    const shown = full ? preview.lines : preview.lines.slice(0, 10);
    for (const line of shown) {
      const prefix = line.number === undefined ? '' : `${String(line.number).padStart(4)} `;
      result.push(...wrap(line.text, Math.max(1, columns - 6 - prefix.length))
        .map((text, i) => `    ${theme.paint('muted', i === 0 ? prefix : ' '.repeat(prefix.length))}${highlight(text, 'diff', theme)}`));
    }
    if (shown.length < preview.lines.length) append(`… more changes · /details ${row.id}`);
  }
  if (row.folded) append('… folded to keep memory bounded');
  return [...result, ''];
}
