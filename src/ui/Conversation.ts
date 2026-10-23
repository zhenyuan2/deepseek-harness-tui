import type { Row } from '../model.js';
import { markdown } from './AssistantMessage.js';
import { ToolMessage, toolFamily, toolSummary } from './ToolMessage.js';
import type { Theme } from './theme.js';
import { truncate, wrap } from './text.js';

interface CachedMessage { signature: unknown[]; lines: string[] }
const cache = new WeakMap<Row, CachedMessage[]>();
const LIVE_MARKDOWN_LIMIT = 120_000;

export function Message(row: Row, columns: number, theme: Theme, details = false): string[] {
  const signature = [columns, theme, details, row.text, row.kind, row.state, row.expanded, row.folded, row.lateResult,
    row.tool?.name, row.tool?.arguments, row.tool?.output, row.tool?.status, row.tool?.endedAt, row.tool?.diffs];
  const entries = cache.get(row) ?? [];
  const found = entries.find(entry => signature.every((value, i) => value === entry.signature[i]));
  if (found) return found.lines;
  let lines: string[];
  try {
    lines = renderMessage(row, columns, theme, details);
  } catch {
    // One malformed row must not abort the whole transcript. Keep its content
    // readable and let the terminal renderer continue with the other rows.
    const text = row.tool?.output || row.text;
    const clipped = text.length > 4_000 ? `${text.slice(0, 4_000)}\n… render fallback truncated` : text;
    const body = wrap(clipped, Math.max(1, columns - 4));
    const marker = row.kind === 'user' ? theme.paint('bold', '❯') : row.kind === 'assistant' ? theme.paint('bold', '●') : row.kind === 'error' ? theme.paint('error', '✗') : theme.paint('muted', '·');
    lines = [...body.map((line, i) => `  ${i === 0 ? marker : ' '} ${line}`), ''];
  }
  cache.set(row, [{ signature, lines }, ...entries].slice(0, 2));
  return lines;
}

function renderMessage(row: Row, columns: number, theme: Theme, details: boolean): string[] {
  if (row.tool || row.kind === 'tool') return ToolMessage(row, columns, theme, details);
  if (row.kind === 'reasoning') {
    if (!details && !row.expanded) return [truncate(`  ${theme.paint('muted', `◇ Thinking${row.state === 'live' ? '…' : ''} · /details ${row.id}`)}`, columns), ''];
    return [theme.paint('muted', '  ◇ Thinking'), ...wrap(row.text, Math.max(1, columns - 4)).map(line => `    ${theme.paint('muted', line)}`), ''];
  }
  // Parsing the whole growing live response on every delta is quadratic. Above
  // this bound render only a plain-text tail until the message settles, then
  // render the complete Markdown once from the cache.
  const liveAssistant = row.kind === 'assistant' && row.state === 'live';
  const tooLong = liveAssistant && row.text.length > LIVE_MARKDOWN_LIMIT;
  let start = tooLong ? row.text.length - LIVE_MARKDOWN_LIMIT : 0;
  if (start > 0) {
    const code = row.text.charCodeAt(start);
    if (code >= 0xDC00 && code <= 0xDFFF) start--;
  }
  const shownText = start > 0 ? row.text.slice(start) : row.text;
  const lines = row.kind === 'assistant' && (!tooLong || start === 0)
    ? markdown(shownText, Math.max(1, columns - 4), theme)
    : wrap(shownText, Math.max(1, columns - 4));
  if (tooLong && start > 0) lines.unshift(theme.paint('muted', `… ${start} earlier characters omitted while streaming`));
  if (lines.length === 0) return [];
  const marker = row.kind === 'user' ? theme.paint('bold', '❯') : row.kind === 'assistant' ? theme.paint('bold', '●') : row.kind === 'error' ? theme.paint('error', '✗') : theme.paint('muted', '·');
  const muted = row.kind === 'system' || row.kind === 'compact';
  return [...lines.map((line, i) => `  ${i === 0 ? marker : ' '} ${muted ? theme.paint('muted', line) : row.kind === 'error' ? theme.paint('error', line) : line}`), ''];
}

/** Group only contiguous completed tools; chronology and individual detail ids stay intact. */
export function Messages(rows: Row[], columns: number, theme: Theme, details = false): string[] {
  const lines: string[] = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i]!;
    const family = details ? undefined : toolFamily(row);
    let end = i + 1;
    if (family) while (end < rows.length && toolFamily(rows[end]!) === family) end++;
    if (end - i < 2) lines.push(...Message(row, columns, theme, details));
    else {
      const group = rows.slice(i, end);
      lines.push(truncate(`  ${theme.paint('success', '●')} ${theme.paint('bold', `${family} ${group.length} ${family === 'Read' ? 'files' : 'queries'}`)}`, columns));
      for (const item of group.slice(0, 3)) lines.push(truncate(`    ${theme.paint('muted', `⎿ ${toolSummary(item.tool!.arguments)} · /details ${item.id}`)}`, columns));
      if (group.length > 3) lines.push(truncate(`    ${theme.paint('muted', `… ${group.length - 3} more · /details ${group[3]!.id}–${group.at(-1)!.id}`)}`, columns));
      lines.push('');
    }
    i = end;
  }
  return lines;
}

export interface PreviewViewport { previewStart?: number; previewTotal: number; previewLines: number }
export function Conversation(rows: Row[], columns: number, theme: Theme, details: boolean, maxLines: number, viewport?: PreviewViewport): string[] {
  const all = Messages(rows, columns, theme, details);
  while (all.at(-1) === '') all.pop();
  if (viewport) { viewport.previewTotal = all.length; viewport.previewLines = Math.max(1, maxLines - 1); }
  if (maxLines <= 0) return [];
  if (all.length <= maxLines) { if (viewport) viewport.previewStart = undefined; return all; }
  const count = Math.max(1, maxLines - 1);
  const start = Math.max(0, Math.min(viewport?.previewStart ?? all.length - count, all.length - count));
  if (viewport?.previewStart !== undefined) viewport.previewStart = start;
  const hint = viewport?.previewStart === undefined ? 'live · PgUp read earlier' : `live ${start + 1}–${start + count}/${all.length} · PgDn follow`;
  return [truncate(theme.paint('muted', `  … ${hint}`), columns), ...all.slice(start, start + count)].slice(0, maxLines);
}
