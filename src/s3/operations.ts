/**
 * The probe and the operations that are not streams (design "Request sequences"): `stat`, `list`,
 * `mkdir`, `remove` and `rename`, each mapped onto S3 as spec "How S3 maps onto
 * RemoteFileSystem" states. Every request goes through `S3Transport` with the operation's signal.
 */
import type { RemoteFsError } from '../fs/errors.js';
import type { RemoteEntry } from '../fs/types.js';
import {
  EXCLUSIVE_REFUSED,
  codeOf,
  describeTls,
  isExclusiveRefusal,
  mayHaveBeenWritten,
  objectUrl,
  replyCode,
  type Action,
  type S3Errors,
} from './errors.js';
import {
  directoryEntry,
  hasKeysUnder,
  headIfObject,
  isSize,
  isValidDate,
  keysUnder,
  listBuckets,
  listDirectory,
  toSeconds,
} from './listing.js';
import { isBucketPath, nameOf, type S3Location } from './paths.js';
import {
  S3TransportError,
  type S3Failure,
  type S3Transport,
} from './transport.js';

/** The largest object a single CopyObject copies (S3's limit). */
export const MAX_COPY_SIZE = 5_368_709_120;

export interface S3Context {
  readonly transport: S3Transport;
  readonly errors: S3Errors;
  /** The bucket of a bucket-scoped instance. */
  readonly bucket: string | undefined;
}

/** Turns a transport failure into the operation's error; any other error passes. */
function failed(
  context: S3Context,
  action: Action,
  location: S3Location,
  target?: S3Location,
): (error: unknown) => never {
  return (error) => {
    if (error instanceof S3TransportError) {
      throw context.errors.fromFailure(
        error.failure,
        action,
        location,
        target === undefined ? {} : { target },
      );
    }
    throw error;
  };
}

function directoryAt(location: S3Location): RemoteEntry {
  return directoryEntry(nameOf(location.path), location.path);
}

function bucketOf(location: S3Location): string {
  // A caller passes only locations past the root checks, which always have a bucket.
  return location.bucket ?? '';
}

/** The object `key` of the location as a file entry, or `undefined` when it does not exist. */
async function headFile(
  context: S3Context,
  location: S3Location,
  key: string,
  signal: AbortSignal,
): Promise<RemoteEntry | undefined> {
  const head = await headIfObject(
    context.transport,
    bucketOf(location),
    key,
    signal,
  );
  if (head === undefined) return undefined;
  if (!isSize(head.contentLength)) {
    throw new S3TransportError({ kind: 'malformed' });
  }
  return {
    name: nameOf(location.path),
    path: location.path,
    type: 'file',
    size: head.contentLength,
    modifiedAt: isValidDate(head.lastModified)
      ? toSeconds(head.lastModified)
      : new Date(0),
    permissions: undefined,
  };
}

/** The error of the probe; `undefined` when the probe proves the connection (200, AccessDenied). */
export function probeError(
  context: S3Context,
  failure: S3Failure,
  root: S3Location,
  expiredOn: string | undefined,
): RemoteFsError | undefined {
  const { errors } = context;
  const host = errors.context.endpointHost;
  const subject = `cannot connect to ${objectUrl(root)} at ${host}`;
  switch (failure.kind) {
    case 'reply': {
      const code = replyCode(failure);
      if (code === 'AccessDenied') return undefined;
      if (code === 'NoSuchBucket' && root.bucket !== undefined) {
        return errors.fromFailure(failure, 'connect', root, {
          code: 'NOT_FOUND',
        });
      }
      const mapped = codeOf(failure);
      return errors.fromFailure(failure, 'connect', root, {
        code: mapped === 'AUTH_FAILED' ? 'AUTH_FAILED' : 'CONNECTION_FAILED',
      });
    }
    case 'tls':
      return errors.fail(
        'CONNECTION_FAILED',
        `${subject}: ${describeTls(failure.errno, failure.host, expiredOn)}`,
      );
    case 'no-reply':
    case 'malformed':
    case 'request':
      return errors.fail(
        'CONNECTION_FAILED',
        `${subject}: ${errors.describe(failure)}`,
      );
    case 'aborted':
      return errors.fail(
        'NOT_CONNECTED',
        `${subject}: disconnect() was called while connecting`,
      );
    case 'credentials':
      return errors.fail(
        'AUTH_FAILED',
        `${subject}: ${errors.describe(failure)}`,
      );
  }
}

/**
 * The one request of connect(): ListBuckets account-wide, ListObjectsV2 of one key
 * bucket-scoped.
 */
export async function sendProbe(
  context: S3Context,
  signal: AbortSignal,
): Promise<void> {
  if (context.bucket === undefined) {
    await context.transport.listBuckets(undefined, signal);
  } else {
    await context.transport.listObjects(
      { bucket: context.bucket, prefix: '', maxKeys: 1 },
      signal,
    );
  }
}

export async function stat(
  context: S3Context,
  location: S3Location,
  signal: AbortSignal,
): Promise<RemoteEntry> {
  if (location.root) return directoryAt(location);
  const fail = failed(context, 'stat', location);
  try {
    const bucket = bucketOf(location);
    if (location.key === undefined) {
      await hasKeysUnder(context.transport, bucket, '', signal);
      return directoryAt(location);
    }
    const file = await headFile(context, location, location.key, signal);
    if (file !== undefined) return file;
    if (
      await hasKeysUnder(context.transport, bucket, `${location.key}/`, signal)
    ) {
      return directoryAt(location);
    }
  } catch (error) {
    fail(error);
  }
  throw context.errors.fail(
    'NOT_FOUND',
    `cannot read the attributes of ${objectUrl(location)}: no object or folder has this path`,
    { path: location.path },
  );
}

export async function list(
  context: S3Context,
  location: S3Location,
  signal: AbortSignal,
): Promise<RemoteEntry[]> {
  const fail = failed(context, 'list', location);
  try {
    if (location.bucket === undefined) {
      return await listBuckets(context.transport, signal);
    }
    const prefix = location.key === undefined ? '' : `${location.key}/`;
    const listing = await listDirectory(
      context.transport,
      location.bucket,
      prefix,
      location.path,
      signal,
    );
    if (location.key === undefined || listing.anyKey) return listing.entries;
    if (
      (await headFile(context, location, location.key, signal)) !== undefined
    ) {
      throw context.errors.fail(
        'NOT_A_DIRECTORY',
        `cannot list ${objectUrl(location)}: it is an object, not a folder`,
        { path: location.path },
      );
    }
  } catch (error) {
    fail(error);
  }
  throw context.errors.fail(
    'NOT_FOUND',
    `cannot list ${objectUrl(location)}: no object or folder has this path`,
    { path: location.path },
  );
}

/** The ancestors of a key, the top first: `a/b/c` gives `a` and `a/b`. */
function ancestorsOf(key: string): string[] {
  const out: string[] = [];
  for (let at = key.indexOf('/', 1); at !== -1; at = key.indexOf('/', at + 1)) {
    out.push(key.slice(0, at));
  }
  return out;
}

function withKey(location: S3Location, key: string): S3Location {
  const base = location.path.slice(
    0,
    location.path.length - (location.key ?? '').length,
  );
  return { ...location, key, path: `${base}${key}` };
}

export async function mkdir(
  context: S3Context,
  location: S3Location,
  recursive: boolean,
  signal: AbortSignal,
): Promise<void> {
  const { errors, transport } = context;
  const exists = (at: S3Location, what: string): RemoteFsError =>
    errors.fail(
      'ALREADY_EXISTS',
      `cannot create ${objectUrl(location)}: ${objectUrl(at)} ${what}`,
      {
        path: at.path,
      },
    );
  if (location.root) {
    if (recursive) return;
    throw exists(location, 'is the root, which exists');
  }
  const fail = failed(context, 'mkdir', location);
  const bucket = bucketOf(location);
  const key = location.key;
  try {
    if (key === undefined) {
      try {
        await transport.createBucket(bucket, signal);
      } catch (error) {
        if (
          recursive &&
          error instanceof S3TransportError &&
          replyCode(error.failure) === 'BucketAlreadyOwnedByYou'
        ) {
          return;
        }
        throw error;
      }
      return;
    }
    if (recursive) {
      for (const ancestor of ancestorsOf(key)) {
        const at = withKey(location, ancestor);
        if ((await headFile(context, at, ancestor, signal)) !== undefined) {
          throw exists(at, 'is an object, not a folder');
        }
      }
    } else {
      const slash = key.lastIndexOf('/');
      const parent = slash > 0 ? key.slice(0, slash) : '';
      if (
        parent !== '' &&
        !(await hasKeysUnder(transport, bucket, `${parent}/`, signal))
      ) {
        throw errors.fail(
          'NOT_FOUND',
          `cannot create ${objectUrl(location)}: its parent ${objectUrl(withKey(location, parent))} is not a folder`,
          { path: location.path },
        );
      }
    }
    if ((await headFile(context, location, key, signal)) !== undefined) {
      throw exists(location, 'is an object');
    }
    if (await hasKeysUnder(transport, bucket, `${key}/`, signal)) {
      if (recursive) return;
      throw exists(location, 'is a folder');
    }
    await transport.putObject(
      { bucket, key: `${key}/`, body: Buffer.alloc(0), exclusive: false },
      signal,
    );
  } catch (error) {
    fail(error);
  }
}

export async function remove(
  context: S3Context,
  location: S3Location,
  signal: AbortSignal,
): Promise<void> {
  const { errors, transport } = context;
  if (location.root) {
    throw errors.fail('INVALID_ARGUMENT', 'cannot remove the root /', {
      path: location.path,
    });
  }
  const fail = failed(context, 'remove', location);
  const bucket = bucketOf(location);
  const key = location.key;
  try {
    if (key === undefined) {
      await transport.deleteBucket(bucket, signal);
      return;
    }
    if ((await headFile(context, location, key, signal)) !== undefined) {
      await transport.deleteObject(bucket, key, signal);
      return;
    }
    const marker = `${key}/`;
    const keys = await keysUnder(transport, bucket, marker, 2, signal);
    if (keys.length === 1 && keys[0] === marker) {
      await transport.deleteObject(bucket, marker, signal);
      return;
    }
    if (keys.length > 0) {
      throw errors.fail(
        'OPERATION_FAILED',
        `cannot remove ${objectUrl(location)}: the folder is not empty`,
        { path: location.path },
      );
    }
  } catch (error) {
    fail(error);
  }
  throw errors.fail(
    'NOT_FOUND',
    `cannot remove ${objectUrl(location)}: no object or folder has this path`,
    { path: location.path },
  );
}

export async function rename(
  context: S3Context,
  from: S3Location,
  to: S3Location,
  signal: AbortSignal,
): Promise<void> {
  const { errors, transport } = context;
  const details = { path: from.path, targetPath: to.path };
  const subject = `${objectUrl(from)} to ${objectUrl(to)}`;
  if (from.root || to.root || isBucketPath(from) || isBucketPath(to)) {
    throw errors.fail(
      'INVALID_ARGUMENT',
      `cannot rename ${subject}: only an object can be renamed, onto a key`,
      details,
    );
  }
  const fromKey = from.key ?? '';
  const toKey = to.key ?? '';
  const fail = failed(context, 'rename', from, to);
  try {
    const source = await headFile(context, from, fromKey, signal);
    if (source === undefined) {
      if (
        await hasKeysUnder(transport, bucketOf(from), `${fromKey}/`, signal)
      ) {
        throw errors.fail(
          'OPERATION_FAILED',
          `cannot rename ${subject}: ${objectUrl(from)} is a folder; only an object can be renamed`,
          details,
        );
      }
      throw errors.fail(
        'NOT_FOUND',
        `cannot rename ${subject}: ${objectUrl(from)} does not exist`,
        details,
      );
    }
    if (source.size > MAX_COPY_SIZE) {
      throw errors.fail(
        'OPERATION_FAILED',
        `cannot rename ${subject}: the object has ${source.size} bytes, more than the ${MAX_COPY_SIZE} bytes one copy can move`,
        details,
      );
    }
    if (await hasKeysUnder(transport, bucketOf(to), `${toKey}/`, signal)) {
      throw errors.fail(
        'ALREADY_EXISTS',
        `cannot rename ${subject}: ${objectUrl(to)} is a folder`,
        details,
      );
    }
  } catch (error) {
    fail(error);
  }

  try {
    await transport.copyObject(
      { fromBucket: bucketOf(from), fromKey, bucket: bucketOf(to), key: toKey },
      signal,
    );
  } catch (error) {
    if (!(error instanceof S3TransportError)) throw error;
    const { failure } = error;
    if (isExclusiveRefusal(failure)) {
      throw errors.fail(
        'OPERATION_FAILED',
        `cannot rename ${subject}: ${errors.describe(failure)}; ${EXCLUSIVE_REFUSED}`,
        details,
      );
    }
    if (failure.kind === 'no-reply') {
      throw errors.fail(
        'CONNECTION_LOST',
        `cannot rename ${subject}: ${errors.describe(failure)}; ${mayHaveBeenWritten(to)}`,
        details,
      );
    }
    fail(error);
  }

  try {
    await transport.deleteObject(bucketOf(from), fromKey, signal);
  } catch (error) {
    if (!(error instanceof S3TransportError)) throw error;
    const code =
      codeOf(error.failure) === 'NOT_CONNECTED'
        ? 'NOT_CONNECTED'
        : 'OPERATION_FAILED';
    throw errors.fail(
      code,
      `cannot rename ${subject}: the copy succeeded and the delete of ${objectUrl(from)} failed (${errors.describe(error.failure)}); both ${objectUrl(from)} and ${objectUrl(to)} now exist`,
      details,
    );
  }
}
