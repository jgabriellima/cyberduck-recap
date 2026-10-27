import { open, type FileHandle } from 'node:fs/promises';
import { basename as localBasename, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { RemoteFsError } from '../../fs/errors.js';
import type { RemoteFileSystem } from '../../fs/types.js';
import { localFileError } from '../errors.js';

/** The local file of `put`, open before the connection and read only after it. */
export interface PutSource {
  readonly shown: string;
  readonly handle: FileHandle;
  /** Set once a read stream owns the descriptor; that stream closes it. */
  streamed: boolean;
}

/** Opens the local file and checks it before any connection; the descriptor stays open. */
export async function openPutSource(
  localPath: string,
  cwd: string,
): Promise<PutSource> {
  let handle: FileHandle;
  try {
    handle = await open(resolve(cwd, localPath), 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw localFileError(`${localPath} does not exist`);
    if (code === 'EISDIR') throw localFileError(`${localPath} is a directory`);
    throw localFileError(`cannot read ${localPath}`);
  }
  let isDirectory: boolean;
  try {
    isDirectory = (await handle.stat()).isDirectory();
  } catch {
    await handle.close().catch(() => undefined);
    throw localFileError(`cannot read ${localPath}`);
  }
  if (isDirectory) {
    await handle.close().catch(() => undefined);
    throw localFileError(`${localPath} is a directory`);
  }
  return { shown: localPath, handle, streamed: false };
}

function existsError(remotePath: string): RemoteFsError {
  return new RemoteFsError(
    'ALREADY_EXISTS',
    `${remotePath} exists; give --overwrite to replace it`,
    { path: remotePath },
  );
}

/** `undefined` when nothing has the path; NOT_FOUND is the only failure that means that. */
async function statOrNothing(
  remote: RemoteFileSystem,
  path: string,
): Promise<'directory' | 'other' | undefined> {
  try {
    const entry = await remote.stat(path);
    return entry.type === 'directory' ? 'directory' : 'other';
  } catch (error) {
    if (error instanceof RemoteFsError && error.code === 'NOT_FOUND') {
      return undefined;
    }
    throw error;
  }
}

/** A remote file that a lost connection cut short: the CLI says so after the error line. */
export class PartialUploadError extends Error {
  override readonly name = 'PartialUploadError';
  readonly remoteError: RemoteFsError;
  readonly remotePath: string;

  constructor(remoteError: RemoteFsError, remotePath: string) {
    super('the upload was cut short');
    this.remoteError = remoteError;
    this.remotePath = remotePath;
  }
}

/**
 * The upload: the remote destination is the URL path, or the local file's name inside it when the
 * path ends with `/` or names a directory. Without `--overwrite` an existing file is refused with
 * a `stat` first and again by an exclusive open, so a file that appears in between is never
 * replaced either.
 */
export async function runPut(
  remote: RemoteFileSystem,
  source: PutSource,
  remotePath: string,
  overwrite: boolean,
): Promise<void> {
  const name = localBasename(source.shown);
  let destination = remotePath;
  let found: 'directory' | 'other' | undefined;
  if (remotePath.endsWith('/')) {
    destination = `${remotePath}${name}`;
  } else {
    found = await statOrNothing(remote, remotePath);
    if (found === 'directory') destination = `${remotePath}/${name}`;
  }
  if (destination !== remotePath) {
    found = await statOrNothing(remote, destination);
  }
  if (found !== undefined && !overwrite) throw existsError(destination);

  // The first stream to fail names the side; a failure of the other is the teardown pipeline
  // causes.
  let first: 'local' | 'remote' | undefined;
  const local: Readable = source.handle.createReadStream();
  source.streamed = true;
  local.on('error', () => {
    first ??= 'local';
  });
  try {
    // Inside the try: a back-end that throws here still has the local stream torn down below.
    const upload = remote.createWriteStream(destination, {
      exclusive: !overwrite,
    });
    upload.on('error', () => {
      first ??= 'remote';
    });
    await pipeline(local, upload);
  } catch (error) {
    local.destroy();
    if (first === 'local') throw localFileError(`cannot read ${source.shown}`);
    if (error instanceof RemoteFsError && error.code === 'ALREADY_EXISTS') {
      throw existsError(destination);
    }
    if (error instanceof RemoteFsError && error.code === 'CONNECTION_LOST') {
      throw new PartialUploadError(error, destination);
    }
    throw error;
  }
}
