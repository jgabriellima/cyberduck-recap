/**
 * The neutral seam between the S3 back-end and the SDK (design Option 8B): `sdk.ts` implements
 * it, every other module programs against it. It imports nothing of the SDK, not even a type,
 * so no SDK type or error object can reach the rest of `src/s3/`.
 */
import type { Readable } from 'node:stream';

/** What a request ended with, with no SDK type in it. */
export type S3Failure =
  | {
      readonly kind: 'reply';
      readonly status: number;
      readonly code: string | undefined;
      /** The `<Message>` of the error body, as the store sent it. */
      readonly serverMessage: string | undefined;
      readonly bucketRegion: string | undefined;
    }
  | {
      readonly kind: 'no-reply';
      readonly errno: string | undefined;
      readonly timeout: boolean;
    }
  | {
      readonly kind: 'tls';
      readonly errno: string;
      readonly host: string;
      readonly port: number;
    }
  /** A reply the SDK could not parse. */
  | { readonly kind: 'malformed' }
  /** The scope's signal fired: the instance was disconnected. */
  | { readonly kind: 'aborted' }
  /** The credential provider failed during an operation. */
  | { readonly kind: 'credentials' }
  /** The SDK refused to build the request; no byte was sent. */
  | { readonly kind: 'request' };

/** One attempt of a request whose attempts are recorded (request-policy.ts). */
export interface AttemptRecord {
  readonly replied: boolean;
  readonly status?: number;
  readonly code?: string;
}

/** The only error a transport method rejects with. Never shown: its message holds no text. */
export class S3TransportError extends Error {
  override readonly name = 'S3TransportError';
  readonly failure: S3Failure;
  readonly attempts: readonly AttemptRecord[];

  constructor(failure: S3Failure, attempts: readonly AttemptRecord[] = []) {
    super(`S3 request failed (${failure.kind})`);
    this.failure = failure;
    this.attempts = attempts;
  }
}

/** Thrown by a credential provider that cannot give keys; `sdk.ts` maps it to `credentials`. */
export class CredentialsUnavailable extends Error {
  override readonly name: string = 'CredentialsUnavailable';
}

/** The keys a provider gives. `expiration` is set only when the source states one. */
export interface S3Keys {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiration?: Date;
}

export type KeyProvider = () => Promise<S3Keys>;

export interface ListInput {
  readonly bucket: string;
  readonly prefix: string;
  readonly delimiter?: string;
  readonly maxKeys?: number;
  readonly token?: string;
}

/** Raw values: the server chooses them, so `listing.ts` validates each one. */
export interface BucketPage {
  readonly buckets: unknown;
  readonly token: unknown;
}

export interface ObjectPage {
  readonly contents: unknown;
  readonly prefixes: unknown;
  readonly truncated: unknown;
  readonly token: unknown;
}

export interface ObjectHead {
  readonly contentLength: unknown;
  readonly lastModified: unknown;
}

export interface ObjectBody {
  readonly body: Readable;
  readonly contentLength: number | undefined;
}

export interface PutInput {
  readonly bucket: string;
  readonly key: string;
  readonly body: Buffer;
  readonly exclusive: boolean;
}

export interface PartInput {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId: string;
  readonly partNumber: number;
  readonly body: Buffer;
}

export interface CompleteInput {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId: string;
  readonly parts: readonly {
    readonly partNumber: number;
    readonly etag: string;
  }[];
  readonly exclusive: boolean;
}

export interface CopyInput {
  readonly fromBucket: string;
  readonly fromKey: string;
  readonly bucket: string;
  readonly key: string;
}

/**
 * Every method rejects only with S3TransportError. A request with `exclusive` is sent once;
 * `putObject`, `completeMultipartUpload` and `copyObject` record their attempts.
 */
export interface S3Transport {
  listBuckets(
    token: string | undefined,
    signal: AbortSignal,
  ): Promise<BucketPage>;
  listObjects(input: ListInput, signal: AbortSignal): Promise<ObjectPage>;
  headObject(
    bucket: string,
    key: string,
    signal: AbortSignal,
  ): Promise<ObjectHead>;
  getObject(
    bucket: string,
    key: string,
    signal: AbortSignal,
  ): Promise<ObjectBody>;
  putObject(input: PutInput, signal: AbortSignal): Promise<void>;
  /** No signal: its reply always arrives, so a late upload ID can be aborted. Raw `UploadId`. */
  createMultipartUpload(bucket: string, key: string): Promise<unknown>;
  /** The raw `ETag`. */
  uploadPart(input: PartInput, signal: AbortSignal): Promise<unknown>;
  /** No signal: a completion in flight is never cut, so its outcome is known. */
  completeMultipartUpload(input: CompleteInput): Promise<void>;
  abortMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<void>;
  /** Always exclusive (`If-None-Match: *`), sent once. */
  copyObject(input: CopyInput, signal: AbortSignal): Promise<void>;
  deleteObject(bucket: string, key: string, signal: AbortSignal): Promise<void>;
  createBucket(bucket: string, signal: AbortSignal): Promise<void>;
  deleteBucket(bucket: string, signal: AbortSignal): Promise<void>;
  destroy(): void;
}

/** The command names of `S3Transport`, the rows of the request policy. */
export type S3Command = Exclude<keyof S3Transport, 'destroy'>;

/** What `sdk.ts` needs to build a transport. */
export interface TransportSettings {
  readonly region: string;
  /** A custom endpoint's origin; `undefined` for AWS's own endpoint. */
  readonly endpoint: string | undefined;
  readonly agent: import('node:https').Agent;
  readonly timeoutMs: number;
  readonly credentials: KeyProvider;
}

/** The shared files the SDK's loader read, by profile name (`profile ` prefix removed). */
export interface LoadedProfiles {
  readonly credentials: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly config: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface SharedFilePaths {
  readonly credentials: string;
  readonly config: string;
}

export interface ChainInit {
  readonly profile: string | undefined;
  readonly paths: SharedFilePaths;
  /** The instance's agent: the chain's STS and SSO requests verify TLS as S3's do. */
  readonly agent: import('node:https').Agent;
  readonly timeoutMs: number;
}

/** The module `connect()` loads with `import()` (design Option 8B). */
export interface SdkModule {
  createTransport(settings: TransportSettings): S3Transport;
  sharedFilePaths(
    env: Readonly<Record<string, string | undefined>>,
  ): SharedFilePaths;
  loadProfiles(paths: SharedFilePaths): Promise<LoadedProfiles>;
  chainCredentials(init: ChainInit): KeyProvider;
}
