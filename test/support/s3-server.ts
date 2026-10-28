/**
 * The fake S3 server of FEATURE-3 decision 4: in process, on 127.0.0.1 and an ephemeral port,
 * HTTPS with a certificate from a test authority made at run time. It checks the AWS Signature
 * Version 4 of every request against the keys the test gives it, records each request, keeps
 * buckets and objects in memory, and lets a test inject a fault into any request.
 *
 * It answers path-style requests (`/<bucket>/<key>`) and virtual-hosted requests whose `Host` is
 * `<bucket>.s3.<region>.amazonaws.com` (AC-28, AC-41, AC-52): the test routes those names here.
 */
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  createServer,
  type Server,
  type ServerOptions as HttpsServerOptions,
} from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import {
  createTestCa,
  type IssuedCertificate,
  type TestCa,
} from './test-ca.js';
import { verifyRequest, type SigningKeys } from './sigv4.js';

export type S3Operation =
  | 'ListBuckets'
  | 'CreateBucket'
  | 'DeleteBucket'
  | 'HeadBucket'
  | 'GetBucketLocation'
  | 'ListObjectsV2'
  | 'ListObjects'
  | 'DeleteObjects'
  | 'GetObject'
  | 'HeadObject'
  | 'PutObject'
  | 'CopyObject'
  | 'DeleteObject'
  | 'CreateMultipartUpload'
  | 'UploadPart'
  | 'CompleteMultipartUpload'
  | 'AbortMultipartUpload'
  | 'Unknown';

export interface RecordedRequest {
  /** Order of arrival, from 0. */
  readonly index: number;
  readonly method: string;
  /** The request target exactly as received: raw path and raw query. */
  readonly url: string;
  readonly rawPath: string;
  /** Decoded query parameters; a parameter with no value is `''`. */
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The `Host` header without its port. */
  readonly host: string;
  readonly style: 'path' | 'virtual-hosted';
  readonly operation: S3Operation;
  readonly bucket: string | undefined;
  readonly key: string | undefined;
  /** `If-None-Match` as received. */
  readonly ifNoneMatch: string | undefined;
  /** The access key id and region of the signature's credential scope, when it has one. */
  readonly accessKeyId: string | undefined;
  readonly region: string | undefined;
  readonly sessionToken: string | undefined;
  /** True when the signature verified against one of the accepted keys. */
  signatureValid: boolean;
  /** Bytes of the (decoded) request body, once read. */
  bodyBytes: number;
  /** The body as text when it is at most 64 KiB (XML of CreateBucket, Complete…, Delete…). */
  bodyText: string | undefined;
  /** The response was handed in full to the connection. */
  responseFinished: boolean;
  /** The connection closed before the response was finished. */
  connectionClosedEarly: boolean;
  /** Body bytes of the response written before the end or the close. */
  responseBytesSent: number;
  /** The status of the reply sent, or `undefined` when none was sent (stall, reset). */
  responseStatus: number | undefined;
}

export interface StoredObject {
  data: Buffer;
  lastModified: Date;
  etag: string;
  /** The size the server reports in HeadObject and listings, when it differs from `data`. */
  reportedSize?: number;
}

export type Fault =
  /** An S3 error reply. `code` and `message` go into the XML body; `extraXml` is appended. */
  | {
      readonly kind: 'error';
      readonly status: number;
      readonly code?: string;
      readonly message?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly extraXml?: string;
    }
  /** A reply exactly as given: a malformed body, an HTML page, a body with no XML. */
  | {
      readonly kind: 'raw';
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string | Buffer;
      /** Send no `Content-Length` header (a HeadObject reply without it, AC-30). */
      readonly omitContentLength?: boolean;
    }
  /** Never answer; the connection stays open until the client or the fixture closes it. */
  | { readonly kind: 'stall' }
  /** Close the connection after the request body, without processing it and without a reply. */
  | { readonly kind: 'reset' }
  /** Process the request (store the object, complete the upload), then close without a reply. */
  | { readonly kind: 'store-then-reset' }
  /** Process the request normally, but only after `until` settles. */
  | { readonly kind: 'hold'; readonly until: Promise<unknown> }
  /** Send the headers (full Content-Length) and the first `after` body bytes, then reset. */
  | { readonly kind: 'reset-in-body'; readonly after: number }
  /** Send the headers (full Content-Length) and `after` body bytes, then end the connection. */
  | { readonly kind: 'short-body'; readonly after: number }
  /** Send the headers and `after` body bytes, then send nothing more. */
  | { readonly kind: 'stall-in-body'; readonly after: number };

/** Returns a fault for a request, or `undefined` to let the next rule or the server answer. */
export type FaultRule = (request: RecordedRequest) => Fault | undefined;

export interface S3ServerOptions {
  /** The authority that issues the server's certificate; default: a new one. */
  readonly ca?: TestCa;
  /** Subject alternative names of the server's certificate; default `DEFAULT_HOSTS`. */
  readonly hosts?: readonly string[];
  /** A certificate to present instead of one issued for `hosts` (expired, other host…). */
  readonly certificate?: IssuedCertificate;
  /** The keys whose signatures the server accepts; default: one random key pair. */
  readonly credentials?: readonly SigningKeys[];
  /** Reject a request whose signature does not verify (default true). */
  readonly checkSignature?: boolean;
  /** Largest page of ListObjectsV2 (default 1000, S3's own). */
  readonly listPageSize?: number;
  /** Buckets per page of ListBuckets; default: every bucket on one page. */
  readonly bucketPageSize?: number;
  /** The upload ID of the n-th CreateMultipartUpload (from 1). */
  readonly uploadId?: (n: number) => string;
  /** The code CreateBucket answers for a bucket that exists (default BucketAlreadyOwnedByYou). */
  readonly existingBucketCode?:
    'BucketAlreadyOwnedByYou' | 'BucketAlreadyExists';
}

export interface MultipartUpload {
  readonly bucket: string;
  readonly key: string;
  readonly parts: Map<number, { data: Buffer; etag: string }>;
}

/** The AWS regions whose S3 host names the default certificate covers. */
export const TEST_REGIONS = [
  'us-east-1',
  'us-west-2',
  'eu-west-1',
  'eu-central-1',
  'ap-south-1',
] as const;

export const DEFAULT_HOSTS: readonly string[] = [
  '127.0.0.1',
  'localhost',
  ...TEST_REGIONS.flatMap((region) => [
    `s3.${region}.amazonaws.com`,
    `*.s3.${region}.amazonaws.com`,
  ]),
  's3.amazonaws.com',
  '*.s3.amazonaws.com',
];

const VIRTUAL_HOST = /^(.+)\.s3(?:[.-]([a-z0-9-]+))?\.amazonaws\.com$/;
const S3_NAMESPACE = 'http://s3.amazonaws.com/doc/2006-03-01/';
const TEXT_LIMIT = 64 * 1024;
const CHUNK = 64 * 1024;

export interface S3ServerFixture {
  readonly host: '127.0.0.1';
  readonly port: number;
  /** `https://127.0.0.1:<port>`: a custom endpoint (path-style). */
  readonly endpoint: string;
  readonly ca: TestCa;
  /** The first accepted key pair: what a test gives the back-end by default. */
  readonly keys: SigningKeys;
  readonly requests: RecordedRequest[];
  /** TCP connections accepted, TLS handshakes completed and TLS handshakes failed. */
  readonly counts: { tcp: number; tls: number; tlsErrors: number };
  /** The largest number of UploadPart requests in flight at once. */
  readonly maxUploadPartsInFlight: number;
  readonly buckets: Map<string, Map<string, StoredObject>>;
  readonly uploads: Map<string, MultipartUpload>;
  addBucket(name: string): void;
  removeBucket(name: string): void;
  putObject(
    bucket: string,
    key: string,
    data: Buffer | string,
    options?: { lastModified?: Date; reportedSize?: number },
  ): void;
  getObject(bucket: string, key: string): Buffer | undefined;
  hasObject(bucket: string, key: string): boolean;
  keysOf(bucket: string): string[];
  /** Adds a fault rule; returns a function that removes it. Rules run in the order added. */
  fault(rule: FaultRule): () => void;
  /** The recorded requests of an operation, optionally for one key. */
  requestsOf(operation: S3Operation, key?: string): RecordedRequest[];
  /** Resolves with the first request (already recorded or later) that matches. */
  /**
   * Resolves when the response to `request` was handed in full to the connection, or the
   * connection closed before that (`responseFinished` / `connectionClosedEarly` are then set).
   */
  responseSettled(request: RecordedRequest): Promise<void>;
  waitForRequest(
    predicate: (request: RecordedRequest) => boolean,
  ): Promise<RecordedRequest>;
  /** Forgets the recorded requests (the objects stay). */
  clearRequests(): void;
  close(): Promise<void>;
}

export async function startS3Server(
  options: S3ServerOptions = {},
): Promise<S3ServerFixture> {
  const ca = options.ca ?? createTestCa();
  const certificate =
    options.certificate ?? ca.issue({ hosts: options.hosts ?? DEFAULT_HOSTS });
  const credentials: readonly SigningKeys[] = options.credentials ?? [
    {
      accessKeyId: `AKIATEST${randomBytes(6).toString('hex').toUpperCase()}`,
      secretAccessKey: randomBytes(24).toString('base64'),
    },
  ];
  const firstKeys = credentials[0];
  if (firstKeys === undefined) {
    throw new Error('startS3Server: give at least one key pair');
  }
  const checkSignature = options.checkSignature ?? true;
  const listPageSize = options.listPageSize ?? 1000;

  const buckets = new Map<string, Map<string, StoredObject>>();
  const uploads = new Map<string, MultipartUpload>();
  const requests: RecordedRequest[] = [];
  const rules: FaultRule[] = [];
  const waiters: {
    predicate: (request: RecordedRequest) => boolean;
    resolve: (request: RecordedRequest) => void;
  }[] = [];
  const sockets = new Set<Socket>();
  const settledResponses = new Map<RecordedRequest, Promise<void>>();
  const counts = { tcp: 0, tls: 0, tlsErrors: 0 };
  let uploadCount = 0;
  let partsInFlight = 0;
  let maxPartsInFlight = 0;

  const tlsOptions: HttpsServerOptions = {
    cert: certificate.cert,
    key: certificate.key,
  };
  const server: Server = createServer(tlsOptions, (req, res) => {
    void handle(req, res);
  });
  server.on('connection', (socket: Socket) => {
    counts.tcp += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('secureConnection', (socket: Socket) => {
    counts.tls += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => {
    counts.tlsErrors += 1;
  });

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const record = recordOf(req);
    requests.push(record);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(record)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(record);
      }
    }
    const inFlight = record.operation === 'UploadPart';
    if (inFlight) {
      partsInFlight += 1;
      maxPartsInFlight = Math.max(maxPartsInFlight, partsInFlight);
    }
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      if (inFlight) partsInFlight -= 1;
    };
    let markSettled: () => void = () => undefined;
    settledResponses.set(
      record,
      new Promise<void>((resolve) => {
        markSettled = resolve;
      }),
    );
    res.on('finish', () => {
      record.responseFinished = true;
      record.responseStatus = res.statusCode;
      done();
      markSettled();
    });
    res.on('close', () => {
      if (!record.responseFinished) record.connectionClosedEarly = true;
      done();
      markSettled();
    });

    let body: Buffer;
    try {
      body = decodeBody(req, await readBody(req));
    } catch {
      return;
    }
    record.bodyBytes = body.length;
    if (body.length <= TEXT_LIMIT) record.bodyText = body.toString('utf8');

    const verdict = verifyRequest(
      {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
      },
      credentials,
    );
    record.signatureValid = verdict.ok;

    let fault: Fault | undefined;
    for (const rule of [...rules]) {
      fault = rule(record);
      if (fault !== undefined) break;
    }
    if (fault?.kind === 'hold') {
      await fault.until.catch(() => undefined);
      fault = undefined;
    }
    if (fault !== undefined) {
      switch (fault.kind) {
        case 'error':
          sendError(res, record, fault.status, fault.code, fault.message, {
            headers: fault.headers,
            extraXml: fault.extraXml,
          });
          return;
        case 'raw':
          send(
            res,
            record,
            fault.status,
            fault.headers ?? {},
            fault.body,
            fault.omitContentLength === true,
          );
          return;
        case 'stall':
          return;
        case 'reset':
          req.socket.destroy();
          return;
        default:
          break;
      }
    }
    if (checkSignature && !verdict.ok) {
      sendError(res, record, 403, verdict.code, signatureMessage(verdict.code));
      return;
    }
    const reply = answer(record, body);
    if (fault?.kind === 'store-then-reset') {
      req.socket.destroy();
      return;
    }
    if (
      fault?.kind === 'reset-in-body' ||
      fault?.kind === 'short-body' ||
      fault?.kind === 'stall-in-body'
    ) {
      await sendPartial(res, record, reply, fault.kind, fault.after);
      return;
    }
    await sendReply(res, record, reply);
  }

  interface Reply {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body?: Buffer;
    /** For HEAD: the Content-Length to announce with no body. */
    readonly headLength?: number;
    readonly omitContentLength?: boolean;
  }

  function answer(request: RecordedRequest, body: Buffer): Reply {
    const { bucket, key, query } = request;
    const fail = (status: number, code: string, message: string): Reply =>
      errorReply(request, status, code, message);
    if (request.operation === 'ListBuckets') return listBuckets(query);
    if (bucket === undefined) {
      return fail(400, 'InvalidRequest', 'Unsupported request');
    }
    const objects = buckets.get(bucket);
    if (request.operation === 'CreateBucket') {
      if (objects !== undefined) {
        const code = options.existingBucketCode ?? 'BucketAlreadyOwnedByYou';
        return fail(409, code, 'The requested bucket name is not available');
      }
      buckets.set(bucket, new Map());
      return { status: 200, headers: { location: `/${bucket}` } };
    }
    if (objects === undefined) {
      return {
        ...fail(404, 'NoSuchBucket', 'The specified bucket does not exist'),
      };
    }
    switch (request.operation) {
      case 'HeadBucket':
        return { status: 200, headers: { 'x-amz-bucket-region': 'us-east-1' } };
      case 'GetBucketLocation':
        return xml(
          200,
          `<LocationConstraint xmlns="${S3_NAMESPACE}"></LocationConstraint>`,
        );
      case 'DeleteBucket':
        if (objects.size > 0) {
          return fail(
            409,
            'BucketNotEmpty',
            'The bucket you tried to delete is not empty',
          );
        }
        buckets.delete(bucket);
        return { status: 204, headers: {} };
      case 'ListObjectsV2':
        return listObjects(bucket, objects, query);
      case 'DeleteObjects':
        return deleteObjects(objects, body);
      default:
        break;
    }
    if (key === undefined) return fail(400, 'InvalidRequest', 'No key');
    const object = objects.get(key);
    const exclusive = request.ifNoneMatch === '*';
    switch (request.operation) {
      case 'HeadObject':
      case 'GetObject': {
        if (object === undefined) {
          return fail(404, 'NoSuchKey', 'The specified key does not exist.');
        }
        const headers = {
          'content-type': 'application/octet-stream',
          'last-modified': object.lastModified.toUTCString(),
          etag: object.etag,
          'accept-ranges': 'bytes',
        };
        if (request.operation === 'HeadObject') {
          return {
            status: 200,
            headers,
            headLength: object.reportedSize ?? object.data.length,
          };
        }
        return { status: 200, headers, body: object.data };
      }
      case 'PutObject': {
        if (exclusive && object !== undefined) return preconditionFailed();
        const stored = store(objects, key, body);
        return { status: 200, headers: { etag: stored.etag } };
      }
      case 'DeleteObject':
        objects.delete(key);
        return { status: 204, headers: {} };
      case 'CopyObject': {
        const source = copySourceOf(request.headers['x-amz-copy-source']);
        const from =
          source === undefined
            ? undefined
            : buckets.get(source.bucket)?.get(source.key);
        if (from === undefined) {
          return fail(404, 'NoSuchKey', 'The specified key does not exist.');
        }
        if (exclusive && object !== undefined) return preconditionFailed();
        const stored = store(objects, key, Buffer.from(from.data));
        return xml(
          200,
          `<CopyObjectResult xmlns="${S3_NAMESPACE}"><LastModified>${stored.lastModified.toISOString()}</LastModified><ETag>${text(stored.etag)}</ETag></CopyObjectResult>`,
        );
      }
      case 'CreateMultipartUpload': {
        uploadCount += 1;
        const id = options.uploadId?.(uploadCount) ?? `upload-${uploadCount}`;
        uploads.set(id, { bucket, key, parts: new Map() });
        return xml(
          200,
          `<InitiateMultipartUploadResult xmlns="${S3_NAMESPACE}"><Bucket>${text(bucket)}</Bucket><Key>${text(key)}</Key><UploadId>${text(id)}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      case 'UploadPart': {
        const upload = uploads.get(query.uploadId ?? '');
        if (upload === undefined) return noSuchUpload();
        const etag = `"${md5(body)}"`;
        upload.parts.set(Number(query.partNumber), { data: body, etag });
        return { status: 200, headers: { etag } };
      }
      case 'CompleteMultipartUpload': {
        const id = query.uploadId ?? '';
        const upload = uploads.get(id);
        if (upload === undefined) return noSuchUpload();
        if (exclusive && object !== undefined) return preconditionFailed();
        const chosen = partsOf(body.toString('utf8'));
        const pieces: Buffer[] = [];
        for (const part of chosen) {
          const stored = upload.parts.get(part.number);
          if (stored === undefined || stored.etag !== part.etag) {
            return fail(
              400,
              'InvalidPart',
              'One or more of the specified parts could not be found.',
            );
          }
          pieces.push(stored.data);
        }
        uploads.delete(id);
        const stored = store(objects, key, Buffer.concat(pieces));
        return xml(
          200,
          `<CompleteMultipartUploadResult xmlns="${S3_NAMESPACE}"><Bucket>${text(bucket)}</Bucket><Key>${text(key)}</Key><ETag>${text(stored.etag)}</ETag></CompleteMultipartUploadResult>`,
        );
      }
      case 'AbortMultipartUpload': {
        if (!uploads.delete(query.uploadId ?? '')) return noSuchUpload();
        return { status: 204, headers: {} };
      }
      default:
        return fail(400, 'InvalidRequest', 'Unsupported request');
    }

    function preconditionFailed(): Reply {
      return fail(
        412,
        'PreconditionFailed',
        'At least one of the pre-conditions you specified did not hold',
      );
    }
    function noSuchUpload(): Reply {
      return fail(404, 'NoSuchUpload', 'The specified upload does not exist.');
    }
  }

  function store(
    objects: Map<string, StoredObject>,
    key: string,
    data: Buffer,
  ): StoredObject {
    const stored: StoredObject = {
      data,
      lastModified: new Date(),
      etag: `"${md5(data)}"`,
    };
    objects.set(key, stored);
    return stored;
  }

  function listBuckets(query: Readonly<Record<string, string>>): Reply {
    const names = [...buckets.keys()].sort(compareKeys);
    const after = query['continuation-token'];
    const start =
      after === undefined ? 0 : names.findIndex((name) => name > after);
    const remaining = start === -1 ? [] : names.slice(start);
    const pageSize = options.bucketPageSize ?? remaining.length;
    const page = remaining.slice(0, Math.max(pageSize, 0));
    const last = page[page.length - 1];
    const token =
      remaining.length > page.length && last !== undefined
        ? `<ContinuationToken>${text(last)}</ContinuationToken>`
        : '';
    const entries = page
      .map(
        (name) =>
          `<Bucket><Name>${text(name)}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>`,
      )
      .join('');
    return xml(
      200,
      `<ListAllMyBucketsResult xmlns="${S3_NAMESPACE}"><Owner><ID>owner</ID><DisplayName>owner</DisplayName></Owner><Buckets>${entries}</Buckets>${token}</ListAllMyBucketsResult>`,
    );
  }

  function listObjects(
    bucket: string,
    objects: Map<string, StoredObject>,
    query: Readonly<Record<string, string>>,
  ): Reply {
    const prefix = query.prefix ?? '';
    const delimiter = query.delimiter ?? '';
    const asked = Number(query['max-keys'] ?? '1000');
    const maxKeys = Math.min(
      Number.isFinite(asked) ? asked : 1000,
      listPageSize,
    );
    const urlEncoded = query['encoding-type'] === 'url';
    const out = (value: string): string =>
      text(urlEncoded ? encodeURIComponent(value) : value);
    const position = decodeToken(query['continuation-token']) ?? {
      after: query['start-after'] ?? '',
      prefix: false,
    };

    const contents: string[] = [];
    const prefixes: string[] = [];
    let lastPrefix: string | undefined;
    let last: { after: string; prefix: boolean } | undefined;
    let truncated = false;
    for (const key of [...objects.keys()].sort(compareKeys)) {
      if (!key.startsWith(prefix)) continue;
      if (position.after !== '' && compareKeys(key, position.after) <= 0) {
        continue;
      }
      if (position.prefix && key.startsWith(position.after)) continue;
      let common: string | undefined;
      if (delimiter !== '') {
        const at = key.indexOf(delimiter, prefix.length);
        if (at !== -1) common = key.slice(0, at + delimiter.length);
      }
      if (common !== undefined && common === lastPrefix) continue;
      if (contents.length + prefixes.length >= maxKeys) {
        truncated = true;
        break;
      }
      if (common !== undefined) {
        lastPrefix = common;
        prefixes.push(common);
        last = { after: common, prefix: true };
        continue;
      }
      const object = objects.get(key);
      if (object === undefined) continue;
      contents.push(
        `<Contents><Key>${out(key)}</Key><LastModified>${object.lastModified.toISOString()}</LastModified><ETag>${text(object.etag)}</ETag><Size>${object.reportedSize ?? object.data.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
      );
      last = { after: key, prefix: false };
    }
    const token =
      truncated && last !== undefined
        ? `<NextContinuationToken>${encodeToken(last)}</NextContinuationToken>`
        : '';
    const echoed =
      query['continuation-token'] === undefined
        ? ''
        : `<ContinuationToken>${text(query['continuation-token'])}</ContinuationToken>`;
    return xml(
      200,
      `<ListBucketResult xmlns="${S3_NAMESPACE}"><Name>${text(bucket)}</Name><Prefix>${out(prefix)}</Prefix>${delimiter === '' ? '' : `<Delimiter>${out(delimiter)}</Delimiter>`}<MaxKeys>${maxKeys}</MaxKeys><KeyCount>${contents.length + prefixes.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${urlEncoded ? '<EncodingType>url</EncodingType>' : ''}${echoed}${token}${contents.join('')}${prefixes.map((common) => `<CommonPrefixes><Prefix>${out(common)}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`,
    );
  }

  function deleteObjects(
    objects: Map<string, StoredObject>,
    body: Buffer,
  ): Reply {
    const keys = [
      ...body.toString('utf8').matchAll(/<Key>([\s\S]*?)<\/Key>/g),
    ].map((match) => unescapeXml(match[1] ?? ''));
    for (const key of keys) objects.delete(key);
    return xml(
      200,
      `<DeleteResult xmlns="${S3_NAMESPACE}">${keys.map((key) => `<Deleted><Key>${text(key)}</Key></Deleted>`).join('')}</DeleteResult>`,
    );
  }

  function recordOf(req: IncomingMessage): RecordedRequest {
    const url = req.url ?? '/';
    const queryAt = url.indexOf('?');
    const rawPath = queryAt === -1 ? url : url.slice(0, queryAt);
    const query = parseQuery(queryAt === -1 ? '' : url.slice(queryAt + 1));
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const virtual = VIRTUAL_HOST.exec(host);
    let bucket: string | undefined;
    let key: string | undefined;
    if (virtual !== null) {
      bucket = virtual[1];
      key = rawPath.length > 1 ? decode(rawPath.slice(1)) : undefined;
    } else {
      const rest = rawPath.slice(1);
      const slash = rest.indexOf('/');
      const first = slash === -1 ? rest : rest.slice(0, slash);
      bucket = first === '' ? undefined : decode(first);
      const remainder = slash === -1 ? '' : rest.slice(slash + 1);
      key = remainder === '' ? undefined : decode(remainder);
    }
    const method = (req.method ?? 'GET').toUpperCase();
    const operation = operationOf(method, bucket, key, query, req.headers);
    const scope = /Credential=([^/,\s]+)\/\d{8}\/([^/,\s]+)\//.exec(
      req.headers.authorization ?? '',
    );
    const token = req.headers['x-amz-security-token'];
    const ifNoneMatch = req.headers['if-none-match'];
    return {
      index: requests.length,
      method,
      url,
      rawPath,
      query,
      headers: { ...req.headers },
      host,
      style: virtual === null ? 'path' : 'virtual-hosted',
      operation,
      bucket,
      key,
      ifNoneMatch: typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined,
      accessKeyId: scope?.[1],
      region: scope?.[2],
      sessionToken: typeof token === 'string' ? token : undefined,
      signatureValid: false,
      bodyBytes: 0,
      bodyText: undefined,
      responseFinished: false,
      connectionClosedEarly: false,
      responseBytesSent: 0,
      responseStatus: undefined,
    };
  }

  function errorReply(
    request: RecordedRequest,
    status: number,
    code: string | undefined,
    message: string | undefined,
    extra: {
      headers?: Readonly<Record<string, string>> | undefined;
      extraXml?: string | undefined;
    } = {},
  ): Reply {
    const requestId = randomBytes(8).toString('hex').toUpperCase();
    const headers: Record<string, string> = {
      'x-amz-request-id': requestId,
      ...(extra.headers ?? {}),
    };
    if (request.method === 'HEAD') return { status, headers };
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>\n<Error>` +
      (code === undefined ? '' : `<Code>${text(code)}</Code>`) +
      (message === undefined ? '' : `<Message>${text(message)}</Message>`) +
      (request.bucket === undefined
        ? ''
        : `<BucketName>${text(request.bucket)}</BucketName>`) +
      (extra.extraXml ?? '') +
      `<RequestId>${requestId}</RequestId><HostId>host</HostId></Error>`;
    return {
      status,
      headers: { 'content-type': 'application/xml', ...headers },
      body: Buffer.from(body, 'utf8'),
    };
  }

  function sendError(
    res: ServerResponse,
    request: RecordedRequest,
    status: number,
    code: string | undefined,
    message: string | undefined,
    extra: {
      headers?: Readonly<Record<string, string>> | undefined;
      extraXml?: string | undefined;
    } = {},
  ): void {
    void sendReply(
      res,
      request,
      errorReply(request, status, code, message, extra),
    );
  }

  async function sendReply(
    res: ServerResponse,
    request: RecordedRequest,
    reply: Reply,
  ): Promise<void> {
    const length = reply.headLength ?? reply.body?.length ?? 0;
    res.writeHead(
      reply.status,
      reply.omitContentLength === true
        ? { ...reply.headers }
        : { ...reply.headers, 'content-length': String(length) },
    );
    if (request.method === 'HEAD' || reply.body === undefined) {
      res.end();
      return;
    }
    await writeChunks(res, request, reply.body, reply.body.length);
    if (!res.destroyed) res.end();
  }

  async function sendPartial(
    res: ServerResponse,
    request: RecordedRequest,
    reply: Reply,
    kind: 'reset-in-body' | 'short-body' | 'stall-in-body',
    after: number,
  ): Promise<void> {
    const body = reply.body ?? Buffer.alloc(0);
    res.writeHead(reply.status, {
      ...reply.headers,
      'content-length': String(body.length),
    });
    await writeChunks(res, request, body, Math.min(after, body.length));
    // Let the bytes reach the client before the connection changes state.
    await new Promise<void>((resolve) => {
      if (res.destroyed) resolve();
      else res.write('', () => resolve());
    });
    if (kind === 'reset-in-body') res.socket?.destroy();
    else if (kind === 'short-body') res.socket?.end();
  }

  function send(
    res: ServerResponse,
    request: RecordedRequest,
    status: number,
    headers: Readonly<Record<string, string>>,
    body: string | Buffer | undefined,
    omitContentLength = false,
  ): void {
    const data =
      body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(body, 'utf8');
    void sendReply(res, request, {
      status,
      headers: { ...headers },
      omitContentLength,
      ...(data === undefined ? {} : { body: data }),
    });
  }

  async function writeChunks(
    res: ServerResponse,
    request: RecordedRequest,
    body: Buffer,
    limit: number,
  ): Promise<void> {
    let offset = 0;
    while (offset < limit && !res.destroyed) {
      const end = Math.min(offset + CHUNK, limit);
      const ok = res.write(body.subarray(offset, end));
      request.responseBytesSent = end;
      offset = end;
      if (!ok) {
        await Promise.race([once(res, 'drain'), once(res, 'close')]);
      }
    }
  }

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  const fixture: S3ServerFixture = {
    host: '127.0.0.1',
    port,
    endpoint: `https://127.0.0.1:${port}`,
    ca,
    keys: firstKeys,
    requests,
    counts,
    get maxUploadPartsInFlight(): number {
      return maxPartsInFlight;
    },
    buckets,
    uploads,
    addBucket(name) {
      if (!buckets.has(name)) buckets.set(name, new Map());
    },
    removeBucket(name) {
      buckets.delete(name);
    },
    putObject(bucket, key, data, extra = {}) {
      let objects = buckets.get(bucket);
      if (objects === undefined) {
        objects = new Map();
        buckets.set(bucket, objects);
      }
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      objects.set(key, {
        data: bytes,
        lastModified: extra.lastModified ?? new Date(),
        etag: `"${md5(bytes)}"`,
        ...(extra.reportedSize === undefined
          ? {}
          : { reportedSize: extra.reportedSize }),
      });
    },
    getObject(bucket, key) {
      return buckets.get(bucket)?.get(key)?.data;
    },
    hasObject(bucket, key) {
      return buckets.get(bucket)?.has(key) ?? false;
    },
    keysOf(bucket) {
      return [...(buckets.get(bucket)?.keys() ?? [])].sort(compareKeys);
    },
    fault(rule) {
      rules.push(rule);
      return () => {
        const at = rules.indexOf(rule);
        if (at !== -1) rules.splice(at, 1);
      };
    },
    requestsOf(operation, key) {
      return requests.filter(
        (request) =>
          request.operation === operation &&
          (key === undefined || request.key === key),
      );
    },
    responseSettled(request) {
      return settledResponses.get(request) ?? Promise.resolve();
    },
    waitForRequest(predicate) {
      const found = requests.find(predicate);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
    clearRequests() {
      requests.length = 0;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return fixture;
}

function operationOf(
  method: string,
  bucket: string | undefined,
  key: string | undefined,
  query: Readonly<Record<string, string>>,
  headers: IncomingMessage['headers'],
): S3Operation {
  if (bucket === undefined) return method === 'GET' ? 'ListBuckets' : 'Unknown';
  if (key === undefined) {
    switch (method) {
      case 'PUT':
        return 'CreateBucket';
      case 'DELETE':
        return 'DeleteBucket';
      case 'HEAD':
        return 'HeadBucket';
      case 'POST':
        return 'delete' in query ? 'DeleteObjects' : 'Unknown';
      case 'GET':
        if ('location' in query) return 'GetBucketLocation';
        return query['list-type'] === '2' ? 'ListObjectsV2' : 'ListObjects';
      default:
        return 'Unknown';
    }
  }
  switch (method) {
    case 'GET':
      return 'GetObject';
    case 'HEAD':
      return 'HeadObject';
    case 'PUT':
      if (headers['x-amz-copy-source'] !== undefined) return 'CopyObject';
      return 'partNumber' in query && 'uploadId' in query
        ? 'UploadPart'
        : 'PutObject';
    case 'POST':
      if ('uploads' in query) return 'CreateMultipartUpload';
      return 'uploadId' in query ? 'CompleteMultipartUpload' : 'Unknown';
    case 'DELETE':
      return 'uploadId' in query ? 'AbortMultipartUpload' : 'DeleteObject';
    default:
      return 'Unknown';
  }
}

function signatureMessage(code: string): string {
  switch (code) {
    case 'InvalidAccessKeyId':
      return 'The AWS Access Key Id you provided does not exist in our records.';
    case 'InvalidToken':
      return 'The provided token is malformed or otherwise invalid.';
    case 'SignatureDoesNotMatch':
      return 'The request signature we calculated does not match the signature you provided.';
    default:
      return 'Access Denied';
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('close', () => {
      if (!req.complete) reject(new Error('request aborted'));
    });
  });
}

/** Removes the `aws-chunked` framing the SDK uses for streamed bodies with a checksum trailer. */
function decodeBody(req: IncomingMessage, raw: Buffer): Buffer {
  const encoding = String(req.headers['content-encoding'] ?? '');
  const hash = String(req.headers['x-amz-content-sha256'] ?? '');
  if (!encoding.includes('aws-chunked') && !hash.startsWith('STREAMING-')) {
    return raw;
  }
  const pieces: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const lineEnd = raw.indexOf('\r\n', offset);
    if (lineEnd === -1) break;
    const header = raw.subarray(offset, lineEnd).toString('ascii');
    const size = parseInt(header.split(';')[0] ?? '', 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    pieces.push(raw.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(pieces);
}

function parseQuery(raw: string): Record<string, string> {
  const query: Record<string, string> = {};
  for (const part of raw.split('&')) {
    if (part === '') continue;
    const at = part.indexOf('=');
    const name = decode(at === -1 ? part : part.slice(0, at));
    query[name] = decode(at === -1 ? '' : part.slice(at + 1));
  }
  return query;
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function copySourceOf(
  header: string | string[] | undefined,
): { bucket: string; key: string } | undefined {
  if (typeof header !== 'string') return undefined;
  const withoutVersion = header.split('?')[0] ?? '';
  const trimmed = withoutVersion.startsWith('/')
    ? withoutVersion.slice(1)
    : withoutVersion;
  const slash = trimmed.indexOf('/');
  if (slash === -1) return undefined;
  return {
    bucket: decode(trimmed.slice(0, slash)),
    key: decode(trimmed.slice(slash + 1)),
  };
}

function partsOf(body: string): { number: number; etag: string }[] {
  return [...body.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((match) => {
    const inner = match[1] ?? '';
    const number = /<PartNumber>(\d+)<\/PartNumber>/.exec(inner)?.[1];
    const etag = /<ETag>([\s\S]*?)<\/ETag>/.exec(inner)?.[1];
    return {
      number: Number(number),
      etag: normaliseEtag(unescapeXml(etag ?? '')),
    };
  });
}

function normaliseEtag(etag: string): string {
  const bare = etag.replace(/^"|"$/g, '');
  return `"${bare}"`;
}

function xml(
  status: number,
  document: string,
): {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
} {
  return {
    status,
    headers: { 'content-type': 'application/xml' },
    body: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n${document}`,
      'utf8',
    ),
  };
}

/** XML text: the markup characters are escaped; every other code point is sent as it is. */
export function text(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function encodeToken(position: { after: string; prefix: boolean }): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

function decodeToken(
  token: string | undefined,
): { after: string; prefix: boolean } | undefined {
  if (token === undefined) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(token, 'base64url').toString('utf8'),
    ) as { after?: unknown; prefix?: unknown };
    if (typeof value.after === 'string' && typeof value.prefix === 'boolean') {
      return { after: value.after, prefix: value.prefix };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** S3 orders keys by their UTF-8 bytes. */
export function compareKeys(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function md5(data: Buffer): string {
  return createHash('md5').update(data).digest('hex');
}

/** An S3 error code as a fault, with the status S3 gives it. */
export function s3Error(
  code: string,
  message = `${code} (fake server)`,
  extra: {
    headers?: Readonly<Record<string, string>>;
    extraXml?: string;
  } = {},
): Fault {
  return {
    kind: 'error',
    status: STATUS_OF[code] ?? 400,
    code,
    message,
    ...(extra.headers === undefined ? {} : { headers: extra.headers }),
    ...(extra.extraXml === undefined ? {} : { extraXml: extra.extraXml }),
  };
}

const STATUS_OF: Readonly<Record<string, number>> = {
  AccessDenied: 403,
  InvalidAccessKeyId: 403,
  SignatureDoesNotMatch: 403,
  ExpiredToken: 403,
  InvalidToken: 403,
  TokenRefreshRequired: 403,
  RequestTimeTooSkewed: 403,
  InvalidObjectState: 403,
  NoSuchBucket: 404,
  NoSuchKey: 404,
  NoSuchUpload: 404,
  PreconditionFailed: 412,
  ConditionalRequestConflict: 409,
  BucketAlreadyExists: 409,
  BucketAlreadyOwnedByYou: 409,
  BucketNotEmpty: 409,
  NotImplemented: 501,
  SlowDown: 503,
  InternalError: 500,
  PermanentRedirect: 301,
};
