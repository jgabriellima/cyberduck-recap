import { Readable, Writable } from 'node:stream';
import type { RemoteFsError } from '../fs/errors.js';
import {
  SFTP_STATUS,
  SftpStatusError,
  operationError,
  reasonFor,
  toRemoteFsError,
  type OperationContext,
} from './error-map.js';
import type { Session } from './session.js';
import { isDirectory } from './entries.js';

/**
 * Under the 32 KiB every SFTP v3 server must accept, and under ssh2's own per-request limit for
 * servers that are not OpenSSH (34000 bytes less 2048 of packet overhead): a larger chunk is split
 * by ssh2 into two requests, the second sent only after the first is answered, which doubles the
 * requests and lets them continue after backpressure stopped the stream. FEATURE-6 may tune both.
 */
export const CHUNK_SIZE = 31 * 1024;
/** Outstanding requests per stream: at most 512 KiB in flight, enough to hide link latency. */
export const WINDOW = 16;
/** G-5: consecutive empty, non-EOF replies at one offset before a read stream gives up. */
export const MAX_EMPTY_READS = 3;

/**
 * SFTP v3 answers FAILURE for opening or reading a directory; a `stat` on that failure path (and
 * only there) tells IS_A_DIRECTORY apart from other failures.
 */
async function explainFailure(
  session: Session,
  error: unknown,
  context: OperationContext,
): Promise<RemoteFsError> {
  if (
    error instanceof SftpStatusError &&
    error.status === SFTP_STATUS.FAILURE
  ) {
    try {
      const attrs = await session.request<{ mode?: number }>((sftp, done) =>
        sftp.stat(context.path ?? '', done),
      );
      if (isDirectory(attrs.mode)) {
        return operationError(
          'IS_A_DIRECTORY',
          context,
          reasonFor('IS_A_DIRECTORY'),
        );
      }
    } catch {
      // The original failure is the better report when the follow-up stat fails too.
    }
  }
  return toRemoteFsError(error, context);
}

function notConnected(context: OperationContext): RemoteFsError {
  return operationError('NOT_CONNECTED', context, reasonFor('NOT_CONNECTED'));
}

interface ReadSlot {
  offset: number;
  length: number;
  emptyReplies: number;
  data?: Buffer;
  eof?: boolean;
}

/**
 * A pipelined read stream: up to WINDOW reads in flight at explicit offsets, delivered in offset
 * order. A short read re-requests the missing range before the stream moves past it.
 */
class SftpReadStream extends Readable {
  readonly #session: Session | undefined;
  readonly #context: OperationContext;
  #handle: Buffer | undefined;
  #untrack: (() => void) | undefined;
  #slots: ReadSlot[] = [];
  #nextOffset = 0;
  #eofSeen = false;
  #wantMore = false;
  #ending = false;

  constructor(session: Session | undefined, path: string) {
    super({ highWaterMark: CHUNK_SIZE * WINDOW });
    this.#session = session;
    this.#context = { operation: 'read', path };
  }

  override _construct(callback: (error?: Error | null) => void): void {
    const session = this.#session;
    if (session === undefined || !session.isOpen) {
      callback(notConnected(this.#context));
      return;
    }
    this.#untrack = session.track({
      // destroy(err) emits on the next tick, so a listener the caller attaches in the same tick as
      // disconnect(), or an end() callback, still receives the error.
      abort: (code) =>
        this.destroy(operationError(code, this.#context, reasonFor(code))),
    });
    session
      .request<Buffer>((sftp, done) =>
        sftp.open(this.#context.path ?? '', 'r', done),
      )
      .then(
        (handle) => {
          if (!Buffer.isBuffer(handle)) {
            callback(malformedOpen(this.#context));
            return;
          }
          this.#handle = handle;
          callback();
        },
        async (error: unknown) =>
          callback(await explainFailure(session, error, this.#context)),
      );
  }

  override _read(): void {
    this.#wantMore = true;
    this.#fill();
  }

  #fill(): void {
    if (this.destroyed || this.#ending || !this.#wantMore) return;
    while (!this.#eofSeen && this.#inFlight() < WINDOW) {
      const slot: ReadSlot = {
        offset: this.#nextOffset,
        length: CHUNK_SIZE,
        emptyReplies: 0,
      };
      this.#nextOffset += CHUNK_SIZE;
      this.#slots.push(slot);
      this.#request(slot);
    }
  }

  #inFlight(): number {
    return this.#slots.filter((slot) => slot.data === undefined && !slot.eof)
      .length;
  }

  #request(slot: ReadSlot): void {
    const session = this.#session;
    const handle = this.#handle;
    if (session === undefined) return;
    // Never silently skip a request: a stream with nothing outstanding would wait forever.
    if (handle === undefined) {
      this.destroy(malformedOpen(this.#context));
      return;
    }
    session
      .request<Buffer>((sftp, done) =>
        sftp.read(handle, slot.offset, slot.length, done),
      )
      .then(
        (data) => this.#onData(slot, data),
        (error: unknown) => this.#onError(slot, error),
      );
  }

  #onData(slot: ReadSlot, data: Buffer): void {
    if (this.destroyed) return;
    if (data.length === 0) {
      slot.emptyReplies += 1;
      if (slot.emptyReplies >= MAX_EMPTY_READS) {
        this.destroy(
          operationError(
            'OPERATION_FAILED',
            this.#context,
            'the server keeps returning empty reads without end of file',
          ),
        );
        return;
      }
      this.#request(slot);
      return;
    }
    if (data.length > slot.length) {
      this.destroy(
        operationError(
          'OPERATION_FAILED',
          this.#context,
          'the server returned more data than requested',
        ),
      );
      return;
    }
    if (data.length < slot.length) {
      const rest: ReadSlot = {
        offset: slot.offset + data.length,
        length: slot.length - data.length,
        emptyReplies: 0,
      };
      this.#slots.splice(this.#slots.indexOf(slot) + 1, 0, rest);
      this.#request(rest);
    }
    slot.data = data;
    slot.length = data.length;
    this.#flush();
  }

  #onError(slot: ReadSlot, error: unknown): void {
    if (this.destroyed) return;
    if (error instanceof SftpStatusError && error.status === SFTP_STATUS.EOF) {
      slot.eof = true;
      this.#eofSeen = true;
      this.#flush();
      return;
    }
    const session = this.#session;
    if (session === undefined) return;
    void explainFailure(session, error, this.#context).then((mapped) =>
      this.destroy(mapped),
    );
  }

  #flush(): void {
    while (this.#slots.length > 0 && !this.destroyed) {
      const head = this.#slots[0];
      if (head === undefined) break;
      if (head.eof === true) {
        this.#slots = [];
        this.#finish();
        return;
      }
      if (head.data === undefined) break;
      this.#slots.shift();
      this.#wantMore = this.push(head.data);
    }
    this.#fill();
  }

  #finish(): void {
    this.#ending = true;
    const session = this.#session;
    const handle = this.#handle;
    this.#handle = undefined;
    this.#untrack?.();
    if (session === undefined || handle === undefined) {
      this.push(null);
      return;
    }
    // A close failure on a read handle loses nothing: every byte has been delivered.
    session
      .request<void>((sftp, done) => sftp.close(handle, done))
      .catch(() => undefined)
      .finally(() => {
        if (!this.destroyed) this.push(null);
      });
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.#untrack?.();
    closeQuietly(this.#session, this.#handle);
    this.#handle = undefined;
    callback(error);
  }
}

/**
 * A pipelined write stream. `finish` means every write was acknowledged and the handle closed;
 * after any error the stream is destroyed and never finishes.
 */
class SftpWriteStream extends Writable {
  readonly #session: Session | undefined;
  readonly #context: OperationContext;
  #handle: Buffer | undefined;
  #untrack: (() => void) | undefined;
  #offset = 0;
  #outstanding = 0;
  #queue: Buffer[] = [];
  #writeCallback: ((error?: Error | null) => void) | undefined;
  #finalCallback: ((error?: Error | null) => void) | undefined;

  constructor(session: Session | undefined, path: string) {
    super({ highWaterMark: CHUNK_SIZE * WINDOW });
    this.#session = session;
    this.#context = { operation: 'write', path };
  }

  override _construct(callback: (error?: Error | null) => void): void {
    const session = this.#session;
    if (session === undefined || !session.isOpen) {
      callback(notConnected(this.#context));
      return;
    }
    this.#untrack = session.track({
      // destroy(err) emits on the next tick, so a listener the caller attaches in the same tick as
      // disconnect(), or an end() callback, still receives the error.
      abort: (code) =>
        this.destroy(operationError(code, this.#context, reasonFor(code))),
    });
    session
      .request<Buffer>((sftp, done) =>
        sftp.open(this.#context.path ?? '', 'w', done),
      )
      .then(
        (handle) => {
          if (!Buffer.isBuffer(handle)) {
            callback(malformedOpen(this.#context));
            return;
          }
          this.#handle = handle;
          callback();
        },
        async (error: unknown) =>
          callback(await explainFailure(session, error, this.#context)),
      );
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    for (let start = 0; start < chunk.length; start += CHUNK_SIZE) {
      this.#queue.push(chunk.subarray(start, start + CHUNK_SIZE));
    }
    this.#writeCallback = callback;
    this.#pump();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#finalCallback = callback;
    this.#maybeClose();
  }

  #pump(): void {
    if (this.destroyed) return;
    while (this.#queue.length > 0 && this.#outstanding < WINDOW) {
      const piece = this.#queue.shift();
      if (piece !== undefined) this.#send(piece);
    }
    // Acknowledging the chunk while the window has room is the backpressure to the producer.
    if (this.#queue.length === 0 && this.#outstanding < WINDOW) {
      const callback = this.#writeCallback;
      this.#writeCallback = undefined;
      callback?.();
    }
  }

  #send(piece: Buffer): void {
    const session = this.#session;
    const handle = this.#handle;
    if (session === undefined) return;
    if (handle === undefined) {
      this.destroy(malformedOpen(this.#context));
      return;
    }
    const position = this.#offset;
    this.#offset += piece.length;
    this.#outstanding += 1;
    session
      .request<void>((sftp, done) => sftp.write(handle, position, piece, done))
      .then(
        () => {
          this.#outstanding -= 1;
          this.#pump();
          this.#maybeClose();
        },
        (error: unknown) => {
          this.#outstanding -= 1;
          if (!this.destroyed)
            this.destroy(toRemoteFsError(error, this.#context));
        },
      );
  }

  #maybeClose(): void {
    const callback = this.#finalCallback;
    if (callback === undefined || this.#outstanding > 0 || this.destroyed)
      return;
    this.#finalCallback = undefined;
    const session = this.#session;
    const handle = this.#handle;
    if (session === undefined || handle === undefined) {
      callback(notConnected(this.#context));
      return;
    }
    this.#handle = undefined;
    session
      .request<void>((sftp, done) => sftp.close(handle, done))
      .then(
        () => {
          this.#untrack?.();
          // A stream destroyed while its handle was closing must not reach `finish`.
          if (!this.destroyed) callback();
        },
        (error: unknown) => {
          if (!this.destroyed) callback(toRemoteFsError(error, this.#context));
        },
      );
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.#untrack?.();
    this.#queue = [];
    closeQuietly(this.#session, this.#handle);
    this.#handle = undefined;
    callback(error);
    // Node settles end() callbacks only once no _write is in progress, so a chunk still waiting
    // for window room is released here; otherwise `end(data, cb)` would never hear of the error.
    const pendingWrite = this.#writeCallback;
    this.#writeCallback = undefined;
    pendingWrite?.(error);
  }
}

function malformedOpen(context: OperationContext): RemoteFsError {
  return operationError(
    'OPERATION_FAILED',
    context,
    'the server opened the file without returning a handle',
  );
}

function closeQuietly(
  session: Session | undefined,
  handle: Buffer | undefined,
): void {
  if (session === undefined || handle === undefined || !session.isOpen) return;
  session
    .request<void>((sftp, done) => sftp.close(handle, done))
    .catch(() => undefined);
}

export function createSftpReadStream(
  session: Session | undefined,
  path: string,
): Readable {
  return new SftpReadStream(session, path);
}

export function createSftpWriteStream(
  session: Session | undefined,
  path: string,
): Writable {
  return new SftpWriteStream(session, path);
}
