import type { ViewModel } from '../model.js';
import { Composer, CommandMenu, type Editor } from './Composer.js';
import { Conversation, Messages } from './Conversation.js';
import type { Transcript } from './transcript.js';
import { StatusLines } from './StatusBar.js';
import { StatuslinePicker } from './StatuslinePicker.js';
import { Picker } from './Picker.js';
import type { Theme } from './theme.js';
import { plain, truncate } from './text.js';
import { ApprovalFrame } from './approval.js';
import { WelcomePanel } from './Welcome.js';
import type { WelcomeImageView } from './terminal-image.js';

export function Header(title: string, model: string, cwd: string, columns: number, theme: Theme): string[] {
  return [truncate(`  ${theme.paint('accent', '✦')} ${theme.paint('bold', plain(title))}`, columns),
    truncate(`    ${theme.paint('muted', `${plain(model)} · ${plain(cwd)}`)}`, columns)];
}
export function App(view: ViewModel, editor: Editor, columns: number, rows: number, theme: Theme, details: boolean, now: number, transcript?: Transcript, image?: WelcomeImageView): string[] {
  if (image) { image.crop = undefined; image.placement = undefined; }
  const capacity = Math.max(1, rows - 1);
  if (columns < 16 || rows < 5) { editor.contentRows = 0; editor.caret = undefined; return [truncate(theme.paint('muted', 'Window too small · Ctrl+C exit'), columns)]; }
  const welcome = view.showWelcome;
  if (editor.welcome !== welcome) { editor.previewStart = undefined; editor.welcome = welcome; }
  const status = StatusLines(view, editor, columns, theme, now, welcome ? 1 : rows >= 10 ? 2 : 1);
  if (view.approval) {
    editor.contentRows = 0; editor.caret = undefined;
    const approval = ApprovalFrame(view.approval, columns, capacity, theme, status,
      editor.approvalPage, editor.approvalSelection);
    editor.approvalPage = approval.page;
    editor.approvalSelection = approval.selection;
    return approval.lines;
  }
  if (view.picker) {
    editor.contentRows = 0; editor.caret = undefined;
    return view.picker.statuslineDraft ? StatuslinePicker(view, columns, capacity, theme)
      : Picker(view.picker, columns, capacity, theme);
  }
  const composer = Composer(editor, columns, theme, Math.min(4, Math.max(1, capacity - 3 - status.length)));
  const menu = CommandMenu(editor, columns, theme);
  const rule = theme.paint('border', '─'.repeat(columns));
  const footer = welcome ? [...composer, ...status] : [rule, ...composer, rule, ...status];
  const menuBudget = Math.max(0, capacity - footer.length);
  const visibleMenu = menu.slice(0, menuBudget);
  const previewBudget = Math.max(0, capacity - footer.length - visibleMenu.length);
  editor.contentRows = previewBudget;
  const active = view.active;
  if (!transcript && editor.previewAnchor !== active[0]?.id) { editor.previewStart = undefined; editor.previewAnchor = active[0]?.id; }
  let body: string[];
  if (welcome) {
    const notices = Messages(view.rows, columns, theme, details);
    if (transcript && notices.length > previewBudget) {
      // Only take over the viewport when the panel would otherwise cut off
      // system output; the transcript provides paging, selection, and export.
      body = transcript.frame([], previewBudget, columns, theme, editor, true);
    } else {
      const shown = notices.slice(0, previewBudget);
      const panel = WelcomePanel(columns, previewBudget - shown.length, theme, view, image);
      body = [...panel, ...shown];
      editor.previewStart = undefined;
      editor.previewTotal = body.length;
      editor.previewLines = previewBudget;
      if (transcript) transcript.selectionViewport = undefined;
    }
  } else {
    body = transcript ? transcript.frame(Messages(active, columns, theme, details), previewBudget, columns, theme, editor)
      : Conversation(active, columns, theme, details, previewBudget, editor);
  }
  const frame = [...Array<string>(Math.max(0, previewBudget - body.length)).fill(''), ...body, ...visibleMenu, ...footer];
  if (editor.caret) editor.caret = { row: editor.caret.row + previewBudget + visibleMenu.length + (welcome ? 0 : 1), column: editor.caret.column };
  return frame;
}
