/**
 * A scripted stand-in for ssh2's SFTP channel and connection: the network is outside the logic
 * under test (session lifecycle, stream reassembly), so unit tests drive replies by hand.
 */
import type {
  SessionTransport,
  SftpAttributes,
  SftpCallback,
  SftpChannel,
  SftpDirEntry,
} from '../../src/sftp/session.js';

export interface PendingRequest {
  readonly kind: string;
  readonly args: readonly unknown[];
  readonly reply: (error: Error | undefined, value?: unknown) => void;
}

export function statusError(code: number, message = 'status'): Error {
  return Object.assign(new Error(message), { code });
}

export class FakeChannel implements SftpChannel {
  readonly pending: PendingRequest[] = [];
  /** Requests answered on the spot; anything without a responder stays pending. */
  responders: Partial<
    Record<string, (...args: unknown[]) => { error?: Error; value?: unknown }>
  > = {};

  #record(
    kind: string,
    args: unknown[],
    callback: SftpCallback<unknown>,
  ): void {
    const responder = this.responders[kind];
    if (responder !== undefined) {
      const { error, value } = responder(...args);
      queueMicrotask(() => callback(error, value));
      return;
    }
    this.pending.push({
      kind,
      args,
      reply: (error, value) => callback(error, value),
    });
  }

  take(kind: string): PendingRequest[] {
    const taken = this.pending.filter((request) => request.kind === kind);
    for (const request of taken) {
      this.pending.splice(this.pending.indexOf(request), 1);
    }
    return taken;
  }

  /** Removes and returns the first pending request of `kind` whose arguments satisfy `matches`. */
  takeOne(
    kind: string,
    matches: (args: readonly unknown[]) => boolean = () => true,
  ): PendingRequest | undefined {
    const index = this.pending.findIndex(
      (request) => request.kind === kind && matches(request.args),
    );
    return index === -1 ? undefined : this.pending.splice(index, 1)[0];
  }

  open(path: string, mode: 'r' | 'w', callback: SftpCallback<Buffer>): void {
    this.#record('open', [path, mode], callback as SftpCallback<unknown>);
  }
  close(handle: Buffer, callback: SftpCallback<void>): void {
    this.#record('close', [handle], callback as SftpCallback<unknown>);
  }
  read(
    handle: Buffer,
    position: number,
    length: number,
    callback: SftpCallback<Buffer>,
  ): void {
    this.#record(
      'read',
      [handle, position, length],
      callback as SftpCallback<unknown>,
    );
  }
  write(
    handle: Buffer,
    position: number,
    data: Buffer,
    callback: SftpCallback<void>,
  ): void {
    this.#record(
      'write',
      [handle, position, Buffer.from(data)],
      callback as SftpCallback<unknown>,
    );
  }
  opendir(path: string, callback: SftpCallback<Buffer>): void {
    this.#record('opendir', [path], callback as SftpCallback<unknown>);
  }
  readdir(handle: Buffer, callback: SftpCallback<SftpDirEntry[]>): void {
    this.#record('readdir', [handle], callback as SftpCallback<unknown>);
  }
  stat(path: string, callback: SftpCallback<SftpAttributes>): void {
    this.#record('stat', [path], callback as SftpCallback<unknown>);
  }
  lstat(path: string, callback: SftpCallback<SftpAttributes>): void {
    this.#record('lstat', [path], callback as SftpCallback<unknown>);
  }
  mkdir(path: string, callback: SftpCallback<void>): void {
    this.#record('mkdir', [path], callback as SftpCallback<unknown>);
  }
  rmdir(path: string, callback: SftpCallback<void>): void {
    this.#record('rmdir', [path], callback as SftpCallback<unknown>);
  }
  unlink(path: string, callback: SftpCallback<void>): void {
    this.#record('unlink', [path], callback as SftpCallback<unknown>);
  }
  rename(from: string, to: string, callback: SftpCallback<void>): void {
    this.#record('rename', [from, to], callback as SftpCallback<unknown>);
  }
}

export class FakeTransport implements SessionTransport {
  readonly sftp = new FakeChannel();
  ended = 0;
  destroyed = 0;
  /** Whether `end()` closes the transport at once, as a responsive server would. */
  closeOnEnd = true;
  readonly #listeners: (() => void)[] = [];
  #closed = false;

  end(): void {
    this.ended += 1;
    if (this.closeOnEnd) this.emitClose();
  }

  destroy(): void {
    this.destroyed += 1;
    this.emitClose();
  }

  onClose(listener: () => void): void {
    this.#listeners.push(listener);
  }

  emitClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#listeners) listener();
  }
}
