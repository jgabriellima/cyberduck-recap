import { isIPv4, isIPv6 } from 'node:net';
import type { HostKeyInfo } from '../fs/backend.js';
import { RemoteFsError } from '../fs/errors.js';

// The protocol-neutral contract (src/fs/backend.ts) owns the shape; re-exported so the SFTP
// options keep their public name.
export type { HostKeyInfo };

export interface SftpFileSystemOptions {
  readonly host: string;
  readonly port?: number;
  readonly username: string;
  readonly password?: string;
  readonly privateKey?: string | Buffer;
  readonly passphrase?: string | Buffer;
  /** OpenSSH-format known_hosts file; required, because host-key verification cannot be off. */
  readonly knownHostsPath: string;
  readonly confirmHostKey?: (key: HostKeyInfo) => Promise<boolean>;
  readonly connectTimeoutMs?: number;
}

export type Credentials =
  | { readonly kind: 'password'; readonly password: string }
  | {
      readonly kind: 'privateKey';
      readonly privateKey: string | Buffer;
      readonly passphrase: string | Buffer | undefined;
    };

export interface ValidatedOptions {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly credentials: Credentials;
  readonly knownHostsPath: string;
  readonly confirmHostKey: ((key: HostKeyInfo) => Promise<boolean>) | undefined;
  readonly connectTimeoutMs: number;
}

export const DEFAULT_PORT = 22;
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;

// A closed set: an option such as `hostVerifier` or `strictHostKeyChecking` must never be able to
// weaken host-key verification, so anything not listed is refused rather than ignored.
const KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  'host',
  'port',
  'username',
  'password',
  'privateKey',
  'passphrase',
  'knownHostsPath',
  'confirmHostKey',
  'connectTimeoutMs',
]);

// Messages name the option and never echo its value: the value may be a credential.
function invalid(option: string, requirement: string): RemoteFsError {
  return new RemoteFsError(
    'INVALID_ARGUMENT',
    `invalid option "${option}": ${requirement}`,
  );
}

const HOST_LABEL = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/;

/**
 * G-1: only a DNS name or an IP literal, so a host can never smuggle a host list, a pattern, a
 * hashed-entry marker or a second line into known_hosts.
 */
export function isValidHost(host: string): boolean {
  if (isIPv4(host)) return true;
  if (isIPv6(host)) return !host.includes('%');
  if (host.length < 1 || host.length > 253) return false;
  return host.split('.').every((label) => HOST_LABEL.test(label));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSecretValue(value: unknown): value is string | Buffer {
  return typeof value === 'string' || Buffer.isBuffer(value);
}

/**
 * The host, user name and port checks of `validateOptions`, in its order and with its messages, for
 * a caller that has an endpoint before it has a credential (the CLI checks a URL before it asks
 * for a password). One source, so the two can never report a different message.
 */
export function validateEndpoint(options: Record<string, unknown>): {
  readonly host: string;
  readonly port: number;
  readonly username: string;
} {
  const { host, username } = options;
  if (!isNonEmptyString(host))
    throw invalid('host', 'must be a non-empty string');
  if (!isValidHost(host)) {
    throw invalid('host', 'must be a DNS host name or an IP address');
  }
  if (!isNonEmptyString(username)) {
    throw invalid('username', 'must be a non-empty string');
  }

  const port = options['port'] ?? DEFAULT_PORT;
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw invalid('port', 'must be an integer from 1 to 65535');
  }
  return { host, port, username };
}

export function validateOptions(input: unknown): ValidatedOptions {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('options', 'must be an object');
  }
  const options = input as Record<string, unknown>;
  for (const key of Object.keys(options)) {
    if (!KNOWN_OPTIONS.has(key)) {
      throw new RemoteFsError(
        'INVALID_ARGUMENT',
        `unknown option "${key}": host-key verification and credentials are configured only through the documented options`,
      );
    }
  }

  const { host, port, username } = validateEndpoint(options);
  const { knownHostsPath } = options;

  const credentials = validateCredentials(options);

  if (!isNonEmptyString(knownHostsPath)) {
    throw invalid('knownHostsPath', 'must be a non-empty string');
  }

  const confirmHostKey = options['confirmHostKey'];
  if (confirmHostKey !== undefined && typeof confirmHostKey !== 'function') {
    throw invalid('confirmHostKey', 'must be a function');
  }

  const connectTimeoutMs =
    options['connectTimeoutMs'] ?? DEFAULT_CONNECT_TIMEOUT_MS;
  if (
    typeof connectTimeoutMs !== 'number' ||
    !Number.isInteger(connectTimeoutMs) ||
    connectTimeoutMs <= 0
  ) {
    throw invalid('connectTimeoutMs', 'must be a positive integer');
  }

  return {
    host,
    port,
    username,
    credentials,
    knownHostsPath,
    confirmHostKey: confirmHostKey as ValidatedOptions['confirmHostKey'],
    connectTimeoutMs,
  };
}

function validateCredentials(options: Record<string, unknown>): Credentials {
  const { password, privateKey, passphrase } = options;
  const hasPassword = password !== undefined;
  const hasKey = privateKey !== undefined;
  if (hasPassword && hasKey) {
    throw invalid(
      'password',
      'give either "password" or "privateKey", not both',
    );
  }
  if (!hasPassword && !hasKey) {
    throw invalid('password', 'give one of "password" or "privateKey"');
  }
  if (passphrase !== undefined && !hasKey) {
    throw invalid('passphrase', 'is only allowed with "privateKey"');
  }
  if (hasPassword) {
    if (typeof password !== 'string') {
      throw invalid('password', 'must be a string');
    }
    return { kind: 'password', password };
  }
  if (!isSecretValue(privateKey)) {
    throw invalid('privateKey', 'must be a string or a Buffer');
  }
  if (passphrase !== undefined && !isSecretValue(passphrase)) {
    throw invalid('passphrase', 'must be a string or a Buffer');
  }
  return { kind: 'privateKey', privateKey, passphrase };
}
