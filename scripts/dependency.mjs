import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

/** Reuse installed dependencies without downloading or mutating the Harness checkout. */
export async function installedDependency(harness, name, version) {
  const requireHarness = createRequire(join(harness, 'package.json'));
  try {
    const manifestPath = requireHarness.resolve(`${name}/package.json`);
    const pkg = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!/^\d+\.\d+\.\d+/.test(version) || pkg.version === version) return dirname(manifestPath);
  } catch {}
  const store = join(harness, 'node_modules/.pnpm');
  const prefix = `${name.replace('/', '+')}@${version}`;
  for (const entry of (await readdir(store)).sort()) {
    if (entry !== prefix && !entry.startsWith(`${prefix}_`)) continue;
    const directory = join(store, entry, 'node_modules', name);
    if (!existsSync(join(directory, 'package.json'))) continue;
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (pkg.name === name && pkg.version === version) return directory;
  }
  throw new Error(`Missing installed dependency ${name}@${version}. Install project dependencies before setup, or provide a Harness checkout containing this version.`);
}
