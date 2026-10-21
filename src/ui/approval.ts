import { homedir } from 'node:os';
import type { ApprovalPrompt } from '../model.js';
import { fileDiff } from './diff.js';
import { plain, truncate, wrap } from './text.js';
import type { Theme } from './theme.js';

export type ApprovalTone = 'normal' | 'muted' | 'code' | 'add' | 'remove' | 'border' | 'warning';
export interface ApprovalLine { text: string; tone: ApprovalTone }
export interface ApprovalContent { heading: string; lines: ApprovalLine[] }

type Arguments = Record<string, unknown>;
type ToolKind = 'bash' | 'edit' | 'write' | 'read' | 'search' | 'fetch' | 'other';

function parseArguments(text: string | undefined): Arguments | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Arguments : undefined;
  } catch {
    return undefined;
  }
}

function textArgument(args: Arguments | undefined, keys: readonly string[], shown?: Set<string>): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) { shown?.add(key); return value; }
  }
  return undefined;
}

/** Like textArgument, but preserves an intentional empty replacement string. */
function rawTextArgument(args: Arguments | undefined, keys: readonly string[], shown: Set<string>): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string') { shown.add(key); return value; }
  }
  return undefined;
}

function numberArgument(args: Arguments | undefined, key: string): number | undefined {
  const value = args?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toolKind(name: string): ToolKind {
  const key = name.toLowerCase().replace(/[\s-]+/g, '_');
  if (['bash', 'shell', 'run_command', 'exec', 'terminal', 'pwsh', 'powershell'].includes(key)) return 'bash';
  if (['edit', 'edit_file', 'str_replace_editor', 'replace_in_file', 'apply_patch'].includes(key)) return 'edit';
  if (['write', 'write_file', 'create_file', 'new_file'].includes(key)) return 'write';
  if (['read', 'read_file', 'view_file'].includes(key)) return 'read';
  if (['grep', 'search', 'search_files', 'find_files', 'glob'].includes(key)) return 'search';
  if (['web_fetch', 'webfetch', 'fetch', 'fetch_url'].includes(key)) return 'fetch';
  return 'other';
}

function headingFor(name: string): string {
  const kind = toolKind(name);
  if (kind === 'bash') return 'Bash command';
  if (kind === 'edit') return 'Edit file';
  if (kind === 'write') return 'Write file';
  if (kind === 'read') return 'Read file';
  if (kind === 'search') return 'Search files';
  if (kind === 'fetch') return 'Fetch URL';
  if (name.toLowerCase().replace(/[\s-]+/g, '_') === 'web_search') return 'Web search';
  if (name.startsWith('mcp__')) {
    const [, server, ...tool] = name.split('__');
    return `${server ?? 'MCP'} · ${tool.join('__') || 'tool'}`;
  }
  return name ? `Use ${name}` : 'Tool action';
}

/** Separate the requester's explanation from the technical permission scope. */
function approvalReason(text: string): { reason: string; permissions?: string } {
  const reason = plain(text).trim();
  const escalation = /^escalate sandbox to ([^:\n]+):\s*([\s\S]*)$/i.exec(reason)
    ?? /^Allow this operation with (.+?) permissions(?::\s*([\s\S]*))?$/i.exec(reason);
  return escalation ? { reason: escalation[2]?.trim() ?? '', permissions: escalation[1]!.trim() } : { reason };
}

function displayPath(path: string): string {
  const home = homedir();
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function targetFor(kind: ToolKind, args: Arguments | undefined, shown: Set<string>): string | undefined {
  const text = (keys: readonly string[]): string | undefined => textArgument(args, keys, shown);
  switch (kind) {
    case 'bash': return text(['command', 'cmd', 'script']);
    case 'edit':
    case 'write': return text(['file_path', 'filePath', 'path']);
    case 'read': return text(['file_path', 'filePath', 'path']);
    case 'search': {
      const pattern = text(['pattern', 'query', 'glob']);
      if (!pattern) return undefined;
      const path = text(['path', 'directory']);
      return path ? `${pattern} in ${path}` : pattern;
    }
    case 'fetch': return text(['url', 'uri']);
    default: return text(['command', 'file_path', 'filePath', 'path', 'pattern', 'query', 'url', 'prompt', 'description']);
  }
}

function diffLines(args: Arguments | undefined, path: string | undefined, shown: Set<string>): ApprovalLine[] {
  if (!args) return [];
  const diffKeys = new Set<string>();
  const oldText = rawTextArgument(args, ['old_string', 'old_str', 'oldText'], diffKeys);
  const newText = rawTextArgument(args, ['new_string', 'new_str', 'newText', 'content'], diffKeys);
  if (newText === undefined) return [];
  const preview = fileDiff({ path: path ?? 'file', oldText: oldText ?? '', newText });
  if (preview.unavailable) return [{ text: 'Diff preview unavailable', tone: 'muted' }];
  for (const key of diffKeys) shown.add(key);
  const lines: ApprovalLine[] = [{ text: `+${preview.added} −${preview.removed}`, tone: 'muted' }];
  for (const line of preview.lines) {
    if (line.text.startsWith('\\ No newline')) continue;
    const tone: ApprovalTone = line.text.startsWith('+') ? 'add'
      : line.text.startsWith('-') ? 'remove'
      : line.text.startsWith('@') ? 'muted' : 'normal';
    lines.push({ text: line.text, tone });
  }
  return lines;
}

function argumentLines(args: Arguments | undefined, shown: Set<string>): ApprovalLine[] {
  if (!args) return [];
  const rest = Object.fromEntries(Object.entries(args).filter(([key]) => !shown.has(key)));
  if (!Object.keys(rest).length) return [];
  const text = JSON.stringify(rest, null, 2).split('\n');
  return text.map(line => ({ text: line, tone: 'code' }));
}

/**
 * Project one pending request into a compact, tool-aware description. Raw
 * parameters not represented by the summary or diff remain available below it.
 */
export function approvalContent(prompt: ApprovalPrompt, width: number): ApprovalContent {
  const name = prompt.toolName ?? '';
  const kind = toolKind(name);
  const args = parseArguments(prompt.arguments);
  const heading = headingFor(name);
  const shown = new Set<string>();
  const target = targetFor(kind, args, shown);
  const lines: ApprovalLine[] = [];
  const fileTarget = ['edit', 'write', 'read'].includes(kind);

  if (target) lines.push({ text: kind === 'bash' ? `$ ${target}` : fileTarget ? displayPath(target) : target, tone: 'code' });
  else if (!args && prompt.arguments) lines.push({ text: prompt.arguments, tone: 'code' });

  const diff = kind === 'edit' || kind === 'write' ? diffLines(args, target, shown) : [];
  if (diff.length) {
    const rule: ApprovalLine = { text: '─'.repeat(Math.max(1, width)), tone: 'border' };
    lines.push({ text: '', tone: 'normal' }, rule, ...diff, rule, { text: '', tone: 'normal' });
  }

  const { reason, permissions } = approvalReason(prompt.text);
  if (permissions) lines.push({ text: 'Additional permissions required', tone: 'warning' });
  if (reason && reason !== target) lines.push({ text: reason, tone: 'normal' });
  const description = textArgument(args, ['description', 'summary'], shown);
  if (description && description !== reason && description !== target) lines.push({ text: description, tone: 'normal' });

  // Absolute file targets already identify their location; relative paths and
  // commands still need the working directory to be interpreted correctly.
  if (prompt.cwd && ['bash', 'edit', 'write', 'read', 'search'].includes(kind)
    && !(fileTarget && target?.startsWith('/'))) {
    lines.push({ text: `in ${displayPath(prompt.cwd)}`, tone: 'muted' });
  }
  if (kind === 'read') {
    const offset = numberArgument(args, 'offset');
    const limit = numberArgument(args, 'limit');
    if (offset !== undefined) shown.add('offset');
    if (limit !== undefined) shown.add('limit');
    const range = [offset === undefined ? '' : `from line ${offset}`, limit === undefined ? '' : `${limit} lines`].filter(Boolean).join(', ');
    if (range) lines.push({ text: range, tone: 'muted' });
  }

  const details = argumentLines(args, shown);
  if (details.length) {
    if (lines.length) lines.push({ text: '', tone: 'normal' });
    lines.push(...details);
  }
  if (permissions) lines.push({ text: `Permissions: ${permissions}`, tone: 'muted' });

  return {
    heading,
    lines: lines.flatMap(line => wrap(line.text, Math.max(1, width)).map(text => ({ text, tone: line.tone }))),
  };
}

function paintedLine(line: ApprovalLine, theme: Theme): string {
  if (!line.text) return '';
  if (line.tone === 'normal') return `  ${line.text}`;
  const tone = line.tone === 'add' ? 'success' : line.tone === 'remove' ? 'error' : line.tone;
  return `  ${theme.paint(tone, line.text)}`;
}

function approvalOptions(columns: number, selected: number, compact: boolean, theme: Theme): string[] {
  const yes = compact ? columns < 22 ? '1. Allow' : '1. Allow once' : columns < 24 ? '1. Allow once' : '1. Yes, allow once';
  const no = compact || columns < 38 ? '2. No (Esc)' : '2. No';
  const row = (index: number, label: string): string => truncate(
    `  ${index === selected ? theme.paint('accent', '❯') : ' '} ${theme.paint(index === selected ? 'bold' : 'muted', label)}`,
    columns,
  );
  return [row(0, yes), row(1, no)];
}

function approvalHint(page: number, pages: number, columns: number): string {
  const pager = pages > 1 ? `PgUp/PgDn ${page + 1}/${pages} · ` : '';
  if (columns >= 70) return `  ${pager}↑/↓ select · Enter confirm · Esc reject`;
  if (columns >= 38) return `  ${pager}↑/↓ · Enter · Esc`;
  if (pages > 1) return `  PgUp/PgDn ${page + 1}/${pages}`;
  return '  ↑/↓ · Enter';
}

function approvalQuestion(prompt: ApprovalPrompt): string {
  const kind = toolKind(prompt.toolName ?? '');
  if (kind === 'edit') return 'Do you want to make this edit?';
  if (kind === 'write') return 'Do you want to write this file?';
  if (kind === 'bash') return 'Do you want to run this command?';
  return 'Do you want to proceed?';
}

export interface ApprovalFrame { lines: string[]; page: number; selection: number }

/**
 * Compose the approval takeover. Normal terminals keep the question and
 * numbered choices visible while details page; very short windows fall back to
 * a compact layout that still exposes paging and the reject shortcut.
 */
export function ApprovalFrame(prompt: ApprovalPrompt, columns: number, capacity: number,
  theme: Theme, status: readonly string[], page: number, selection: number): ApprovalFrame {
  const selected = selection === 1 ? 1 : 0;
  const content = approvalContent(prompt, Math.max(1, Math.min(96, columns - 2)));
  const statusLines = capacity >= 8 ? [...status] : [];
  const fixed = 7 + statusLines.length;
  const available = capacity - fixed;

  if (available >= 1) {
    const pages = Math.max(1, Math.ceil(content.lines.length / available));
    const current = Math.max(0, Math.min(page, pages - 1));
    const shown = content.lines.slice(current * available, (current + 1) * available);
    const lines = [
      truncate(theme.paint('bold', `  ${plain(content.heading)}`), columns),
      '',
      ...shown.map(line => paintedLine(line, theme)),
      '',
      truncate(theme.paint('bold', `  ${approvalQuestion(prompt)}`), columns),
      ...approvalOptions(columns, selected, false, theme),
      truncate(theme.paint('muted', approvalHint(current, pages, columns)), columns),
    ];
    if (statusLines.length) {
      lines.push(...Array<string>(Math.max(0, capacity - lines.length - statusLines.length)).fill(''), ...statusLines);
    }
    return {
      page: current,
      selection: selected,
      lines,
    };
  }

  const compactAvailable = Math.max(1, capacity - 3);
  const pages = Math.max(1, Math.ceil(content.lines.length / compactAvailable));
  const current = Math.max(0, Math.min(page, pages - 1));
  const shown = content.lines.slice(current * compactAvailable, (current + 1) * compactAvailable);
  const meta = pages > 1 ? `PgUp/PgDn ${current + 1}/${pages}` : plain(content.heading);
  return {
    page: current,
    selection: selected,
    lines: [
      truncate(theme.paint('warning', `  ${meta}`), columns),
      ...shown.map(line => paintedLine(line, theme)),
      ...approvalOptions(columns, selected, true, theme),
    ],
  };
}
