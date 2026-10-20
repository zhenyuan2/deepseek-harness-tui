/** Translate Harness services and events into terminal state. */
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage, hasMethod } from './harness.js';
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ApprovalDecision, ViewModel } from './model.js';
import type { Actions } from './terminal.js';
import { commands, isCommand } from './ui/commands.js';

/** Errors already surfaced by `agent/error`, consumed by the matching turn end. */
export interface ProjectionState { reportedErrors: Map<string, number> }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Plugin-owned source kinds are extensible and need not be imported by the UI. */
function isInternalContext(source: { kind: string }): boolean {
  return source.kind === 'agent-instructions' || source.kind === 'runtime-context';
}

function noteError(state: ProjectionState, message: string): void {
  state.reportedErrors.set(message, (state.reportedErrors.get(message) ?? 0) + 1);
}

function consumeError(state: ProjectionState, message: string): boolean {
  const count = state.reportedErrors.get(message) ?? 0;
  if (count === 0) return false;
  if (count === 1) state.reportedErrors.delete(message);
  else state.reportedErrors.set(message, count - 1);
  return true;
}

/** Observe one owned agent; other agents continue through other answerers. */
export interface SessionCommands { resume(id?: string): void; model(route?: string, effort?: string): void; statusline?(): void; newSession?(clearScreen?: boolean): void }
export function connect(ctx: Context, agent: Agent | undefined, view: ViewModel, quit: () => void, selection?: ModelSelectionRef,
  commandsUI?: SessionCommands, startConversation?: (text: string) => void): Actions & { dispose(): void } {
  const projection: ProjectionState = { reportedErrors: new Map() };
  const stops: (() => void)[] = [];
  stops.push(ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject !== agent) return;
    view.setStatus(status);
    // Errors without a turn boundary (maintenance, startup) should not linger
    // in the dedupe map forever.
    if (status === 'idle') projection.reportedErrors.clear();
  }));
  stops.push(ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent) return;
    if (frame.type === 'start') view.startStream();
    if (frame.type === 'end' && frame.outcome.kind === 'abandoned') view.abandon();
    if (frame.type === 'chunk') {
      if (frame.chunk.type === 'text-delta') view.delta('assistant', frame.chunk.text);
      if (frame.chunk.type === 'reasoning-delta') view.delta('reasoning', frame.chunk.text);
    }
  }));
  stops.push(ctx.on('session/event', (session, event) => {
    if (!agent || session !== agent.session) return;
    projectSessionEvent(view, event, projection);
    view.changed();
  }));
  stops.push(ctx.on('agent/error', ({ agent: subject, error }) => {
    if (subject !== agent) return;
    const message = errorText(error);
    noteError(projection, message);
    view.add('error', message);
  }));

  // This UI claims only its own Agent's approval requests. Returning next()
  // for another Agent preserves Cordis waterfall delegation.
  stops.push(ctx.on('approval/request', (request, next) => {
    if (request.agent !== agent) return next();
    if (request.signal?.aborted) return Promise.resolve<ApprovalOutcome>('cancelled');
    return new Promise<ApprovalOutcome>(resolve => {
      let settled = false;
      const finish = (outcome: ApprovalOutcome): void => {
        if (settled) return;
        settled = true;
        request.signal?.removeEventListener('abort', abort);
        view.removeApproval(prompt);
        resolve(outcome);
      };
      const abort = (): void => { finish('cancelled'); };
      const prompt = {
        text: `${request.toolName}: ${request.reason ?? 'Harness requests approval for this action.'}`,
        toolName: request.toolName,
        arguments: request.callId ? view.rows.find(row => row.toolCallId === request.callId)?.tool?.arguments : undefined,
        cwd: agent.session.header?.cwd ?? process.cwd(),
        answer: (decision: ApprovalDecision): void => { finish(decision); },
      };
      // Parallel tool calls can ask for more than one approval. Queue them
      // instead of rejecting the second one, and never claim a request only to
      // fail closed while another answerer could have handled it.
      view.queueApproval(prompt);
      request.signal?.addEventListener('abort', abort, { once: true });
    });
  }));

  return {
    submit(text) {
      if (text === '/quit' || text === '/exit') { quit(); return; }
      if (text === '/help') {
        view.add('system', [
          ...commands.map(command => `${command.usage}  ${command.description}`), '',
          'Enter send · Ctrl+J / Alt+Enter newline · Tab complete command',
          '↑/↓ edit lines or recall history · Alt+↑/↓ history · Ctrl+U clear input',
          'F2 toggle live details · Ctrl+L clear screen (keep chat) · Esc stop · Ctrl+C exit',
          'PgUp / PgDn browse conversation · Ctrl+W delete word · Ctrl+K delete to line end',
          'Alt+←/→ move by word · Ctrl+A/E move to line start/end',
          'Drag to select; hold at the top/bottom edge to scroll · Release to copy · Ctrl+C copies selection · Esc clears selection',
          'New input while working queues the next turn.',
        ].join('\n'));
      } else if (text === '/new' || text === '/clear') {
        if (commandsUI?.newSession) commandsUI.newSession(text === '/clear');
        else view.add('error', 'New conversations are unavailable in this runtime.');
      }
      else if (/^\/details(?:\s+\d+(?:\s*[-–]\s*\d+)?)?$/.test(text)) {
        const match = text.match(/^\/details(?:\s+(\d+)(?:\s*[-–]\s*(\d+))?)?$/)!;
        view.details(match[1] ? Number(match[1]) : undefined, match[2] ? Number(match[2]) : undefined);
      }
      else if (text === '/session') view.add('system', `Session: ${agent?.session.id ?? view.sessionId}\nUse /resume to switch conversations.`);
      else if (text === '/statusline') {
        if (commandsUI?.statusline) commandsUI.statusline();
        else view.add('error', 'Statusline configuration is unavailable in this runtime.');
      }
      else if (/^\/resume(?:\s|$)/.test(text)) {
        if (!commandsUI) { view.add('error', 'Session switching is unavailable in this runtime.'); return; }
        const parts = text.trim().split(/\s+/);
        if (parts.length > 2) { view.add('error', 'Usage: /resume [session-id]'); return; }
        commandsUI.resume(parts[1]);
      }
      else if (/^\/model(?:\s|$)/.test(text) && commandsUI) {
        const parts = text.trim().split(/\s+/);
        if (parts.length > 3) { view.add('error', 'Usage: /model [provider/model] [effort]'); return; }
        commandsUI.model(parts[1], parts[2]);
      }
      else if (text === '/model') view.add('system', `Model: ${view.model}\n/model provider/model switches this session while idle.`);
      else if (text.startsWith('/model ')) {
        if (!selection) { view.add('error', 'Model switching is unavailable in this runtime.'); return; }
        if (view.status !== 'idle' || view.queued.length) { view.add('error', 'Stop the current turn before switching models.'); return; }
        const route = text.slice(7).trim(); const separator = route.indexOf('/');
        if (separator < 1 || separator === route.length - 1 || /\s/.test(route)) { view.add('error', 'Usage: /model provider/model'); return; }
        const provider = route.slice(0, separator); const model = route.slice(separator + 1);
        const llm = ctx.get('llm');
        if (!llm || !hasMethod(llm, 'listProviders')) {
          view.add('error', 'Model switching requires the Harness llm.listProviders() API.');
          return;
        }
        if (!llm.listProviders().some(item => item.id === provider)) { view.add('error', `Provider is not registered: ${provider}`); return; }
        selection.current = { provider, model };
        view.model = route;
        view.add('system', `Model: ${route} · applies to the next request; provider validates the model on use.`);
      }
      else if (isCommand(text)) {
        const name = text.split(/\s+/, 1)[0]!;
        const usage = commands.find(command => command.name === name)?.usage ?? name;
        view.add('error', `Usage: ${usage}`);
      }
      else {
        if (!text.trim()) return;
        if (!agent) { startConversation?.(text); return; }
        const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
        view.enqueue(message.id, text);
        try { agent.followup(message); }
        catch (error) { view.dequeue(message.id); view.add('error', error instanceof Error ? error.message : String(error)); }
      }
    },
    cancel() { agent?.cancel({ kind: 'user' }); view.cancelApprovals('cancelled'); view.queued = []; view.changed(); },
    quit,
    dispose() { for (const stop of stops.splice(0)) stop(); view.cancelApprovals('cancelled'); },
  };
}

/** Replay durable facts into the local view without re-emitting Harness events. */
export function projectSessionEvent(view: ViewModel, event: SessionEvent, state?: ProjectionState): void {
  view.tokens.apply(event);
  switch (event.type) {
    case 'user/message':
      // Keep injected instructions and runtime snapshots in Harness history, out of the
      // transcript for both live events and session replay.
      if (isInternalContext(event.data.source)) break;
      view.userMessage(event.data.id, event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
      break;
    case 'assistant/message': {
      const content = event.data.message.content;
      const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const reasoning = content.filter(block => block.type === 'reasoning').map(block => block.text).join('\n');
      // Replay has no live rows; a live message normally already streamed its
      // reasoning, but reconstruct it if that stream was unavailable.
      if (reasoning && (!state || !view.hasLive('reasoning'))) view.add('reasoning', reasoning);
      view.commit(text);
      if (!state && event.data.interrupted && (text || reasoning)) view.add('system', 'Assistant response was interrupted before completion.');
      break;
    }
    case 'tool/call': view.toolCall(event.data.callId, event.data.name, event.data.arguments, event.time); break;
    case 'tool/result': {
      const content = event.data.message.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n');
      view.toolResult(event.data.message.toolCallId,
        content || event.data.error?.reason || '',
        !!event.data.error || !!event.data.message.isError, event.data.meta, event.time);
      break;
    }
    case 'turn/end':
      view.finishTurn();
      if (event.data.reason.kind === 'error') {
        const message = event.data.reason.error.message;
        if (!state || !consumeError(state, message)) view.add('error', message);
      } else if (event.data.reason.kind !== 'completed') view.add('system', `Turn ended: ${event.data.reason.kind}`);
      break;
    default: break; // Other plugins may add durable session event types.
  }
}
