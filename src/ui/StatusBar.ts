import { statuslineFields, type StatuslineField } from '../statusline.js';
import type { ViewModel } from '../model.js';
import type { Editor } from './Composer.js';
import type { Theme } from './theme.js';
import { plain, truncate, cellWidth } from './text.js';
const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function tokens(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return String(value);
}
export function StatusLines(view: ViewModel, editor: Editor, columns: number, theme: Theme, now: number, maxLines = 2): string[] {
  const running = view.status === 'running';
  const tools = view.active.filter(row => row.tool?.status === 'running');
  const task = tools.length ? `${plain(tools.at(-1)!.tool!.name)}${tools.length > 1 ? ` +${tools.length - 1}` : ''}`
    : view.active.some(row => row.kind === 'assistant' && row.state === 'live') ? 'Responding'
    : view.active.some(row => row.kind === 'reasoning' && row.state === 'live') ? 'Thinking' : 'Working';
  const stopHint = view.picker ? 'Esc close' : 'Esc stop';
  const elapsed = `${Math.max(0, Math.floor((now - (view.startedAt ?? now)) / 1000))}s`;
  const extra = view.queued.length || editor.pastedLines ? 2 : 0;
  const taskWidth = Math.max(0, columns - cellWidth(`  ⠋  · ${elapsed} · ${stopHint}`) - extra);
  const runningActivity = taskWidth > 0
    ? `${spinner[Math.floor(now / 100) % spinner.length]} ${truncate(task, taskWidth)} · ${elapsed} · ${stopHint}`
    : `${spinner[Math.floor(now / 100) % spinner.length]} ${stopHint}`;
  const activity = view.approval ? `Approval required${view.pendingApprovals.length > 1 ? ` · ${view.pendingApprovals.length - 1} more pending` : ''}`
    : running ? runningActivity
    : view.status === 'idle' ? 'Ready' : view.status;
  const activityChips = [activity];
  if (view.queued.length) activityChips.push(`${view.queued.length} queued`);
  if (editor.pastedLines) activityChips.push(`pasted ${editor.pastedLines} lines`);
  if (!running && !view.picker && !view.approval && columns >= 70) activityChips.push('Enter send');
  const activityLine = theme.paint(running ? 'accent' : 'muted', fitChips(activityChips, columns));
  if (maxLines < 2) return [activityLine];
  // Configuration, rather than changing activity/text widths, determines footer height.
  return view.statusline.length ? [StatusFields(view, view.statusline, columns, theme), activityLine] : [activityLine];
}

/** Keep whole fields in priority order; ellipsis explicitly signals omitted fields. */
function fitChips(chips: string[], columns: number): string {
  const available = Math.max(0, columns - 2);
  let result = '';
  for (const [index, chip] of chips.entries()) {
    const candidate = result ? `${result} · ${chip}` : chip;
    const reserve = index < chips.length - 1 ? 2 : 0;
    if (cellWidth(candidate) + reserve <= available) result = candidate;
    else return truncate(`  ${result ? `${result} …` : truncate(chip, Math.max(0, available - reserve)) + (reserve ? ' …' : '')}`, columns);
  }
  return truncate(`  ${result}`, columns);
}

export function StatusFields(view: ViewModel, fields: readonly StatuslineField[], columns: number, theme: Theme): string {
  const chips: string[] = [];
  const stats = view.tokens;
  for (const { id: field } of statuslineFields) {
    if (!fields.includes(field)) continue;
    if (field === 'model' && view.model) chips.push(plain(view.model.slice(view.model.indexOf('/') + 1)));
    else if (field === 'reasoning' && view.reasoning) chips.push(plain(view.reasoning));
    else if (field === 'context') chips.push(`Ctx ${tokens(stats.contextTokens)}/${tokens(stats.contextWindow)}${stats.contextTokens !== undefined && stats.contextWindow ? ` (${Math.round(stats.contextTokens / stats.contextWindow * 100)}%)` : ''}`);
    else if (field === 'input') chips.push(`Input ${stats.samples ? tokens(stats.input) : '—'}`);
    else if (field === 'output') chips.push(`Output ${stats.samples ? tokens(stats.output) : '—'}`);
    else if (field === 'cache') chips.push(`Cache ${stats.cacheHitRate === undefined ? '—' : `${(stats.cacheHitRate * 100).toFixed(1)}%`}`);
  }
  return theme.paint('muted', fitChips(chips, columns));
}

export function StatusBar(view: ViewModel, editor: Editor, columns: number, theme: Theme, now: number): string {
  return StatusLines(view, editor, columns, theme, now, 1)[0]!;
}
