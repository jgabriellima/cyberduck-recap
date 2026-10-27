import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  link,
  lstat,
  open,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename as localBasename, dirname, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RemoteFileSystem } from '../../fs/types.js';
import { errnoOf } from '../../fs/errors.js';
import { existsText, localFileError, usageError } from '../errors.js';
import { shownUrl } from '../redact.js';
import { basename } from '../url.js';
import { download } from './transfer.js';

/**
 * The local file functions of `get`, in one object a unit test can replace, so the fallback for
 * a file system with no hard links is tested with a `link` that fails.
 */
export const localFiles = { link, lstat, open, rename, stat, unlink };

// `link` fails with these where the file system has no hard links (FAT, exFAT, some SMB and NFS
// mounts). EXDEV cannot occur within one directory; it is listed as a guard.
const NO_HARD_LINKS: ReadonlySet<string> = new Set([
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EXDEV',
]);

const DEFAULT_FILE_MODE = 0o666;
const PRIVATE_FILE_MODE = 0o600;

export interface GetPlan {
  readonly remotePath: string;
  /** Absolute. */
  readonly destination: string;
  readonly overwrite: boolean;
  /** The mode bits of the regular file that `--overwrite` replaces, kept on the new file. */
  readonly keptMode: number | undefined;
}

/**
 * A stream that writes into an open file and leaves it open, so its mode is set on the descriptor
 * after the last byte. A FileHandle stream with `autoClose: false` would instead keep the handle
 * referenced, and its `close()` would never settle.
 */
function fileWriter(handle: FileHandle): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const writeAll = async (): Promise<void> => {
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset);
          offset += bytesWritten;
        }
      };
      writeAll().then(() => callback(), callback);
    },
  });
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await localFiles.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function existsError(destination: string): Error {
  return localFileError(existsText(shownUrl(destination)));
}

/**
 * The checks before any connection: the destination comes from the command line only, its
 * directory exists, and without `--overwrite` nothing has its name yet.
 */
export async function planGet(
  remotePath: string,
  localPath: string | undefined,
  cwd: string,
  overwrite: boolean,
): Promise<GetPlan> {
  const name = basename(remotePath);
  const nameless = name === '' || name === '.' || name === '..';
  let destination: string;
  if (localPath === undefined || (await isDirectory(resolve(cwd, localPath)))) {
    if (nameless) {
      throw usageError(
        `the remote path '${remotePath}' has no file name; give a local file path`,
      );
    }
    destination = join(resolve(cwd, localPath ?? '.'), name);
  } else {
    destination = resolve(cwd, localPath);
  }

  const directory = dirname(destination);
  if (!(await isDirectory(directory))) {
    throw localFileError(`the directory ${shownUrl(directory)} does not exist`);
  }
  let existing;
  try {
    existing = await localFiles.lstat(destination);
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') {
      throw localFileError(`cannot write ${shownUrl(destination)}`);
    }
  }
  if (existing === undefined) {
    return { remotePath, destination, overwrite, keptMode: undefined };
  }
  if (!overwrite) throw existsError(destination);
  if (existing.isDirectory()) {
    throw localFileError(`${shownUrl(destination)} is a directory`);
  }
  return {
    remotePath,
    destination,
    overwrite,
    keptMode: existing.isFile() ? existing.mode & 0o7777 : undefined,
  };
}

async function removeQuietly(path: string): Promise<void> {
  await localFiles.unlink(path).catch(() => undefined);
}

/**
 * The download (design Option 4C, with 4E as its fallback). It writes a private temporary file
 * beside the destination, gives it its final mode only after the last byte, then:
 * - with `--overwrite`, renames it over the destination (a link is replaced, never followed);
 * - without, hard-links it to the destination, which the kernel refuses in one step when anything
 *   has that name by then (a file or link planted during the download is never replaced).
 */
export async function runGet(
  remote: RemoteFileSystem,
  plan: GetPlan,
  umask: number,
): Promise<void> {
  const { destination } = plan;
  const directory = dirname(destination);
  const temporary = join(
    directory,
    `.${localBasename(destination)}.${randomBytes(8).toString('hex')}.part`,
  );
  let handle: FileHandle;
  try {
    handle = await localFiles.open(temporary, 'wx', PRIVATE_FILE_MODE);
  } catch {
    throw localFileError(
      `cannot create a temporary file in ${shownUrl(directory)}`,
    );
  }
  const finalMode = plan.keptMode ?? DEFAULT_FILE_MODE & ~umask;
  try {
    const failure = await download(
      () => remote.createReadStream(plan.remotePath),
      fileWriter(handle),
    );
    if (failure?.side === 'local') {
      throw localFileError(`cannot write ${shownUrl(destination)}`);
    }
    if (failure !== undefined) throw failure.error;
    // fchmod on the open descriptor: the mode lands on the file that was written, whatever the
    // name points to by now.
    await handle.chmod(finalMode).catch(() => {
      throw localFileError(`cannot write ${shownUrl(destination)}`);
    });
  } catch (error) {
    await handle.close().catch(() => undefined);
    await removeQuietly(temporary);
    throw error;
  }
  try {
    await handle.close();
    await finish(temporary, plan, finalMode);
  } finally {
    await removeQuietly(temporary);
  }
}

async function finish(
  temporary: string,
  plan: GetPlan,
  finalMode: number,
): Promise<void> {
  const { destination } = plan;
  if (plan.overwrite) {
    try {
      await localFiles.rename(temporary, destination);
    } catch {
      throw localFileError(`cannot write ${shownUrl(destination)}`);
    }
    return;
  }
  try {
    await localFiles.link(temporary, destination);
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'EEXIST') throw existsError(destination);
    if (code !== undefined && NO_HARD_LINKS.has(code)) {
      await copyExclusive(temporary, destination, finalMode);
      return;
    }
    throw localFileError(`cannot write ${shownUrl(destination)}`);
  }
}

/**
 * Fallback 4E: creates the destination only when nothing has its name (O_CREAT|O_EXCL never
 * follows a link), then copies the temporary file into it. A failed copy removes only the file
 * this call created, checked by device and inode.
 */
async function copyExclusive(
  temporary: string,
  destination: string,
  finalMode: number,
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await localFiles.open(destination, 'wx', finalMode);
  } catch (error) {
    if (errnoOf(error) === 'EEXIST') throw existsError(destination);
    throw localFileError(`cannot write ${shownUrl(destination)}`);
  }
  try {
    await handle.chmod(finalMode);
    await pipeline(createReadStream(temporary), fileWriter(handle));
  } catch {
    const [created, now] = await Promise.all([
      handle.stat().catch(() => undefined),
      localFiles.lstat(destination).catch(() => undefined),
    ]);
    if (
      created !== undefined &&
      now !== undefined &&
      created.dev === now.dev &&
      created.ino === now.ino
    ) {
      await removeQuietly(destination);
    }
    throw localFileError(`cannot write ${shownUrl(destination)}`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
