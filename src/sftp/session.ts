import { RemoteFsError } from '../fs/errors.js';
import { SftpStatusError, statusOf } from './error-map.js';

export type SftpCallback<T> = (
  error: Error | null | undefined,
  value?: T,
) => void;

export interface SftpAttributes {
  readonly mode?: number;
  readonly size?: number;
  readonly mtime?: number;
}

export interface SftpDirEntry {
  readonly filename: string;
  readonly attrs: SftpAttributes;
}

/**
 * The SFTP requests the back-end uses, in the shape of ssh2's channel. End of file and end of
 * directory arrive as a status error with code 1 (EOF); a zero-length read is a successful empty
 * Buffer, so the two stay distinguishable (G-5).
 */
export interface SftpChannel {
  open(path: string, mode: 'r' | 'w', callback: SftpCallback<Buffer>): void;
  close(handle: Buffer, callback: SftpCallback<void>): void;
  read(
    handle: Buffer,
    position: number,
    length: number,
    callback: SftpCallback<Buffer>,
  ): void;
  write(
    handle: Buffer,
    position: number,
    data: Buffer,
    callback: SftpCallback<void>,
  ): void;
  opendir(path: string, callback: SftpCallback<Buffer>): void;
  readdir(handle: Buffer, callback: SftpCallback<SftpDirEntry[]>): void;
  stat(path: string, callback: SftpCallback<SftpAttributes>): void;
  lstat(path: string, callback: SftpCallback<SftpAttributes>): void;
  mkdir(path: string, callback: SftpCallback<void>): void;
  rmdir(path: string, callback: SftpCallback<void>): void;
  unlink(path: string, callback: SftpCallback<void>): void;
  rename(from: string, to: string, callback: SftpCallback<void>): void;
}

/** The connection a session runs over; ssh2's client in production, a fake in unit tests. */
export interface SessionTransport {
  readonly sftp: SftpChannel;
  /** Graceful close; `onClose` fires when it completes. */
  end(): void;
  destroy(): void;
  onClose(listener: () => void): void;
}

/** A stream the session must fail when it ends; the stream builds the error with its own path. */
export interface TrackedStream {
  abort(code: 'CONNECTION_LOST' | 'NOT_CONNECTED'): void;
}

export interface SessionOptions {
  /** Internal: tests shorten the stall threshold; production uses STALL_TIMEOUT_MS. */
  readonly stallTimeoutMs?: number;
  /** How long `disconnect()` waits for a graceful close before destroying the transport. */
  readonly closeTimeoutMs?: number;
}

/** G-6: requests pending with no SFTP reply for this long mean the server is stuck. */
export const STALL_TIMEOUT_MS = 120_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 20_000;

interface Settler {
  settled: boolean;
  reject(error: Error): void;
}

type SessionState = 'open' | 'closing' | 'closed';

/**
 * One established SFTP session. It owns the transport, settles every request exactly once and
 * turns the session's end into typed errors: a loss into CONNECTION_LOST, `disconnect()` into
 * NOT_CONNECTED. Nothing reconnects by itself.
 */
export class Session {
  readonly #transport: SessionTransport;
  readonly #stallTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #inFlight = new Set<Settler>();
  readonly #streams = new Set<TrackedStream>();
  readonly #lostListeners: (() => void)[] = [];
  #state: SessionState = 'open';
  #lastProgress = 0;
  #watchdog: NodeJS.Timeout | undefined;
  #closed: Promise<void>;
  #markClosed!: () => void;

  constructor(transport: SessionTransport, options: SessionOptions = {}) {
    this.#transport = transport;
    this.#stallTimeoutMs = options.stallTimeoutMs ?? STALL_TIMEOUT_MS;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#closed = new Promise((resolve) => {
      this.#markClosed = resolve;
    });
    transport.onClose(() => {
      this.#markClosed();
      if (this.#state === 'open') this.#lose();
    });
  }

  get isOpen(): boolean {
    return this.#state === 'open';
  }

  /** Called once if the session ends without `disconnect()`. */
  onLost(listener: () => void): void {
    this.#lostListeners.push(listener);
  }

  /**
   * Runs one SFTP request. Rejects with `SftpStatusError` for a server status, with a
   * `RemoteFsError` (CONNECTION_LOST or NOT_CONNECTED, without a path) when the session ends.
   */
  request<T>(
    start: (sftp: SftpChannel, done: SftpCallback<T>) => void,
  ): Promise<T> {
    if (this.#state !== 'open') {
      return Promise.reject(sessionError('NOT_CONNECTED'));
    }
    return new Promise<T>((resolve, reject) => {
      const settler: Settler = { settled: false, reject };
      if (this.#inFlight.size === 0) this.#lastProgress = Date.now();
      this.#inFlight.add(settler);
      this.#armWatchdog();
      const done: SftpCallback<T> = (error, value) => {
        if (settler.settled) return;
        settler.settled = true;
        this.#inFlight.delete(settler);
        this.#lastProgress = Date.now();
        if (error === null || error === undefined) {
          resolve(value as T);
          return;
        }
        const status = statusOf(error);
        if (status === undefined) {
          // A failure without an SFTP status means the channel or socket died (e.g. ssh2's
          // "No response from server"): always a loss, whichever of error and close comes first.
          reject(sessionError('CONNECTION_LOST'));
          this.#lose();
          return;
        }
        reject(new SftpStatusError(status, error.message));
      };
      try {
        start(this.#transport.sftp, done);
      } catch {
        done(
          Object.assign(new Error('request could not be sent'), { code: -1 }),
        );
      }
    });
  }

  /** Registers an open stream; returns the function that unregisters it. */
  track(stream: TrackedStream): () => void {
    this.#streams.add(stream);
    return () => this.#streams.delete(stream);
  }

  async disconnect(): Promise<void> {
    if (this.#state === 'closed') return;
    if (this.#state === 'closing') return this.#closed;
    this.#state = 'closing';
    this.#endEverything('NOT_CONNECTED');
    this.#transport.end();
    let timer: NodeJS.Timeout | undefined;
    const forced = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.#transport.destroy();
        resolve();
      }, this.#closeTimeoutMs);
    });
    try {
      await Promise.race([this.#closed, forced]);
    } finally {
      clearTimeout(timer);
      this.#state = 'closed';
    }
  }

  #lose(): void {
    if (this.#state !== 'open') return;
    this.#state = 'closed';
    this.#endEverything('CONNECTION_LOST');
    this.#transport.destroy();
    for (const listener of this.#lostListeners) listener();
  }

  #endEverything(code: 'CONNECTION_LOST' | 'NOT_CONNECTED'): void {
    clearTimeout(this.#watchdog);
    this.#watchdog = undefined;
    const streams = [...this.#streams];
    this.#streams.clear();
    for (const stream of streams) stream.abort(code);
    const pending = [...this.#inFlight];
    this.#inFlight.clear();
    for (const settler of pending) {
      if (settler.settled) continue;
      settler.settled = true;
      settler.reject(sessionError(code));
    }
  }

  // The watchdog measures progress, not request age: a slow link that keeps answering is never
  // cut, and a paused consumer leaves no request outstanding (G-6).
  #armWatchdog(): void {
    if (this.#watchdog !== undefined || this.#state !== 'open') return;
    const due = this.#lastProgress + this.#stallTimeoutMs - Date.now();
    this.#watchdog = setTimeout(() => this.#checkStall(), Math.max(due, 0));
    this.#watchdog.unref();
  }

  #checkStall(): void {
    this.#watchdog = undefined;
    if (this.#state !== 'open' || this.#inFlight.size === 0) return;
    if (Date.now() - this.#lastProgress >= this.#stallTimeoutMs) {
      this.#lose();
      return;
    }
    this.#armWatchdog();
  }
}

function sessionError(
  code: 'CONNECTION_LOST' | 'NOT_CONNECTED',
): RemoteFsError {
  return new RemoteFsError(
    code,
    code === 'NOT_CONNECTED' ? 'not connected' : 'the connection was lost',
  );
}
