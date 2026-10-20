/** Input editing is independent of the renderer and never interprets pasted text as actions. */
import type { ViewModel } from '../model.js';
import type { Actions } from '../terminal.js';
import type { Editor } from './Composer.js';
import { graphemes, plain } from './text.js';
import { movePicker, pickerOptions } from './Picker.js';
export interface Key { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string }
export function createInputHandler(view: ViewModel, editor: Editor, actions: Actions, schedule: () => void, toggleDetails: () => void): (text: string | undefined, key?: Key) => void {
  let pasting = false; let pasted = '';
  return (text: string | undefined, key: Key = {}): void => {
    if (pasting && key.name !== 'paste-end') { pasted += text ?? ''; return; }
    if (key.ctrl && key.name === 'c') { actions.quit(); return; }
    if (key.name === 'paste-start') { pasting = true; pasted = ''; return; }
    if (key.name === 'paste-end') {
      pasting = false;
      if (view.picker && !view.approval) { if (!view.picker.statuslineDraft) view.picker.query += plain(pasted).replace(/\n/g, ' '); view.picker.selection = 0; view.picker.error = undefined; }
      else if (!view.approval) { editor.insert(pasted); editor.pastedLines = plain(pasted).split('\n').length; }
      pasted = ''; schedule(); return;
    }
    if (key.name === 'escape') {
      if (view.picker && !view.approval) view.picker.cancel();
      else { view.approval?.answer('cancelled'); actions.cancel(); }
      schedule(); return;
    }
    if (view.approval) {
      if (key.name === 'pageup' || key.name === 'pagedown') { editor.approvalPage += key.name === 'pageup' ? -1 : 1; schedule(); return; }
      if (text?.toLowerCase() === 'y') view.approval.answer('allowed-once');
      if (text?.toLowerCase() === 'n') view.approval.answer('rejected');
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
      if (view.status === 'idle' && !view.queued.length) view.clearScreen();
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
      // Enter submits exactly what was typed. Rewriting a command prefix here
      // would turn a path such as `/mode` into `/model`; Tab owns completion.
      const value = editor.submit();
      if (value) { editor.previewStart = undefined; actions.submit(value); }
    } else if (key.name === 'backspace') { if (editor.cursor > 0) editor.buffer.splice(--editor.cursor, 1); }
    else if (key.name === 'delete') editor.buffer.splice(editor.cursor, 1);
    else if (key.name === 'left' || (key.meta && key.name === 'b')) editor.cursor = key.meta || key.ctrl ? editor.wordBoundary(-1) : Math.max(0, editor.cursor - 1);
    else if (key.name === 'right' || (key.meta && key.name === 'f')) editor.cursor = key.meta || key.ctrl ? editor.wordBoundary(1) : Math.min(editor.buffer.length, editor.cursor + 1);
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) editor.cursor = editor.lineBoundary(false);
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) editor.cursor = editor.lineBoundary(true);
    else if (key.ctrl && key.name === 'w') { const start = editor.wordBoundary(-1); editor.buffer.splice(start, editor.cursor - start); editor.cursor = start; }
    else if (key.ctrl && key.name === 'k') editor.buffer.splice(editor.cursor, editor.lineBoundary(true) - editor.cursor);
    else if (key.ctrl && key.name === 'u') editor.replace('');
    else if (key.ctrl && key.name === 'd' && !editor.text) { actions.quit(); return; }
    else if (key.name === 'up' || key.name === 'down') {
      const direction = key.name === 'up' ? -1 : 1;
      if (editor.suggestions.length) editor.selection = (editor.selection + direction + editor.suggestions.length) % editor.suggestions.length;
      else if (editor.text.includes('\n') && !key.meta) editor.moveLine(direction);
      else editor.recall(direction);
    } else if (text && !key.ctrl && !key.meta) editor.insert(text);
    schedule();
  };
}
