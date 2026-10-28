/**
 * The one place where the S3 tests meet the S3 back-end (FEATURE-3). The spec fixes the public
 * names; the design record names the internal seams. Only this file follows them, so a later
 * rename touches one file.
 *
 * Assumed API:
 * - `src/s3/s3-file-system.ts`: `new S3FileSystem(options?)`, a `RemoteFileSystem`.
 * - `src/s3/internals.ts` (design Option 11C, not public): `setS3Internals(fs, internals)` sets
 *   `lookup` (the HTTPS agent's resolver) and `partLimit` (AC-43) before `connect()`.
 * - `src/s3/upload.ts`: `PART_SIZE` and `MAX_PARTS` (AC-43).
 *
 * The modules are loaded with `import()` of a computed specifier, so the tests written before the
 * code type-check and fail at run time until the back-end exists.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import type { LookupFunction } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { expect, onTestFinished, vi } from 'vitest';
import {
  REMOTE_FS_ERROR_CODES,
  RemoteFsError,
  type RemoteFileSystem,
  type RemoteFsErrorCode,
} from '../../src/fs/index.js';
import { useAwsEnv, type AwsEnv } from './aws-env.js';
import {
  startS3Server,
  type S3ServerFixture,
  type S3ServerOptions,
} from './s3-server.js';

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/** `S3FileSystemOptions` of the spec, as the tests give it. */
export interface S3Options {
  readonly bucket?: string;
  readonly endpoint?: string;
  readonly region?: string;
  readonly credentials?: S3Credentials;
  readonly profile?: string;
  readonly ca?: string | Buffer | readonly (string | Buffer)[];
  readonly timeoutMs?: number;
}

/** The design's `S3Internals`: seams for the tests only. */
export interface S3Internals {
  readonly lookup?: LookupFunction;
  readonly partLimit?: number;
}

export type S3FileSystemConstructor = new (
  options?: S3Options,
) => RemoteFileSystem;

const MODULES = {
  fileSystem: '../../src/s3/s3-file-system.js',
  upload: '../../src/s3/upload.js',
  internals: '../../src/s3/internals.js',
  index: '../../src/index.js',
} as const;

async function load(specifier: string): Promise<Record<string, unknown>> {
  return (await import(specifier)) as Record<string, unknown>;
}

export async function loadS3FileSystem(): Promise<S3FileSystemConstructor> {
  const module = await load(MODULES.fileSystem);
  const constructor = module.S3FileSystem;
  if (typeof constructor !== 'function') {
    throw new Error('src/s3/s3-file-system.ts does not export S3FileSystem');
  }
  return constructor as S3FileSystemConstructor;
}

export async function loadUploadModule(): Promise<{
  readonly PART_SIZE: unknown;
  readonly MAX_PARTS: unknown;
}> {
  const module = await load(MODULES.upload);
  return { PART_SIZE: module.PART_SIZE, MAX_PARTS: module.MAX_PARTS };
}

export async function loadIndex(): Promise<Record<string, unknown>> {
  return load(MODULES.index);
}

/**
 * A new instance with exactly these options (nothing added), disconnected when the test ends.
 * `options` is `unknown` so a test can pass what the type would refuse (AC-4).
 */
export async function createS3(
  options?: unknown,
  internals?: S3Internals,
): Promise<RemoteFileSystem> {
  const S3FileSystem = await loadS3FileSystem();
  const fs = new S3FileSystem(options as S3Options);
  if (internals !== undefined) {
    const { setS3Internals } = (await load(MODULES.internals)) as {
      setS3Internals: (target: RemoteFileSystem, seams: S3Internals) => void;
    };
    setS3Internals(fs, internals);
  }
  onTestFinished(async () => {
    await fs.disconnect().catch(() => undefined);
  });
  return fs;
}

export const MIB = 1_048_576;
export const PART = 16_777_216;
export const LARGEST_UPLOAD = 167_772_160_000;

export interface S3Setup {
  readonly server: S3ServerFixture;
  readonly env: AwsEnv;
  /** Options that reach the server: its endpoint, keys, CA and region `us-east-1`. */
  options(overrides?: Readonly<Record<string, unknown>>): S3Options;
  /** A new instance (not connected) with `options(overrides)`. */
  s3(
    overrides?: Readonly<Record<string, unknown>>,
    internals?: S3Internals,
  ): Promise<RemoteFileSystem>;
  /** A connected instance with `options(overrides)`. */
  connected(
    overrides?: Readonly<Record<string, unknown>>,
    internals?: S3Internals,
  ): Promise<RemoteFileSystem>;
}

/**
 * A clean AWS environment and a fake server with bucket `b`, closed when the test ends. The
 * option `credentials` gives the server's keys, so no AWS source is read unless a test removes it.
 */
export async function useS3(
  serverOptions: S3ServerOptions = {},
  setup: { readonly buckets?: readonly string[] } = {},
): Promise<S3Setup> {
  const env = await useAwsEnv();
  const server = await startS3Server(serverOptions);
  onTestFinished(() => server.close());
  for (const bucket of setup.buckets ?? ['b']) server.addBucket(bucket);
  const options = (
    overrides: Readonly<Record<string, unknown>> = {},
  ): S3Options => {
    const merged: Record<string, unknown> = {
      endpoint: server.endpoint,
      region: 'us-east-1',
      credentials: server.keys,
      ca: server.ca.cert,
      ...overrides,
    };
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined) delete merged[key];
    }
    return merged;
  };
  return {
    server,
    env,
    options,
    s3: (overrides, internals) => createS3(options(overrides), internals),
    async connected(overrides, internals) {
      const fs = await createS3(options(overrides), internals);
      await fs.connect();
      return fs;
    },
  };
}

/** Deterministic bytes of a given length, different for each `seed`. */
export function bytes(length: number, seed = 7): Buffer {
  const data = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    data[index] = (index * 31 + seed) & 0xff;
  }
  return data;
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface StreamOutcome {
  readonly data: Buffer;
  readonly errors: unknown[];
  readonly dataEvents: number;
  readonly ended: boolean;
  readonly finished: boolean;
  readonly closed: boolean;
}

/**
 * Reads a stream to its end or its error, counting the events. Resolves on `close`, the last
 * event of a stream that settles; an error without `close` resolves after the event queue turns.
 */
export function readAll(stream: Readable): Promise<StreamOutcome> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errors: unknown[] = [];
    let dataEvents = 0;
    let ended = false;
    let closed = false;
    const settle = (): void =>
      resolve({
        data: Buffer.concat(chunks),
        errors,
        dataEvents,
        ended,
        finished: false,
        closed,
      });
    stream.on('data', (chunk: Buffer | string) => {
      dataEvents += 1;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => {
      ended = true;
    });
    stream.on('error', (error) => {
      errors.push(error);
      setImmediate(() => setImmediate(settle));
    });
    stream.on('close', () => {
      closed = true;
      setImmediate(settle);
    });
  });
}

/**
 * Writes `data` in chunks with back-pressure, ends the stream, and resolves when it settles
 * (`close`, or a turn of the event queue after `finish` or `error`).
 */
export function writeAll(
  stream: Writable,
  data: Buffer,
  chunkSize = MIB,
): Promise<StreamOutcome & { readonly finishedBeforeError: boolean }> {
  return new Promise((resolve) => {
    const errors: unknown[] = [];
    let finished = false;
    let closed = false;
    let done = false;
    const settle = (): void => {
      if (done) return;
      done = true;
      resolve({
        data,
        errors,
        dataEvents: 0,
        ended: false,
        finished,
        closed,
        finishedBeforeError: finished && errors.length === 0,
      });
    };
    stream.on('finish', () => {
      finished = true;
      setImmediate(() => setImmediate(settle));
    });
    stream.on('error', (error) => {
      errors.push(error);
      setImmediate(() => setImmediate(settle));
    });
    stream.on('close', () => {
      closed = true;
      setImmediate(() => setImmediate(settle));
    });
    let offset = 0;
    const pump = (): void => {
      while (offset < data.length) {
        if (errors.length > 0 || stream.destroyed) return;
        const end = Math.min(offset + chunkSize, data.length);
        const ok = stream.write(data.subarray(offset, end));
        offset = end;
        if (!ok) {
          stream.once('drain', pump);
          return;
        }
      }
      if (errors.length === 0 && !stream.destroyed) stream.end();
    };
    pump();
  });
}

/** The one error of an outcome, checked to be a `RemoteFsError` with `code` (and `path`). */
export function onlyError(
  outcome: { readonly errors: readonly unknown[] },
  code: RemoteFsErrorCode,
  path?: string,
): RemoteFsError {
  expect(outcome.errors).toHaveLength(1);
  return expectRemoteError(outcome.errors[0], code, path);
}

export function expectRemoteError(
  error: unknown,
  code: RemoteFsErrorCode,
  path?: string,
): RemoteFsError {
  expect(error).toBeInstanceOf(RemoteFsError);
  const remote = error as RemoteFsError;
  expect(REMOTE_FS_ERROR_CODES).toContain(remote.code);
  expect({ code: remote.code, message: remote.message }).toMatchObject({
    code,
  });
  if (path !== undefined) expect(remote.path).toBe(path);
  return remote;
}

/** Awaits `promise`, which must reject with a `RemoteFsError` of `code` (and `path`). */
export async function rejection(
  promise: Promise<unknown>,
  code: RemoteFsErrorCode,
  path?: string,
): Promise<RemoteFsError> {
  let caught: unknown;
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (error) {
    caught = error;
  }
  expect(resolved, `expected a ${code} rejection`).toBe(false);
  return expectRemoteError(caught, code, path);
}

/**
 * Everything an error carries, as `util.inspect` shows it at depth 10 with hidden properties,
 * plus each message of its `cause` chain: where a secret must not be (AC-35, AC-44, AC-49).
 */
export function everythingIn(error: unknown): string {
  const parts = [inspect(error, { depth: 10, showHidden: true })];
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth += 1) {
    parts.push(current.message, String(current.stack));
    for (const name of Object.getOwnPropertyNames(current)) {
      parts.push(
        inspect((current as unknown as Record<string, unknown>)[name], {
          depth: 10,
          showHidden: true,
        }),
      );
    }
    current = current.cause;
  }
  return parts.join('\n');
}

export interface OutputSpy {
  /** Everything written to stdout, stderr and `console` since the spy started. */
  text(): string;
  /** The number of writes and console calls. */
  calls(): number;
}

/** Records writes to `process.stdout`, `process.stderr` and every `console` method. */
export function spyOutput(): OutputSpy {
  const written: string[] = [];
  const record = (...args: unknown[]): void => {
    written.push(
      args
        .map((arg) =>
          typeof arg === 'string'
            ? arg
            : Buffer.isBuffer(arg)
              ? arg.toString('utf8')
              : inspect(arg, { depth: 10 }),
        )
        .join(' '),
    );
  };
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((...args) => {
      record(args[0]);
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((...args) => {
      record(args[0]);
      return true;
    }),
    ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(record),
    ),
  ];
  onTestFinished(() => {
    for (const spy of spies) spy.mockRestore();
  });
  return {
    text: () => written.join('\n'),
    calls: () => written.length,
  };
}

/** The escape set of `cyberduck/standard.sanitised-server-text`, as code points. */
export const ESCAPED_CODE_POINTS: readonly number[] = [
  ...range(0x00, 0x1f),
  ...range(0x7f, 0x9f),
  0x2028,
  0x2029,
  ...range(0x202a, 0x202e),
  ...range(0x2066, 0x2069),
];

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

export function escapeOf(codePoint: number): string {
  return codePoint <= 0xff
    ? `\\x${codePoint.toString(16).padStart(2, '0')}`
    : `\\u${codePoint.toString(16).padStart(4, '0')}`;
}

/** The spec's escape, written from its definition. */
export function escaped(text: string): string {
  let out = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    out += ESCAPED_CODE_POINTS.includes(codePoint)
      ? escapeOf(codePoint)
      : character;
  }
  return out;
}

export function hasRawEscapedCodePoint(text: string): boolean {
  for (const character of text) {
    if (ESCAPED_CODE_POINTS.includes(character.codePointAt(0) ?? 0)) {
      return true;
    }
  }
  return false;
}

/**
 * A `lookup` that resolves every name to 127.0.0.1 and records it (AC-28): with it the agent
 * never asks a real resolver.
 */
export function recordingLookup(): {
  readonly lookup: LookupFunction;
  readonly names: string[];
} {
  const names: string[] = [];
  const lookup = ((
    hostname: string,
    options: unknown,
    callback?: unknown,
  ): void => {
    names.push(hostname);
    const done = (typeof options === 'function' ? options : callback) as (
      error: Error | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void;
    const all =
      typeof options === 'object' &&
      options !== null &&
      (options as { all?: boolean }).all === true;
    if (all) done(null, [{ address: '127.0.0.1', family: 4 }]);
    else done(null, '127.0.0.1', 4);
  }) as LookupFunction;
  return { lookup, names };
}

export interface InterceptedConnection {
  /** The host the client asked for (the AWS name), its port and its TLS server name. */
  readonly host: string;
  readonly port: number;
  readonly servername: string | undefined;
}

/**
 * Routes every TLS connection to an `amazonaws.com` host to the fake server, keeping the TLS
 * server name, so the certificate check still runs against the AWS name (AC-28, AC-41, AC-52).
 * No connection leaves the machine. Plain TCP connections are recorded too: there must be none.
 */
export function interceptAwsConnections(server: { readonly port: number }): {
  readonly connections: InterceptedConnection[];
  readonly plain: { host: string; port: number }[];
} {
  const connections: InterceptedConnection[] = [];
  const plain: { host: string; port: number }[] = [];
  const originalTls = tls.connect.bind(tls);
  const tlsSpy = vi
    .spyOn(tls, 'connect')
    .mockImplementation((...args: unknown[]) => {
      const first = args[0];
      if (typeof first === 'object' && first !== null) {
        const options = first as tls.ConnectionOptions;
        const host = options.host ?? 'localhost';
        connections.push({
          host,
          port: Number(options.port),
          servername: options.servername,
        });
        if (host.endsWith('.amazonaws.com')) {
          args[0] = {
            ...options,
            host: '127.0.0.1',
            port: server.port,
            servername: options.servername ?? host,
          };
        }
      }
      return (originalTls as (...rest: unknown[]) => tls.TLSSocket)(...args);
    });
  const originalNet = net.connect.bind(net);
  const netSpy = vi
    .spyOn(net, 'connect')
    .mockImplementation((...args: unknown[]) => {
      const first = args[0];
      if (typeof first === 'object' && first !== null) {
        const options = first as { host?: string; port?: number };
        plain.push({
          host: options.host ?? 'localhost',
          port: Number(options.port),
        });
      }
      return (originalNet as (...rest: unknown[]) => net.Socket)(...args);
    });
  onTestFinished(() => {
    tlsSpy.mockRestore();
    netSpy.mockRestore();
  });
  return { connections, plain };
}

export interface ChildResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `test/support/s3-child-connect.ts` in a new Node process with `env` (and nothing of this
 * process's AWS settings): it builds an instance from `S3_CHILD_OPTIONS` (JSON), connects, and
 * prints `connected` or the error's code. Needed where Node reads a variable only at start-up
 * (`NODE_EXTRA_CA_CERTS`, AC-26).
 */
export async function runChildConnect(
  env: Readonly<Record<string, string>>,
): Promise<ChildResult> {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const child = spawn(
    process.execPath,
    [
      '--no-warnings',
      '--import',
      fileURLToPath(new URL('./ts-import-hook.ts', import.meta.url)),
      fileURLToPath(new URL('./s3-child-connect.ts', import.meta.url)),
    ],
    {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const [code] = (await once(child, 'close')) as [number | null];
  return {
    code,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}
