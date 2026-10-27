import { chmod, lstat, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { localFileError } from './errors.js';

const PRIVATE_DIRECTORY = 0o700;

/**
 * The file functions of the directory step, in one object a unit test can replace, so a directory
 * that another process creates between the check and the `mkdir` can be shown.
 */
export const directoryFiles = { chmod, lstat, mkdir };

/**
 * The CLI's own known_hosts file: under an absolute XDG_CONFIG_HOME, else under `<home>/.config`
 * (a relative or empty XDG_CONFIG_HOME is ignored, as the XDG specification says). Never
 * OpenSSH's own file.
 */
export function defaultKnownHostsPath(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const xdg = env['XDG_CONFIG_HOME'];
  const base =
    xdg !== undefined && xdg !== '' && isAbsolute(xdg)
      ? xdg
      : join(home, '.config');
  return join(base, 'cyberduck-recap', 'known_hosts');
}

async function exists(path: string): Promise<boolean> {
  try {
    await directoryFiles.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates each missing directory of `directory`, one at a time, with mode 0700. The mode is set
 * again after `mkdir`, so a strict or loose umask cannot change it. A directory that exists keeps
 * its mode, also one another process created between the check and the `mkdir` (EEXIST on a
 * directory counts as success).
 */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  const missing: string[] = [];
  let current = directory;
  while (!(await exists(current))) {
    missing.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of missing) {
    try {
      await directoryFiles.mkdir(path, { mode: PRIVATE_DIRECTORY });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const stats = await directoryFiles.lstat(path).catch(() => undefined);
        if (stats?.isDirectory() === true) continue;
      }
      throw localFileError(`cannot create the directory ${path}`);
    }
    try {
      await directoryFiles.chmod(path, PRIVATE_DIRECTORY);
    } catch {
      throw localFileError(`cannot create the directory ${path}`);
    }
  }
}
