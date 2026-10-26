import type { Readable, Writable } from 'node:stream';
import { inspect } from 'node:util';
import { RemoteFsError } from '../fs/errors.js';
import type {
  MkdirOptions,
  RemoteEntry,
  RemoteFileSystem,
} from '../fs/types.js';
import { openSession, type ConnectAttempt } from './connection.js';
import * as operations from './operations.js';
import {
  validateOptions,
  type SftpFileSystemOptions,
  type ValidatedOptions,
} from './options.js';
import type { Session } from './session.js';
import { createSftpReadStream, createSftpWriteStream } from './streams.js';

type State = 'idle' | 'connecting' | 'connected';

interface PendingAttempt {
  readonly attempt: ConnectAttempt;
  readonly done: Promise<void>;
}

/** What inspection and JSON show of an instance: never a credential (S-6). */
interface PublicView {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly state: State;
}

function requirePath(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RemoteFsError(
      'INVALID_ARGUMENT',
      `invalid argument "${name}": must be a non-empty string`,
    );
  }
}

/**
 * The SFTP back-end of `RemoteFileSystem`. It holds the state machine (idle, connecting,
 * connected) and the credentials, in private fields that inspection and JSON never reach.
 */
export class SftpFileSystem implements RemoteFileSystem {
  readonly #options: ValidatedOptions;
  #session: Session | undefined;
  #attempt: PendingAttempt | undefined;

  constructor(options: SftpFileSystemOptions) {
    this.#options = validateOptions(options);
  }

  get #state(): State {
    if (this.#session?.isOpen === true) return 'connected';
    return this.#attempt === undefined ? 'idle' : 'connecting';
  }

  connect(): Promise<void> {
    if (this.#session?.isOpen === true) return Promise.resolve();
    // A second call while one is in progress shares its outcome instead of opening a session.
    if (this.#attempt !== undefined) return this.#attempt.done;
    const attempt = openSession(this.#options);
    const entry: PendingAttempt = {
      attempt,
      done: attempt.session.then(
        async (session) => {
          if (this.#attempt !== entry) {
            // disconnect() abandoned this attempt after its handshake had already succeeded.
            await session.disconnect();
            throw new RemoteFsError(
              'CONNECTION_FAILED',
              `connection to ${this.#options.host}:${this.#options.port} was cancelled by disconnect()`,
            );
          }
          this.#attempt = undefined;
          this.#session = session;
          session.onLost(() => {
            if (this.#session === session) this.#session = undefined;
          });
        },
        (error: unknown) => {
          if (this.#attempt === entry) this.#attempt = undefined;
          throw error;
        },
      ),
    };
    this.#attempt = entry;
    return entry.done;
  }

  async disconnect(): Promise<void> {
    // Detached synchronously, so a connect() made right after this call starts a new attempt
    // instead of joining the one being cancelled, and its session is never closed by this call.
    const pending = this.#attempt;
    const session = this.#session;
    this.#attempt = undefined;
    this.#session = undefined;
    pending?.attempt.cancel();
    await Promise.all([
      pending?.done.catch(() => undefined),
      session?.disconnect(),
    ]);
  }

  #connected(operation: string, path: string): Session {
    const session = this.#session;
    if (session?.isOpen !== true) {
      throw new RemoteFsError(
        'NOT_CONNECTED',
        `${operation} ${path}: not connected`,
        {
          path,
        },
      );
    }
    return session;
  }

  async list(path: string): Promise<RemoteEntry[]> {
    requirePath('path', path);
    return operations.list(this.#connected('list', path), path);
  }

  async stat(path: string): Promise<RemoteEntry> {
    requirePath('path', path);
    return operations.stat(this.#connected('stat', path), path);
  }

  createReadStream(path: string): Readable {
    requirePath('path', path);
    return createSftpReadStream(this.#session, path);
  }

  createWriteStream(path: string): Writable {
    requirePath('path', path);
    return createSftpWriteStream(this.#session, path);
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    requirePath('path', path);
    return operations.mkdir(this.#connected('mkdir', path), path, options);
  }

  async remove(path: string): Promise<void> {
    requirePath('path', path);
    return operations.remove(this.#connected('remove', path), path);
  }

  async rename(from: string, to: string): Promise<void> {
    requirePath('from', from);
    requirePath('to', to);
    const session = this.#session;
    if (session?.isOpen !== true) {
      throw new RemoteFsError(
        'NOT_CONNECTED',
        `rename ${from} to ${to}: not connected`,
        { path: from, targetPath: to },
      );
    }
    return operations.rename(session, from, to);
  }

  toJSON(): PublicView {
    return {
      host: this.#options.host,
      port: this.#options.port,
      username: this.#options.username,
      state: this.#state,
    };
  }

  [inspect.custom](): string {
    return `SftpFileSystem ${inspect(this.toJSON())}`;
  }
}
