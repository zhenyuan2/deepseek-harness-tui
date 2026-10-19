import { lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const profileName = 'deepseek-harness-tui';
export const demoProfileName = `${profileName}-demo`;

async function info(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** Move a legacy profile intact; never merge it into an existing profile. */
export async function migrateProfiles(directory, warn = console.warn) {
  for (const [legacy, name] of [['learn-tui', profileName], ['learn-tui-demo', demoProfileName]]) {
    const source = join(directory, legacy);
    const target = join(directory, name);
    const previous = await info(source);
    if (!previous) continue;
    if (await info(target)) {
      warn(`Using ${target}. Legacy profile ${source} was left unchanged; review its custom configuration manually.`);
      continue;
    }
    if (!previous.isDirectory()) throw new Error(`Cannot migrate ${source}: expected a profile directory. Move it manually before running setup.`);
    await rename(source, target);
  }
}
