import type { RemoteFsError } from '../fs/errors.js';
import { escapeUnsafeText } from '../text/escape.js';
import { isNonEmptyString } from '../text/non-empty.js';
import { invalidArgument } from './errors.js';
import { bucketProblem, endpointProblem, isRegion } from './validation.js';

export interface S3FileSystemOptions {
  /** Bucket-scoped when given: `/` is the root of that bucket. Account-wide when absent. */
  readonly bucket?: string;
  /** An `https:` URL with no user information, query, fragment or path. */
  readonly endpoint?: string;
  readonly region?: string;
  /** Absent: the standard AWS credential chain. */
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  /** The profile of the shared files; absent: `AWS_PROFILE`. */
  readonly profile?: string;
  /** Certificate authorities trusted in addition to Node's default roots. */
  readonly ca?: string | Buffer | readonly (string | Buffer)[];
  /** The longest wait for a connection, or for the next byte of a reply. Default 30000. */
  readonly timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ValidatedS3Options {
  readonly bucket: string | undefined;
  /** The endpoint's origin. */
  readonly endpoint: string | undefined;
  readonly region: string | undefined;
  readonly credentials:
    | {
        readonly accessKeyId: string;
        readonly secretAccessKey: string;
        readonly sessionToken?: string;
      }
    | undefined;
  readonly profile: string | undefined;
  readonly ca: string | Buffer | readonly (string | Buffer)[] | undefined;
  readonly timeoutMs: number;
}

const KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  'bucket',
  'endpoint',
  'region',
  'credentials',
  'profile',
  'ca',
  'timeoutMs',
]);

// No value of an option enters these messages, so no secret can: each names the option only.
function invalid(message: string): RemoteFsError {
  return invalidArgument(message);
}

function isCa(value: unknown): boolean {
  const one = (item: unknown): boolean =>
    typeof item === 'string' || Buffer.isBuffer(item);
  return one(value) || (Array.isArray(value) && value.every(one));
}

function validateCredentials(
  value: unknown,
): ValidatedS3Options['credentials'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(
      'the option credentials must be an object with accessKeyId and secretAccessKey',
    );
  }
  const { accessKeyId, secretAccessKey, sessionToken } = value as Record<
    string,
    unknown
  >;
  for (const name of Object.keys(value)) {
    if (!['accessKeyId', 'secretAccessKey', 'sessionToken'].includes(name)) {
      throw invalid(
        `the option credentials has an unknown key ${escapeUnsafeText(name).slice(0, 64)}`,
      );
    }
  }
  if (!isNonEmptyString(accessKeyId)) {
    throw invalid(
      'the option credentials.accessKeyId must be a non-empty string',
    );
  }
  if (!isNonEmptyString(secretAccessKey)) {
    throw invalid(
      'the option credentials.secretAccessKey must be a non-empty string',
    );
  }
  if (sessionToken !== undefined && !isNonEmptyString(sessionToken)) {
    throw invalid(
      'the option credentials.sessionToken must be a non-empty string when it is given',
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken === undefined ? {} : { sessionToken }),
  };
}

/**
 * Validates the options of `new S3FileSystem` (AC-4): a closed set of keys, each message naming
 * the option and never echoing a value. No I/O, no environment variable.
 */
export function validateS3Options(input: unknown): ValidatedS3Options {
  if (input === undefined) input = {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('the options must be an object');
  }
  const options = input as Record<string, unknown>;
  for (const name of Object.keys(options)) {
    if (!KNOWN_OPTIONS.has(name)) {
      throw invalid(
        `unknown option ${escapeUnsafeText(name).slice(0, 64)}; the options are ${[...KNOWN_OPTIONS].join(', ')}`,
      );
    }
  }
  const { bucket, endpoint, region, credentials, profile, ca, timeoutMs } =
    options;

  if (bucket !== undefined) {
    if (typeof bucket !== 'string') {
      throw invalid('the option bucket must be a string');
    }
    const problem = bucketProblem(bucket);
    if (problem !== undefined) {
      throw invalid(`the option bucket ${problem}`);
    }
  }
  let origin: string | undefined;
  if (endpoint !== undefined) {
    if (typeof endpoint !== 'string') {
      throw invalid('the option endpoint must be a string');
    }
    const problem = endpointProblem(endpoint);
    if (problem !== undefined) {
      throw invalid(`the option endpoint ${problem}`);
    }
    origin = new URL(endpoint).origin;
  }
  if (region !== undefined && !isRegion(region)) {
    throw invalid(
      'the option region must be a region name of lower-case letters, digits and -',
    );
  }
  if (profile !== undefined && !isNonEmptyString(profile)) {
    throw invalid('the option profile must be a non-empty string');
  }
  if (ca !== undefined && !isCa(ca)) {
    throw invalid(
      'the option ca must be a PEM string, a Buffer, or an array of them',
    );
  }
  if (
    timeoutMs !== undefined &&
    !(
      typeof timeoutMs === 'number' &&
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0
    )
  ) {
    throw invalid('the option timeoutMs must be a positive integer');
  }
  return {
    bucket: bucket,
    endpoint: origin,
    region: region,
    credentials:
      credentials === undefined ? undefined : validateCredentials(credentials),
    profile: profile,
    ca: ca as ValidatedS3Options['ca'],
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}
