/** Full-screen conversation viewport with an independently pinned composer. */
import { writeSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { PassThrough } from 'node:stream';
import type { ViewModel } from './model.js';
import { App, Header } from './ui/App.js';
import { Editor } from './ui/Composer.js';
import { createInputHandler, type Key } from './ui/input.js';
import { Messages } from './ui/Conversation.js';
import { ScrollbackRenderer } from './ui/scrollback.js';
import { Transcript } from './ui/transcript.js';
import { mouseInput, type MouseReport } from './ui/mouse.js';
import { TextSelection } from './ui/selection.js';
import { Scrollbar } from './ui/Scrollbar.js';
import { copyText } from './ui/clipboard.js';
import { readClipboardImage as readSystemClipboard, type ImageLimits, type PendingImage } from './ui/clipboard-image.js';
import { TerminalGraphics, type GraphicsCapabilities } from './ui/terminal-graphics.js';
import { useNonBlockingOutput, type OutputLease } from './ui/terminal-output.js';
import { movePicker } from './ui/Picker.js';
import { createTheme } from './ui/theme.js';
import { plain, truncate } from './ui/text.js';
export { plain, graphemes, width, wrap } from './ui/text.js';
export type ImageFailureReason = 'model-unsupported' | 'cancelled' | 'failed';
export interface SubmitResult { readonly accepted: boolean; readonly reason?: ImageFailureReason }
export type SubmitOutcome = boolean | SubmitResult;
export interface Actions {
  /** Image submissions settle only after admission; a false result leaves the draft recallable. */
  submit(text: string, images?: readonly PendingImage[]): void | Promise<SubmitOutcome>;
  imageLimits?(): ImageLimits;
  cancel(): void;
  quit(): void;
}
export interface TerminalClose {
  (): void;
  /** Resolve after the output queued by close() has reached the terminal. */
  flush(): Promise<void>;
}
// Conversation mounts share terminal support, but never reuse deleted image IDs.
const graphicsCapabilities = new WeakMap<object, GraphicsCapabilities>();
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

/** A blocking fd may still report EAGAIN transiently; retry partial writes for shutdown. */
function writeAllSync(fd: number, text: string): boolean {
  const data = Buffer.from(text);
  let offset = 0;
  let retries = 0;
  while (offset < data.length) {
    try {
      const written = writeSync(fd, data, offset, data.length - offset);
      if (written <= 0) return false;
      offset += written;
      retries = 0;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK' && code !== 'EINTR') return false;
      if (++retries > 200) return false;
      Atomics.wait(waitBuffer, 0, 0, 5);
    }
  }
  return true;
}

export function openTerminal(view: ViewModel, actions: Actions, title: string,
  ports = { input: process.stdin, output: process.stdout },
  options: { mouseTracking?: boolean; exit?: (code: number) => void; copy?: (text: string) => void;
    readClipboardImage?: () => Promise<PendingImage | undefined> } = {}): TerminalClose {
  const { input, output } = ports;
  const mouseTracking = options.mouseTracking ?? true;
  if (!input.isTTY || !output.isTTY) throw new Error('DeepSeek Harness TUI requires an interactive terminal (stdin and stdout TTY).');
  const write = output.write.bind(output);
  const copy = options.copy ?? ((text: string) => copyText(text, write));
  const renderer = new ScrollbackRenderer(write);
  const theme = createTheme(); const editor = new Editor(() => actions.imageLimits?.(), () => schedule());
  const transcript = new Transcript();
  const selection = new TextSelection();
  const scrollbar = new Scrollbar();
  const keys = new PassThrough();
  const wasRaw = input.isRaw; const wasFlowing = input.readableFlowing === true;
  let closed = false; let details = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let dragTick: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let rawTouched = false; let resumed = false; let pasteEnabled = false; let listening = false;
  let guards = false; let finishing = false;
  let releaseOutput: OutputLease | undefined;
  let waitingForDrain = false; let recoveryPending = false; let resizePending = false;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const columns = (): number => Math.max(1, (output.columns || 80) - 1);
  const rows = (): number => Math.max(1, output.rows || 24);
  const flushOutput = (): Promise<void> => new Promise(resolve => {
    if (output.destroyed || output.writableFinished) { resolve(); return; }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      output.off('error', finish); output.off('close', finish);
      resolve();
    };
    output.once('error', finish); output.once('close', finish);
    try { output.write('', finish); } catch { finish(); }
  });
  const restoreWrites: (() => void)[] = [];
  let header = true;
  let lastApproval = view.approval;
  let screenRevision = 0;
  const consumeScreenClear = (): void => {
    if (screenRevision === view.screenRevision) return;
    screenRevision = view.screenRevision;
    graphics.resetScreen(columns(), rows());
    selection.clear(); transcript.clear(); renderer.clear(); header = false;
    editor.previewStart = undefined; editor.previewTotal = 0; editor.previewAnchor = undefined;
  };

  const redraw = (): void => {
    timer = undefined;
    if (closed) return;
    if (output.writableNeedDrain) { waitingForDrain = true; return; }
    waitingForDrain = false;
    try {
      if (recoveryPending) {
        recoveryPending = false;
        graphics.resetScreen(columns(), rows());
        renderer.invalidate();
      }
      if (resizePending) {
        resizePending = false;
        graphics.resize();
      }
      consumeScreenClear();
      if (view.approval !== lastApproval) { editor.approvalPage = 0; editor.approvalSelection = 0; lastApproval = view.approval; }
      if (header) { transcript.append(Header(title, view.model, view.cwd || process.cwd(), columns(), theme)); header = false; }
      transcript.append(Messages(view.takeCompleted(), columns(), theme));
      const frame = App(view, editor, columns(), rows(), theme, details, Date.now(), transcript, graphics.view);
      while (frame.length < rows()) frame.push('');
      selection.update(frame, columns(), view.approval || view.picker ? undefined : transcript.selectionViewport);
      const viewport = transcript.selectionViewport;
      scrollbar.update(columns(), mouseTracking && !view.approval && !view.picker && viewport ? editor.contentRows : 0,
        viewport?.lines.length ?? 0, viewport?.height ?? 0, viewport?.start ?? 0);
      syncDragScroll();
      const placement = selection.active ? undefined : graphics.view?.placement;
      if (graphics.prepare(placement, columns(), rows())) renderer.invalidate();
      renderer.render(transcript.takePublished(), scrollbar.overlay(selection.overlay(), theme), output.columns || 80, rows(), editor.contentRows, editor.caret);
      graphics.paint(placement);
    } catch (error: unknown) {
      selection.clear();
      scrollbar.cancel();
      stopDragScroll();
      // Rendering is model-driven. Keep the terminal alive with a bounded
      // diagnostic instead of letting a timer callback throw out of the process.
      try {
        if (graphics.clear(columns(), rows())) renderer.invalidate();
        const message = `Render error: ${error instanceof Error ? error.message : String(error)} · Ctrl+C exit`;
        renderer.render([], [truncate(theme.paint('error', plain(message)), columns())], output.columns || 80, rows());
      } catch {
        // The next close() still owns terminal restoration.
      }
    }
  };
  const schedule = (): void => { if (!closed && timer === undefined) timer = setTimeout(redraw, 25); };
  // Paste protocols carry text only. Reading the OS clipboard is the part of
  // image paste that Codex and Claude Code implement in-process, not in the terminal.
  const clipboardReader = options.readClipboardImage ?? (() => readSystemClipboard({ limits: editor.imageLimits }));
  const pasteClipboardImage = (): void | Promise<void> => {
    if (closed || editor.clipboardRead || editor.droppedRead || editor.submitting) return;
    const slot = editor.insertPendingImage('Clipboard image');
    const read = Symbol('clipboard-read');
    editor.clipboardRead = read;
    editor.notify('Reading clipboard image…', null);
    return Promise.resolve().then(() => clipboardReader()).then(image => {
      if (closed || editor.clipboardRead !== read) return;
      if (!image) {
        editor.failPendingImage(slot, '');
        editor.notify('No image on clipboard · drag an image file or paste its path');
        return;
      }
      if (!editor.resolvePendingImage(slot, [image])) editor.clearNotice();
      schedule();
    }).catch((error: unknown) => {
      if (!closed && editor.clipboardRead === read) {
        editor.failPendingImage(slot, '');
        editor.notify(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (editor.clipboardRead === read) { editor.clipboardRead = undefined; schedule(); }
    });
  };
  let capabilities = graphicsCapabilities.get(output);
  if (!capabilities) { capabilities = {}; graphicsCapabilities.set(output, capabilities); }
  const graphics = new TerminalGraphics(write, schedule, undefined, undefined, capabilities);
  const recoverScreen = (measure = false): void => {
    if (closed) return;
    // VS Code can recreate its display while hidden, or coalesce a resize
    // round trip back to the original dimensions. Cached rows/images are then
    // insufficient: repaint even when the model and final size are unchanged.
    recoveryPending = true;
    if (measure) resizePending = true;
    selection.clear(); scrollbar.cancel(); stopDragScroll();
    schedule();
  };
  const onResize = (): void => recoverScreen(true);
  const onDrain = (): void => { if (waitingForDrain) schedule(); };

  const stopDragScroll = (): void => {
    if (dragTick !== undefined) { clearInterval(dragTick); dragTick = undefined; }
  };
  const scrollSelection = (direction: number): boolean => {
    const viewport = transcript.selectionViewport;
    if (!selection.reviewing || !viewport) return false;
    const last = Math.max(0, editor.previewTotal - editor.previewLines);
    const next = Math.max(0, Math.min(last, viewport.start + direction * 2));
    if (next === viewport.start) return false;
    // Conversation history follows the bottom; welcome output follows the top.
    editor.previewStart = view.showWelcome && next === 0 ? undefined : next;
    redraw();
    return true;
  };
  const syncDragScroll = (): void => {
    if (!selection.scrollDirection) { stopDragScroll(); return; }
    if (dragTick !== undefined) return;
    dragTick = setInterval(() => {
      if (timer !== undefined) { clearTimeout(timer); redraw(); }
      if (!scrollSelection(selection.scrollDirection)) stopDragScroll();
    }, 80);
    dragTick.unref();
  };

  const handleKey = createInputHandler(view, editor, actions, schedule, () => { details = !details; }, pasteClipboardImage,
    undefined, () => !closed);
  // Pasted keys must never copy or trigger selection shortcuts.
  let pasting = false;
  const onKey = (text: string | undefined, key: Key = {}): void => {
    if (!pasting && selection.active && (key.name === 'escape' || (key.ctrl && key.name === 'c'))) {
      if (key.ctrl && key.name === 'c') {
        // Flush pending model changes before copying so stale coordinates are refused.
        if (timer !== undefined) { clearTimeout(timer); redraw(); }
        const text = selection.text(); if (text) copy(text);
      }
      selection.clear(); stopDragScroll(); schedule();
      return;
    }
    if (key.name === 'paste-start') pasting = true;
    if (key.name === 'paste-end') pasting = false;
    selection.clear();
    scrollbar.cancel();
    stopDragScroll();
    handleKey(text, key);
  };
  const seekPreview = (start: number, last: number): void => {
    editor.previewStart = (view.showWelcome ? start === 0 : start >= last) ? undefined : start;
  };
  const handleMouseReport = (report: MouseReport, repaint: boolean): void => {
    if (scrollbar.pointer(report, seekPreview)) {
      selection.clear(); stopDragScroll();
      if (repaint) redraw(); else schedule();
      return;
    }
    const text = selection.pointer(report);
    if (selection.reviewing && transcript.selectionViewport) editor.previewStart = transcript.selectionViewport.start;
    syncDragScroll();
    if (repaint) {
      const placement = selection.active ? undefined : graphics.view?.placement;
      if (graphics.prepare(placement, columns(), rows())) renderer.invalidate();
      renderer.render([], scrollbar.overlay(selection.overlay(), theme), output.columns || 80, rows(), editor.contentRows, editor.caret);
      graphics.paint(placement);
    } else schedule();
    if (text) copy(text);
  };
  const mouse = mouseInput(text => { keys.write(text); }, direction => {
    if (!mouseTracking) return;
    scrollbar.cancel();
    if (selection.reviewing) {
      if (timer !== undefined) { clearTimeout(timer); redraw(); }
      scrollSelection(direction); return;
    }
    selection.clear();
    if (view.approval) editor.approvalPage += direction;
    else if (view.picker) movePicker(view.picker, direction);
    else {
      editor.scrollPreview(direction, 3, view.showWelcome);
    }
    schedule();
  }, report => {
    if (!mouseTracking || closed) return;
    if (output.writableNeedDrain) {
      waitingForDrain = true;
      // Coalesce frames without dropping gesture state: a release still has
      // to clear selection and scrollbar drags while the terminal is blocked.
      handleMouseReport(report, false);
      return;
    }
    // Incorporate queued changes before interpreting coordinates or committing a copy.
    if (timer !== undefined) { clearTimeout(timer); redraw(); }
    handleMouseReport(report, true);
  }, response => graphics.response(response), recoverScreen);
  const onData = (chunk: Buffer | string): void => mouse.write(chunk);

  // Last-resort terminal restoration for signals and uncaught failures. The
  // normal close() can be skipped when Node exits, so this path uses a
  // synchronous write and resets raw mode without waiting for stream flushes.
  const restoreTerminalSync = (): void => {
    // writeSync cannot guarantee a full write while fd 1 is still O_NONBLOCK.
    try { releaseOutput?.block(); } catch { /* best effort */ }
    try { graphics.dispose(columns(), rows()); } catch { /* best effort */ }
    try { if (rawTouched) input.setRawMode(wasRaw); } catch { /* stream may be gone */ }
    const sequence = '\x1b[?1049l\x1b[r\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l';
    try {
      const fd = (output as { fd?: number }).fd;
      if (typeof fd === 'number' && fd >= 0 && writeAllSync(fd, sequence)) return;
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
      // close() restores the console patch first, but use a blocking write so
      // the diagnostic is not lost when process.exit follows immediately.
      try { if (!writeAllSync(2, message)) process.stderr.write(message); }
      catch { try { process.stderr.write(message); } catch { /* stderr may be gone */ } }
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
    // Fatal shutdown needs synchronous writes; keep interactive writes
    // nonblocking only while the UI is live.
    if (emergency) { try { releaseOutput?.block(); } catch { /* best effort */ } }
    editor.cancelImageReads();
    if (timer !== undefined) clearTimeout(timer);
    if (tick !== undefined) clearInterval(tick);
    stopDragScroll();
    try { unsubscribe?.(); } catch { /* disposers are best-effort during shutdown */ }
    if (listening) {
      try { input.off('keypress', onKey); } catch { /* stream may be gone */ }
      try { input.off('data', onData); } catch { /* stream may be gone */ }
      try { keys.off('keypress', onKey); } catch { /* stream may be gone */ }
      try { output.off('resize', onResize); } catch { /* stream may be gone */ }
      try { output.off('drain', onDrain); } catch { /* stream may be gone */ }
    }
    try { mouse.close(); } catch { /* timer may already be gone */ }
    try { graphics.dispose(columns(), rows()); } catch { /* terminal may be gone */ }
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
      try { write((renderedClose ? '' : '\x1b[?1049l\x1b[r') + '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l'); } catch { /* best effort */ }
      try { write('\x1b[?25h\x1b[0m'); } catch { /* best effort */ }
      try { if (rawTouched) input.setRawMode(wasRaw); } catch { /* stream may be gone */ }
      try { if (resumed && !wasFlowing) input.pause(); } catch { /* stream may be gone */ }
      try { releaseOutput?.(); } catch { /* output may be gone */ }
      // Keep signal handlers until the terminal is actually restored, so an
      // exception inside close() still leaves the exit fallback installed.
      // During a fatal signal finish() removes them after exit, otherwise Node
      // can apply the signal's default action as soon as the last listener goes.
      if (!finishing) removeGuards();
    }
  };

  try {
    releaseOutput = useNonBlockingOutput(output);
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
    // Button-event tracking reports dragging as well as wheel events.
    pasteEnabled = true;
    write('\x1b[?2004h\x1b[?1004h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l');
    if (mouseTracking) write('\x1b[?1002h\x1b[?1006h');
    input.on('keypress', onKey); listening = true;
    keys.on('keypress', onKey); input.on('data', onData);
    output.on('resize', onResize);
    output.on('drain', onDrain);
    unsubscribe = view.subscribe(schedule);
    tick = setInterval(() => {
      if ((view.status === 'running' || view.pendingAdmissions || editor.clipboardRead || editor.droppedRead) && !view.approval) schedule();
    }, 100);
    tick.unref();
    redraw();
    if (view.showWelcome) graphics.start();
    const terminalClose = close as TerminalClose;
    terminalClose.flush = flushOutput;
    return terminalClose;
  } catch (error: unknown) {
    // openTerminal performs terminal side effects before the first render.
    // Undo them here so the caller's startup catch can report the real error
    // through the now-restored stderr instead of leaving the shell in raw mode.
    close();
    throw error;
  }
}
