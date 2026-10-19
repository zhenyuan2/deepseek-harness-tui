import { mkdir, lstat, readFile, realpath, readlink, rm, symlink, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Read a package name without trusting an arbitrary directory. */
async function packageName(directory) {
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    return typeof manifest.name === 'string' ? manifest.name : undefined;
  } catch {
    return undefined;
  }
}

/** Refresh a dependency symlink, preserving ordinary files unless a matching peer directory is replaceable. */
export async function link(source, target, options = {}) {
  // Validate the new dependency before removing an existing link.
  const resolvedSource = await realpath(source);
  const sourceInfo = await lstat(resolvedSource);
  await mkdir(dirname(target), { recursive: true });
  let targetInfo;
  try {
    targetInfo = await lstat(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (targetInfo) {
    if (!targetInfo.isSymbolicLink()) {
      // npm may install a peer dependency as a real directory before setup.
      // Replacing it is safe only for the exact package this checkout owns.
      if (options.replaceDirectory && targetInfo.isDirectory()) {
        const [sourcePackage, targetPackage] = await Promise.all([packageName(resolvedSource), packageName(target)]);
        if (!sourcePackage || sourcePackage !== targetPackage) {
          throw new Error(`Already exists: ${target}. It is not a symlink; move it manually before setup.`);
        }
        await rm(target, { recursive: true, force: true });
      } else {
        throw new Error(`Already exists: ${target}. It is not a symlink; move it manually before setup.`);
      }
    } else {
      // readlink also works for dangling links left after pnpm prunes a version.
      const linkedPath = resolve(dirname(target), await readlink(target));
      try {
        if (await realpath(linkedPath) === resolvedSource) return;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await unlink(target);
    }
  }
  await symlink(resolve(source), target, sourceInfo.isDirectory() ? 'dir' : 'file');
}
