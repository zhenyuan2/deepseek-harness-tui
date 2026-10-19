/** One catalog drives completion and help. Execution remains in the Harness bridge. */
export const commands = [
  { name: '/help', usage: '/help', description: 'Keyboard shortcuts and commands' },
  { name: '/details', usage: '/details [id|from-to]', description: 'Print full tool output or thinking' },
  { name: '/new', usage: '/new', description: 'Start a fresh chat; keep terminal output' },
  { name: '/clear', usage: '/clear', description: 'Clear the terminal and start a fresh chat' },
  { name: '/session', usage: '/session', description: 'Show session ID and resume guidance' },
  { name: '/resume', usage: '/resume [session-id]', description: 'Browse and switch historical conversations' },
  { name: '/model', usage: '/model [provider/model] [effort]', description: 'Choose a model and reasoning depth' },
  { name: '/statusline', usage: '/statusline', description: 'Choose statusline fields and token statistics' },
  { name: '/quit', usage: '/quit', description: 'Exit' },
  { name: '/exit', usage: '/exit', description: 'Alias for /quit' },
];

const names = new Set(commands.map(command => command.name));

/**
 * A slash command is recognized only by an exact first token from the catalog.
 * Anything else is ordinary text: absolute paths such as `/Users/nick/a.ts`
 * must reach the model, not the unknown-command branch.
 */
export function isCommand(text: string): boolean {
  return names.has(text.split(/\s+/, 1)[0] ?? '');
}
