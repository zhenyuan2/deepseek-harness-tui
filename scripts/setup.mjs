// Link the already-installed checkout without downloading or modifying it.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { link } from './link.mjs';
import { installedDependency } from './dependency.mjs';
import { harnessPeers, checkPeerArtifacts } from './harness.mjs';
import { profileName, demoProfileName, migrateProfiles } from './profiles.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const harness = await realpath(resolve(process.argv[2] ?? join(root, '../deepseek-harness')));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const peers = await harnessPeers(harness, manifest.peerDependencies);
await checkPeerArtifacts(peers);
for (const pkg of peers) {
  const name = pkg.manifest.name;
  // npm can auto-install peers as real directories; replace only a directory
  // whose package name matches this peer, never arbitrary user data.
  await link(pkg.directory, join(root, 'node_modules', name), { replaceDirectory: true });
}
for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
  const target = join(root, 'node_modules', name);
  // Respect dependencies already installed by npm.
  if (existsSync(target) && !(await lstat(target)).isSymbolicLink()) continue;
  await link(await installedDependency(harness, name, version), target);
}
await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
await link(join(root, 'node_modules/typescript/bin/tsc'), join(root, 'node_modules/.bin/tsc'));

const profiles = join(root, '.dsh-home/profiles');
await migrateProfiles(profiles);
const profile = join(profiles, profileName);
await mkdir(profile, { recursive: true });
await link(root, join(profile, 'node_modules', manifest.name));
const profileManifest = join(profile, 'package.json');
if (!existsSync(profileManifest)) {
  await writeFile(profileManifest, JSON.stringify({
    name: `local-${profileName}-profile`, private: true, type: 'module',
    dependencies: { [manifest.name]: `link:${root}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', manifest.name], patchReload: 'startup' } },
  }, null, 2) + '\n');
}
const configuredProfile = JSON.parse(await readFile(profileManifest, 'utf8'));
let profileChanged = false;
if (configuredProfile.name === 'local-learn-tui-profile') {
  configuredProfile.name = `local-${profileName}-profile`;
  profileChanged = true;
}
if (configuredProfile.dsh?.profile?.patchReload === undefined) {
  configuredProfile.dsh.profile.patchReload = 'startup';
  profileChanged = true;
}
if (profileChanged) await writeFile(profileManifest, JSON.stringify(configuredProfile, null, 2) + '\n');
if (!existsSync(join(profile, 'cordis.patch.yml'))) await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
const demo = join(profiles, demoProfileName);
await mkdir(demo, { recursive: true });
await link(root, join(demo, 'node_modules', manifest.name));
await writeFile(join(demo, 'package.json'), JSON.stringify({
  name: `local-${demoProfileName}`, private: true, type: 'module',
  dependencies: { [manifest.name]: `link:${root}` },
  dsh: { profile: { bundles: [], patchReload: 'startup' } },
}, null, 2) + '\n');
await writeFile(join(demo, 'cordis.patch.yml'), [
  '- insert:',
  '    - id: demo-runtime',
  `      name: ${JSON.stringify(join(root, 'fixtures/demo-runtime.mjs'))}`,
  '    - id: simple-tui',
  '      name: "@nickyuan/deepseek-harness-tui"',
  '      config:',
  '        title: DeepSeek Harness TUI · OFFLINE DEMO (no model or tools)',
  '        maxRows: 500',
  '',
].join('\n'));
await writeFile(join(root, '.local.json'), JSON.stringify({ harness }, null, 2) + '\n');
console.log(`Linked to ${harness}\nLocal profile: ${profile}\nNext: npm run build && npm run demo\nReal agent: npm start (requires a fully built harness)`);
