/** Translate Harness services and events into terminal state. */
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage, hasMethod } from './harness.js';
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm';
import type { ApprovalDecision, ViewModel } from './model.js';
import type { Actions, SubmitResult } from './terminal.js';
import { DEFAULT_IMAGE_LIMITS, validateImages, type ImageLimits, type PendingImage } from './ui/clipboard-image.js';
import { commands, isCommand } from './ui/commands.js';

type ImageAttachmentRef = ImageBlock['attachment'];
interface AttachmentWriter {
  readonly imageLimits?: ImageLimits;
  saveImages(inputs: readonly { data: Uint8Array; mediaType: PendingImage['mediaType']; name?: string }[]):
    Promise<readonly ImageAttachmentRef[]>;
}

function attachmentService(ctx: Context): AttachmentWriter | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get('attachments') as AttachmentWriter | undefined;
}

/** Text plus numbered image/file markers; shared by live events, queued chips, and replay. */
export function messageText(content: readonly ContentBlock[]): string {
  let images = 0;
  return content.flatMap(block => {
    if (block.type === 'text') return block.text ? [block.text] : [];
    if (block.type === 'image') return [`[Image #${++images}]`];
    if (block.type === 'file') return [`[File: ${block.attachment.name}]`];
    return [`[${block.type}]`];
  }).join('\n');
}

async function saveImages(ctx: Context, images: readonly PendingImage[]): Promise<readonly ImageAttachmentRef[]> {
  const service = attachmentService(ctx);
  if (!service?.saveImages) throw new Error('Image attachments are unavailable: the Harness attachment service is not mounted.');
  validateImages(images, service.imageLimits ?? DEFAULT_IMAGE_LIMITS);
  return service.saveImages(images.map(image => ({ data: image.data, mediaType: image.mediaType,
    ...(image.name ? { name: image.name } : {}) })));
}

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
  commandsUI?: SessionCommands, startConversation?: Actions['submit']): Actions & { dispose(): void } {
  const projection: ProjectionState = { reportedErrors: new Map() };
  const stops: (() => void)[] = [];
  let disposed = false;
  let generation = 0;
  const admissions = new Set<(accepted: boolean, reason?: SubmitResult['reason']) => void>();
  // Image admission is asynchronous; chain later submissions behind it so a
  // prompt typed after an image never reaches the agent first.
  let delivery: Promise<void> | undefined;
  const queue = (task: () => void | Promise<void>): void => {
    const fail = (error: unknown): void => {
      if (!disposed) view.add('error', error instanceof Error ? error.message : String(error));
    };
    if (!delivery) {
      try {
        const result = task();
        if (result && typeof (result as Promise<void>).then === 'function') {
          const current = (result as Promise<void>).catch(fail);
          delivery = current;
          void current.then(() => { if (delivery === current) delivery = undefined; });
        }
      } catch (error) { fail(error); }
      return;
    }
    const previous = delivery;
    const current = previous.then(task, task).then(() => {}, fail);
    delivery = current;
    void current.then(() => { if (delivery === current) delivery = undefined; });
  };
  const deliver = (text: string, refs: readonly ImageAttachmentRef[] = [], images: readonly PendingImage[] = []): boolean => {
    if (disposed || !agent) return false;
    const content: ContentBlock[] = [];
    let offset = 0;
    for (const [index, attachment] of refs.entries()) {
      const position = Math.max(offset, Math.min(text.length, images[index]?.textOffset ?? text.length));
      if (position > offset) content.push({ type: 'text', text: text.slice(offset, position) });
      content.push({ type: 'image', attachment });
      offset = position;
    }
    if (offset < text.length) content.push({ type: 'text', text: text.slice(offset) });
    const message = createUserMessage({ content, source: { kind: 'user' } });
    view.enqueue(message.id, messageText(content));
    try { agent.followup(message); return true; }
    catch (error) { view.dequeue(message.id); view.add('error', error instanceof Error ? error.message : String(error)); return false; }
  };
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
      // `displayReason` is the asker's localized, user-facing text; `reason` is
      // the audit explanation and may contain internal wording such as
      // "escalate sandbox to ...".
      const reason = request.displayReason?.en || request.reason;
      const prompt = {
        text: reason ?? `${request.toolName} needs your approval before it can run.`,
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
    imageLimits() { return attachmentService(ctx)?.imageLimits ?? DEFAULT_IMAGE_LIMITS; },
    submit(text, images = []) {
      if (images.length && isCommand(text)) { view.add('error', 'Remove attached images before sending a slash command.'); return; }
      if (text === '/quit' || text === '/exit') { quit(); return; }
      if (text === '/help') {
        view.add('system', [
          ...commands.map(command => `${command.usage}  ${command.description}`), '',
          'Enter send · Ctrl+J / Alt+Enter newline · Tab complete command',
          'Ctrl+V / Alt+V attach clipboard image · drop an image file or paste its path',
          'Images appear at the cursor · Backspace / Delete removes the adjacent image',
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
        if (view.pendingAdmissions) { view.add('error', 'Wait for image attachments to finish or press Esc before switching models.'); return; }
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
        if (!text.trim() && !images.length) return;
        if (!agent) return startConversation ? startConversation(text, images) : images.length ? Promise.resolve(false) : undefined;
        const ticket = generation;
        if (!images.length) {
          queue(() => { if (ticket === generation && !disposed) deliver(text); });
          return;
        }
        return new Promise<SubmitResult>(resolve => {
          const controller = new AbortController();
          const finish = (accepted: boolean, reason?: SubmitResult['reason']): void => {
            // Cancellation may settle this request before its storage operation
            // returns. Only the first result can release the busy state.
            if (!admissions.delete(finish)) return;
            controller.abort();
            view.pendingAdmissions--; view.changed();
            resolve(reason ? { accepted, reason } : { accepted });
          };
          admissions.add(finish);
          view.pendingAdmissions++; view.changed();
          queue(async () => {
            if (ticket !== generation || disposed) { finish(false, 'cancelled'); return; }
            try {
              // Use the route selected for the next turn, rather than a
              // display label or the model assembled for a previous step.
              const route = selection?.current ?? agent.options;
              const llm = ctx.get('llm');
              if (route?.provider && route.model && llm && hasMethod(llm, 'resolveModelInfo')) {
                const info = await llm.resolveModelInfo(route.provider, route.model, controller.signal);
                if (ticket !== generation || disposed) { finish(false, 'cancelled'); return; }
                // An omitted capability list is unknown, so retain the
                // Harness compatibility behavior for older providers.
                if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
                  view.add('error', `Current model ${route.provider}/${route.model} cannot process images. `
                    + 'Run /model with an empty input, then press ↑ to recall this message.');
                  finish(false, 'model-unsupported');
                  return;
                }
              }
              const refs = await saveImages(ctx, images);
              if (ticket !== generation || disposed) { finish(false, 'cancelled'); return; }
              const delivered = deliver(text, refs, images);
              finish(delivered, delivered ? undefined : 'failed');
            } catch (error) {
              if (ticket === generation && !disposed) {
                view.add('error', `Could not attach image: ${error instanceof Error ? error.message : String(error)}`);
              }
              finish(false, 'failed');
            }
          });
        });
      }
    },
    cancel() {
      generation++; delivery = undefined;
      for (const finish of admissions) finish(false, 'cancelled');
      agent?.cancel({ kind: 'user' }); view.cancelApprovals('cancelled'); view.queued = []; view.changed();
    },
    quit,
    dispose() {
      disposed = true; generation++; delivery = undefined;
      for (const finish of admissions) finish(false, 'cancelled');
      for (const stop of stops.splice(0)) stop(); view.cancelApprovals('cancelled');
    },
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
      view.userMessage(event.data.id, messageText(event.data.content));
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
