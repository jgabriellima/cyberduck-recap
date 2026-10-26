import ssh2 from 'ssh2';
import type {
  AnyAuthMethod,
  AuthHandlerMiddleware,
  ConnectConfig,
  FileEntry,
  ParsedKey,
  SFTPWrapper,
  ServerHostKeyAlgorithm,
  Stats,
} from 'ssh2';
import { RemoteFsError } from '../fs/errors.js';
import { serverHostKeyAlgorithms } from './algorithms.js';
import {
  MalformedReplyError,
  classifyConnectError,
  sanitizedCause,
} from './error-map.js';
import { fingerprint, keyType } from './host-key.js';
import {
  appendKnownHost,
  knownKeyTypes,
  matchHost,
  readKnownHosts,
} from './known-hosts.js';
import type { ValidatedOptions } from './options.js';
import { Session, type SessionTransport, type SftpChannel } from './session.js';

const { Client, utils } = ssh2;

const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 3;

export interface ConnectInternals {
  /** Test hook for the stall watchdog threshold (G-6); not reachable through options. */
  readonly stallTimeoutMs?: number;
}

export interface ConnectAttempt {
  readonly session: Promise<Session>;
  /** Abandons the attempt; `session` then rejects with CONNECTION_FAILED. */
  cancel(): void;
}

/**
 * A timer whose clock stops while a person decides on a host key, so `connectTimeoutMs` bounds
 * only the network and never the person (AC-27).
 */
class PausableTimer {
  #remaining: number;
  #startedAt = 0;
  #timer: NodeJS.Timeout | undefined;
  readonly #onExpire: () => void;

  constructor(ms: number, onExpire: () => void) {
    this.#remaining = ms;
    this.#onExpire = onExpire;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#startedAt = Date.now();
    this.#timer = setTimeout(this.#onExpire, Math.max(this.#remaining, 0));
  }

  pause(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#remaining -= Date.now() - this.#startedAt;
  }

  clear(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

function authFailed(
  username: string,
  host: string,
  port: number,
  why: string,
): RemoteFsError {
  return new RemoteFsError(
    'AUTH_FAILED',
    `authentication of user "${username}" on ${host}:${port} failed: ${why}`,
  );
}

/**
 * Step 3: the key is parsed before any I/O, so a wrong value (a file path instead of the key) or a
 * wrong passphrase fails without a connection. No cause is attached: it could quote key material.
 */
function parsePrivateKey(options: ValidatedOptions): ParsedKey | undefined {
  const { credentials, username, host, port } = options;
  if (credentials.kind !== 'privateKey') return undefined;
  const parsed = utils.parseKey(credentials.privateKey, credentials.passphrase);
  if (!(parsed instanceof Error) && parsed.isPrivateKey()) return parsed;
  if (credentials.passphrase !== undefined) {
    const withoutPassphrase = utils.parseKey(credentials.privateKey);
    const encrypted =
      withoutPassphrase instanceof Error &&
      /encrypted/i.test(withoutPassphrase.message);
    if (encrypted) {
      throw authFailed(
        username,
        host,
        port,
        'the private key could not be decrypted with the given passphrase',
      );
    }
  }
  throw authFailed(username, host, port, 'the private key could not be parsed');
}

type Reply<T> = (error: Error | undefined, value?: T) => void;

/**
 * Passes a successful reply on only when it carries what the request needs. ssh2 hands a bare OK
 * status to the callback with no value, which would otherwise surface as `undefined` (ATK-11).
 */
function expecting<T>(
  what: string,
  isValid: (value: unknown) => value is T,
  callback: Reply<T>,
): (error: Error | undefined | null, value?: unknown) => void {
  return (error, value) => {
    if (error) callback(error);
    else if (isValid(value)) callback(undefined, value);
    else callback(new MalformedReplyError(what));
  };
}

const isHandle = (value: unknown): value is Buffer => Buffer.isBuffer(value);
const isAttributes = (value: unknown): value is Stats =>
  typeof value === 'object' && value !== null;
const isEntryList = (value: unknown): value is FileEntry[] =>
  Array.isArray(value) &&
  value.every(
    (entry: unknown) =>
      isAttributes(entry) &&
      typeof (entry as { filename?: unknown }).filename === 'string' &&
      isAttributes((entry as { attrs?: unknown }).attrs),
  );

/** ssh2 accepts readdir options at runtime; @types/ssh2 lags the library and omits them (M-6). */
interface SftpWithReaddirOptions {
  readdir(
    handle: Buffer,
    options: { readonly full: boolean },
    callback: (error: Error | undefined, list?: unknown) => void,
  ): void;
}

/** Adapts ssh2's SFTP object to the channel the session drives. Exported for unit tests. */
export function toChannel(sftp: SFTPWrapper): SftpChannel {
  return {
    open: (path, mode, callback) =>
      sftp.open(path, mode, expecting('file handle', isHandle, callback)),
    close: (handle, callback) => sftp.close(handle, (error) => callback(error)),
    read: (handle, position, length, callback) => {
      const buffer = Buffer.alloc(length);
      const onRead = (error: Error | undefined, bytesRead: unknown): void => {
        if (error) callback(error);
        else if (typeof bytesRead !== 'number') {
          callback(new MalformedReplyError('data'));
        } else callback(undefined, buffer.subarray(0, bytesRead));
      };
      // ssh2's own readFile sets this flag: without it EOF reads as a zero-length success, which
      // could not be told apart from an empty reply (G-5).
      Object.assign(onRead, { _wantEOFError: true });
      sftp.read(handle, buffer, 0, length, position, onRead);
    },
    write: (handle, position, data, callback) =>
      sftp.write(handle, data, 0, data.length, position, (error) =>
        callback(error),
      ),
    opendir: (path, callback) =>
      sftp.opendir(path, expecting('directory handle', isHandle, callback)),
    // `full: true` skips ssh2's own `.`/`..` filter, which throws inside ssh2 on a reply without
    // names; the operations drop those entries themselves.
    readdir: (handle, callback) =>
      (sftp as unknown as SftpWithReaddirOptions).readdir(
        handle,
        { full: true },
        expecting('directory entries', isEntryList, callback),
      ),
    stat: (path, callback) =>
      sftp.stat(path, expecting('attributes', isAttributes, callback)),
    lstat: (path, callback) =>
      sftp.lstat(path, expecting('attributes', isAttributes, callback)),
    mkdir: (path, callback) => sftp.mkdir(path, (error) => callback(error)),
    rmdir: (path, callback) => sftp.rmdir(path, (error) => callback(error)),
    unlink: (path, callback) => sftp.unlink(path, (error) => callback(error)),
    rename: (from, to, callback) =>
      sftp.rename(from, to, (error) => callback(error)),
  };
}

/**
 * The connect sequence (design steps 3 to 9). Its ordering is the security contract: the host key
 * is judged, and a confirmed key recorded, before any credential leaves the process.
 */
export function openSession(
  options: ValidatedOptions,
  internals: ConnectInternals = {},
): ConnectAttempt {
  let cancel: (() => void) | undefined;
  let cancelled = false;
  const session = (async (): Promise<Session> => {
    const privateKey = parsePrivateKey(options);
    const knownHosts = await readKnownHosts(options.knownHostsPath);
    if (cancelled) throw cancelledError(options);
    return handshake(options, internals, privateKey, knownHosts, (fn) => {
      cancel = fn;
    });
  })();
  return {
    session,
    cancel: () => {
      cancelled = true;
      cancel?.();
    },
  };
}

function cancelledError(options: ValidatedOptions): RemoteFsError {
  return new RemoteFsError(
    'CONNECTION_FAILED',
    `connection to ${options.host}:${options.port} was cancelled by disconnect()`,
  );
}

function handshake(
  options: ValidatedOptions,
  internals: ConnectInternals,
  privateKey: ParsedKey | undefined,
  knownHosts: Awaited<ReturnType<typeof readKnownHosts>>,
  setCancel: (cancel: () => void) => void,
): Promise<Session> {
  const { host, port, username, credentials } = options;
  const where = `${host}:${port}`;

  return new Promise<Session>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let recorded: RemoteFsError | undefined;
    let pendingRecord: Buffer | undefined;
    let acceptedKey: Buffer | undefined;
    let authCalls = 0;
    let socketClosed = false;
    let established = false;

    const fail = (error: RemoteFsError): void => {
      if (settled) return;
      settled = true;
      timer.clear();
      client.destroy();
      reject(error);
    };
    const timer = new PausableTimer(options.connectTimeoutMs, () =>
      fail(
        new RemoteFsError(
          'CONNECTION_FAILED',
          `connection to ${where} timed out after ${options.connectTimeoutMs} ms`,
        ),
      ),
    );
    setCancel(() => fail(cancelledError(options)));

    const judgeHostKey = async (blob: Buffer): Promise<boolean> => {
      // A re-key on an established session must present the key accepted at connect.
      if (acceptedKey !== undefined) return acceptedKey.equals(blob);
      const presentedFingerprint = fingerprint(blob);
      const match = matchHost(knownHosts, host, port, blob);
      if (match.kind === 'trusted') {
        acceptedKey = blob;
        return true;
      }
      if (match.kind === 'changed') {
        // No callback and no option can accept a changed key.
        recorded = new RemoteFsError(
          'HOST_KEY_CHANGED',
          `the host key of ${where} has changed (presented ${presentedFingerprint}, expected ${match.expectedFingerprints.join(' or ')}); the connection was refused`,
          {
            expectedFingerprints: match.expectedFingerprints,
            presentedFingerprint,
          },
        );
        return false;
      }
      const unknown = new RemoteFsError(
        'HOST_KEY_UNKNOWN',
        `the host key of ${where} (${presentedFingerprint}) is not in the known_hosts file and was not confirmed`,
        { presentedFingerprint },
      );
      const confirm = options.confirmHostKey;
      if (confirm === undefined) {
        recorded = unknown;
        return false;
      }
      timer.pause();
      // Anything but a literal `true` (false, a rejection, a synchronous throw) refuses.
      const confirmed = await Promise.resolve()
        .then(() =>
          confirm({
            host,
            port,
            keyType: keyType(blob) ?? 'unknown',
            fingerprint: presentedFingerprint,
          }),
        )
        .then(
          (answer) => answer === true,
          () => false,
        );
      if (settled) return false;
      timer.start();
      if (!confirmed) {
        recorded = unknown;
        return false;
      }
      // Recorded only after the handshake proves the server holds the key (S-2): see authHandler.
      pendingRecord = blob;
      acceptedKey = blob;
      return true;
    };

    const authMethod = (): AnyAuthMethod =>
      credentials.kind === 'password'
        ? { type: 'password', username, password: credentials.password }
        : // parsePrivateKey ran for this credential kind, so the parsed key is present.
          { type: 'publickey', username, key: privateKey as ParsedKey };

    const authHandler: AuthHandlerMiddleware = (
      _methodsLeft,
      _partial,
      next,
    ) => {
      authCalls += 1;
      if (authCalls > 1) {
        // Exactly one credential is offered; its rejection ends the attempt.
        fail(
          authFailed(
            username,
            host,
            port,
            'the server rejected the credentials',
          ),
        );
        return;
      }
      const blob = pendingRecord;
      if (blob === undefined) {
        next(authMethod());
        return;
      }
      pendingRecord = undefined;
      appendKnownHost(options.knownHostsPath, host, port, blob).then(
        () => {
          if (!settled) next(authMethod());
        },
        (error: unknown) =>
          fail(
            error instanceof RemoteFsError
              ? error
              : new RemoteFsError(
                  'CONNECTION_FAILED',
                  `could not record the host key in ${options.knownHostsPath}`,
                ),
          ),
      );
    };

    client.on('error', (error: Error & { level?: unknown }) => {
      if (settled) return;
      if (recorded !== undefined) {
        fail(recorded);
        return;
      }
      const code = classifyConnectError(error);
      fail(
        code === 'AUTH_FAILED'
          ? authFailed(
              username,
              host,
              port,
              'the server rejected the credentials',
            )
          : new RemoteFsError(
              'CONNECTION_FAILED',
              `could not establish an SSH session with ${where}`,
              { cause: sanitizedCause(error) },
            ),
      );
    });
    client.on('close', () => {
      socketClosed = true;
      fail(
        recorded ??
          new RemoteFsError(
            'CONNECTION_FAILED',
            `${where} closed the connection before the session was established`,
          ),
      );
    });
    client.on('ready', () => {
      client.sftp((error, sftp) => {
        if (settled) return;
        if (error) {
          fail(
            new RemoteFsError(
              'CONNECTION_FAILED',
              `${where} refused the SFTP subsystem`,
              { cause: sanitizedCause(error) },
            ),
          );
          return;
        }
        settled = true;
        established = true;
        timer.clear();
        resolve(
          new Session(transportOf(client, sftp), {
            closeTimeoutMs: options.connectTimeoutMs,
            ...(internals.stallTimeoutMs === undefined
              ? {}
              : { stallTimeoutMs: internals.stallTimeoutMs }),
          }),
        );
      });
    });

    const config: ConnectConfig = {
      host,
      port,
      username,
      // Our own pausable timer replaces ssh2's, which cannot pause for a person.
      readyTimeout: 0,
      // Must return undefined: ssh2 treats any other return value as a synchronous verdict.
      hostVerifier: (blob: Buffer, verify: (valid: boolean) => void): void => {
        // Answering after the socket closed crashes ssh2's torn-down protocol, so a late answer
        // (e.g. a confirmation that arrives after the server hung up) is dropped.
        const answer = (valid: boolean): void => {
          const abandoned = settled && !established;
          if (!socketClosed && !abandoned) verify(valid);
        };
        judgeHostKey(blob).then(answer, () => answer(false));
      },
      authHandler,
      tryKeyboard: false,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      algorithms: {
        serverHostKey: serverHostKeyAlgorithms(
          knownKeyTypes(knownHosts, host, port),
        ) as ServerHostKeyAlgorithm[],
      },
    };
    timer.start();
    try {
      client.connect(config);
    } catch (error) {
      fail(
        new RemoteFsError(
          'CONNECTION_FAILED',
          `could not connect to ${where}`,
          { cause: sanitizedCause(error) },
        ),
      );
    }
  });
}

function transportOf(
  client: InstanceType<typeof Client>,
  sftp: SFTPWrapper,
): SessionTransport {
  const closeListeners: (() => void)[] = [];
  let closed = false;
  const notifyClosed = (): void => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener();
  };
  // Once established, the session's end is reported through `close`; errors carry nothing more.
  client.on('close', notifyClosed);
  // The SFTP channel can end while the SSH connection stays up; that also ends the session.
  sftp.on('close', notifyClosed);
  sftp.on('error', () => client.destroy());
  return {
    sftp: toChannel(sftp),
    end: () => client.end(),
    destroy: () => client.destroy(),
    onClose: (listener) => {
      if (closed) listener();
      else closeListeners.push(listener);
    },
  };
}
