export const REMOTE_FS_ERROR_CODES = [
  'AUTH_FAILED',
  'HOST_KEY_UNKNOWN',
  'HOST_KEY_CHANGED',
  'CONNECTION_FAILED',
  'CONNECTION_LOST',
  'NOT_CONNECTED',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'ALREADY_EXISTS',
  'NOT_A_DIRECTORY',
  'IS_A_DIRECTORY',
  'INVALID_ARGUMENT',
  'OPERATION_FAILED',
] as const;

export type RemoteFsErrorCode = (typeof REMOTE_FS_ERROR_CODES)[number];

export interface RemoteFsErrorDetails {
  readonly path?: string;
  readonly targetPath?: string;
  readonly expectedFingerprints?: readonly string[];
  readonly presentedFingerprint?: string;
  /** Back-ends pass only a sanitised cause, never a protocol library's own error object. */
  readonly cause?: Error;
}

/** The one error type every back-end reports, so callers branch on `code`, never on a protocol. */
export class RemoteFsError extends Error {
  override readonly name = 'RemoteFsError';
  readonly code: RemoteFsErrorCode;
  declare readonly path?: string;
  declare readonly targetPath?: string;
  declare readonly expectedFingerprints?: readonly string[];
  declare readonly presentedFingerprint?: string;

  constructor(
    code: RemoteFsErrorCode,
    message: string,
    details: RemoteFsErrorDetails = {},
  ) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.code = code;
    // Absent details stay absent rather than `undefined`, so inspected errors show only what applies.
    const optional: Record<string, unknown> = {
      path: details.path,
      targetPath: details.targetPath,
      expectedFingerprints: details.expectedFingerprints,
      presentedFingerprint: details.presentedFingerprint,
    };
    for (const [key, value] of Object.entries(optional)) {
      if (value !== undefined) {
        Object.defineProperty(this, key, {
          value,
          enumerable: true,
          writable: false,
        });
      }
    }
  }
}

export function isRemoteFsError(value: unknown): value is RemoteFsError {
  return value instanceof RemoteFsError;
}
