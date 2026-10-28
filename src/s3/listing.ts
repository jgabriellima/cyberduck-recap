/**
 * Listings (spec "How S3 maps onto RemoteFileSystem"): every page of `ListBuckets` and
 * `ListObjectsV2`, each value of a page validated (cyberduck/standard.untrusted-server-replies),
 * and the entries of one directory level.
 */
import type { RemoteEntry } from '../fs/types.js';
import { entryPath } from './paths.js';
import { S3TransportError, type S3Transport } from './transport.js';

/** A reply that is not valid for its request: OPERATION_FAILED for the caller. */
function malformed(): S3TransportError {
  return new S3TransportError({ kind: 'malformed' });
}

const EPOCH = 0;
const HIDDEN_NAMES: ReadonlySet<string> = new Set(['', '.', '..']);

function directory(name: string, path: string): RemoteEntry {
  return {
    name,
    path,
    type: 'directory',
    size: 0,
    modifiedAt: new Date(EPOCH),
    permissions: undefined,
  };
}

/** A time cut to whole seconds, as the other back-ends report it. */
export function toSeconds(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

export function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Follows a continuation token: a token seen before stops the listing as a malformed reply. */
function nextToken(
  truncated: unknown,
  token: unknown,
  seen: Set<string>,
): string | undefined {
  if (truncated !== true) return undefined;
  if (typeof token !== 'string' || token === '' || seen.has(token)) {
    throw malformed();
  }
  seen.add(token);
  return token;
}

/** Every bucket, over every page, as directory entries of `/`. */
export async function listBuckets(
  transport: S3Transport,
  signal: AbortSignal,
): Promise<RemoteEntry[]> {
  const entries = new Map<string, RemoteEntry>();
  const seen = new Set<string>();
  let token: string | undefined;
  do {
    const page = await transport.listBuckets(token, signal);
    if (page.buckets !== undefined && !Array.isArray(page.buckets))
      throw malformed();
    for (const bucket of (page.buckets ?? []) as unknown[]) {
      const name = (bucket as { Name?: unknown } | null)?.Name;
      if (typeof name !== 'string' || name === '' || name.includes('/')) {
        throw malformed();
      }
      entries.set(name, directory(name, `/${name}`));
    }
    // ListBuckets has no IsTruncated: a token means another page.
    token = nextToken(
      page.token === undefined ? false : true,
      page.token,
      seen,
    );
  } while (token !== undefined);
  return [...entries.values()];
}

export interface DirectoryListing {
  readonly entries: RemoteEntry[];
  /** Whether the store holds any key under the prefix (a marker, or a hidden name). */
  readonly anyKey: boolean;
}

/**
 * One directory level of `bucket` under `prefix` (`''` or a key followed by `/`): a `file` for
 * each object directly in it and a `directory` for each sub-prefix. The marker is left out, and
 * so is a name `''`, `.` or `..`.
 */
export async function listDirectory(
  transport: S3Transport,
  bucket: string,
  prefix: string,
  directoryPath: string,
  signal: AbortSignal,
): Promise<DirectoryListing> {
  const entries = new Map<string, RemoteEntry>();
  const seen = new Set<string>();
  let anyKey = false;
  let token: string | undefined;
  do {
    const page = await transport.listObjects(
      {
        bucket,
        prefix,
        delimiter: '/',
        ...(token === undefined ? {} : { token }),
      },
      signal,
    );
    if (typeof page.truncated !== 'boolean') throw malformed();
    if (page.contents !== undefined && !Array.isArray(page.contents))
      throw malformed();
    if (page.prefixes !== undefined && !Array.isArray(page.prefixes))
      throw malformed();
    for (const item of (page.contents ?? []) as unknown[]) {
      const { Key, Size, LastModified } = (item ?? {}) as {
        Key?: unknown;
        Size?: unknown;
        LastModified?: unknown;
      };
      if (typeof Key !== 'string' || !Key.startsWith(prefix)) throw malformed();
      const name = Key.slice(prefix.length);
      // A `/` after the prefix: the store ignored the delimiter.
      if (name.includes('/')) throw malformed();
      if (!isSize(Size) || !isValidDate(LastModified)) throw malformed();
      anyKey = true;
      if (HIDDEN_NAMES.has(name)) continue;
      entries.set(`file ${name}`, {
        name,
        path: entryPath(directoryPath, name),
        type: 'file',
        size: Size,
        modifiedAt: toSeconds(LastModified),
        permissions: undefined,
      });
    }
    for (const item of (page.prefixes ?? []) as unknown[]) {
      const value = (item as { Prefix?: unknown } | null)?.Prefix;
      if (
        typeof value !== 'string' ||
        !value.startsWith(prefix) ||
        !value.endsWith('/') ||
        value.length === prefix.length
      ) {
        throw malformed();
      }
      const name = value.slice(prefix.length, -1);
      if (name.includes('/')) throw malformed();
      anyKey = true;
      if (HIDDEN_NAMES.has(name)) continue;
      entries.set(
        `directory ${name}`,
        directory(name, entryPath(directoryPath, name)),
      );
    }
    token = nextToken(page.truncated, page.token, seen);
  } while (token !== undefined);
  return { entries: [...entries.values()], anyKey };
}

/** Whether any key starts with `prefix` (one key is enough). */
export async function hasKeysUnder(
  transport: S3Transport,
  bucket: string,
  prefix: string,
  signal: AbortSignal,
): Promise<boolean> {
  const page = await transport.listObjects(
    { bucket, prefix, maxKeys: 1 },
    signal,
  );
  if (page.contents !== undefined && !Array.isArray(page.contents))
    throw malformed();
  return Array.isArray(page.contents) && page.contents.length > 0;
}
