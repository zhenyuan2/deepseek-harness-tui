import type { ViewModel } from '../model.js';
import type { Theme } from './theme.js';
import { StatusFields } from './StatusBar.js';
import { plain, truncate } from './text.js';

/** A fixed checklist with a draft preview; the chat composer is suspended. */
export function StatuslinePicker(view: ViewModel, columns: number, height: number, theme: Theme): string[] {
  const picker = view.picker!;
  const fields = picker.statuslineDraft!;
  const detail = height >= 12;
  const preview = height >= 7;
  const overhead = 2 + (detail ? 1 : 0) + (preview ? 2 : 0) + (picker.error ? 1 : 0);
  picker.pageSize = Math.max(1, height - overhead);
  picker.selection = Math.max(0, Math.min(picker.selection, picker.options.length - 1));
  const start = Math.floor(picker.selection / picker.pageSize) * picker.pageSize;
  const lines = [theme.paint('bold', `  Configure statusline · ${picker.selection + 1}/${picker.options.length}`)];
  for (const [index, option] of picker.options.slice(start, start + picker.pageSize).entries()) {
    const selected = start + index === picker.selection;
    lines.push(theme.paint(selected ? 'accent' : 'muted', `  ${selected ? '›' : ' '} [${option.checked ? 'x' : ' '}] ${plain(option.label)}`));
  }
  if (detail) lines.push(theme.paint('muted', `  ${plain(picker.options[picker.selection]?.description ?? '')}`));
  if (picker.error) lines.push(theme.paint('error', `  Save failed: ${plain(picker.error)}`));
  if (preview) {
    lines.push(theme.paint('bold', '  Preview'));
    lines.push(fields.length ? StatusFields(view, fields, columns, theme) : theme.paint('muted', '  Activity only'));
  }
  const hint = picker.loading ? 'Saving…' : columns >= 54
    ? '↑↓ select · Space toggle · Enter save · Esc discard'
    : columns >= 40 ? '↑↓ · Space ✓ · Enter save · Esc back'
    : columns >= 28 ? '↑↓ Space · Enter ✓ · Esc ×' : 'Space Enter Esc';
  return [...lines.slice(0, height - 1), ...Array<string>(Math.max(0, height - 1 - lines.length)).fill(''), theme.paint('muted', `  ${hint}`)]
    .map(line => truncate(line, columns));
}
