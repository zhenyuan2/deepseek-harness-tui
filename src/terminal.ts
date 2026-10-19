/** Normal-buffer conversation viewport with an independently pinned composer. */
import { writeSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { PassThrough } from 'node:stream';
import type { ViewModel } from './model.js';
import { App, Header } from './ui/App.js';
import { Editor } from './ui/Composer.js';
import { createInputHandler } from './ui/input.js';
import { Messages } from './ui/Conversation.js';
import { ScrollbackRenderer } from './ui/scrollback.js';
import { Transcript } from './ui/transcript.js';
import { mouseInput } from './ui/mouse.js';
import { movePicker } from './ui/Picker.js';
import { createTheme } from './ui/theme.js';
import { plain, truncate } from './ui/text.js';
export { plain, graphemes, width, wrap } from './ui/text.js';
export interface Actions { submit(text: string): void; cancel(): void; quit(): void }

export function openTerminal(view: ViewModel, actions: Actions, title: string,
  ports = { input: process.stdin, output: process.stdout },
  options: { mouseTracking?: boolean; exit?: (code: number) => void } = {}): () => void {
  const { input, output } = ports;
  if (!input.isTTY || !output.isTTY) throw new Error('DeepSeek Harness TUI requires an interactive terminal (stdin and stdout TTY).');
  const write = output.write.bind(output);
  const renderer = new ScrollbackRenderer(write);
  const theme = createTheme(); const editor = new Editor();
  const transcript = new Transcript();
  const keys = new PassThrough();
  const wasRaw = input.isRaw; const wasFlowing = input.readableFlowing === true;
  let closed = false; let details = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let rawTouched = false; let resumed = false; let pasteEnabled = false; let listening = false;
  let guards = false; let finishing = false;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const columns = (): number => Math.max(1, (output.columns || 80) - 1);
  const rows = (): number => Math.max(1, output.rows || 24);
  const restoreWrites: (() => void)[] = [];
  let header = true;
  let lastApproval = view.approval;
  let screenRevision = 0;
  const consumeScreenClear = (): void => {
    if (screenRevision === view.screenRevision) return;
    screenRevision = view.screenRevision;
    transcript.clear(); renderer.clear(); header = false;
    editor.previewStart = undefined; editor.previewTotal = 0; editor.previewAnchor = undefined;
  };

  const redraw = (): void => {
    timer = undefined;
    if (closed) return;
    try {
      consumeScreenClear();
      if (view.approval !== lastApproval) { editor.approvalPage = 0; lastApproval = view.approval; }
      if (header) { transcript.append(Header(title, view.model, view.cwd || process.cwd(), columns(), theme)); header = false; }
      transcript.append(Messages(view.takeCompleted(), columns(), theme));
      const frame = App(view, editor, columns(), rows(), theme, details, Date.now(), transcript);
      renderer.render(transcript.takePublished(), frame, output.columns || 80, rows(), editor.contentRows, editor.caret);
    } catch (error: unknown) {
      // Rendering is model-driven. Keep the terminal alive with a bounded
      // diagnostic instead of letting a timer callback throw out of the process.
      try {
        const message = `Render error: ${error instanceof Error ? error.message : String(error)} · Ctrl+C exit`;
        renderer.render([], [truncate(theme.paint('error', plain(message)), columns())], output.columns || 80, rows());
      } catch {
        // The next close() still owns terminal restoration.
      }
    }
  };
  const schedule = (): void => { if (!closed && timer === undefined) timer = setTimeout(redraw, 25); };

  const onKey = createInputHandler(view, editor, actions, schedule, () => { details = !details; });
  const mouse = mouseInput(text => { keys.write(text); }, direction => {
    if (!options.mouseTracking) return;
    if (view.approval) editor.approvalPage += direction;
    else if (view.picker) movePicker(view.picker, direction);
    else {
      const last = Math.max(0, editor.previewTotal - editor.previewLines);
      const start = (editor.previewStart ?? last) + direction * 3;
      editor.previewStart = start >= last ? undefined : Math.max(0, start);
    }
    schedule();
  });
  const onData = (chunk: Buffer | string): void => mouse.write(chunk);

  // Last-resort terminal restoration for signals and uncaught failures. The
  // normal close() can be skipped when Node exits, so this path uses a
  // synchronous write and resets raw mode without waiting for stream flushes.
  const restoreTerminalSync = (): void => {
    try { if (rawTouched) input.setRawMode(wasRaw); } catch { /* stream may be gone */ }
    const sequence = '\x1b[r\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l';
    try {
      const fd = (output as { fd?: number }).fd;
      if (typeof fd === 'number' && fd >= 0) {
        try { writeSync(fd, sequence); return; } catch { /* fall back to the stream */ }
      }
      output.write(sequence);
    } catch { /* best effort during shutdown */ }
  };

  const finish = (code: number, error?: unknown): void => {
    if (finishing) return;
    finishing = true;
    try { close(true); } catch { /* terminal restoration is best effort */ }
    restoreTerminalSync();
    if (error !== undefined) {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      const message = `\nDeepSeek Harness TUI: ${detail}\n`;
      // close() restores the console patch first, but use a synchronous write
      // so the diagnostic is not lost when process.exit follows immediately.
      try { writeSync(2, message); } catch { try { process.stderr.write(message); } catch { /* stderr may be gone */ } }
    }
    try { exit(code); } catch { /* the process may already be exiting */ } finally { removeGuards(); }
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    const codes: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
    finish(codes[signal] ?? 1);
  };
  const onException = (error: unknown): void => finish(1, error);
  const onRejection = (reason: unknown): void => finish(1, reason);
  const onProcessExit = (): void => restoreTerminalSync();
  const installGuards = (): void => {
    if (guards) return;
    guards = true;
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);
    process.on('uncaughtException', onException);
    process.on('unhandledRejection', onRejection);
    process.on('exit', onProcessExit);
  };
  const removeGuards = (): void => {
    if (!guards) return;
    guards = false;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
    process.off('exit', onProcessExit);
  };

  const close = (emergency = false): void => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    if (tick !== undefined) clearInterval(tick);
    try { unsubscribe?.(); } catch { /* disposers are best-effort during shutdown */ }
    if (listening) {
      try { input.off('keypress', onKey); } catch { /* stream may be gone */ }
      try { input.off('data', onData); } catch { /* stream may be gone */ }
      try { keys.off('keypress', onKey); } catch { /* stream may be gone */ }
      try { output.off('resize', schedule); } catch { /* stream may be gone */ }
    }
    try { mouse.close(); } catch { /* timer may already be gone */ }
    try { keys.destroy(); } catch { /* stream may already be destroyed */ }
    for (const restore of restoreWrites) { try { restore(); } catch { /* restore as much as possible */ } }
    let renderedClose = false;
    try {
      // Fatal paths must not spend time rendering a long transcript or mutate
      // model state; clearing the viewport and restoring modes is enough.
      if (emergency) {
        renderer.close([], output.columns || 80, rows());
        renderedClose = true;
      } else {
        consumeScreenClear();
        view.finishTurn();
        transcript.append(Messages(view.takeCompleted(), columns(), theme));
        renderer.close(transcript.finish(columns()), output.columns || 80, rows());
        renderedClose = true;
      }
    } catch {
      // A malformed message must not prevent the terminal from being handed back.
      try { renderer.close([], output.columns || 80, rows()); renderedClose = true; } catch { /* best effort */ }
    } finally {
      // renderer.close() normally writes these, but it may have thrown before
      // reaching them. Repeat defensively so raw mode and screen modes are safe.
      try { if (pasteEnabled) write('\x1b[?2004l'); } catch { /* best effort */ }
      // Resetting margins also homes the cursor. Preserve the cursor after the
      // published tail on success so a replacement TUI cannot overwrite it.
      try { write((renderedClose ? '' : '\x1b[r') + '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l'); } catch { /* best effort */ }
      try { write('\x1b[?25h\x1b[0m'); } catch { /* best effort */ }
      try { if (rawTouched) input.setRawMode(wasRaw); } catch { /* stream may be gone */ }
      try { if (resumed && !wasFlowing) input.pause(); } catch { /* stream may be gone */ }
      // Keep signal handlers until the terminal is actually restored, so an
      // exception inside close() still leaves the exit fallback installed.
      // During a fatal signal finish() removes them after exit, otherwise Node
      // can apply the signal's default action as soon as the last listener goes.
      if (!finishing) removeGuards();
    }
  };

  try {
    installGuards();
    // Route plugin diagnostics through the transcript, never through the active editor.
    if (output === process.stdout) for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write; const decoder = new StringDecoder('utf8');
      stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
        const message = typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk));
        const clean = plain(message).trimEnd();
        if (clean) view.add('system', clean);
        const done = typeof encoding === 'function' ? encoding : callback;
        if (done) process.nextTick(done);
        return true;
      }) as typeof stream.write;
      restoreWrites.push(() => { stream.write = original; });
    }
    emitKeypressEvents(keys);
    rawTouched = true; input.setRawMode(true);
    resumed = true; input.resume();
    // Native selection requires mouse reporting to be disabled. Reset inherited
    // modes too, so a previous application cannot leave dragging captured.
    pasteEnabled = true;
    write('\x1b[?2004h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l');
    if (options.mouseTracking) write('\x1b[?1000h\x1b[?1006h');
    input.on('keypress', onKey); listening = true;
    keys.on('keypress', onKey); input.on('data', onData);
    output.on('resize', schedule);
    unsubscribe = view.subscribe(schedule);
    tick = setInterval(() => { if (view.status === 'running' && !view.approval) schedule(); }, 100);
    tick.unref();
    redraw();
    return close;
  } catch (error: unknown) {
    // openTerminal performs terminal side effects before the first render.
    // Undo them here so the caller's startup catch can report the real error
    // through the now-restored stderr instead of leaving the shell in raw mode.
    close();
    throw error;
  }
}
