import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Locate the checkout's declared peers before changing any dependency links. */
export async function harnessPeers(harness, versions) {
  const packages = new Map();
  async function discover(directory, depth) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      packages.set(manifest.name, { directory, manifest });
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (depth === 0) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules') await discover(join(directory, entry.name), depth - 1);
    }
  }
  await discover(join(harness, 'packages'), 3);
  await discover(join(harness, 'vendor'), 2);
  const peers = [];
  for (const [name, version] of Object.entries(versions)) {
    const pkg = packages.get(name);
    if (!pkg || pkg.manifest.version !== version) {
      throw new Error(`${name}: expected ${version}, found ${pkg?.manifest.version ?? 'missing'}. Update this TUI's peer versions for the Harness release first.`);
    }
    peers.push(pkg);
  }
  return peers;
}

async function newestSource(directory) {
  let newest = 0;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return newest; throw error; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, await newestSource(path));
    else if (/\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) newest = Math.max(newest, (await stat(path)).mtimeMs);
  }
  return newest;
}

/** Reject absent or visibly stale checkout artifacts instead of using an older API silently. */
export async function checkPeerArtifacts(peers) {
  const failures = [];
  for (const { directory, manifest } of peers) {
    if (!manifest.main || !manifest.types) { failures.push(`${manifest.name}: no runtime/types entry`); continue; }
    let runtime;
    try {
      runtime = await stat(join(directory, manifest.main));
      await stat(join(directory, manifest.types));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      failures.push(`${manifest.name}: missing runtime or type declarations`);
      continue;
    }
    const newest = Math.max((await stat(join(directory, 'package.json'))).mtimeMs, await newestSource(join(directory, 'src')));
    if (newest > runtime.mtimeMs) failures.push(`${manifest.name}: source/package version is newer than the runtime build`);
  }
  if (failures.length) throw new Error(`Harness needs rebuilding:\n${failures.map(message => `  ${message}`).join('\n')}\nRun pnpm install and pnpm run build in the Harness checkout, then npm run setup here.`);
}
