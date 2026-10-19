import type { ViewModel } from '../model.js';
import { Composer, CommandMenu, type Editor } from './Composer.js';
import { Conversation, Messages } from './Conversation.js';
import type { Transcript } from './transcript.js';
import { StatusLines } from './StatusBar.js';
import { StatuslinePicker } from './StatuslinePicker.js';
import { Picker } from './Picker.js';
import type { Theme } from './theme.js';
import { plain, truncate, wrap } from './text.js';

export function Header(title: string, model: string, cwd: string, columns: number, theme: Theme): string[] {
  return ['', truncate(`  ${theme.paint('accent', '✦')} ${theme.paint('bold', plain(title))}`, columns),
    truncate(`    ${theme.paint('muted', `${plain(model)} · ${plain(cwd)}`)}`, columns),
    truncate(`    ${theme.paint('muted', '/help commands · /details tool output · Ctrl+C exit')}`, columns), ''];
}
export function App(view: ViewModel, editor: Editor, columns: number, rows: number, theme: Theme, details: boolean, now: number, transcript?: Transcript): string[] {
  const capacity = Math.max(1, rows - 1);
  if (columns < 16 || rows < 5) { editor.contentRows = 0; editor.caret = undefined; return [truncate(theme.paint('muted', 'Window too small · Ctrl+C exit'), columns)]; }
  const status = StatusLines(view, editor, columns, theme, now, rows >= 10 ? 2 : 1);
  if (view.approval) {
    editor.contentRows = 0; editor.caret = undefined;
    const prompt = view.approval;
    const body = [prompt.text, ...(prompt.cwd ? [`Directory: ${prompt.cwd}`] : []),
      ...(prompt.arguments ? ['Arguments:', prompt.arguments] : [])].join('\n');
    const description = wrap(body, Math.max(1, columns - 4));
    const approvalStatus = capacity >= 8 ? status : [];
    const available = Math.max(1, capacity - 3 - approvalStatus.length);
    const pages = Math.max(1, Math.ceil(description.length / available));
    editor.approvalPage = Math.max(0, Math.min(editor.approvalPage, pages - 1));
    const shown = description.slice(editor.approvalPage * available, (editor.approvalPage + 1) * available);
    return [truncate(theme.paint('warning', '  ◆ Permission needed'), columns), ...shown.map(line => `    ${line}`),
      ...Array<string>(Math.max(0, available - shown.length)).fill(''),
      truncate(columns >= 26 ? `  ${editor.approvalPage + 1}/${pages} · PgUp/PgDn details`
        : `PgUp/PgDn ${editor.approvalPage + 1}/${pages}`, columns),
      truncate(columns >= 38 ? '  y allow once · n reject · Esc cancel' : 'y yes n no Esc', columns), ...approvalStatus];
  }
  if (view.picker) {
    editor.contentRows = 0; editor.caret = undefined;
    return view.picker.statuslineDraft ? StatuslinePicker(view, columns, capacity, theme)
      : Picker(view.picker, columns, capacity, theme);
  }
  const composer = Composer(editor, columns, theme, Math.min(4, Math.max(1, capacity - 3 - status.length)));
  const menu = CommandMenu(editor, columns, theme);
  const rule = theme.paint('border', '─'.repeat(columns));
  const footer = [rule, ...composer, rule, ...status];
  const menuBudget = Math.max(0, capacity - footer.length);
  const visibleMenu = menu.slice(0, menuBudget);
  const previewBudget = Math.max(0, capacity - footer.length - visibleMenu.length);
  editor.contentRows = previewBudget;
  const active = view.active;
  if (!transcript && editor.previewAnchor !== active[0]?.id) { editor.previewStart = undefined; editor.previewAnchor = active[0]?.id; }
  const body = transcript ? transcript.frame(Messages(active, columns, theme, details), previewBudget, columns, theme, editor)
    : Conversation(active, columns, theme, details, previewBudget, editor);
  const frame = [...body, ...Array<string>(Math.max(0, previewBudget - body.length)).fill(''), ...visibleMenu, ...footer];
  if (editor.caret) editor.caret = { row: editor.caret.row + previewBudget + visibleMenu.length + 1, column: editor.caret.column };
  return frame;
}
