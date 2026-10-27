import type { RemoteFsErrorCode } from '../fs/errors.js';

/** The codes the CLI reports itself, beside the codes of `RemoteFsError`. */
export type CliErrorCode = 'INTERNAL' | 'USAGE' | 'LOCAL_FILE' | 'CANCELLED';

// A Record over every RemoteFsErrorCode: a new code without an exit code fails the type check.
export const REMOTE_EXIT_CODES: Readonly<Record<RemoteFsErrorCode, number>> = {
  AUTH_FAILED: 10,
  HOST_KEY_UNKNOWN: 11,
  HOST_KEY_CHANGED: 12,
  CONNECTION_FAILED: 13,
  CONNECTION_LOST: 14,
  NOT_CONNECTED: 15,
  NOT_FOUND: 16,
  PERMISSION_DENIED: 17,
  ALREADY_EXISTS: 18,
  NOT_A_DIRECTORY: 19,
  IS_A_DIRECTORY: 20,
  INVALID_ARGUMENT: 21,
  OPERATION_FAILED: 22,
};

export const CLI_EXIT_CODES: Readonly<Record<CliErrorCode, number>> = {
  INTERNAL: 1,
  USAGE: 2,
  LOCAL_FILE: 3,
  CANCELLED: 130,
};

/** What each exit code means, in the order `--help` prints them. */
export const EXIT_CODE_TABLE: readonly (readonly [number, string, string])[] = [
  [0, '', 'the command succeeded'],
  [CLI_EXIT_CODES.INTERNAL, 'INTERNAL', 'a defect of the program'],
  [
    CLI_EXIT_CODES.USAGE,
    'USAGE',
    'a wrong command line or URL, or no credential',
  ],
  [CLI_EXIT_CODES.LOCAL_FILE, 'LOCAL_FILE', 'a local file cannot be used'],
  ...Object.entries(REMOTE_EXIT_CODES).map(
    ([code, exit]) => [exit, code, 'reported by the back-end'] as const,
  ),
  [CLI_EXIT_CODES.CANCELLED, 'CANCELLED', 'the password prompt was cancelled'],
];
