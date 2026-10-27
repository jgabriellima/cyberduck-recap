/**
 * The one place where the CLI tests meet the CLI's API (FEATURE-2). The spec fixes the observable
 * behaviour of `runCli(args, context)`; the design node may refine the signature, the registry's
 * shape and the composition module's name, and only this file then follows it.
 *
 * Assumed API:
 * - `src/cli/index.ts`: `runCli(args, context): Promise<number>` and `createRegistry()`, whose
 *   result has `register(scheme, factory)`. A factory takes one argument (what the CLI resolved
 *   from the URL, the credential and the known_hosts path) and returns a `RemoteFileSystem`.
 * - `src/backends.ts` (the composition module outside `src/cli/`): `registerBackends(registry)`
 *   registers the production back-ends (`sftp`).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { registerBackends } from '../../src/backends.js';
import { createRegistry, runCli } from '../../src/cli/index.js';
import type { RemoteFileSystem } from '../../src/fs/index.js';
import { sentinel, tempDir, trustingKnownHosts, useServer } from './harness.js';
import type { SftpServerFixture, SftpServerOptions } from './sftp-server.js';

export const PROGRAM = 'cyberduck-recap';
export const USAGE_HINT = `${PROGRAM}: run '${PROGRAM} --help' for usage`;

/** The "Exit codes" table of the spec. */
export const EXIT_CODES: Readonly<Record<string, number>> = {
  INTERNAL: 1,
  USAGE: 2,
  LOCAL_FILE: 3,
  AUTH_FAILED: 10,
  HOST_KEY_UNKNOWN: 11,
  HOST_KEY_CHANGED: 12,
  CONNECTION_FAILED: 13,
  CONNECTION_LOST: 14,
  NOT_CONNECTED: 15,
  NOT_FOUND: 16,
  PERMISSION_DENIED: 17,
  ALREADY_EXISTS: 18,
  NOT_A_DIRECTORY: 19,
  IS_A_DIRECTORY: 20,
  INVALID_ARGUMENT: 21,
  OPERATION_FAILED: 22,
  CANCELLED: 130,
};

export type BackendFactory = (target: unknown) => RemoteFileSystem;

export interface Registry {
  register(scheme: string, factory: BackendFactory): void;
}

/** The production registry (`sftp`) plus the back-ends a test adds. */
export function testRegistry(
  extra: Readonly<Record<string, BackendFactory>> = {},
): Registry {
  const registry = createRegistry() as Registry;
  registerBackends(registry as never);
  for (const [scheme, factory] of Object.entries(extra)) {
    registry.register(scheme, factory);
  }
  return registry;
}

/** Collects what the CLI writes and resolves waiters when some text appears. */
export class Capture extends Writable {
  #chunks: Buffer[] = [];
  #waiters: { text: string; resolve: () => void }[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const text = this.text();
    this.#waiters = this.#waiters.filter((waiter) => {
      if (!text.includes(waiter.text)) return true;
      waiter.resolve();
      return false;
    });
    callback();
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }

  /** Lines split on LF; a last line without LF is kept, an empty tail is not. */
  lines(): string[] {
    const text = this.text();
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /** Resolves once `text` has been written; waits on writes, never on a timer. */
  waitFor(text: string): Promise<void> {
    if (this.text().includes(text)) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push({ text, resolve }));
  }
}

/** A test `stdin`: a fake TTY when `isTTY` is true, with a `setRawMode` spy. */
export class FakeInput extends PassThrough {
  readonly isTTY: boolean;
  isRaw = false;
  readonly rawModeCalls: boolean[] = [];
  #written = 0;

  constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
  }

  setRawMode(mode: boolean): this {
    this.rawModeCalls.push(mode);
    this.isRaw = mode;
    return this;
  }

  /** Writes bytes as a terminal or a pipe would send them. */
  type(data: string | Buffer): void {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    this.#written += bytes.length;
    this.write(bytes);
  }

  get bytesWritten(): number {
    return this.#written;
  }
}

export interface RunOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly home?: string;
  readonly stdin?: FakeInput;
  readonly registry?: Registry;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutLines: string[];
  readonly stderrLines: string[];
  readonly stdin: FakeInput;
}

export interface Started {
  readonly stdout: Capture;
  readonly stderr: Capture;
  readonly stdin: FakeInput;
  readonly done: Promise<RunResult>;
}

/** Starts the CLI in process; the caller can type into `stdin` while it runs. */
export async function startCli(
  args: readonly string[],
  options: RunOptions = {},
): Promise<Started> {
  const stdout = new Capture();
  const stderr = new Capture();
  const stdin = options.stdin ?? new FakeInput(false);
  const context = {
    stdout,
    stderr,
    stdin,
    env: options.env ?? {},
    cwd: options.cwd ?? (await tempDir()),
    home: options.home ?? (await tempDir()),
    registry: options.registry ?? testRegistry(),
  };
  const done = runCli([...args], context as never).then(
    (code: number): RunResult => ({
      code,
      stdout: stdout.text(),
      stderr: stderr.text(),
      stdoutLines: stdout.lines(),
      stderrLines: stderr.lines(),
      stdin,
    }),
  );
  return { stdout, stderr, stdin, done };
}

export async function cli(
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return (await startCli(args, options)).done;
}

const ERROR_LINE = new RegExp(`^${PROGRAM}: [A-Z][A-Z_]*: `);

/** The spec's "error line": the first stderr line of the form `cyberduck-recap: <CODE>: …`. */
export function errorLine(result: { readonly stderrLines: string[] }): string {
  const line = result.stderrLines.find((candidate) =>
    ERROR_LINE.test(candidate),
  );
  if (line === undefined) {
    throw new Error(
      `no error line on stderr: ${JSON.stringify(result.stderrLines)}`,
    );
  }
  return line;
}

/** Is `hint` a stderr line that comes after the error line? */
export function hintFollowsError(
  result: { readonly stderrLines: string[] },
  hint: string,
): boolean {
  const error = result.stderrLines.indexOf(errorLine(result));
  const at = result.stderrLines.indexOf(hint);
  return at > error;
}

/** The spec's "Escaped" set, as code points. */
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

/** The escape the spec defines for one code point of the set. */
export function escapeOf(codePoint: number): string {
  return codePoint <= 0xff
    ? `\\x${codePoint.toString(16).padStart(2, '0')}`
    : `\\u${codePoint.toString(16).padStart(4, '0')}`;
}

/** The spec's escape, written from its definition, to compute expected output. */
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

/** True when `text` holds a raw code point of the escaped set. */
export function hasRawEscapedCodePoint(text: string): boolean {
  for (const character of text) {
    if (ESCAPED_CODE_POINTS.includes(character.codePointAt(0) ?? 0)) {
      return true;
    }
  }
  return false;
}

export interface CliServer {
  readonly fixture: SftpServerFixture;
  readonly password: string;
  readonly knownHostsPath: string;
  /** `sftp://tester@127.0.0.1:<port><path>` */
  url(path: string): string;
  /** The environment that gives the password (source 2 of AC-20). */
  readonly env: Readonly<Record<string, string>>;
}

/** The in-process SFTP server with a password user and a known_hosts file that trusts it. */
export async function useCliServer(
  options: SftpServerOptions = {},
): Promise<CliServer> {
  const password = sentinel();
  const fixture = await useServer({ password, ...options });
  const knownHostsPath = await trustingKnownHosts(fixture);
  return {
    fixture,
    password,
    knownHostsPath,
    url: (path) => `sftp://tester@127.0.0.1:${fixture.port}${path}`,
    env: { CYBERDUCK_RECAP_PASSWORD: password },
  };
}

/** Writes a file under the server's root, making its directories. */
export async function serverFile(
  fixture: SftpServerFixture,
  path: string,
  data: Buffer | string,
): Promise<void> {
  const local = fixture.local(path);
  await mkdir(join(local, '..'), { recursive: true });
  await writeFile(local, data);
}

/** Deterministic test bytes of a given length. */
export function bytes(length: number): Buffer {
  const data = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    data[index] = (index * 31 + 7) & 0xff;
  }
  return data;
}

export const MIB_5 = 5_242_880;

export const isWindows = process.platform === 'win32';
export const isRoot =
  typeof process.getuid === 'function' && process.getuid() === 0;
