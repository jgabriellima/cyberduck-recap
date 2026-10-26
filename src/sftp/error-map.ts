import { RemoteFsError, type RemoteFsErrorCode } from '../fs/errors.js';
import { sanitizeServerText } from './sanitize.js';

/** SFTP status codes (v3, plus FILE_ALREADY_EXISTS that some v5+ servers send). */
export const SFTP_STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
  FILE_ALREADY_EXISTS: 11,
} as const;

/** A server's status reply, kept apart from transport failures until an operation maps it. */
export class SftpStatusError extends Error {
  override readonly name = 'SftpStatusError';
  readonly status: number;
  readonly serverText: string;

  constructor(status: number, serverText: string) {
    super(`SFTP status ${status}`);
    this.status = status;
    this.serverText = serverText;
  }
}

/**
 * A reply that lacks what its request needs (no handle for OPEN, no attributes for STAT, no names
 * for READDIR): the server is broken or hostile, but the session itself is still usable.
 */
export class MalformedReplyError extends Error {
  override readonly name = 'MalformedReplyError';

  constructor(what: string) {
    super(`the server's reply carried no ${what}`);
  }
}

// These reads run inside ssh2 event handlers and callbacks: a getter or Proxy trap that throws
// there escapes as an uncaught exception instead of a RemoteFsError, so a throwing read counts
// as an absent property.
function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** ssh2 marks a server status reply with a numeric `code`; anything else is a transport failure. */
export function statusOf(error: unknown): number | undefined {
  const code = readProperty(error, 'code');
  return typeof code === 'number' ? code : undefined;
}

export interface OperationContext {
  /** The operation's name as callers know it, e.g. `list`. */
  readonly operation: string;
  readonly path?: string;
  readonly targetPath?: string;
}

function subject(context: OperationContext): string {
  if (context.path === undefined) return context.operation;
  if (context.targetPath === undefined) {
    return `${context.operation} ${context.path}`;
  }
  return `${context.operation} ${context.path} to ${context.targetPath}`;
}

function details(context: OperationContext): {
  path?: string;
  targetPath?: string;
} {
  return {
    ...(context.path === undefined ? {} : { path: context.path }),
    ...(context.targetPath === undefined
      ? {}
      : { targetPath: context.targetPath }),
  };
}

export function operationError(
  code: RemoteFsErrorCode,
  context: OperationContext,
  reason: string,
): RemoteFsError {
  return new RemoteFsError(
    code,
    `${subject(context)}: ${reason}`,
    details(context),
  );
}

const REASONS: Partial<Record<RemoteFsErrorCode, string>> = {
  NOT_FOUND: 'no such file or directory',
  PERMISSION_DENIED: 'permission denied',
  ALREADY_EXISTS: 'already exists',
  NOT_A_DIRECTORY: 'not a directory',
  IS_A_DIRECTORY: 'is a directory',
  CONNECTION_LOST: 'the connection was lost',
  NOT_CONNECTED: 'not connected',
};

export function reasonFor(code: RemoteFsErrorCode): string {
  return REASONS[code] ?? 'the operation failed';
}

/**
 * The status-to-code table (M-2). FAILURE is ambiguous in SFTP v3, so operations that can tell its
 * meaning apart (mkdir, list, streams) do so with a `stat` before falling back to this table.
 */
export function mapStatus(
  status: number,
  serverText: string,
  context: OperationContext,
): RemoteFsError {
  switch (status) {
    case SFTP_STATUS.NO_SUCH_FILE:
      return operationError('NOT_FOUND', context, reasonFor('NOT_FOUND'));
    case SFTP_STATUS.PERMISSION_DENIED:
      return operationError(
        'PERMISSION_DENIED',
        context,
        reasonFor('PERMISSION_DENIED'),
      );
    case SFTP_STATUS.FILE_ALREADY_EXISTS:
      return operationError(
        'ALREADY_EXISTS',
        context,
        reasonFor('ALREADY_EXISTS'),
      );
    case SFTP_STATUS.NO_CONNECTION:
    case SFTP_STATUS.CONNECTION_LOST:
      return operationError(
        'CONNECTION_LOST',
        context,
        reasonFor('CONNECTION_LOST'),
      );
    default: {
      const text = sanitizeServerText(serverText);
      return operationError(
        'OPERATION_FAILED',
        context,
        text === '' ? `server status ${status}` : `server said "${text}"`,
      );
    }
  }
}

/** Puts the operation's paths on whatever a session or channel failure produced. */
export function toRemoteFsError(
  error: unknown,
  context: OperationContext,
): RemoteFsError {
  if (error instanceof SftpStatusError) {
    return mapStatus(error.status, error.serverText, context);
  }
  if (error instanceof MalformedReplyError) {
    return operationError('OPERATION_FAILED', context, error.message);
  }
  if (error instanceof RemoteFsError) {
    if (error.path !== undefined) return error;
    return operationError(error.code, context, reasonFor(error.code));
  }
  return operationError(
    'OPERATION_FAILED',
    context,
    'unexpected client failure',
  );
}

/**
 * A cause that keeps only a message and a code: never the original object graph, which for ssh2
 * can reach the client and its configuration (S-6).
 */
export function sanitizedCause(error: unknown): Error {
  // It builds the cause inside ssh2 handlers, so a throwing trap or getter must not escape.
  let message: string;
  try {
    message =
      error instanceof Error ? sanitizeServerText(error.message) : 'unknown';
  } catch {
    message = 'unknown';
  }
  const cause = new Error(message);
  const code = readProperty(error, 'code');
  if (typeof code === 'string' || typeof code === 'number') {
    Object.defineProperty(cause, 'code', { value: code, enumerable: true });
  }
  return cause;
}

export interface Ssh2ConnectError {
  readonly level?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

/** Connection-phase classification of ssh2's own errors, used when our code recorded nothing. */
export function classifyConnectError(
  error: Ssh2ConnectError,
): RemoteFsErrorCode {
  return readProperty(error, 'level') === 'client-authentication'
    ? 'AUTH_FAILED'
    : 'CONNECTION_FAILED';
}
