/**
 * The one output point of the S3 back-end (design Option 6A): every RemoteFsError that `src/s3/`
 * makes is built by `S3Errors.fail`, which receives the whole message and redacts every known
 * secret in it. Server text enters a message only through `serverText`, an S3 code only through
 * `replyCode` (checked against `S3_CODE`), a Node error code only through `errnoText`. The
 * tables more than one module needs (the code map, the AUTH_FAILED codes, the permissions, the
 * remedies) are here only (cyberduck/standard.single-source).
 */
import {
  RemoteFsError,
  type RemoteFsErrorCode,
  type RemoteFsErrorDetails,
} from '../fs/errors.js';
import { escapeUnsafeText } from '../text/escape.js';
import type { S3Location } from './paths.js';
import type { SecretSet } from './secrets.js';
import { tlsCauseOf } from './tls.js';
import type { S3Failure } from './transport.js';
import { COMMAND_SAFE } from './validation.js';

/** Codes with which a store refuses the keys or the signature: AUTH_FAILED, never a permission. */
export const AUTH_FAILED_CODES: ReadonlySet<string> = new Set([
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'ExpiredToken',
  'InvalidToken',
  'TokenRefreshRequired',
  'RequestTimeTooSkewed',
]);

const CHECK_KEYS_CODES: ReadonlySet<string> = new Set([
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
]);

const NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  'NoSuchBucket',
  'NoSuchKey',
  'NoSuchUpload',
  'NotFound',
]);

const ALREADY_EXISTS_CODES: ReadonlySet<string> = new Set([
  'PreconditionFailed',
  'ConditionalRequestConflict',
  'BucketAlreadyExists',
  'BucketAlreadyOwnedByYou',
]);

/** A reply with no code of its own (a HEAD reply has no body) takes the code S3 means by it. */
const CODE_OF_STATUS: Readonly<Record<number, string>> = {
  301: 'PermanentRedirect',
  403: 'AccessDenied',
  404: 'NotFound',
  412: 'PreconditionFailed',
};

const S3_CODE = /^[A-Za-z0-9.]{1,64}$/;
const ERRNO = /^[A-Z0-9_]+$/;
const SERVER_TEXT_LIMIT = 500;

export type Action =
  | 'connect'
  | 'list'
  | 'stat'
  | 'read'
  | 'write'
  | 'mkdir'
  | 'remove'
  | 'rename';

/** The S3 permissions of each operation (spec "Errors"); a bucket path has its own. */
function permissionsOf(
  action: Action,
  location: S3Location,
): readonly string[] {
  const bucketItself = location.key === undefined;
  switch (action) {
    case 'connect':
    case 'list':
      return location.bucket === undefined
        ? ['s3:ListAllMyBuckets']
        : ['s3:ListBucket'];
    case 'stat':
      return ['s3:GetObject', 's3:ListBucket'];
    case 'read':
      return ['s3:GetObject'];
    case 'write':
      return ['s3:PutObject'];
    case 'mkdir':
      return bucketItself && !location.root
        ? ['s3:CreateBucket']
        : ['s3:PutObject'];
    case 'remove':
      return bucketItself && !location.root
        ? ['s3:DeleteBucket']
        : ['s3:DeleteObject'];
    case 'rename':
      return ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'];
  }
}

const VERBS: Readonly<Record<Action, string>> = {
  connect: 'connect to',
  list: 'list',
  stat: 'read the attributes of',
  read: 'read',
  write: 'write',
  mkdir: 'create',
  remove: 'remove',
  rename: 'rename',
};

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;
}

/**
 * The object URL of spec "Errors": `s3://<bucket>/<key>`, `s3://<bucket>`, `s3://`. The bucket and
 * the key are text, not percent-encoded, and escaped like server text.
 */
export function objectUrl(
  location: Pick<S3Location, 'bucket' | 'key'>,
): string {
  if (location.bucket === undefined) return 's3://';
  const bucket = escapeUnsafeText(location.bucket);
  return location.key === undefined
    ? `s3://${bucket}`
    : `s3://${bucket}/${escapeUnsafeText(location.key)}`;
}

/** The phrase of an upload that failed before the store could have created the object. */
export function noObjectWritten(location: S3Location): string {
  return `no object was written to ${objectUrl(location)}`;
}

/** The phrase of an upload whose completing request may have succeeded. */
export function mayHaveBeenWritten(location: S3Location): string {
  return `the object at ${objectUrl(location)} may have been written; check it with stat (ls in the CLI)`;
}

export const EXCLUSIVE_REFUSED =
  'exclusive create (If-None-Match) is not supported by the store; write with exclusive: false (--overwrite in the CLI) to replace';

/** A store that refuses `If-None-Match: *`: HTTP 501, or HTTP 400 whose message names it. */
export function isExclusiveRefusal(failure: S3Failure): boolean {
  if (failure.kind !== 'reply') return false;
  if (failure.status === 501 || failure.code === 'NotImplemented') return true;
  return (
    failure.status === 400 &&
    (failure.serverMessage ?? '').toLowerCase().includes('if-none-match')
  );
}

/** The S3 code of a reply: its own, else the one its status means, else `undefined`. */
export function replyCode(failure: S3Failure): string | undefined {
  if (failure.kind !== 'reply') return undefined;
  if (failure.code !== undefined && S3_CODE.test(failure.code)) {
    return failure.code;
  }
  if (failure.code !== undefined) return undefined;
  return CODE_OF_STATUS[failure.status];
}

/**
 * Whether a failed request on key `k` means that no object `k` exists: the one rule of the stat,
 * the read, the write and every check that comes before a change.
 */
export function isNoSuchObject(failure: S3Failure): boolean {
  return (
    failure.kind === 'reply' &&
    codeOf(failure) === 'NOT_FOUND' &&
    failure.code !== 'NoSuchBucket'
  );
}

/** The RemoteFsError code of a failure of an operation (not of the probe). */
export function codeOf(failure: S3Failure): RemoteFsErrorCode {
  switch (failure.kind) {
    case 'no-reply':
      return 'CONNECTION_LOST';
    case 'tls':
      return 'CONNECTION_FAILED';
    case 'aborted':
      return 'NOT_CONNECTED';
    case 'credentials':
      return 'AUTH_FAILED';
    case 'malformed':
    case 'request':
      return 'OPERATION_FAILED';
    case 'reply':
      break;
  }
  const code = replyCode(failure);
  if (code !== undefined) {
    if (AUTH_FAILED_CODES.has(code)) return 'AUTH_FAILED';
    if (code === 'InvalidObjectState') return 'OPERATION_FAILED';
    if (NOT_FOUND_CODES.has(code)) return 'NOT_FOUND';
    if (ALREADY_EXISTS_CODES.has(code)) return 'ALREADY_EXISTS';
  }
  if (failure.status === 404) return 'NOT_FOUND';
  if (failure.status === 403) return 'PERMISSION_DENIED';
  return 'OPERATION_FAILED';
}

/**
 * The remedy of `aws s3api abort-multipart-upload` for an upload that could not be aborted. The
 * key and the upload ID can come from a hostile store, so a command line is printed only when
 * every raw value is in COMMAND_SAFE, each in single quotes; else the values are listed apart,
 * escaped and quoted, and no command is printed.
 */
export function abortRemedy(
  bucket: string,
  key: string,
  uploadId: string,
): string {
  if ([bucket, key, uploadId].every((value) => COMMAND_SAFE.test(value))) {
    return `aws s3api abort-multipart-upload --bucket '${bucket}' --key '${key}' --upload-id '${uploadId}'`;
  }
  const quoted = (value: string): string =>
    `'${escapeUnsafeText(value).replaceAll("'", "'\\''")}'`;
  return `the command aws s3api abort-multipart-upload with these values: bucket ${quoted(bucket)}, key ${quoted(key)}, upload ID ${quoted(uploadId)}`;
}

export interface ErrorContext {
  /** The endpoint's host, named when a bucket does not exist on it. */
  readonly endpointHost: string;
  /** Where the keys came from: `option credentials`, `environment` or `profile <name>`. */
  readonly keySource: string;
  readonly timeoutMs: number;
}

/**
 * INVALID_ARGUMENT for a value the caller gave, before an instance has secrets to redact: its
 * message names the value's place, never the value.
 */
export function invalidArgument(message: string, path?: string): RemoteFsError {
  return new RemoteFsError(
    'INVALID_ARGUMENT',
    message,
    path === undefined ? {} : { path },
  );
}

/** The one constructor of every RemoteFsError of `src/s3/`, and the one redaction point. */
export class S3Errors {
  readonly #secrets: SecretSet;
  context: ErrorContext;

  constructor(secrets: SecretSet, context: ErrorContext) {
    this.#secrets = secrets;
    this.context = context;
  }

  /** Redacts the whole message, then builds the error. Never sets `cause`. */
  fail(
    code: RemoteFsErrorCode,
    message: string,
    details: Omit<RemoteFsErrorDetails, 'cause'> = {},
  ): RemoteFsError {
    return new RemoteFsError(code, this.#secrets.redact(message), {
      ...(details.path === undefined ? {} : { path: details.path }),
      ...(details.targetPath === undefined
        ? {}
        : { targetPath: details.targetPath }),
    });
  }

  /**
   * Server text: redacted while raw (so a cut never leaves part of a secret), escaped, then cut to
   * 500 code points with one `…`. A code point is never split.
   */
  serverText(raw: string): string {
    const escaped = escapeUnsafeText(this.#secrets.redact(raw));
    const codePoints = Array.from(escaped);
    return codePoints.length > SERVER_TEXT_LIMIT
      ? `${codePoints.slice(0, SERVER_TEXT_LIMIT).join('')}…`
      : escaped;
  }

  notConnected(path: string | undefined): RemoteFsError {
    return this.fail(
      'NOT_CONNECTED',
      'the S3 file system is not connected; call connect() first',
      path === undefined ? {} : { path },
    );
  }

  /** What the person must fix after a reply of the store, `''` when nothing applies. */
  remedyOf(failure: S3Failure, action: Action, location: S3Location): string {
    if (failure.kind !== 'reply') return '';
    const code = replyCode(failure);
    if (code === 'NoSuchBucket' && location.bucket !== undefined) {
      return `; the bucket ${escapeUnsafeText(location.bucket)} does not exist on ${escapeUnsafeText(this.context.endpointHost)}`;
    }
    if (code === 'RequestTimeTooSkewed') {
      return "; the local clock differs from the server's clock; set the local clock";
    }
    if (code !== undefined && AUTH_FAILED_CODES.has(code)) {
      const fix = CHECK_KEYS_CODES.has(code)
        ? 'check the access key and secret access key'
        : 'refresh the session token';
      return `; the keys came from ${this.context.keySource}; ${fix}`;
    }
    if (codeOf(failure) === 'PERMISSION_DENIED') {
      const permissions = permissionsOf(action, location);
      const noun = permissions.length === 1 ? 'permission' : 'permissions';
      return `; it needs the S3 ${noun} ${joinWords(permissions)}`;
    }
    if (failure.status === 301 && failure.bucketRegion !== undefined) {
      return `; the store redirected the request to the region ${this.serverText(failure.bucketRegion)}`;
    }
    return '';
  }

  /** What happened, after `cannot <verb> <url>: `. */
  describe(failure: S3Failure): string {
    switch (failure.kind) {
      case 'reply': {
        const code = replyCode(failure);
        const named =
          code ??
          (failure.code === undefined
            ? `HTTP ${failure.status}`
            : 'an unknown error');
        const text =
          failure.serverMessage === undefined || failure.serverMessage === ''
            ? ''
            : `: ${this.serverText(failure.serverMessage)}`;
        return `${named}${text}`;
      }
      case 'no-reply':
        return failure.timeout
          ? `the store sent nothing for ${this.context.timeoutMs} ms`
          : `the connection was lost${errnoText(failure.errno)}`;
      case 'tls':
        return describeTls(failure.errno, failure.host, undefined);
      case 'malformed':
        return 'the store sent a reply that is not valid for the request';
      case 'aborted':
        return 'the S3 file system was disconnected';
      case 'credentials':
        return `the AWS credentials from ${this.context.keySource} could not be refreshed`;
      case 'request':
        return 'the request could not be built';
    }
  }

  /** The error of a failed request of an operation, with its path (and target path). */
  fromFailure(
    failure: S3Failure,
    action: Action,
    location: S3Location,
    options: {
      readonly target?: S3Location;
      readonly code?: RemoteFsErrorCode;
      /** Appended to the message: what became of the object. */
      readonly outcome?: string;
    } = {},
  ): RemoteFsError {
    const subject =
      options.target === undefined
        ? objectUrl(location)
        : `${objectUrl(location)} to ${objectUrl(options.target)}`;
    const outcome = options.outcome === undefined ? '' : `; ${options.outcome}`;
    const message = `cannot ${VERBS[action]} ${subject}: ${this.describe(failure)}${this.remedyOf(failure, action, location)}${outcome}`;
    return this.fail(options.code ?? codeOf(failure), message, {
      path: location.path,
      ...(options.target === undefined
        ? {}
        : { targetPath: options.target.path }),
    });
  }
}

/** The cause of a TLS failure and what the person must fix; never a way to turn the check off. */
export function describeTls(
  errno: string,
  host: string,
  expiredOn: string | undefined,
): string {
  const shownHost = escapeUnsafeText(host);
  switch (tlsCauseOf(errno)) {
    case 'untrusted':
      return `the certificate of ${shownHost} is issued by an authority that is not trusted; trust the authority with AWS_CA_BUNDLE (a PEM file) or the option ca`;
    case 'expired':
      return `the certificate of ${shownHost} expired${expiredOn === undefined ? '' : ` on ${expiredOn}`}; the server's operator must renew it`;
    case 'host':
      return `the certificate of the server is not valid for ${shownHost}`;
    default:
      return `the TLS handshake with ${shownHost} failed${errnoText(errno)}`;
  }
}

/** ` (<code>)` for a Node error code of the expected shape; `''` for none or any other text. */
function errnoText(errno: string | undefined): string {
  return errno !== undefined && ERRNO.test(errno) ? ` (${errno})` : '';
}
