/**
 * The only module of the project that imports the AWS SDK (design Option 8B), loaded with
 * `import()` when an S3 instance connects. It turns the neutral calls of `S3Transport` into SDK
 * commands and every SDK error into an `S3Failure`, so no SDK object leaves this file. It holds no
 * project rule: the attempts, idle bounds and redirect rule come from `request-policy.ts`.
 *
 * Production dependencies (FEATURE-3 design CO-1): `@aws-sdk/client-s3`,
 * `@aws-sdk/credential-providers`, `@smithy/node-http-handler`, and `@smithy/core` at the exact
 * version `@aws-sdk/client-s3` resolves (for `loadSharedConfigFiles`, `getHomeDir` and the retry
 * strategy). `@aws-sdk/lib-storage` is not used: the upload is own code (`upload.ts`).
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getHomeDir, loadSharedConfigFiles } from '@smithy/core/config';
import { StandardRetryStrategy } from '@smithy/core/retry';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { errnoOf } from '../fs/errors.js';
import {
  REQUEST_POLICY,
  STANDARD_ATTEMPTS,
  redirectRegion,
  sendsOnce,
  serverWorkIdleMs,
} from './request-policy.js';
import { tlsCauseOf } from './tls.js';
import { isVirtualHostable } from './validation.js';
import {
  CredentialsUnavailable,
  S3TransportError,
  type AttemptRecord,
  type ChainInit,
  type KeyProvider,
  type LoadedProfiles,
  type S3Command,
  type S3Failure,
  type S3Transport,
  type SharedFilePaths,
  type TransportSettings,
} from './transport.js';

/**
 * A logger that writes nothing. Its class name is not `NoOpLogger`: the SDK's chain writes its
 * warning about several credential sources to `console.warn` when the logger has that name.
 */
class SilentLogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

const SILENT = new SilentLogger();

/** The SDK's command type, as far as this file needs it. */
interface SdkCommand {
  readonly middlewareStack: {
    add(
      middleware: unknown,
      options: {
        step: string;
        priority?: string;
        name?: string;
        override?: boolean;
      },
    ): void;
  };
}

interface Recorded {
  readonly attempts: AttemptRecord[];
  target: { host: string; port: number } | undefined;
}

function recordOf(error: unknown): AttemptRecord {
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } })
    .$metadata;
  const status = metadata?.httpStatusCode;
  if (typeof status === 'number') {
    const { code } = bodyOf(error);
    return { replied: true, status, ...(code === undefined ? {} : { code }) };
  }
  return { replied: false };
}

/**
 * Records each attempt (a reply or none) and the host of the request. It runs in the
 * `deserialize` step, inside the SDK's retry loop, so it sees every attempt.
 */
function recorder(recorded: Recorded) {
  return (next: (args: unknown) => Promise<unknown>) =>
    async (args: unknown): Promise<unknown> => {
      const request = (
        args as { request?: { hostname?: unknown; port?: unknown } }
      ).request;
      if (typeof request?.hostname === 'string') {
        recorded.target = {
          host: request.hostname,
          port: typeof request.port === 'number' ? request.port : 443,
        };
      }
      try {
        const result = await next(args);
        const status = (result as { response?: { statusCode?: unknown } })
          .response?.statusCode;
        recorded.attempts.push({
          replied: true,
          ...(typeof status === 'number' ? { status } : {}),
        });
        return result;
      } catch (error) {
        recorded.attempts.push(recordOf(error));
        throw error;
      }
    };
}

/**
 * On AWS's endpoint, moves a bucket the SDK put in the path into the host name, before the host
 * header is set and the request signed (`isVirtualHostable` in validation.ts says which).
 */
function virtualHost() {
  return (next: (args: unknown) => Promise<unknown>) =>
    async (args: unknown): Promise<unknown> => {
      const { input, request } = args as {
        input?: { Bucket?: unknown };
        request?: {
          hostname?: unknown;
          path?: unknown;
          headers?: Record<string, string>;
        };
      };
      const bucket = input?.Bucket;
      if (
        typeof bucket === 'string' &&
        isVirtualHostable(bucket) &&
        request !== undefined &&
        typeof request.hostname === 'string' &&
        typeof request.path === 'string' &&
        !request.hostname.startsWith(`${bucket}.`) &&
        (request.path === `/${bucket}` ||
          request.path.startsWith(`/${bucket}/`))
      ) {
        request.hostname = `${bucket}.${request.hostname}`;
        request.path = request.path.slice(bucket.length + 1) || '/';
        if (request.headers !== undefined) delete request.headers.host;
      }
      return next(args);
    };
}

/** Error bodies are small; a larger one is cut here and fails to parse (a malformed reply). */
const ERROR_BODY_LIMIT = 65_536;
const rawErrorBodies = new WeakMap<object, string>();

async function collect(body: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= limit) {
      body.destroy();
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

/**
 * Keeps the bytes of an error reply as the store sent them: an XML parser normalises a carriage
 * return to a line feed, and the message must reach `serverText` unchanged to be escaped
 * exactly. The SDK then parses the same bytes.
 */
function keepErrorBody() {
  return (next: (args: unknown) => Promise<unknown>) =>
    async (args: unknown): Promise<unknown> => {
      const result = await next(args);
      const response = (
        result as { response?: { statusCode?: unknown; body?: unknown } }
      ).response;
      if (
        response !== undefined &&
        typeof response.statusCode === 'number' &&
        response.statusCode >= 300 &&
        typeof (response.body as Readable | undefined)?.pipe === 'function'
      ) {
        const bytes = await collect(
          response.body as Readable,
          ERROR_BODY_LIMIT,
        );
        response.body = bytes;
        rawErrorBodies.set(response, bytes.toString('utf8'));
      }
      return result;
    };
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

function unescapeXml(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g,
    (whole, entity: string) => {
      if (entity.startsWith('#')) {
        const point = entity.startsWith('#x')
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
      }
      return XML_ENTITIES[entity] ?? whole;
    },
  );
}

/** The `<Message>` of an error body, with the bytes the store sent. */
function rawMessageOf(error: unknown): string | undefined {
  const response = (error as { $response?: unknown }).$response;
  if (typeof response !== 'object' || response === null) return undefined;
  const raw = rawErrorBodies.get(response);
  const match =
    raw === undefined ? null : /<Message>([\s\S]*?)<\/Message>/.exec(raw);
  return match?.[1] === undefined ? undefined : unescapeXml(match[1]);
}

function headerOf(error: unknown, name: string): string | undefined {
  const response = (
    error as { $response?: { headers?: Record<string, unknown> } }
  ).$response;
  const value = response?.headers?.[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The code and the message a store put in its error body. The SDK sets `Code` only from a body;
 * a reply without one (a HEAD reply has no body) gives neither, and its made-up name is dropped.
 */
function bodyOf(error: unknown): {
  code: string | undefined;
  serverMessage: string | undefined;
} {
  const record = error as { Code?: unknown };
  if (typeof record.Code !== 'string' || record.Code === '') {
    return { code: undefined, serverMessage: undefined };
  }
  // The message comes from the bytes the store sent, never from the SDK's error object.
  return { code: record.Code, serverMessage: rawMessageOf(error) };
}

/** Turns anything the SDK throws into a neutral failure; the SDK object stays here. */
function failureOf(
  error: unknown,
  signal: AbortSignal | undefined,
  target: { host: string; port: number } | undefined,
): S3Failure {
  if (error instanceof CredentialsUnavailable) return { kind: 'credentials' };
  if (
    signal?.aborted === true ||
    (error as { name?: unknown }).name === 'AbortError'
  ) {
    return { kind: 'aborted' };
  }
  const errno = errnoOf(error);
  if (tlsCauseOf(errno) !== undefined && errno !== undefined) {
    return {
      kind: 'tls',
      errno,
      host: target?.host ?? '',
      port: target?.port ?? 443,
    };
  }
  const record = error as {
    $fault?: unknown;
    $metadata?: { httpStatusCode?: unknown };
    $response?: unknown;
  };
  const status = record.$metadata?.httpStatusCode;
  if (record.$fault !== undefined && typeof status === 'number') {
    return {
      kind: 'reply',
      status,
      ...bodyOf(error),
      bucketRegion: headerOf(error, 'x-amz-bucket-region'),
    };
  }
  if (record.$response !== undefined) return { kind: 'malformed' };
  const name = (error as { name?: unknown }).name;
  if (errno !== undefined || name === 'TimeoutError') {
    return {
      kind: 'no-reply',
      errno,
      timeout:
        name === 'TimeoutError' && errno !== 'ECONNRESET' && errno !== 'EPIPE',
    };
  }
  return { kind: 'request' };
}

/** The two shared files, from the variables or the home directory, as the SDK finds them. */
export function sharedFilePaths(
  env: Readonly<Record<string, string | undefined>>,
): SharedFilePaths {
  const home = getHomeDir();
  const nonEmpty = (value: string | undefined): string | undefined =>
    value === undefined || value === '' ? undefined : value;
  return {
    credentials:
      nonEmpty(env.AWS_SHARED_CREDENTIALS_FILE) ??
      join(home, '.aws', 'credentials'),
    config: nonEmpty(env.AWS_CONFIG_FILE) ?? join(home, '.aws', 'config'),
  };
}

/** Both shared files, read with the SDK's own loader (a file that cannot be read is empty). */
export async function loadProfiles(
  paths: SharedFilePaths,
): Promise<LoadedProfiles> {
  const files = await loadSharedConfigFiles({
    filepath: paths.credentials,
    configFilepath: paths.config,
    ignoreCache: true,
  });
  const strings = (
    sections: Record<string, Record<string, unknown> | undefined>,
  ): Record<string, Record<string, string>> =>
    Object.fromEntries(
      Object.entries(sections).map(([name, section]) => [
        name,
        Object.fromEntries(
          Object.entries(section ?? {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
      ]),
    );
  return {
    credentials: strings(files.credentialsFile),
    config: strings(files.configFile),
  };
}

/** The SDK's Node chain (sources 1 to 4), silent, reading the same two files. */
export function chainCredentials(init: ChainInit): KeyProvider {
  const chain = fromNodeProviderChain({
    ...(init.profile === undefined ? {} : { profile: init.profile }),
    filepath: init.paths.credentials,
    configFilepath: init.paths.config,
    ignoreCache: true,
    logger: SILENT,
  });
  return async () => {
    let identity;
    try {
      identity = await chain();
    } catch {
      // The SDK's text can hold a command line, a process's output or a file's line.
      throw new CredentialsUnavailable('the AWS credential chain gave no keys');
    }
    return {
      accessKeyId: identity.accessKeyId,
      secretAccessKey: identity.secretAccessKey,
      ...(identity.sessionToken === undefined
        ? {}
        : { sessionToken: identity.sessionToken }),
      ...(identity.expiration === undefined
        ? {}
        : { expiration: identity.expiration }),
    };
  };
}

type Idle = 'normal' | 'server-work';

export function createTransport(settings: TransportSettings): S3Transport {
  const handlers: Record<Idle, NodeHttpHandler> = {
    normal: new NodeHttpHandler({
      httpsAgent: settings.agent,
      connectionTimeout: settings.timeoutMs,
      socketTimeout: settings.timeoutMs,
      logger: SILENT,
    }),
    'server-work': new NodeHttpHandler({
      httpsAgent: settings.agent,
      connectionTimeout: settings.timeoutMs,
      socketTimeout: serverWorkIdleMs(settings.timeoutMs),
      logger: SILENT,
    }),
  };
  // One retry quota per instance, not one per client.
  const retryStrategy = new StandardRetryStrategy(STANDARD_ATTEMPTS);
  const clients = new Map<string, S3Client>();
  const bucketRegions = new Map<string, string>();
  let destroyed = false;

  function clientFor(region: string, once: boolean, idle: Idle): S3Client {
    const id = `${region} ${once ? 'once' : 'standard'} ${idle}`;
    let client = clients.get(id);
    if (client === undefined) {
      const config: S3ClientConfig = {
        region,
        credentials: settings.credentials,
        requestHandler: handlers[idle],
        logger: SILENT,
        // Each value below is explicit, so no environment variable or profile changes it.
        forcePathStyle: settings.endpoint !== undefined,
        ...(settings.endpoint === undefined
          ? {}
          : { endpoint: settings.endpoint }),
        ignoreConfiguredEndpointUrls: true,
        useFipsEndpoint: false,
        useDualstackEndpoint: false,
        useArnRegion: false,
        disableMultiregionAccessPoints: true,
        disableS3ExpressSessionAuth: true,
        followRegionRedirects: false,
        defaultsMode: 'legacy',
        retryMode: 'standard',
        // S3-compatible stores that do not know the CRC trailers accept the requests; TLS
        // protects the bytes in transit.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        ...(once ? { maxAttempts: 1 } : { retryStrategy }),
      };
      client = new S3Client(config);
      if (settings.endpoint === undefined) {
        client.middlewareStack.add(virtualHost() as never, {
          step: 'build',
          priority: 'high',
          name: 'cyberduckRecapVirtualHost',
        });
      }
      clients.set(id, client);
    }
    return client;
  }

  /**
   * Sends one command through the client its policy names, follows one region redirect, and
   * rejects only with S3TransportError.
   */
  async function send<Output>(
    command: S3Command,
    bucket: string | undefined,
    make: () => SdkCommand,
    options: {
      readonly exclusive?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<Output> {
    const policy = REQUEST_POLICY[command];
    const signal = policy.signal ? options.signal : undefined;
    const recorded: Recorded = { attempts: [], target: undefined };
    let region =
      (bucket === undefined ? undefined : bucketRegions.get(bucket)) ??
      settings.region;
    for (let redirects = 0; ; redirects += 1) {
      if (destroyed || signal?.aborted === true) {
        throw new S3TransportError({ kind: 'aborted' }, recorded.attempts);
      }
      const client = clientFor(
        region,
        sendsOnce(command, options.exclusive ?? false),
        policy.idle,
      );
      const sdkCommand = make();
      sdkCommand.middlewareStack.add(recorder(recorded), {
        step: 'deserialize',
        priority: 'high',
        name: 'cyberduckRecapAttemptRecorder',
        override: true,
      });
      sdkCommand.middlewareStack.add(keepErrorBody(), {
        step: 'deserialize',
        priority: 'low',
        name: 'cyberduckRecapErrorBody',
        override: true,
      });
      try {
        return (await client.send(
          sdkCommand as never,
          signal === undefined ? {} : { abortSignal: signal },
        )) as Output;
      } catch (error) {
        const failure = failureOf(error, signal, recorded.target);
        const next =
          redirects === 0 && bucket !== undefined
            ? redirectRegion(failure)
            : undefined;
        if (next !== undefined && next !== region) {
          bucketRegions.set(bucket ?? '', next);
          region = next;
          continue;
        }
        throw new S3TransportError(
          failure,
          policy.recordAttempts ? recorded.attempts : [],
        );
      }
    }
  }

  return {
    async listBuckets(token, signal) {
      const output = await send<{
        Buckets?: unknown;
        ContinuationToken?: unknown;
      }>(
        'listBuckets',
        undefined,
        () =>
          new ListBucketsCommand(
            token === undefined ? {} : { ContinuationToken: token },
          ),
        { signal },
      );
      return { buckets: output.Buckets, token: output.ContinuationToken };
    },
    async listObjects(input, signal) {
      const output = await send<{
        Contents?: unknown;
        CommonPrefixes?: unknown;
        IsTruncated?: unknown;
        NextContinuationToken?: unknown;
      }>(
        'listObjects',
        input.bucket,
        () =>
          new ListObjectsV2Command({
            Bucket: input.bucket,
            Prefix: input.prefix,
            ...(input.delimiter === undefined
              ? {}
              : { Delimiter: input.delimiter }),
            ...(input.maxKeys === undefined ? {} : { MaxKeys: input.maxKeys }),
            ...(input.token === undefined
              ? {}
              : { ContinuationToken: input.token }),
          }),
        { signal },
      );
      return {
        contents: output.Contents,
        prefixes: output.CommonPrefixes,
        truncated: output.IsTruncated,
        token: output.NextContinuationToken,
      };
    },
    async headObject(bucket, key, signal) {
      const output = await send<{
        ContentLength?: unknown;
        LastModified?: unknown;
      }>(
        'headObject',
        bucket,
        () => new HeadObjectCommand({ Bucket: bucket, Key: key }),
        { signal },
      );
      return {
        contentLength: output.ContentLength,
        lastModified: output.LastModified,
      };
    },
    async getObject(bucket, key, signal) {
      const output = await send<{ Body?: unknown; ContentLength?: unknown }>(
        'getObject',
        bucket,
        () => new GetObjectCommand({ Bucket: bucket, Key: key }),
        { signal },
      );
      const body = output.Body as Readable | undefined;
      if (body === undefined || typeof body.pipe !== 'function') {
        throw new S3TransportError({ kind: 'malformed' });
      }
      // The read stream's own watchdog is the one idle rule of the body: the socket's timer of
      // the handler would also fire while a consumer pauses the body.
      (body as IncomingMessage).socket?.setTimeout(0);
      return {
        body,
        contentLength:
          typeof output.ContentLength === 'number'
            ? output.ContentLength
            : undefined,
      };
    },
    async putObject(input, signal) {
      await send(
        'putObject',
        input.bucket,
        () =>
          new PutObjectCommand({
            Bucket: input.bucket,
            Key: input.key,
            Body: input.body,
            ContentLength: input.body.length,
            ...(input.exclusive ? { IfNoneMatch: '*' } : {}),
          }),
        { signal, exclusive: input.exclusive },
      );
    },
    async createMultipartUpload(bucket, key) {
      const output = await send<{ UploadId?: unknown }>(
        'createMultipartUpload',
        bucket,
        () => new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
      );
      return output.UploadId;
    },
    async uploadPart(input, signal) {
      const output = await send<{ ETag?: unknown }>(
        'uploadPart',
        input.bucket,
        () =>
          new UploadPartCommand({
            Bucket: input.bucket,
            Key: input.key,
            UploadId: input.uploadId,
            PartNumber: input.partNumber,
            Body: input.body,
            ContentLength: input.body.length,
          }),
        { signal },
      );
      return output.ETag;
    },
    async completeMultipartUpload(input) {
      await send(
        'completeMultipartUpload',
        input.bucket,
        () =>
          new CompleteMultipartUploadCommand({
            Bucket: input.bucket,
            Key: input.key,
            UploadId: input.uploadId,
            MultipartUpload: {
              Parts: input.parts.map((part) => ({
                PartNumber: part.partNumber,
                ETag: part.etag,
              })),
            },
            ...(input.exclusive ? { IfNoneMatch: '*' } : {}),
          }),
        { exclusive: input.exclusive },
      );
    },
    async abortMultipartUpload(bucket, key, uploadId) {
      await send(
        'abortMultipartUpload',
        bucket,
        () =>
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
          }),
      );
    },
    async copyObject(input, signal) {
      // x-amz-copy-source is a header the caller encodes: each segment once, the `/`s kept.
      const source = [input.fromBucket, ...input.fromKey.split('/')]
        .map(encodeURIComponent)
        .join('/');
      await send(
        'copyObject',
        input.bucket,
        () =>
          new CopyObjectCommand({
            Bucket: input.bucket,
            Key: input.key,
            CopySource: source,
            IfNoneMatch: '*',
          }),
        { signal, exclusive: true },
      );
    },
    async deleteObject(bucket, key, signal) {
      await send(
        'deleteObject',
        bucket,
        () => new DeleteObjectCommand({ Bucket: bucket, Key: key }),
        { signal },
      );
    },
    async createBucket(bucket, signal) {
      const region = settings.region;
      await send(
        'createBucket',
        bucket,
        () =>
          new CreateBucketCommand({
            Bucket: bucket,
            ...(region === 'us-east-1'
              ? {}
              : {
                  CreateBucketConfiguration: {
                    LocationConstraint: region as never,
                  },
                }),
          }),
        { signal },
      );
    },
    async deleteBucket(bucket, signal) {
      await send(
        'deleteBucket',
        bucket,
        () => new DeleteBucketCommand({ Bucket: bucket }),
        { signal },
      );
    },
    destroy() {
      destroyed = true;
      for (const client of clients.values()) client.destroy();
      clients.clear();
      handlers.normal.destroy();
      handlers['server-work'].destroy();
      settings.agent.destroy();
    },
  };
}
