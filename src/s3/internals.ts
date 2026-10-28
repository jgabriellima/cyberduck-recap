/**
 * The test seams of the S3 back-end (design Option 11C), out of the public constructor: the
 * package index does not export this module, so the class and its declarations hold no seam.
 * Neither seam turns a check off: `lookup` only resolves names (TLS still checks the host name),
 * and `partLimit` only lowers the largest upload.
 */
import type { LookupFunction } from 'node:net';
import { MAX_PARTS } from './upload.js';

export interface S3Internals {
  /** Passed to the HTTPS agent; default: Node's own lookup. */
  readonly lookup?: LookupFunction;
  /** 1..MAX_PARTS; default MAX_PARTS (AC-43). */
  readonly partLimit?: number;
}

const seams = new WeakMap<object, S3Internals>();
const sealed = new WeakSet<object>();

/** Throws TypeError after connect() began, or for a partLimit outside 1..MAX_PARTS. */
export function setS3Internals(fs: object, internals: S3Internals): void {
  if (sealed.has(fs)) {
    throw new TypeError('setS3Internals must be called before connect()');
  }
  const { partLimit } = internals;
  if (
    partLimit !== undefined &&
    !(
      Number.isSafeInteger(partLimit) &&
      partLimit >= 1 &&
      partLimit <= MAX_PARTS
    )
  ) {
    throw new TypeError(`partLimit must be an integer from 1 to ${MAX_PARTS}`);
  }
  seams.set(fs, { ...internals });
}

/** The seams of `fs` (`{}` when none were set). Called by connect(), which seals them. */
export function internalsOf(fs: object, seal = false): S3Internals {
  if (seal) sealed.add(fs);
  return seams.get(fs) ?? {};
}
