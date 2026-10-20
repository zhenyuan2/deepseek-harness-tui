import { TokenStats, defaultStatusline, type StatuslineField } from './statusline.js';
/** Observable UI projection; Harness remains the durable conversation store. */
export interface FileDiff { path: string; oldText: string | null; newText: string }
export interface ToolState {
  name: string;
  arguments: string;
  output: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt?: number;
  diffs?: FileDiff[];
}
export interface Row {
  id: number;
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'system' | 'error';
  text: string;
  state: 'live' | 'done';
  archived?: boolean;
  expanded?: boolean;
  label?: string;
  toolCallId?: string;
  tool?: ToolState;
}
export type ApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled';
export interface ApprovalPrompt { text: string; toolName?: string; arguments?: string; cwd?: string; answer(decision: ApprovalDecision): void }
export const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;
export interface PickerOption {
  id: string;
  label: string;
  description?: string;
  current?: boolean;
  checked?: boolean;
  disabled?: boolean;
  choose(): void;
}
export interface PickerState {
  statuslineDraft?: readonly StatuslineField[];
  title: string;
  hint?: string;
  options: PickerOption[];
  query: string;
  selection: number;
  loading?: boolean;
  loadingText?: string;
  saving?: boolean;
  error?: string;
  pageSize: number;
  cancel(): void;
  back?(): void;
  confirm?(): void;
}
export class ViewModel {
  rows: Row[] = [];
  status = 'starting';
  screenRevision = 0;
  /** The first accepted chat dismisses the welcome art even if startup fails. */
  welcomeDismissed = false;
  sessionId = '';
  model = '';
  reasoning = '';
  statusline: readonly StatuslineField[] = defaultStatusline;
  tokens = new TokenStats();
  picker?: PickerState;
  cwd = '';
  approval?: ApprovalPrompt;
  pendingApprovals: ApprovalPrompt[] = [];
  queued: { id: string; text: string }[] = [];
  startedAt?: number;
  private sequence = 0;
  private live = new Map<Row['kind'], Row>();
  private listeners = new Set<() => void>();
  constructor(private readonly maxRows: number, private readonly maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  changed(): void { for (const listener of this.listeners) listener(); }
  setStatus(status: string): void {
    if (status === 'running' && this.status !== 'running') this.startedAt = Date.now();
    this.status = status; this.changed();
  }
  add(kind: Row['kind'], text: string, options: Partial<Omit<Row, 'id' | 'kind' | 'text'>> = {}): Row {
    const row: Row = { id: ++this.sequence, kind, text, state: 'done', ...options };
    this.rows.push(row);
    // Never drop an unprinted row; the renderer drains synchronous bursts in order.
    this.trim(); this.changed(); return row;
  }
  private trim(): void {
    let excess = this.rows.length - this.maxRows;
    this.rows = this.rows.filter(row => {
      if (excess > 0 && row.archived) { excess--; return false; }
      return true;
    });
  }
  /** Only a settled prefix can enter native scrollback; later results keep their order. */
  takeCompleted(): Row[] {
    const ready: Row[] = [];
    for (const row of this.rows) {
      if (row.archived) continue;
      if (row.state === 'live') break;
      row.archived = true;
      ready.push({ ...row, tool: row.tool ? { ...row.tool } : undefined });
    }
    this.trim(); return ready;
  }
  get active(): Row[] { return this.rows.filter(row => !row.archived); }
  get showWelcome(): boolean {
    return !this.welcomeDismissed && this.status === 'idle' && this.sessionId === 'Not started';
  }
  /** Dismiss visible output without changing conversation facts or retained details. */
  clearScreen(restoreWelcome = false): void {
    this.takeCompleted();
    this.welcomeDismissed = !restoreWelcome;
    this.screenRevision++;
    this.changed();
  }
  queueApproval(prompt: ApprovalPrompt): void {
    this.pendingApprovals.push(prompt);
    if (!this.approval) this.approval = prompt;
    this.changed();
  }
  removeApproval(prompt: ApprovalPrompt): void {
    this.pendingApprovals = this.pendingApprovals.filter(item => item !== prompt);
    if (this.approval === prompt) this.approval = this.pendingApprovals[0];
    this.changed();
  }
  cancelApprovals(decision: ApprovalDecision = 'cancelled'): void {
    for (const prompt of [...this.pendingApprovals]) {
      try { prompt.answer(decision); } catch { /* keep cancelling the rest */ }
    }
  }
  details(id?: number, endId?: number): void {
    if (id !== undefined && endId !== undefined) {
      const rows = this.rows.filter(row => row.id >= id && row.id <= endId && row.state === 'done');
      if (!rows.length) { this.add('system', `No retained messages in range #${id}–#${endId}.`); return; }
      for (const row of rows) this.details(row.id);
      return;
    }
    const row = id === undefined ? [...this.rows].reverse().find(row => row.state === 'done' && (row.tool || row.kind === 'reasoning')) : this.rows.find(row => row.id === id);
    if (!row) { this.add('system', 'No retained details. Use /details <message number> after a tool completes.'); return; }
    if (row.state === 'live') { this.add('system', `Message #${row.id} is still running. F2 toggles the live preview.`); return; }
    this.add(row.kind, row.text, { expanded: true, label: row.label, tool: row.tool ? { ...row.tool } : undefined });
  }
  enqueue(id: string, text: string): void { this.queued.push({ id, text }); this.changed(); }
  dequeue(id: string): void { this.queued = this.queued.filter(item => item.id !== id); this.changed(); }
  userMessage(id: string, text: string): void { this.dequeue(id); this.add('user', text); }
  startStream(): void { if (this.live.size) this.abandon(); }
  hasLive(kind: Row['kind']): boolean { return this.live.has(kind); }
  toolCall(callId: string, name: string, args: string, startedAt = Date.now()): void {
    this.add('tool', args, { state: 'live', toolCallId: callId, label: `${name} · running`,
      tool: { name, arguments: args, output: '', status: 'running', startedAt } });
  }
  toolResult(callId: string, text: string, failed: boolean, meta?: unknown, endedAt = Date.now()): void {
    const row = callId ? this.rows.find(row => row.toolCallId === callId && row.state === 'live') : undefined;
    if (!row?.tool) { this.add(failed ? 'error' : 'tool', this.truncateOutput(text)); return; }
    if (!failed && meta && typeof meta === 'object' && 'diffs' in meta && Array.isArray(meta.diffs)) {
      row.tool.diffs = meta.diffs.filter((diff): diff is FileDiff => diff && typeof diff === 'object'
        && typeof diff.path === 'string' && (diff.oldText === null || typeof diff.oldText === 'string') && typeof diff.newText === 'string');
    }
    row.tool.output = this.truncateOutput(text);
    row.tool.status = failed ? 'failed' : 'done'; row.tool.endedAt = endedAt;
    row.label = `${row.tool.name} · ${row.tool.status}`;
    // row.text stays the original call arguments. ToolMessage reads
    // tool.output; duplicating large output here only doubled memory.
    row.kind = failed ? 'error' : 'tool'; row.state = 'done'; this.changed();
  }
  private truncateOutput(text: string): string {
    if (text.length <= this.maxOutputChars) return text;
    let end = Math.max(1, this.maxOutputChars);
    const code = text.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) end--;
    return `${text.slice(0, end)}\n… output truncated (${text.length} chars in full)`;
  }
  delta(kind: 'assistant' | 'reasoning', text: string): void {
    if (!text) return;
    const row = this.live.get(kind);
    if (row) { row.text += text; this.changed(); }
    else this.live.set(kind, this.add(kind, text, { state: 'live' }));
  }
  commit(text: string): void {
    const row = this.live.get('assistant');
    if (row) { row.text = text; row.state = 'done'; }
    else if (text) this.add('assistant', text);
    for (const preview of this.live.values()) preview.state = 'done';
    this.live.clear(); this.changed();
  }
  abandon(): void {
    const abandoned = new Set(this.live.values());
    this.rows = this.rows.filter(row => !abandoned.has(row)); this.live.clear(); this.changed();
  }
  finishTurn(): void {
    this.abandon();
    for (const row of this.rows) if (row.state === 'live' && row.tool) {
      row.tool.status = 'cancelled'; row.tool.endedAt = Date.now(); row.state = 'done';
      row.label = `${row.tool.name} · cancelled`;
    }
    this.changed();
  }
}
