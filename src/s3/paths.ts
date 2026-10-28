import { bucketProblem } from './validation.js';

/**
 * Where a back-end path points (spec "Paths and URLs"). `path` is the read path (steps 1 and 2),
 * the path of every entry and error. `root` is `/` of the instance: the buckets account-wide, the
 * bucket's top level bucket-scoped.
 */
export interface S3Location {
  readonly path: string;
  readonly root: boolean;
  /** `undefined` only for the account-wide root. */
  readonly bucket: string | undefined;
  /** `undefined` for a root or a bucket path; never `''`. */
  readonly key: string | undefined;
}

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Why a path cannot name an object; the caller makes it an INVALID_ARGUMENT error. */
export class PathProblem extends Error {
  override readonly name = 'PathProblem';
  readonly path: string;
  readonly why: string;

  constructor(path: string, why: string) {
    super(why);
    this.path = path;
    this.why = why;
  }
}

/**
 * Reads a path: `.`, `''` and a relative path are read against `/`, one trailing `/` is removed,
 * and the key is used exactly as it stands. Throws PathProblem for a value no request can carry:
 * not a string, U+0000, a lone surrogate (it has no UTF-8 form), or a bad bucket segment.
 */
export function readPath(
  raw: unknown,
  scopedBucket: string | undefined,
): S3Location {
  if (typeof raw !== 'string') {
    throw new PathProblem(String(raw), 'the path must be a string');
  }
  let path = raw === '.' || raw === '' ? '/' : raw;
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path.includes('\0')) {
    throw new PathProblem(path, 'the path must not contain U+0000');
  }
  if (LONE_SURROGATE.test(path)) {
    throw new PathProblem(path, 'the path must not contain a lone surrogate');
  }
  if (path === '/') {
    return { path, root: true, bucket: scopedBucket, key: undefined };
  }
  if (scopedBucket !== undefined) {
    return { path, root: false, bucket: scopedBucket, key: path.slice(1) };
  }
  const rest = path.slice(1);
  const slash = rest.indexOf('/');
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const problem = bucketProblem(bucket);
  if (problem !== undefined) {
    throw new PathProblem(path, `the bucket segment of the path ${problem}`);
  }
  const key = slash === -1 ? '' : rest.slice(slash + 1);
  return { path, root: false, bucket, key: key === '' ? undefined : key };
}

/** The path of an entry `name` directly in the directory at `directory`. */
export function entryPath(directory: string, name: string): string {
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}

/** The last segment of a read path; `/` for the root. */
export function nameOf(path: string): string {
  if (path === '/') return '/';
  return path.slice(path.lastIndexOf('/') + 1);
}

/** A bucket path account-wide: the bucket itself, not a key in it. */
export function isBucketPath(location: S3Location): boolean {
  return !location.root && location.key === undefined;
}
