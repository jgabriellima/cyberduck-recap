import { Readable, Writable } from 'node:stream';
import type { RemoteFsError } from '../fs/errors.js';
import type {
  MkdirOptions,
  RemoteEntry,
  RemoteFileSystem,
  WriteStreamOptions,
} from '../fs/types.js';
import { resolveCredentials } from './credentials.js';
import { invalidArgument, S3Errors } from './errors.js';
import { internalsOf } from './internals.js';
import { Lifecycle, type OperationScope } from './lifecycle.js';
import * as operations from './operations.js';
import {
  validateS3Options,
  type S3FileSystemOptions,
  type ValidatedS3Options,
} from './options.js';
import { PathProblem, readPath, type S3Location } from './paths.js';
import { S3ReadStream } from './read-stream.js';
import { SecretSet } from './secrets.js';
import { resolveSettings, DEFAULT_REGION } from './settings.js';
import {
  createAgent,
  expiryOf,
  TrustProblem,
  trustedAuthorities,
} from './tls.js';
import {
  S3TransportError,
  type S3Transport,
  type SdkModule,
} from './transport.js';
import { S3WriteStream } from './write-stream.js';

/**
 * Amazon S3 and S3-compatible stores as a `RemoteFileSystem` (FEATURE-3). Account-wide, `/`
 * holds the buckets; with the option `bucket`, `/` is the root of that bucket. The SDK is loaded
 * when the instance connects, so a user who does not use S3 never loads it.
 */
export class S3FileSystem implements RemoteFileSystem {
  readonly #options: ValidatedS3Options;
  readonly #secrets = new SecretSet();
  readonly #errors: S3Errors;
  readonly #lifecycle = new Lifecycle();
  #transport: S3Transport | undefined;
  #connecting: Promise<void> | undefined;
  #ending: Promise<void> | undefined;

  constructor(options?: S3FileSystemOptions) {
    this.#options = validateS3Options(options);
    this.#secrets.add(this.#options.credentials?.secretAccessKey);
    this.#secrets.add(this.#options.credentials?.sessionToken);
    this.#errors = new S3Errors(this.#secrets, {
      endpointHost:
        this.#options.endpoint === undefined
          ? `s3.${this.#options.region ?? DEFAULT_REGION}.amazonaws.com`
          : new URL(this.#options.endpoint).host,
      keySource: 'option credentials',
      timeoutMs: this.#options.timeoutMs,
    });
  }

  connect(): Promise<void> {
    if (this.#lifecycle.state === 'connected') return Promise.resolve();
    if (this.#connecting !== undefined) return this.#connecting;
    const signal = this.#lifecycle.startConnecting();
    const connecting = this.#connect(signal).then(
      () => {
        this.#connecting = undefined;
        if (signal.aborted) throw this.#errors.notConnected(undefined);
        this.#lifecycle.connected();
      },
      (error: unknown) => {
        this.#connecting = undefined;
        this.#transport?.destroy();
        this.#transport = undefined;
        if (!signal.aborted) this.#lifecycle.failedToConnect();
        throw error;
      },
    );
    this.#connecting = connecting;
    return connecting;
  }

  /** Rejects with NOT_CONNECTED as soon as disconnect() ends the generation. */
  #untilEnded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void =>
        reject(
          this.#errors.fail(
            'NOT_CONNECTED',
            'disconnect() was called while connecting',
          ),
        );
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  async #connect(signal: AbortSignal): Promise<void> {
    const options = this.#options;
    const internals = internalsOf(this, true);
    const sdk = await this.#untilEnded<SdkModule>(import('./sdk.js'), signal);
    const env = { ...process.env };
    this.#secrets.add(env.AWS_SECRET_ACCESS_KEY);
    this.#secrets.add(env.AWS_SESSION_TOKEN);
    const paths = sdk.sharedFilePaths(env);
    const profiles = await this.#untilEnded(sdk.loadProfiles(paths), signal);
    const settings = resolveSettings(options, env, profiles);

    let ca;
    try {
      ca = await this.#untilEnded(trustedAuthorities(options.ca, env), signal);
    } catch (error) {
      if (error instanceof TrustProblem) {
        throw this.#errors.fail(
          'CONNECTION_FAILED',
          `cannot connect to ${settings.endpointHost}: ${error.why}`,
        );
      }
      throw error;
    }

    // Made before the keys are read: the credential chain's STS and SSO requests use it too.
    const agent = createAgent(ca, internals.lookup);
    let credentials;
    try {
      credentials = await this.#untilEnded(
        resolveCredentials({
          option: options.credentials,
          settings,
          env,
          profiles,
          paths,
          timeoutMs: options.timeoutMs,
          agent,
          secrets: this.#secrets,
          errors: this.#errors,
          sdk,
        }),
        signal,
      );
    } catch (error) {
      agent.destroy();
      throw error;
    }
    this.#errors.context = {
      endpointHost: settings.endpointHost,
      keySource: credentials.source,
      timeoutMs: options.timeoutMs,
    };

    const transport = sdk.createTransport({
      region: settings.region,
      endpoint: settings.endpoint,
      agent,
      timeoutMs: options.timeoutMs,
      credentials: credentials.provider,
    });
    this.#transport = transport;
    const context = this.#context(transport);
    const root = readPath('/', options.bucket);
    try {
      await operations.sendProbe(context, signal);
    } catch (error) {
      if (!(error instanceof S3TransportError)) throw error;
      const { failure } = error;
      let expiredOn: string | undefined;
      if (failure.kind === 'tls' && failure.errno === 'CERT_HAS_EXPIRED') {
        expiredOn = await expiryOf(
          failure,
          ca,
          internals.lookup,
          options.timeoutMs,
        );
      }
      const refused = operations.probeError(context, failure, root, expiredOn);
      if (refused !== undefined) throw refused;
    }
  }

  async disconnect(): Promise<void> {
    if (this.#ending !== undefined) return this.#ending;
    const state = this.#lifecycle.state;
    if (state === 'idle') return;
    const connecting = this.#connecting;
    this.#ending = (async () => {
      const ended = this.#lifecycle.end();
      await connecting?.catch(() => undefined);
      await ended;
      this.#transport?.destroy();
      this.#transport = undefined;
    })().finally(() => {
      this.#ending = undefined;
    });
    return this.#ending;
  }

  #context(transport: S3Transport): operations.S3Context {
    return { transport, errors: this.#errors, bucket: this.#options.bucket };
  }

  /** The location of `path`; INVALID_ARGUMENT for a path no request can carry. */
  #locate(path: string): S3Location {
    try {
      return readPath(path, this.#options.bucket);
    } catch (error) {
      if (error instanceof PathProblem) {
        throw invalidArgument(error.why, error.path);
      }
      throw error;
    }
  }

  /** The scope and transport of a connected instance; NOT_CONNECTED otherwise. */
  #connected(path: string): {
    scope: OperationScope;
    context: operations.S3Context;
  } {
    const scope = this.#lifecycle.begin();
    const transport = this.#transport;
    if (scope === undefined || transport === undefined) {
      throw this.#errors.notConnected(path);
    }
    return { scope, context: this.#context(transport) };
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const location = this.#locate(path);
    const { scope, context } = this.#connected(location.path);
    return operations.list(context, location, scope.signal);
  }

  async stat(path: string): Promise<RemoteEntry> {
    const location = this.#locate(path);
    const { scope, context } = this.#connected(location.path);
    return operations.stat(context, location, scope.signal);
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    const location = this.#locate(path);
    const { scope, context } = this.#connected(location.path);
    return operations.mkdir(
      context,
      location,
      options.recursive === true,
      scope.signal,
    );
  }

  async remove(path: string): Promise<void> {
    const location = this.#locate(path);
    const { scope, context } = this.#connected(location.path);
    return operations.remove(context, location, scope.signal);
  }

  async rename(from: string, to: string): Promise<void> {
    const source = this.#locate(from);
    const target = this.#locate(to);
    const { scope, context } = this.#connected(source.path);
    return operations.rename(context, source, target, scope.signal);
  }

  createReadStream(path: string): Readable {
    let location: S3Location;
    try {
      location = this.#locate(path);
    } catch (error) {
      return failedReadable(error as RemoteFsError);
    }
    const scope = this.#lifecycle.begin();
    return new S3ReadStream({
      context: this.#context(this.#transportOrClosed()),
      location,
      scope: this.#transport === undefined ? undefined : scope,
      timeoutMs: this.#options.timeoutMs,
    });
  }

  createWriteStream(path: string, options: WriteStreamOptions = {}): Writable {
    let location: S3Location;
    try {
      location = this.#locate(path);
    } catch (error) {
      return failedWritable(error as RemoteFsError);
    }
    const scope = this.#lifecycle.begin();
    return new S3WriteStream({
      context: this.#context(this.#transportOrClosed()),
      location,
      scope: this.#transport === undefined ? undefined : scope,
      exclusive: options.exclusive === true,
      partLimit: internalsOf(this).partLimit,
    });
  }

  /** A transport to hand a stream that will fail NOT_CONNECTED before it sends anything. */
  #transportOrClosed(): S3Transport {
    return this.#transport ?? CLOSED_TRANSPORT;
  }
}

function closed(): Promise<never> {
  return Promise.reject(new S3TransportError({ kind: 'aborted' }));
}

/** The transport of an instance that is not connected: every request fails, none is sent. */
const CLOSED_TRANSPORT: S3Transport = {
  listBuckets: closed,
  listObjects: closed,
  headObject: closed,
  getObject: closed,
  putObject: closed,
  createMultipartUpload: closed,
  uploadPart: closed,
  completeMultipartUpload: closed,
  abortMultipartUpload: closed,
  copyObject: closed,
  deleteObject: closed,
  createBucket: closed,
  deleteBucket: closed,
  destroy: () => undefined,
};

function failedReadable(error: RemoteFsError): Readable {
  return new Readable({
    construct(callback) {
      callback(error);
    },
    read() {},
  });
}

function failedWritable(error: RemoteFsError): Writable {
  return new Writable({
    construct(callback) {
      callback(error);
    },
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}
