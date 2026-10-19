import { spawn } from 'node:child_process';

/** OSC 52 reaches the user's terminal over SSH; native tools cover local terminals. */
export function copyText(text: string, write: (sequence: string) => unknown): void {
  const sequence = `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`;
  write(process.env.TMUX ? `\x1bPtmux;${sequence.replaceAll('\x1b', '\x1b\x1b')}\x1b\\` : sequence);
  // SSH_TTY can remain stale after a local tmux reattach.
  if (process.env.SSH_CONNECTION) return;
  const commands: [string, string[]][] = process.platform === 'darwin' ? [['pbcopy', []]]
    : process.platform === 'win32' ? [['clip.exe', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  const attempt = (index: number): void => {
    const command = commands[index]; if (!command) return;
    const child = spawn(command[0], command[1], { stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000 });
    let retried = false;
    const next = (): void => { if (!retried) { retried = true; attempt(index + 1); } };
    child.once('error', next);
    child.once('close', code => { if (code !== 0) next(); });
    child.stdin.on('error', () => { /* exit/error owns fallback */ });
    child.stdin.end(process.platform === 'win32' ? Buffer.from(text, 'utf16le') : text);
  };
  attempt(0);
}
