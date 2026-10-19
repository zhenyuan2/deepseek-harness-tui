import { lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const profileName = 'deepseek-harness-tui';

async function info(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** Move a legacy profile intact; never merge it into an existing profile. */
export async function migrateProfiles(directory, warn = console.warn) {
  const source = join(directory, 'learn-tui');
  const target = join(directory, profileName);
  const previous = await info(source);
  if (!previous) return;
  if (await info(target)) {
    warn(`Using ${target}. Legacy profile ${source} was left unchanged; review its custom configuration manually.`);
    return;
  }
  if (!previous.isDirectory()) throw new Error(`Cannot migrate ${source}: expected a profile directory. Move it manually before running setup.`);
  await rename(source, target);
}
