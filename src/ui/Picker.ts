import type { PickerOption, PickerState } from '../model.js';
import type { Theme } from './theme.js';
import { plain, truncate, cellWidth } from './text.js';

export function pickerOptions(picker: PickerState): PickerOption[] {
  const query = plain(picker.query).toLocaleLowerCase().trim();
  return query ? picker.options.filter(option => `${option.label} ${option.id} ${option.description ?? ''}`.toLocaleLowerCase().includes(query)) : picker.options;
}

export function movePicker(picker: PickerState, direction: number): void {
  const size = pickerOptions(picker).length;
  picker.selection = Math.max(0, Math.min(Math.max(0, size - 1), picker.selection + direction));
}

/** Search owns keyboard focus; the composer is restored after dismissal. */
export function Picker(picker: PickerState, columns: number, height: number, theme: Theme): string[] {
  if (height <= 0) return [];
  const options = pickerOptions(picker);
  picker.selection = Math.min(picker.selection, Math.max(0, options.length - 1));
  const compact = height < 8;
  const overhead = (compact ? 3 : 5) + (picker.error ? 1 : 0);
  picker.pageSize = Math.max(1, Math.floor((height - overhead) / (compact ? 1 : 2)));
  const start = Math.floor(picker.selection / picker.pageSize) * picker.pageSize;
  const count = ` · ${options.length ? picker.selection + 1 : 0}/${options.length}`;
  const lines = [theme.paint('bold', `  ${truncate(plain(picker.title), Math.max(0, columns - 2 - cellWidth(count)))}${count}`)];
  if (!compact && picker.hint) lines.push(theme.paint('muted', `  ${plain(picker.hint)}`));
  lines.push(`  ${theme.paint('accent', 'Search ❯')} ${plain(picker.query)}`);
  if (picker.error) lines.push(theme.paint('error', `  ${plain(picker.error)}`));
  if (picker.loading) lines.push(theme.paint('muted', `  ${plain(picker.loadingText ?? 'Loading…')}`));
  else if (!options.length && !picker.error) lines.push(theme.paint('muted', '  No matches. Change the search or press Esc.'));
  else if (!picker.loading) for (const [index, option] of options.slice(start, start + picker.pageSize).entries()) {
    const selected = start + index === picker.selection;
    const tone = option.disabled ? 'muted' : selected ? 'accent' : 'bold';
    lines.push(theme.paint(tone, `  ${selected ? '›' : ' '} ${option.checked === undefined ? '' : option.checked ? '[x] ' : '[ ] '}${plain(option.label)}${option.current ? '  ● current' : ''}`));
    if (!compact) lines.push(theme.paint('muted', `    ${plain(option.description ?? option.id)}`));
  }
  const footer = theme.paint('muted', picker.saving ? '  Saving… please wait' : columns < 40 ? '  ↑↓ Enter ✓ Esc ×' : `  ↑/↓ select · ${picker.confirm ? 'Space toggle · Enter save' : 'Enter confirm'} · Esc cancel${picker.back ? ' · ← back' : ''}`);
  const body = lines.slice(0, Math.max(0, height - 1));
  return [...body, ...Array<string>(Math.max(0, height - 1 - body.length)).fill(''), footer].map(line => truncate(line, columns));
}
