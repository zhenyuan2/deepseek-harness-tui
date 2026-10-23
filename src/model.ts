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
/** Durable identity of a projected row; local rows stay identity-free. */
export interface MessageIdentity {
  seq?: number;
  turn?: number;
  step?: number;
  anchor?: string;
  messageId?: string;
}
export interface Row extends MessageIdentity {
  id: number;
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'system' | 'compact' | 'error';
  text: string;
  state: 'live' | 'done';
  archived?: boolean;
  /** True when full text/arguments/output/diffs were replaced by previews. */
  folded?: boolean;
  /** A result appended after its original card had already entered scrollback. */
  lateResult?: boolean;
  expanded?: boolean;
  label?: string;
  toolCallId?: string;
  tool?: ToolState;
}
function definedIdentity(identity: MessageIdentity): MessageIdentity {
  const result: MessageIdentity = {};
  if (identity.seq !== undefined) result.seq = identity.seq;
  if (identity.turn !== undefined) result.turn = identity.turn;
  if (identity.step !== undefined) result.step = identity.step;
  if (identity.anchor !== undefined) result.anchor = identity.anchor;
  if (identity.messageId !== undefined) result.messageId = identity.messageId;
  return result;
}
function mergeIdentity(base: MessageIdentity | undefined, next: MessageIdentity): MessageIdentity {
  return { ...(base ? definedIdentity(base) : {}), ...definedIdentity(next) };
}
export type ApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled';
export interface ApprovalPrompt {
  /** Human-readable explanation of why permission is required. */
  text: string;
  toolName?: string;
  arguments?: string;
  cwd?: string;
  answer(decision: ApprovalDecision): void;
}
export const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;
/** Text retained across rows before old archived rows are folded to previews. */
export const DEFAULT_MAX_RETAINED_CHARS = 8_000_000;
/** Characters kept when one folded row is reduced to a preview. */
export const DEFAULT_FOLD_PREVIEW_CHARS = 1_000;
/** Replay windows bound both row count and retained characters. */
export const DEFAULT_REPLAY_MAX_ROWS = 300;
export const DEFAULT_REPLAY_MAX_CHARS = 4_000_000;
function previewText(text: string, limit = DEFAULT_FOLD_PREVIEW_CHARS): string {
  if (text.length <= limit) return text;
  let end = Math.max(1, limit);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xD800 && code <= 0xDBFF) end--;
  return `${text.slice(0, end)}…`;
}
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
  /** Submitted image messages that have not finished attachment admission. */
  pendingAdmissions = 0;
  startedAt?: number;
  /** Set when replay dropped old rows instead of materializing the whole log. */
  replayOmitted = false;
  replayOmittedRows = 0;
  private sequence = 0;
  private live = new Map<Row['kind'], Row>();
  /** Identity of the open assistant attempt, copied onto live rows. */
  private stream?: MessageIdentity;
  private listeners = new Set<() => void>();
  constructor(private readonly maxRows: number, private readonly maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
    private readonly maxRetainedChars = DEFAULT_MAX_RETAINED_CHARS) {}
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
  private rowChars(row: Row): number {
    let chars = row.text.length;
    if (row.tool) {
      chars += row.tool.arguments.length + row.tool.output.length;
      for (const diff of row.tool.diffs ?? []) {
        chars += diff.path.length + (diff.oldText?.length ?? 0) + diff.newText.length;
      }
    }
    return chars;
  }
  /** Approximate text retained by the projection; used by budgets and tests. */
  get retainedChars(): number {
    let chars = 0;
    for (const row of this.rows) chars += this.rowChars(row);
    return chars;
  }
  /**
   * Build a folded replacement row. Replacing the object (instead of mutating
   * it) lets the render cache's weak old-entry — and the full lines it holds —
   * become collectible.
   */
  private foldRow(row: Row): Row | undefined {
    let folded = false;
    const text = previewText(row.text);
    if (text !== row.text) folded = true;
    let tool: ToolState | undefined;
    if (row.tool) {
      const args = previewText(row.tool.arguments);
      const output = previewText(row.tool.output);
      if (args !== row.tool.arguments || output !== row.tool.output || row.tool.diffs?.length) folded = true;
      tool = { ...row.tool, arguments: args, output, diffs: undefined };
    }
    if (!folded) return undefined;
    return { ...row, text, ...(tool ? { tool } : {}), folded: true };
  }
  /** Fold archived rows, oldest first, until the text budget is met. */
  private foldArchived(): void {
    let chars = this.retainedChars;
    if (chars <= this.maxRetainedChars) return;
    for (let index = 0; index < this.rows.length; index++) {
      if (chars <= this.maxRetainedChars) break;
      const row = this.rows[index]!;
      if (!row.archived || row.folded) continue;
      const folded = this.foldRow(row);
      if (!folded) continue;
      this.rows[index] = folded;
      chars -= this.rowChars(row) - this.rowChars(folded);
    }
  }
  /**
   * Bound rows while replaying: only settled rows are dropped, so a tool call
   * awaiting its result (or a live assistant preview) is never cut mid-flight.
   */
  trimReplay(maxRows = DEFAULT_REPLAY_MAX_ROWS, maxChars = DEFAULT_REPLAY_MAX_CHARS): boolean {
    const rows = Math.max(1, Math.trunc(maxRows));
    const chars = Math.max(1, Math.trunc(maxChars));
    let retained = this.retainedChars;
    let omitted = 0;
    while (this.rows.length > rows || retained > chars) {
      if (this.rows.length <= 1) break;
      const index = this.rows.findIndex(row => row.state === 'done' && !row.archived);
      if (index === -1) break;
      const [row] = this.rows.splice(index, 1);
      if (!row) break;
      retained -= this.rowChars(row);
      omitted++;
    }
    if (omitted) { this.replayOmitted = true; this.replayOmittedRows += omitted; }
    return omitted > 0;
  }
  /** Put a replay-window notice before the retained history. */
  prependNotice(text: string): Row {
    const row: Row = { id: ++this.sequence, kind: 'system', text, state: 'done' };
    this.rows.unshift(row);
    this.trim(); this.changed();
    return row;
  }
  private applyIdentity(row: Row, identity: MessageIdentity): void {
    if (identity.seq !== undefined) row.seq = identity.seq;
    if (identity.turn !== undefined) row.turn = identity.turn;
    if (identity.step !== undefined) row.step = identity.step;
    if (identity.anchor !== undefined) row.anchor = identity.anchor;
    if (identity.messageId !== undefined) row.messageId = identity.messageId;
  }
  private insertBefore(row: Row, before?: Row): void {
    const index = before ? this.rows.indexOf(before) : -1;
    if (index === -1) this.rows.push(row);
    else this.rows.splice(index, 0, row);
    this.trim(); this.changed();
  }
  private removeRow(row: Row): void {
    if (this.live.get(row.kind) === row) this.live.delete(row.kind);
    const index = this.rows.indexOf(row);
    if (index !== -1) this.rows.splice(index, 1);
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
    // The copies above keep their full text for this render; the retained rows
    // can now be folded without changing what enters native scrollback.
    this.trim();
    this.foldArchived();
    return ready;
  }
  get active(): Row[] { return this.rows.filter(row => !row.archived); }
  get showWelcome(): boolean {
    return !this.welcomeDismissed && this.status === 'idle' && this.sessionId === 'Not started';
  }
  /** Dismiss visible output without changing conversation facts or retained details. */
  clearScreen(restoreWelcome = false): void {
    this.takeCompleted();
    this.stream = undefined;
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
      const folded = rows.filter(row => row.folded).length;
      if (folded) this.add('system', `${folded} message(s) in #${id}–${endId} were folded to keep memory bounded; only previews remain.`);
      for (const row of rows) if (!row.folded) this.details(row.id);
      return;
    }
    const row = id === undefined
      ? [...this.rows].reverse().find(row => row.state === 'done' && !row.folded && (row.tool || row.kind === 'reasoning'))
      : this.rows.find(row => row.id === id);
    if (!row) { this.add('system', 'No retained details. Use /details <message number> after a tool completes.'); return; }
    if (row.state === 'live') { this.add('system', `Message #${row.id} is still running. F2 toggles the live preview.`); return; }
    if (row.folded) {
      this.add('system', `Message #${row.id} was folded to keep memory bounded; only its preview remains.`);
      return;
    }
    this.add(row.kind, row.text, { expanded: true, label: row.label, tool: row.tool ? { ...row.tool } : undefined });
  }
  enqueue(id: string, text: string): void { this.queued.push({ id, text }); this.changed(); }
  dequeue(id: string): void { this.queued = this.queued.filter(item => item.id !== id); this.changed(); }
  userMessage(id: string, text: string, identity: MessageIdentity = {}): Row {
    this.dequeue(id);
    return this.add('user', text, { ...identity, messageId: id });
  }
  startStream(turn?: number, step?: number): void {
    if (this.live.size) this.abandon();
    this.stream = turn === undefined && step === undefined ? undefined : { turn, step };
  }
  hasLive(kind: Row['kind']): boolean { return this.live.has(kind); }
  toolCall(callId: string, name: string, args: string, startedAt = Date.now(), identity: MessageIdentity = {}): Row {
    return this.add('tool', args, { ...identity, state: 'live', toolCallId: callId, label: `${name} · running`,
      tool: { name, arguments: args, output: '', status: 'running', startedAt } });
  }
  toolResult(callId: string, text: string, failed: boolean, meta?: unknown, endedAt = Date.now(), identity: MessageIdentity = {}): void {
    // A result can arrive after finishTurn marked its card cancelled, or after
    // a reconnect replayed the call. Match by callId, not by "still live".
    const cards = callId ? this.rows.filter(row => row.toolCallId === callId && row.tool) : [];
    const row = cards.find(item => !item.archived) ?? cards.at(-1);
    if (!row?.tool) {
      this.add(failed ? 'error' : 'tool', this.truncateOutput(text), identity);
      return;
    }
    const diffs = !failed ? this.diffsOf(meta) : undefined;
    if (row.archived) {
      // The original card already entered the append-only transcript. A
      // mutation would update the model but never the displayed history, so
      // append a visible late-result card instead of silently losing it.
      const existing = cards.find(item => item.lateResult);
      if (existing?.tool) {
        if (!existing.archived) this.applyToolResult(existing, text, failed, diffs, endedAt);
        return;
      }
      const late: Row = {
        id: ++this.sequence,
        kind: failed ? 'error' : 'tool',
        // The old card's own arguments may already be previews; that loss is
        // unavoidable. The newly arrived result and diff are not.
        text: row.text,
        state: 'done',
        lateResult: true,
        ...(row.seq === undefined ? {} : { seq: row.seq }),
        ...(row.turn === undefined ? {} : { turn: row.turn }),
        ...(row.step === undefined ? {} : { step: row.step }),
        toolCallId: callId,
        label: `${row.tool.name} · ${failed ? 'failed' : 'done'} (late)`,
        tool: {
          ...row.tool,
          arguments: row.tool.arguments,
          output: this.truncateOutput(text),
          status: failed ? 'failed' : 'done',
          endedAt,
          diffs,
        },
      };
      this.rows.push(late);
      this.trim();
      // Use the budget for the new card: it is a fresh row, not a copy of the
      // old folded card. Fold it only if retaining the full result actually
      // exceeds the budget, and then mark it so /details can explain.
      this.foldArchived();
      if (this.retainedChars > this.maxRetainedChars) {
        const index = this.rows.indexOf(late);
        if (index !== -1) {
          const folded = this.foldRow(late);
          if (folded) this.rows[index] = folded;
        }
      }
      this.changed();
      return;
    }
    this.applyToolResult(row, text, failed, diffs, endedAt);
  }
  private diffsOf(meta: unknown): FileDiff[] | undefined {
    if (!meta || typeof meta !== 'object' || !('diffs' in meta) || !Array.isArray(meta.diffs)) return undefined;
    return meta.diffs.filter((diff): diff is FileDiff => diff && typeof diff === 'object'
      && typeof diff.path === 'string' && (diff.oldText === null || typeof diff.oldText === 'string') && typeof diff.newText === 'string');
  }
  private applyToolResult(row: Row, text: string, failed: boolean, diffs: FileDiff[] | undefined, endedAt: number): void {
    if (!row.tool) return;
    if (diffs) row.tool.diffs = diffs;
    row.tool.output = row.folded ? previewText(text) : this.truncateOutput(text);
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
    if (row) { row.text += text; this.changed(); return; }
    this.live.set(kind, this.add(kind, text, { ...this.stream, state: 'live' }));
  }
  /**
   * Settle one durable assistant message. Reasoning stays live until this
   * point, so the authoritative text can replace the streamed preview before
   * the row is ever copied into the append-only transcript.
   */
  commit(text: string, reasoning = '', identity: MessageIdentity = {}): void {
    const id = mergeIdentity(this.stream, identity);
    let assistant = this.live.get('assistant');
    if (assistant) {
      this.applyIdentity(assistant, id);
      if (text) { assistant.text = text; assistant.state = 'done'; }
      else { this.removeRow(assistant); assistant = undefined; }
    } else if (text) {
      assistant = this.add('assistant', text, { ...id, state: 'done' });
    }
    const reasoningRow = this.live.get('reasoning');
    if (reasoningRow) {
      if (reasoning) reasoningRow.text = reasoning;
      reasoningRow.state = 'done';
      this.applyIdentity(reasoningRow, id);
    } else if (reasoning) {
      const row: Row = { id: ++this.sequence, kind: 'reasoning', text: reasoning, state: 'done', ...id };
      this.insertBefore(row, assistant);
    }
    for (const preview of this.live.values()) preview.state = 'done';
    this.live.clear();
    this.stream = undefined;
    this.changed();
  }
  abandon(): void {
    const abandoned = new Set(this.live.values());
    this.rows = this.rows.filter(row => !abandoned.has(row));
    this.live.clear();
    this.stream = undefined;
    this.changed();
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
