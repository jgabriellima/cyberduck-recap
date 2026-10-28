/**
 * The request policy of the S3 back-end (design Decision 13): for each command, how many attempts
 * it gets, which idle bound applies and whether its attempts are recorded. `sdk.ts` reads this
 * table and holds no project rule of its own; no SDK import here.
 */
import type { S3Command, S3Failure } from './transport.js';
import { isRegion } from './validation.js';

export interface RequestPolicy {
  /**
   * `standard`: the SDK's retry (3 attempts). `once`: one attempt. `once-when-exclusive`: one
   * attempt for an exclusive create, else standard. A creating request with `If-None-Match: *`
   * is sent once: a second attempt after a lost reply would get 412 for this operation's own
   * object.
   */
  readonly attempts: 'standard' | 'once' | 'once-when-exclusive';
  /**
   * `normal`: no byte for `timeoutMs` fails the attempt. `server-work`: the store may work for
   * long before its first byte (a completion of 10,000 parts, a copy of 5 GiB).
   */
  readonly idle: 'normal' | 'server-work';
  /** The outcome rule of a failed upload needs to know whether each attempt got a reply. */
  readonly recordAttempts: boolean;
  /** Whether the request is cut when the instance is disconnected. */
  readonly signal: boolean;
}

const STANDARD: RequestPolicy = {
  attempts: 'standard',
  idle: 'normal',
  recordAttempts: false,
  signal: true,
};

export const REQUEST_POLICY: Readonly<Record<S3Command, RequestPolicy>> = {
  listBuckets: STANDARD,
  listObjects: STANDARD,
  headObject: STANDARD,
  getObject: STANDARD,
  putObject: {
    attempts: 'once-when-exclusive',
    idle: 'normal',
    recordAttempts: true,
    signal: true,
  },
  // Sent without the signal, so the reply always arrives and a late upload ID is aborted.
  createMultipartUpload: { ...STANDARD, signal: false },
  uploadPart: STANDARD,
  completeMultipartUpload: {
    attempts: 'once-when-exclusive',
    idle: 'server-work',
    recordAttempts: true,
    signal: false,
  },
  // A cleanup task of disconnect(): it must reach the store after the instance's signal fired.
  abortMultipartUpload: { ...STANDARD, signal: false },
  copyObject: {
    attempts: 'once',
    idle: 'server-work',
    recordAttempts: true,
    signal: true,
  },
  deleteObject: STANDARD,
  createBucket: STANDARD,
  deleteBucket: STANDARD,
};

export const STANDARD_ATTEMPTS = 3;

/** The idle bound of the `server-work` commands: at least 10 minutes. */
export function serverWorkIdleMs(timeoutMs: number): number {
  return Math.max(timeoutMs, 600_000);
}

/** Whether `command` goes through a one-attempt client. */
export function sendsOnce(command: S3Command, exclusive: boolean): boolean {
  const { attempts } = REQUEST_POLICY[command];
  return (
    attempts === 'once' || (attempts === 'once-when-exclusive' && exclusive)
  );
}

/**
 * The region a reply redirects to (design Option 3B): HTTP 301, or HTTP 400
 * `IllegalLocationConstraintException`, with an `x-amz-bucket-region` that passes the region
 * rule. `undefined` for any other reply: a hostile region never reaches a host name or a signature.
 */
export function redirectRegion(failure: S3Failure): string | undefined {
  if (failure.kind !== 'reply') return undefined;
  const redirect =
    failure.status === 301 ||
    (failure.status === 400 &&
      failure.code === 'IllegalLocationConstraintException');
  if (!redirect) return undefined;
  return isRegion(failure.bucketRegion) ? failure.bucketRegion : undefined;
}
