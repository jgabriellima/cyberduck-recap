/**
 * The uploader of a write stream (design Option 1B, spec "Uploads"): one `PutObject` for at most
 * one part size, else a multipart upload of `PART_SIZE` parts with at most `MAX_PARTS_IN_FLIGHT`
 * in flight. Every failure after `CreateMultipartUpload` aborts the upload once, and the error
 * says whether an object can have been written, from the attempts of the completing request.
 */
import type { RemoteFsError, RemoteFsErrorCode } from '../fs/errors.js';
import {
  EXCLUSIVE_REFUSED,
  abortRemedy,
  codeOf,
  isExclusiveRefusal,
  mayHaveBeenWritten,
  noObjectWritten,
  objectUrl,
  replyCode,
  type S3Errors,
} from './errors.js';
import type { OperationScope } from './lifecycle.js';
import type { S3Location } from './paths.js';
import {
  S3TransportError,
  type AttemptRecord,
  type S3Failure,
  type S3Transport,
} from './transport.js';
import { isUploadId } from './validation.js';

/** 16 MiB: one PutObject up to this size; the size of every part but the last. */
export const PART_SIZE = 16_777_216;
/** S3 allows at most 10,000 parts, so the largest upload is 167,772,160,000 bytes. */
export const MAX_PARTS = 10_000;
/** At most 5 buffers of a part size in memory per upload: 4 in flight and 1 filling. */
export const MAX_PARTS_IN_FLIGHT = 4;
/** The first capacity of the part being filled; it doubles up to `PART_SIZE`. */
const FIRST_CAPACITY = 65_536;
const NOTHING = Buffer.alloc(0);

export interface UploadTarget {
  readonly location: S3Location;
  readonly bucket: string;
  readonly key: string;
  readonly exclusive: boolean;
}

/** The first thing that went wrong; the error is built from it once the abort is done. */
type FirstFailure =
  | {
      readonly kind: 'transport';
      readonly step: 'put' | 'create' | 'part' | 'complete';
      readonly failure: S3Failure;
      readonly attempts: readonly AttemptRecord[];
    }
  | { readonly kind: 'limit' }
  | { readonly kind: 'no-upload-id' }
  | { readonly kind: 'no-etag'; readonly partNumber: number }
  | { readonly kind: 'ended' }
  | { readonly kind: 'cancelled' };

function transportFailure(
  step: 'put' | 'create' | 'part' | 'complete',
  error: unknown,
): FirstFailure {
  if (error instanceof S3TransportError) {
    return {
      kind: 'transport',
      step,
      failure: error.failure,
      attempts: error.attempts,
    };
  }
  return {
    kind: 'transport',
    step,
    failure: { kind: 'request' },
    attempts: [],
  };
}

export class Uploader {
  readonly #transport: S3Transport;
  readonly #scope: OperationScope;
  readonly #errors: S3Errors;
  readonly #target: UploadTarget;
  readonly #partLimit: number;

  /**
   * The part being filled, owned by the uploader: a caller may reuse its chunk once the write
   * callback has run, so the bytes are copied here, once, before that callback.
   */
  #filling: Buffer = NOTHING;
  #buffered = 0;
  #creating: Promise<string | undefined> | undefined;
  #uploadId: string | undefined;
  #nextPart = 1;
  readonly #parts: { partNumber: number; etag: string }[] = [];
  readonly #inFlight = new Set<Promise<void>>();
  #first: FirstFailure | undefined;
  #outcome: Promise<RemoteFsError> | undefined;
  #done = false;
  readonly settled: Promise<void>;
  #markSettled: () => void = () => undefined;

  constructor(
    transport: S3Transport,
    scope: OperationScope,
    errors: S3Errors,
    target: UploadTarget,
    partLimit: number = MAX_PARTS,
  ) {
    this.#transport = transport;
    this.#scope = scope;
    this.#errors = errors;
    this.#target = target;
    this.#partLimit = partLimit;
    this.settled = new Promise((resolve) => {
      this.#markSettled = resolve;
    });
    // disconnect() waits until this upload completed or was aborted.
    scope.cleanup(this.settled);
  }

  /** Whether the upload completed or its failure was settled (the abort is done). */
  get done(): boolean {
    return this.#done;
  }

  /**
   * Copies `chunk` into the part being filled; resolves when all of it is copied, so the caller
   * owns `chunk` again (at most 4 parts in flight and 1 filling).
   */
  async write(chunk: Buffer): Promise<void> {
    if (this.#first !== undefined) throw await this.#settle();
    let offset = 0;
    while (offset < chunk.length) {
      // A part leaves only when a byte follows it: exactly PART_SIZE bytes stay one PutObject.
      if (this.#buffered === PART_SIZE) {
        await this.#sendPart(this.#take());
        if (this.#first !== undefined) throw await this.#settle();
      }
      const length = Math.min(
        chunk.length - offset,
        PART_SIZE - this.#buffered,
      );
      this.#reserve(this.#buffered + length);
      chunk.copy(this.#filling, this.#buffered, offset, offset + length);
      this.#buffered += length;
      offset += length;
    }
  }

  /** Resolves after the completing request succeeded: the store holds the whole object. */
  async finish(): Promise<void> {
    if (this.#first !== undefined) throw await this.#settle();
    const { bucket, key, exclusive } = this.#target;
    if (this.#creating === undefined) {
      try {
        await this.#transport.putObject(
          { bucket, key, body: this.#take(), exclusive },
          this.#scope.signal,
        );
      } catch (error) {
        this.#first ??= transportFailure('put', error);
        throw await this.#settle();
      }
      this.#succeed();
      return;
    }
    if (this.#buffered > 0) await this.#sendPart(this.#take());
    await this.#drain();
    if (this.#first !== undefined) throw await this.#settle();
    try {
      await this.#transport.completeMultipartUpload({
        bucket,
        key,
        uploadId: this.#uploadId ?? '',
        parts: [...this.#parts].sort((a, b) => a.partNumber - b.partNumber),
        exclusive,
      });
    } catch (error) {
      this.#first ??= transportFailure('complete', error);
      throw await this.#settle();
    }
    this.#succeed();
  }

  /** The instance was disconnected: stop, abort, and give the error the stream emits. */
  interrupt(): Promise<RemoteFsError> {
    this.#first ??= { kind: 'ended' };
    return this.#settle();
  }

  /** The caller destroyed the stream: stop and abort; nothing is reported. */
  async cancel(): Promise<void> {
    if (this.#done && this.#outcome === undefined) return;
    this.#first ??= { kind: 'cancelled' };
    await this.#settle();
  }

  #succeed(): void {
    this.#done = true;
    this.#markSettled();
  }

  /**
   * Room for `size` bytes in the part being filled. A small upload holds a small buffer, which
   * doubles (each byte is copied at most twice in all); once a part has left, the upload is
   * multipart and each new part gets `PART_SIZE` at once, so its bytes are copied once.
   */
  #reserve(size: number): void {
    if (size <= this.#filling.length) return;
    const capacity =
      this.#creating === undefined
        ? Math.min(
            PART_SIZE,
            Math.max(size, FIRST_CAPACITY, this.#filling.length * 2),
          )
        : PART_SIZE;
    const grown = Buffer.allocUnsafe(capacity);
    this.#filling.copy(grown, 0, 0, this.#buffered);
    this.#filling = grown;
  }

  /** The filled bytes, handed over with their buffer: the uploader never writes to it again. */
  #take(): Buffer {
    const taken = this.#filling.subarray(0, this.#buffered);
    this.#filling = NOTHING;
    this.#buffered = 0;
    return taken;
  }

  #ensureMultipart(): Promise<string | undefined> {
    const { bucket, key } = this.#target;
    this.#creating ??= this.#transport.createMultipartUpload(bucket, key).then(
      (uploadId) => {
        // No request may carry an ID that failed the check.
        if (!isUploadId(uploadId)) {
          this.#first ??= { kind: 'no-upload-id' };
          return undefined;
        }
        this.#uploadId = uploadId;
        if (this.#scope.signal.aborted) this.#first ??= { kind: 'ended' };
        return uploadId;
      },
      (error: unknown) => {
        this.#first ??= transportFailure('create', error);
        return undefined;
      },
    );
    return this.#creating;
  }

  async #sendPart(body: Buffer): Promise<void> {
    const uploadId = await this.#ensureMultipart();
    if (uploadId === undefined || this.#first !== undefined) return;
    while (this.#inFlight.size >= MAX_PARTS_IN_FLIGHT) {
      await Promise.race(this.#inFlight);
    }
    if (this.#first !== undefined) return;
    const partNumber = this.#nextPart;
    if (partNumber > this.#partLimit) {
      this.#first ??= { kind: 'limit' };
      return;
    }
    this.#nextPart += 1;
    const { bucket, key } = this.#target;
    const sent: Promise<void> = this.#transport
      .uploadPart(
        { bucket, key, uploadId, partNumber, body },
        this.#scope.signal,
      )
      .then(
        (etag) => {
          if (typeof etag !== 'string' || etag === '') {
            this.#first ??= { kind: 'no-etag', partNumber };
            return;
          }
          this.#parts.push({ partNumber, etag });
        },
        (error: unknown) => {
          this.#first ??= transportFailure('part', error);
        },
      )
      .finally(() => {
        this.#inFlight.delete(sent);
      });
    this.#inFlight.add(sent);
  }

  async #drain(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight]);
  }

  /** Waits for the parts in flight, aborts a started upload once, and builds the one error. */
  #settle(): Promise<RemoteFsError> {
    this.#outcome ??= (async () => {
      await this.#drain();
      await this.#creating;
      let abortFailed = false;
      if (this.#uploadId !== undefined) {
        const { bucket, key } = this.#target;
        try {
          await this.#transport.abortMultipartUpload(
            bucket,
            key,
            this.#uploadId,
          );
        } catch (error) {
          // NoSuchUpload: nothing is left to abort (a completion whose reply was lost did it).
          abortFailed = !(
            error instanceof S3TransportError &&
            replyCode(error.failure) === 'NoSuchUpload'
          );
        }
      }
      const error = this.#errorOf(abortFailed);
      this.#done = true;
      this.#markSettled();
      return error;
    })();
    return this.#outcome;
  }

  #errorOf(abortFailed: boolean): RemoteFsError {
    const { location } = this.#target;
    const errors = this.#errors;
    const first = this.#first ?? { kind: 'cancelled' };
    let code: RemoteFsErrorCode = 'OPERATION_FAILED';
    let detail: string;
    let outcome = noObjectWritten(location);
    switch (first.kind) {
      case 'transport': {
        const { failure, attempts, step } = first;
        detail = `${errors.describe(failure)}${errors.remedyOf(failure, 'write', location)}`;
        code = codeOf(failure);
        const completing = step === 'put' || step === 'complete';
        if (isExclusiveRefusal(failure) && this.#target.exclusive) {
          code = 'OPERATION_FAILED';
          detail = `${errors.describe(failure)}; ${EXCLUSIVE_REFUSED}`;
        } else if (
          completing &&
          failure.kind !== 'aborted' &&
          attempts.some((attempt) => !attempt.replied)
        ) {
          // An attempt with no reply may have been stored; a later reply cannot tell.
          const last = attempts.at(-1);
          code =
            last === undefined || !last.replied || last.code === 'NoSuchUpload'
              ? 'CONNECTION_LOST'
              : codeOf(failure);
          outcome = mayHaveBeenWritten(location);
        }
        break;
      }
      case 'limit':
        detail = `the upload needs more than ${this.#partLimit} parts of ${PART_SIZE} bytes; the largest upload is ${this.#partLimit * PART_SIZE} bytes`;
        break;
      case 'no-upload-id':
        detail =
          'the store answered CreateMultipartUpload with no valid upload ID';
        break;
      case 'no-etag':
        detail = `the store answered UploadPart ${first.partNumber} with no ETag`;
        break;
      case 'ended':
        code = 'NOT_CONNECTED';
        detail = 'the S3 file system was disconnected';
        break;
      case 'cancelled':
        detail = 'the write stream was destroyed before its end';
        break;
    }
    let message = `cannot write ${objectUrl(location)}: ${detail}; ${outcome}`;
    if (abortFailed && this.#uploadId !== undefined) {
      const { bucket, key } = this.#target;
      message +=
        `; the incomplete multipart upload ${errors.serverText(this.#uploadId)} of ${objectUrl(location)} could not be aborted:` +
        ' the store keeps its parts, and can bill them, until someone aborts it;' +
        ` abort it with ${abortRemedy(bucket, key, this.#uploadId)},` +
        ' or with a bucket lifecycle rule AbortIncompleteMultipartUpload';
    }
    return errors.fail(code, message, { path: location.path });
  }
}
