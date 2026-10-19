#!/usr/bin/env node
import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { homedir, constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const profile = 'deepseek-harness-tui';

function run(entry, args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: 'inherit', env });
    // Keep the wrapper alive long enough to forward terminal signals when it
    // is targeted directly (for example `kill -TERM <pid>`). The child owns
    // restoring raw mode and terminal modes before it exits.
    const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const forward = signal => { try { child.kill(signal); } catch { /* child already exited */ } };
    for (const signal of forwarded) process.on(signal, forward);
    const detach = () => { for (const signal of forwarded) process.off(signal, forward); };
    child.once('error', error => { detach(); reject(error); });
    child.once('exit', (code, signal) => {
      detach();
      resolveRun(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(manifest.version);
    return 0;
  }
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`Usage: deepseek-harness-tui [--resume <session-id>] [--dump-config]

Start DeepSeek Harness with the ${profile} profile.
On first launch, register this installation using dsh plugin (requires pnpm).

  --resume <session-id>  Resume a saved conversation
  --dump-config         Print the composed Harness configuration
  -v, --version         Print the package version
  -h, --help            Show this help

Uses DSH_HOME when set, otherwise ~/.dsh.
Requires @deepseek-ai/dsh installed alongside this package.`);
    return 0;
  }
  let resume;
  let dump = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume' && resume === undefined && args[i + 1] && !args[i + 1].startsWith('-')) resume = args[++i];
    else if (args[i] === '--dump-config' && !dump) dump = true;
    else throw new Error(`Unknown or incomplete option: ${args[i]}. Run with --help for usage.`);
  }
  const require = createRequire(import.meta.url);
  let cliPath;
  try { cliPath = require.resolve('@deepseek-ai/dsh/package.json'); }
  catch { throw new Error(`Install the CLI alongside this package: npm install -g @deepseek-ai/dsh ${manifest.name}`); }
  const cli = JSON.parse(await readFile(cliPath, 'utf8'));
  const binary = typeof cli.bin === 'string' ? cli.bin : cli.bin?.dsh;
  if (typeof binary !== 'string' || !binary) throw new Error('Incompatible Harness CLI: the dsh executable entry is missing.');
  const entry = resolve(dirname(cliPath), binary);
  if (!(await stat(entry).catch(() => undefined))?.isFile()) throw new Error('Harness CLI executable is missing. Reinstall @deepseek-ai/dsh.');
  const configuredHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const home = resolve(configuredHome === '~' ? homedir() : configuredHome.startsWith('~/') ? join(homedir(), configuredHome.slice(2)) : configuredHome);
  const env = { ...process.env, DSH_HOME: home };
  const profileDir = join(home, 'profiles', profile);
  let registered = false;
  try {
    const configured = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'));
    registered = configured.dsh?.profile?.bundles?.includes(manifest.name)
      && await realpath(join(profileDir, 'node_modules', manifest.name)) === await realpath(root);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!registered) {
    console.error(`Registering ${manifest.name} in the ${profile} profile...`);
    const code = await run(entry, ['plugin', '--profile', profile, 'add', `link:${root}`], env);
    if (code !== 0) return code;
  }
  // Do not inherit a resume target from a wrapping development launcher.
  delete env.DSH_TUI_RESUME_SESSION;
  if (resume) env.DSH_TUI_RESUME_SESSION = resume;
  return run(entry, ['--profile', profile, ...(dump ? ['--dump-config'] : [])], env);
}

try { process.exitCode = await main(); }
catch (error) { console.error(`deepseek-harness-tui: ${error.message}`); process.exitCode = 1; }
