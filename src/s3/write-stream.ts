/**
 * The write stream of an object: the directory-shape check before any creating request, then the
 * bytes to the uploader. `finish` comes only after the store holds the whole object; a failure is
 * emitted once, after the abort of a started multipart upload.
 */
import { Writable } from 'node:stream';
import type { RemoteFsError } from '../fs/errors.js';
import { noObjectWritten, objectUrl } from './errors.js';
import type { OperationScope } from './lifecycle.js';
import { hasKeysUnder, headIfObject } from './listing.js';
import type { S3Context } from './operations.js';
import type { S3Location } from './paths.js';
import { S3TransportError } from './transport.js';
import { Uploader } from './upload.js';

export interface WriteStreamInput {
  readonly context: S3Context;
  readonly location: S3Location;
  /** `undefined`: the instance is not connected. */
  readonly scope: OperationScope | undefined;
  readonly exclusive: boolean;
  readonly partLimit: number | undefined;
}

export class S3WriteStream extends Writable {
  readonly #input: WriteStreamInput;
  #uploader: Uploader | undefined;
  /** A `_write` or `_final` waits for the uploader: its callback reports a failure. */
  #busy = false;

  constructor(input: WriteStreamInput) {
    super();
    this.#input = input;
  }

  override _construct(callback: (error?: Error | null) => void): void {
    this.#open().then(
      () => callback(),
      (error: unknown) => callback(error as Error),
    );
  }

  /**
   * A write needs only the bucket. A key with keys under `k/` and no object `k` is a folder;
   * no creating request is sent then, and no HeadObject of `k` comes before one otherwise.
   */
  async #open(): Promise<void> {
    const { context, location, scope, exclusive } = this.#input;
    const { errors, transport } = context;
    if (scope === undefined) throw errors.notConnected(location.path);
    const isFolder = (what: string): RemoteFsError =>
      errors.fail(
        'IS_A_DIRECTORY',
        `cannot write ${objectUrl(location)}: it is ${what}; ${noObjectWritten(location)}`,
        { path: location.path },
      );
    if (location.key === undefined) {
      throw isFolder(location.root ? 'the root' : 'a bucket');
    }
    const bucket = location.bucket ?? '';
    const key = location.key;
    try {
      if (await hasKeysUnder(transport, bucket, `${key}/`, scope.signal)) {
        const head = await headIfObject(transport, bucket, key, scope.signal);
        if (head === undefined) throw isFolder('a folder');
        if (exclusive) {
          throw errors.fail(
            'ALREADY_EXISTS',
            `cannot write ${objectUrl(location)}: an object has this key; ${noObjectWritten(location)}`,
            { path: location.path },
          );
        }
      }
    } catch (error) {
      if (error instanceof S3TransportError) {
        throw errors.fromFailure(error.failure, 'write', location, {
          outcome: noObjectWritten(location),
        });
      }
      throw error;
    }
    const uploader = new Uploader(
      transport,
      scope,
      errors,
      { location, bucket, key, exclusive },
      this.#input.partLimit,
    );
    this.#uploader = uploader;
    scope.signal.addEventListener(
      'abort',
      () => {
        // A pending write or final reports the failure through its callback; an idle stream
        // has no callback, so it is destroyed with the error.
        void uploader.interrupt().then((error) => {
          if (!this.#busy && !this.destroyed) this.destroy(error);
        });
      },
      { once: true },
    );
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#run((uploader) => uploader.write(chunk), callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#run((uploader) => uploader.finish(), callback);
  }

  #run(
    step: (uploader: Uploader) => Promise<void>,
    callback: (error?: Error | null) => void,
  ): void {
    const uploader = this.#uploader;
    if (uploader === undefined) {
      callback();
      return;
    }
    this.#busy = true;
    step(uploader).then(
      () => {
        this.#busy = false;
        callback();
      },
      (error: unknown) => {
        this.#busy = false;
        callback(error as Error);
      },
    );
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    const uploader = this.#uploader;
    if (uploader === undefined || uploader.done) {
      callback(error);
      return;
    }
    // Destroyed before its end: the upload is not finished, so a started one is aborted.
    uploader.cancel().then(
      () => callback(error),
      () => callback(error),
    );
  }
}
