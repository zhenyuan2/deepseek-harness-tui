// Launch source builds through the Harness checkout's standard CLI.
import { readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { harnessPeers, checkPeerArtifacts } from './harness.mjs';
import { profileName } from './profiles.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!existsSync(join(root, '.local.json')) || !existsSync(join(root, 'dist/index.js'))) {
  console.error('Run npm run setup and npm run build first.');
  process.exit(1);
}
const { harness } = JSON.parse(await readFile(join(root, '.local.json'), 'utf8'));
try {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const peers = await harnessPeers(harness, manifest.peerDependencies);
  await checkPeerArtifacts(peers);
  for (const pkg of peers) {
    if (await realpath(join(root, 'node_modules', pkg.manifest.name)) !== await realpath(pkg.directory)) {
      throw new Error(`${pkg.manifest.name}: dependency does not point to this Harness checkout. Run npm run setup first.`);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const args = process.argv.slice(2);
const profile = profileName;
if (!existsSync(join(root, '.dsh-home/profiles', profile, 'package.json'))) {
  console.error('Run npm run setup first to create the profile or migrate the legacy profile name.');
  process.exit(1);
}
let resumeSessionId;
const resumeIndex = args.indexOf('--resume');
if (resumeIndex !== -1) {
  resumeSessionId = args[resumeIndex + 1];
  if (!resumeSessionId || resumeSessionId.startsWith('-')) {
    console.error('Usage: npm start -- --resume <session-id> (requires persistent Harness sessions)');
    process.exit(1);
  }
  args.splice(resumeIndex, 2);
}
if (!args.includes('--dump-config') && !args.includes('--dump-default-config')) {
  // The checkout's YAML can be newer than its installed/build artifacts.
  // Report missing base plugins before entering the older launcher's boot wait.
  const baseDir = join(harness, 'packages/bundle/base');
  const base = JSON.parse(await readFile(join(baseDir, 'package.json'), 'utf8'));
  const yaml = await readFile(join(baseDir, 'cordis.patch.yml'), 'utf8');
  const { createRequire } = await import('node:module');
  const requireBase = createRequire(join(baseDir, 'package.json'));
  const missing = [];
  for (const match of yaml.matchAll(/name: '([^']+)'/g)) {
    const specifier = match[1];
    try {
      const entry = requireBase.resolve(specifier);
      if (!existsSync(entry)) missing.push(specifier);
    } catch { missing.push(specifier); }
  }
  if (missing.length) {
    console.error(`Harness ${base.version} has missing base-plugin artifacts:\n${[...new Set(missing)].map(name => `  ${name}`).join('\n')}\n\nIn ${harness}, run pnpm install and pnpm run build first.`);
    process.exit(1);
  }
}
const child = spawn(process.execPath, [
  join(harness, 'apps/cli/lib/bin.js'), '--profile', profile, ...args,
], {
  stdio: 'inherit', env: {
    ...process.env, DSH_HOME: join(root, '.dsh-home'),
    ...(resumeSessionId ? { DSH_TUI_RESUME_SESSION: resumeSessionId } : {}),
  },
});
// Forward signals when this launcher is targeted directly; the child owns
// restoring raw mode and terminal modes before it exits.
const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const forward = signal => { try { child.kill(signal); } catch { /* child already exited */ } };
for (const signal of forwarded) process.on(signal, forward);
const detach = () => { for (const signal of forwarded) process.off(signal, forward); };
child.on('error', error => { detach(); console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { detach(); process.exitCode = code ?? 1; });
