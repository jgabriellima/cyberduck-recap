/**
 * The read stream of an object (design "Read stream"): `GetObject`, then the body with
 * backpressure, an own idle watchdog that runs only while the consumer wants data, and a count of
 * the bytes against `Content-Length`. It emits exactly one error, and no `data` or `end` after it.
 */
import { Readable } from 'node:stream';
import type { RemoteFsError } from '../fs/errors.js';
import { isNoSuchObject, objectUrl } from './errors.js';
import type { OperationScope } from './lifecycle.js';
import { hasKeysUnder } from './listing.js';
import type { S3Context } from './operations.js';
import type { S3Location } from './paths.js';
import { S3TransportError } from './transport.js';

export interface ReadStreamInput {
  readonly context: S3Context;
  readonly location: S3Location;
  /** `undefined`: the instance is not connected. */
  readonly scope: OperationScope | undefined;
  readonly timeoutMs: number;
}

export class S3ReadStream extends Readable {
  readonly #input: ReadStreamInput;
  #body: Readable | undefined;
  #expected: number | undefined;
  #received = 0;
  #watchdog: NodeJS.Timeout | undefined;
  #failed = false;

  constructor(input: ReadStreamInput) {
    super();
    this.#input = input;
  }

  override _construct(callback: (error?: Error | null) => void): void {
    this.#open().then(
      () => callback(),
      (error: unknown) => callback(error as Error),
    );
  }

  async #open(): Promise<void> {
    const { context, location, scope } = this.#input;
    const { errors, transport } = context;
    if (scope === undefined) throw errors.notConnected(location.path);
    if (location.key === undefined) {
      throw errors.fail(
        'IS_A_DIRECTORY',
        `cannot read ${objectUrl(location)}: it is a ${location.root ? 'root' : 'bucket'}, not an object`,
        { path: location.path },
      );
    }
    const bucket = location.bucket ?? '';
    let opened;
    try {
      opened = await transport.getObject(bucket, location.key, scope.signal);
    } catch (error) {
      if (!(error instanceof S3TransportError)) throw error;
      const { failure } = error;
      if (!isNoSuchObject(failure))
        throw errors.fromFailure(failure, 'read', location);
      let folder: boolean;
      try {
        folder = await hasKeysUnder(
          transport,
          bucket,
          `${location.key}/`,
          scope.signal,
        );
      } catch (listError) {
        if (listError instanceof S3TransportError) {
          throw errors.fromFailure(listError.failure, 'read', location);
        }
        throw listError;
      }
      throw folder
        ? errors.fail(
            'IS_A_DIRECTORY',
            `cannot read ${objectUrl(location)}: it is a folder, not an object`,
            { path: location.path },
          )
        : errors.fail(
            'NOT_FOUND',
            `cannot read ${objectUrl(location)}: no object has this key`,
            { path: location.path },
          );
    }
    this.#body = opened.body;
    this.#expected = opened.contentLength;
    this.#wire(opened.body, scope);
  }

  #wire(body: Readable, scope: OperationScope): void {
    const { context, location } = this.#input;
    const { errors } = context;
    body.pause();
    const onAbort = (): void => this.#fail(errors.notConnected(location.path));
    scope.signal.addEventListener('abort', onAbort, { once: true });
    body.once('close', () =>
      scope.signal.removeEventListener('abort', onAbort),
    );
    body.on('data', (chunk: Buffer) => {
      if (this.#failed) return;
      this.#received += chunk.length;
      if (this.push(chunk)) {
        this.#arm();
      } else {
        this.#disarm();
        body.pause();
      }
    });
    body.once('end', () => {
      this.#disarm();
      if (this.#failed) return;
      if (this.#expected !== undefined && this.#received < this.#expected) {
        this.#fail(
          this.#lost(
            `the store sent ${this.#received} of ${this.#expected} bytes`,
          ),
        );
        return;
      }
      this.push(null);
    });
    body.once('error', () => {
      this.#fail(
        scope.signal.aborted
          ? errors.notConnected(location.path)
          : this.#lost('the connection was lost during the body'),
      );
    });
    body.once('close', () => {
      // A body closed with neither its end nor an error: the connection went away.
      if (!body.readableEnded) {
        this.#fail(this.#lost('the connection was closed during the body'));
      }
    });
  }

  #lost(what: string): RemoteFsError {
    const { context, location } = this.#input;
    return context.errors.fail(
      'CONNECTION_LOST',
      `cannot read ${objectUrl(location)}: ${what}`,
      { path: location.path },
    );
  }

  /** Starts the idle bound again; an armed watchdog is refreshed, not replaced, on each chunk. */
  #arm(): void {
    if (this.#watchdog !== undefined) {
      this.#watchdog.refresh();
      return;
    }
    this.#watchdog = setTimeout(() => {
      this.#fail(
        this.#lost(`the store sent nothing for ${this.#input.timeoutMs} ms`),
      );
    }, this.#input.timeoutMs);
  }

  #disarm(): void {
    if (this.#watchdog !== undefined) clearTimeout(this.#watchdog);
    this.#watchdog = undefined;
  }

  #fail(error: RemoteFsError): void {
    if (this.#failed || this.destroyed) return;
    this.#failed = true;
    this.#disarm();
    this.destroy(error);
  }

  override _read(): void {
    const body = this.#body;
    if (body === undefined || this.#failed) return;
    this.#arm();
    body.resume();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.#failed = true;
    this.#disarm();
    this.#body?.destroy();
    callback(error);
  }
}
