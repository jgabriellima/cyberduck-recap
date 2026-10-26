import type { MkdirOptions, RemoteEntry } from '../fs/types.js';
import {
  SFTP_STATUS,
  SftpStatusError,
  operationError,
  reasonFor,
  toRemoteFsError,
  type OperationContext,
} from './error-map.js';
import { baseName, isDirectory, joinPath, toEntry } from './entries.js';
import { isValidEntryName } from './sanitize.js';
import type {
  Session,
  SftpAttributes,
  SftpCallback,
  SftpChannel,
  SftpDirEntry,
} from './session.js';

function hasStatus(error: unknown, status: number): boolean {
  return error instanceof SftpStatusError && error.status === status;
}

async function call<T>(
  session: Session,
  context: OperationContext,
  start: (sftp: SftpChannel, done: SftpCallback<T>) => void,
): Promise<T> {
  try {
    return await session.request(start);
  } catch (error) {
    throw toRemoteFsError(error, context);
  }
}

/** `undefined` when the path does not exist; any other failure is thrown already mapped. */
async function lstatIfExists(
  session: Session,
  path: string,
  context: OperationContext,
): Promise<SftpAttributes | undefined> {
  try {
    return await session.request<SftpAttributes>((sftp, done) =>
      sftp.lstat(path, done),
    );
  } catch (error) {
    if (hasStatus(error, SFTP_STATUS.NO_SUCH_FILE)) return undefined;
    throw toRemoteFsError(error, context);
  }
}

async function closeHandle(session: Session, handle: Buffer): Promise<void> {
  await session
    .request<void>((sftp, done) => sftp.close(handle, done))
    .catch(() => undefined);
}

export async function list(
  session: Session,
  path: string,
): Promise<RemoteEntry[]> {
  const context: OperationContext = { operation: 'list', path };
  let handle: Buffer;
  try {
    handle = await session.request<Buffer>((sftp, done) =>
      sftp.opendir(path, done),
    );
  } catch (error) {
    if (hasStatus(error, SFTP_STATUS.FAILURE)) {
      // SFTP v3 reports opendir on a file as a generic FAILURE; a stat tells it apart.
      const attrs = await statIfExists(session, path, context).catch(
        () => undefined,
      );
      if (attrs !== undefined && !isDirectory(attrs.mode)) {
        throw operationError(
          'NOT_A_DIRECTORY',
          context,
          reasonFor('NOT_A_DIRECTORY'),
        );
      }
    }
    throw toRemoteFsError(error, context);
  }

  const raw: SftpDirEntry[] = [];
  try {
    for (;;) {
      try {
        const batch = await session.request<SftpDirEntry[]>((sftp, done) =>
          sftp.readdir(handle, done),
        );
        raw.push(...batch);
      } catch (error) {
        if (hasStatus(error, SFTP_STATUS.EOF)) break;
        throw toRemoteFsError(error, context);
      }
    }
  } finally {
    if (session.isOpen) await closeHandle(session, handle);
  }

  const entries: RemoteEntry[] = [];
  for (const { filename, attrs } of raw) {
    if (filename === '.' || filename === '..') continue;
    if (!isValidEntryName(filename)) {
      // One bad name fails the whole listing (G-3): returning the rest would hide the fault.
      throw operationError(
        'OPERATION_FAILED',
        context,
        'the server returned an invalid entry name',
      );
    }
    entries.push(toEntry(filename, joinPath(path, filename), attrs));
  }
  return entries;
}

export async function stat(
  session: Session,
  path: string,
): Promise<RemoteEntry> {
  const context: OperationContext = { operation: 'stat', path };
  const attrs = await call<SftpAttributes>(session, context, (sftp, done) =>
    sftp.stat(path, done),
  );
  return toEntry(baseName(path), path, attrs);
}

async function mkdirOne(
  session: Session,
  path: string,
  context: OperationContext,
): Promise<void> {
  try {
    await session.request<void>((sftp, done) => sftp.mkdir(path, done));
  } catch (error) {
    if (hasStatus(error, SFTP_STATUS.FAILURE)) {
      // OpenSSH answers FAILURE for EEXIST; whether the path exists now decides the code.
      const existing = await lstatIfExists(session, path, context).catch(
        () => undefined,
      );
      if (existing !== undefined) {
        throw operationError(
          'ALREADY_EXISTS',
          context,
          reasonFor('ALREADY_EXISTS'),
        );
      }
    }
    throw toRemoteFsError(error, context);
  }
}

function prefixes(path: string): string[] {
  const absolute = path.startsWith('/');
  const segments = path.split('/').filter((segment) => segment.length > 0);
  return segments.map(
    (_, index) =>
      `${absolute ? '/' : ''}${segments.slice(0, index + 1).join('/')}`,
  );
}

export async function mkdir(
  session: Session,
  path: string,
  options: MkdirOptions = {},
): Promise<void> {
  const context: OperationContext = { operation: 'mkdir', path };
  if (options.recursive !== true) {
    await mkdirOne(session, path, context);
    return;
  }
  for (const prefix of prefixes(path)) {
    const prefixContext: OperationContext = {
      operation: 'mkdir',
      path: prefix,
    };
    const existing = await statIfExists(session, prefix, prefixContext);
    if (existing !== undefined) {
      if (isDirectory(existing.mode)) continue;
      throw operationError(
        'ALREADY_EXISTS',
        prefixContext,
        'exists and is not a directory',
      );
    }
    try {
      await mkdirOne(session, prefix, prefixContext);
    } catch (error) {
      // Created concurrently between our stat and mkdir: what matters is that it is a directory now.
      const now = await statIfExists(session, prefix, prefixContext).catch(
        () => undefined,
      );
      if (now === undefined || !isDirectory(now.mode)) throw error;
    }
  }
}

async function statIfExists(
  session: Session,
  path: string,
  context: OperationContext,
): Promise<SftpAttributes | undefined> {
  try {
    return await session.request<SftpAttributes>((sftp, done) =>
      sftp.stat(path, done),
    );
  } catch (error) {
    if (hasStatus(error, SFTP_STATUS.NO_SUCH_FILE)) return undefined;
    throw toRemoteFsError(error, context);
  }
}

export async function remove(session: Session, path: string): Promise<void> {
  const context: OperationContext = { operation: 'remove', path };
  // lstat, not stat: a symbolic link is removed itself, never its target.
  const attrs = await call<SftpAttributes>(session, context, (sftp, done) =>
    sftp.lstat(path, done),
  );
  if (isDirectory(attrs.mode)) {
    await call<void>(session, context, (sftp, done) => sftp.rmdir(path, done));
  } else {
    await call<void>(session, context, (sftp, done) => sftp.unlink(path, done));
  }
}

export async function rename(
  session: Session,
  from: string,
  to: string,
): Promise<void> {
  const context: OperationContext = {
    operation: 'rename',
    path: from,
    targetPath: to,
  };
  // SFTP v3 RENAME may overwrite on some servers; checking first keeps the never-overwrite promise.
  // posix-rename@openssh.com is never used because it overwrites by design.
  const target = await lstatIfExists(session, to, context);
  if (target !== undefined) {
    throw operationError(
      'ALREADY_EXISTS',
      context,
      'the target already exists',
    );
  }
  await call<void>(session, context, (sftp, done) =>
    sftp.rename(from, to, done),
  );
}
