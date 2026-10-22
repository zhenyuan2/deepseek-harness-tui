/** Input editing is independent of the renderer and never interprets pasted text as actions. */
import type { ViewModel } from '../model.js';
import type { Actions, SubmitOutcome } from '../terminal.js';
import type { Editor } from './Composer.js';
import { graphemes, plain } from './text.js';
import { movePicker, pickerOptions } from './Picker.js';
import { imagePathCandidatesFromPaste, imagesFromPastedText, validateImages } from './clipboard-image.js';
import { isCommand } from './commands.js';
export interface Key { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string }
export function createInputHandler(view: ViewModel, editor: Editor, actions: Actions, schedule: () => void, toggleDetails: () => void,
  pasteImage?: () => void | Promise<void>, readImages: typeof imagesFromPastedText = imagesFromPastedText,
  isActive: () => boolean = () => true): (text: string | undefined, key?: Key) => void {
  let pasting = false; let pasted = ''; let discardPaste = false;
  let deferred: { text: string | undefined; key: Key }[] | undefined;
  let deferredPaste = false; let replaying = false;
  const discardDeferred = (): void => { deferred = undefined; deferredPaste = false; };
  const replay = (): void => {
    if (replaying) return;
    // Queued input may have been typed before an approval or picker opened.
    // It must never be dispatched into that modal decision surface.
    if (view.approval || view.picker) { discardDeferred(); return; }
    replaying = true;
    try {
      while (deferred?.length && !editor.submitting) {
        if (!isActive() || view.approval || view.picker) { discardDeferred(); break; }
        const next = deferred.shift()!;
        handle(next.text, next.key);
      }
      if (!editor.submitting && !deferred?.length) discardDeferred();
    } finally { replaying = false; }
  };
  const startPathRead = (value: string): void => {
    if (editor.droppedRead) {
      // One path read at a time; keep a second paste visible as ordinary text.
      editor.insert(value); editor.pastedLines = plain(value).split('\n').length; return;
    }
    const slot = editor.insertPendingImage(value);
    const read = new AbortController();
    editor.droppedRead = read;
    editor.notify('Checking pasted paths…', null);
    void Promise.resolve().then(() => readImages(value, process.platform, editor.imageLimits, read.signal, () => {
      if (editor.droppedRead === read && isActive()) editor.notify('Reading dropped images…', null);
    })).then(images => {
      if (editor.droppedRead !== read || !isActive()) return;
      if (images?.length) {
        if (!editor.resolvePendingImage(slot, images)) editor.clearNotice();
      } else {
        editor.failPendingImage(slot, value);
        editor.clearNotice();
      }
    }).catch((error: unknown) => {
      if (editor.droppedRead === read && isActive()) {
        editor.failPendingImage(slot, value);
        editor.notify(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (editor.droppedRead === read) { editor.droppedRead = undefined; schedule(); }
    });
  };
  const handle = (text: string | undefined, key: Key = {}): void => {
    if (!isActive()) return;
    if (replaying && (view.approval || view.picker)) { discardDeferred(); return; }
    if (!replaying && deferred && !view.approval && !view.picker) {
      // Preserve complete paste protocols so pasted control characters never
      // become actions when the queued input is replayed.
      const immediate = !deferredPaste && ((key.ctrl && key.name === 'c') || key.name === 'escape'
        || (key.ctrl && key.name === 'u' && !editor.submitting)
        || key.name === 'pageup' || key.name === 'pagedown' || key.name === 'f2');
      if (!immediate) {
        deferred.push({ text, key: { ...key } });
        if (key.name === 'paste-start') deferredPaste = true;
        if (key.name === 'paste-end') deferredPaste = false;
        schedule(); return;
      }
      if (key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'u'))) discardDeferred();
    }
    if (pasting && key.name !== 'paste-end') { pasted += text ?? ''; return; }
    if (key.ctrl && key.name === 'c') { actions.quit(); return; }
    if (key.name === 'paste-start') { pasting = true; pasted = ''; discardPaste = editor.submitting; return; }
    // Keep the exact graph of text and images until admission succeeds. Esc
    // may cancel admission; editing resumes once its result has settled.
    if (editor.submitting && key.name !== 'paste-end') {
      if (key.name === 'escape') actions.cancel();
      schedule(); return;
    }
    // Terminals cannot deliver clipboard images through bracketed paste. The
    // host reads the OS clipboard instead; Ctrl+V is free in raw mode while
    // Cmd+V remains the terminal's native text paste.
    if (pasteImage && (key.ctrl || key.meta) && key.name === 'v' && !key.shift && !view.approval && !view.picker) {
      const reading = pasteImage();
      if (reading) void reading.then(replay, replay);
      return;
    }
    if (key.name === 'paste-end') {
      pasting = false;
      const value = pasted; pasted = '';
      if (discardPaste || editor.submitting) { discardPaste = false; schedule(); return; }
      if (view.picker && !view.approval) { if (!view.picker.statuslineDraft) view.picker.query += plain(value).replace(/\n/g, ' '); view.picker.selection = 0; view.picker.error = undefined; }
      else if (!view.approval) {
        if (isCommand(value.trim()) || !imagePathCandidatesFromPaste(value)) {
          editor.insert(value); editor.pastedLines = plain(value).split('\n').length;
        } else startPathRead(value);
      }
      schedule(); return;
    }
    if (key.name === 'escape') {
      editor.cancelImageReads();
      // Reject this request and return control to the composer so the user can
      // say what to do instead. A second Esc then stops a still-running turn.
      if (view.approval) view.approval.answer('rejected');
      else if (view.picker) view.picker.cancel();
      else actions.cancel();
      schedule(); return;
    }
    if (view.approval) {
      if (key.name === 'pageup' || key.name === 'pagedown') { editor.approvalPage += key.name === 'pageup' ? -1 : 1; schedule(); return; }
      if (key.name === 'up' || key.name === 'down') {
        editor.approvalSelection = key.name === 'up' ? 0 : 1;
        schedule(); return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        view.approval.answer(editor.approvalSelection === 1 ? 'rejected' : 'allowed-once');
        return;
      }
      const choice = text?.toLowerCase();
      if (choice === '1' || choice === 'y') view.approval.answer('allowed-once');
      if (choice === '2' || choice === 'n') view.approval.answer('rejected');
      return;
    }
    if (view.picker) {
      const picker = view.picker;
      if (key.name === 'up' || key.name === 'down') movePicker(picker, key.name === 'up' ? -1 : 1);
      else if (key.name === 'pageup' || key.name === 'pagedown') movePicker(picker, (key.name === 'pageup' ? -1 : 1) * picker.pageSize);
      else if (key.name === 'left') picker.back?.();
      else if ((key.name === 'return' || key.name === 'enter') && !picker.loading) {
        if (picker.confirm) picker.confirm();
        else { const option = pickerOptions(picker)[picker.selection]; if (option && !option.disabled) option.choose(); }
      } else if (text === ' ' && picker.confirm && !picker.loading) {
        const option = pickerOptions(picker)[picker.selection]; if (option && !option.disabled) option.choose();
      } else if (picker.statuslineDraft) { /* Fixed checklist has no text input. */ }
      else if (key.name === 'backspace') { picker.query = graphemes(picker.query).slice(0, -1).join(''); picker.selection = 0; picker.error = undefined; }
      else if (key.ctrl && key.name === 'u') { picker.query = ''; picker.selection = 0; picker.error = undefined; }
      else if (text && !key.ctrl && !key.meta) { picker.query += plain(text); picker.selection = 0; picker.error = undefined; }
      schedule(); return;
    }
    if (key.ctrl && key.name === 'l') {
      if (view.status === 'idle' && !view.queued.length && !view.pendingAdmissions) view.clearScreen();
      schedule(); return;
    }
    if (key.name === 'f2') { toggleDetails(); schedule(); return; }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      editor.scrollPreview(key.name === 'pageup' ? -1 : 1, editor.previewLines, view.showWelcome);
      schedule(); return;
    }
    const enter = key.name === 'return' || key.name === 'enter';
    if ((enter && (key.meta || key.shift)) || (key.ctrl && key.name === 'j') || key.name === 'enter' || /^\x1b\[(?:13;2u|27;2;13~)$/.test(key.sequence ?? '')) {
      editor.insert('\n');
    } else if (key.name === 'tab' && editor.suggestions.length) {
      editor.replace(editor.suggestions[editor.selection % editor.suggestions.length]!.name + ' ');
    } else if (enter) {
      if (editor.droppedRead) {
        editor.notify('Reading dropped images · press Enter when ready', null);
        schedule(); return;
      }
      if (editor.clipboardRead) {
        editor.notify('Reading clipboard image · press Enter when ready', null);
        schedule(); return;
      }
      // Enter submits exactly what was typed. Rewriting a command prefix here
      // would turn a path such as `/mode` into `/model`; Tab owns completion.
      if (editor.attachments.length && isCommand(editor.text.trim())) {
        editor.notify('Remove attached images before sending a slash command.');
        schedule(); return;
      }
      const attachments = editor.submissionImages();
      if (attachments.length) {
        try { validateImages(attachments, editor.imageLimits); }
        catch (error) {
          editor.submit(); editor.previewStart = undefined;
          editor.notify(`${error instanceof Error ? error.message : String(error)} · ↑ recall`);
          schedule(); return;
        }
        editor.submitting = true;
        deferred ??= [];
        editor.clearNotice();
        const finish = (outcome: SubmitOutcome | void): void => {
          const accepted = typeof outcome === 'boolean' ? outcome : outcome ? outcome.accepted : true;
          const reason = typeof outcome === 'object' && outcome ? outcome.reason : undefined;
          editor.submitting = false;
          editor.submit(); editor.previewStart = undefined;
          if (!accepted) {
            editor.notify(reason === 'model-unsupported'
              ? 'Message not sent · /model first, then ↑ recall'
              : 'Message not sent · ↑ recall');
          }
          replay();
          schedule();
        };
        try {
          const result = actions.submit(editor.text.trim(), attachments);
          if (result) void result.then(finish, () => finish({ accepted: false, reason: 'failed' }));
          else finish(true); // Hosts without an asynchronous admission API.
        } catch { finish({ accepted: false, reason: 'failed' }); }
        schedule(); return;
      }
      const value = editor.submit();
      if (value || attachments.length) { editor.previewStart = undefined; actions.submit(value, attachments.length ? attachments : undefined); }
    } else if (key.name === 'backspace') {
      if (editor.cursor > 0) { editor.buffer.splice(--editor.cursor, 1); editor.clearFeedback(); }
    }
    else if (key.name === 'delete') { if (editor.buffer.splice(editor.cursor, 1).length) editor.clearFeedback(); }
    else if (key.name === 'left' || (key.meta && key.name === 'b')) editor.cursor = key.meta || key.ctrl ? editor.wordBoundary(-1) : Math.max(0, editor.cursor - 1);
    else if (key.name === 'right' || (key.meta && key.name === 'f')) editor.cursor = key.meta || key.ctrl ? editor.wordBoundary(1) : Math.min(editor.buffer.length, editor.cursor + 1);
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) editor.cursor = editor.lineBoundary(false);
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) editor.cursor = editor.lineBoundary(true);
    else if (key.ctrl && key.name === 'w') { const start = editor.wordBoundary(-1); if (editor.buffer.splice(start, editor.cursor - start).length) editor.clearFeedback(); editor.cursor = start; }
    else if (key.ctrl && key.name === 'k') { if (editor.buffer.splice(editor.cursor, editor.lineBoundary(true) - editor.cursor).length) editor.clearFeedback(); }
    else if (key.ctrl && key.name === 'u') { editor.replace(''); editor.clearAttachments(); }
    else if (key.ctrl && key.name === 'd' && !editor.buffer.length) { actions.quit(); return; }
    else if (key.name === 'up' || key.name === 'down') {
      const direction = key.name === 'up' ? -1 : 1;
      if (editor.suggestions.length) editor.selection = (editor.selection + direction + editor.suggestions.length) % editor.suggestions.length;
      else if (editor.text.includes('\n') && !key.meta) {
        // Recalled multiline input keeps normal vertical editing until the
        // cursor reaches the matching line boundary, then enters history.
        const atBoundary = direction < 0 ? editor.atFirstLine : editor.atLastLine;
        if (editor.browsingHistory && atBoundary) editor.recall(direction);
        else editor.moveLine(direction);
      }
      else editor.recall(direction);
    } else if (text && !key.ctrl && !key.meta) editor.insert(text);
    schedule();
  };
  return handle;
}
