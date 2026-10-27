/**
 * The one place the adversarial CLI tests (FEATURE-2) name the CLI's entry, its context and its
 * back-end registry. The spec fixes `runCli(args, context)` in src/cli/ and the context's fields
 * (stdout, stderr, stdin, env, cwd, home, registry); the registry's shape is the design's choice.
 * The attacks assume the same API as the acceptance tests (test/support/cli.ts):
 * `createRegistry()` with `register(scheme, factory)` in src/cli/index.ts, and
 * `registerBackends(registry)` in src/backends.ts for the production back-ends. A factory takes one
 * argument whose shape the attacks never read, and returns a RemoteFileSystem. When the design
 * picks another shape, only this file follows it.
 */
import { readdirSync } from 'node:fs';
import { PassThrough, Readable, Writable } from 'node:stream';
import { registerBackends } from '../../../src/backends.js';
import { createRegistry, runCli } from '../../../src/cli/index.js';
import {
  RemoteFsError,
  type RemoteEntry,
  type RemoteFileSystem,
} from '../../../src/index.js';

/** What the CLI hands a factory; the attacks only pass it on or serialise it. */
export type BackendTarget = unknown;
export type BackendFactory = (target: BackendTarget) => RemoteFileSystem;

export interface Registry {
  register(scheme: string, factory: BackendFactory): void;
}

/** Every code point of cyberduck/standard.sanitised-server-text, as a raw character. */
/* eslint-disable no-control-regex -- the set under test is control and format characters */
export const RAW_ESCAPED_SET =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
/* eslint-enable no-control-regex */

export class Capture extends Writable {
  private readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: () => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

export type NonTtyStdin = PassThrough & { isTTY: false };

/** A script's stdin: no terminal, and it never ends, so a CLI that waits on it hangs. */
export function scriptStdin(): NonTtyStdin {
  const stdin = new PassThrough() as NonTtyStdin;
  stdin.isTTY = false;
  return stdin;
}

export type FakeTty = PassThrough & {
  isTTY: true;
  isRaw: boolean;
  readonly rawModeCalls: boolean[];
  setRawMode(mode: boolean): FakeTty;
};

/** The spec's "fake TTY": the test writes the bytes a person types and sees every raw-mode call. */
export function fakeTty(): FakeTty {
  const tty = new PassThrough() as FakeTty;
  const calls: boolean[] = [];
  Object.assign(tty, { isTTY: true, isRaw: false, rawModeCalls: calls });
  tty.setRawMode = (mode: boolean): FakeTty => {
    calls.push(mode);
    tty.isRaw = mode;
    return tty;
  };
  return tty;
}

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliCall {
  readonly registry: Registry;
  readonly cwd: string;
  readonly home: string;
  readonly env?: Record<string, string | undefined>;
  readonly stdin?: NonTtyStdin | FakeTty;
  /** The live stderr, for a test that waits on a prompt before it types. */
  readonly stderr?: Capture;
}

export function stderrLines(text: string): string[] {
  return text.split('\n').filter((line) => line.length > 0);
}

export async function cli(args: string[], call: CliCall): Promise<CliRun> {
  const stdout = new Capture();
  const stderr = call.stderr ?? new Capture();
  const context = {
    stdout,
    stderr,
    stdin: call.stdin ?? scriptStdin(),
    env: call.env ?? {},
    cwd: call.cwd,
    home: call.home,
    registry: call.registry,
  };
  // A rejection here fails the test: runCli must resolve to an exit code for every outcome.
  const code = await runCli(
    args,
    context as unknown as Parameters<typeof runCli>[1],
  );
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** The production registry (`sftp`) plus the test back-ends of `extra`. */
export function registry(
  extra: Readonly<Record<string, BackendFactory>> = {},
): Registry {
  const built = createRegistry() as unknown as Registry;
  registerBackends(built as never);
  for (const [scheme, factory] of Object.entries(extra)) {
    built.register(scheme, factory);
  }
  return built;
}

export interface MemSpy {
  connects: number;
  disconnects: number;
  readonly targets: BackendTarget[];
  readonly readPaths: string[];
}

export interface MemBehaviour {
  /** Remote path to file content; every parent of a file is a directory. */
  readonly files?: Record<string, Buffer>;
  readonly connect?: (target: BackendTarget) => Promise<void>;
  readonly disconnect?: () => Promise<void>;
  readonly list?: (path: string) => Promise<RemoteEntry[]>;
  readonly stat?: (path: string) => Promise<RemoteEntry>;
  readonly createReadStream?: (path: string) => Readable;
}

function entry(
  path: string,
  type: RemoteEntry['type'],
  size: number,
): RemoteEntry {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  return {
    name: segments.at(-1) ?? path,
    path,
    type,
    size,
    modifiedAt: new Date(0),
    permissions: type === 'directory' ? 0o755 : 0o644,
  };
}

/** A test-only in-memory back-end whose every operation a test can make hostile. */
export function memBackend(behaviour: MemBehaviour = {}): {
  factory: BackendFactory;
  spy: MemSpy;
  files: Map<string, Buffer>;
} {
  const files = new Map(Object.entries(behaviour.files ?? {}));
  const spy: MemSpy = {
    connects: 0,
    disconnects: 0,
    targets: [],
    readPaths: [],
  };
  const isDirectory = (path: string): boolean => {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    return (
      path === '/' ||
      path === '.' ||
      [...files.keys()].some((name) => name.startsWith(prefix))
    );
  };
  const notFound = (path: string): RemoteFsError =>
    new RemoteFsError('NOT_FOUND', 'no such file', { path });

  const factory: BackendFactory = (target) => {
    spy.targets.push(target);
    return {
      connect: async () => {
        spy.connects += 1;
        await behaviour.connect?.(target);
      },
      disconnect: async () => {
        spy.disconnects += 1;
        await behaviour.disconnect?.();
      },
      list: async (path) => {
        if (behaviour.list) return behaviour.list(path);
        if (!isDirectory(path)) throw notFound(path);
        return [];
      },
      stat: async (path) => {
        if (behaviour.stat) return behaviour.stat(path);
        const content = files.get(path);
        if (content !== undefined) return entry(path, 'file', content.length);
        if (isDirectory(path)) return entry(path, 'directory', 0);
        throw notFound(path);
      },
      createReadStream: (path) => {
        spy.readPaths.push(path);
        if (behaviour.createReadStream) return behaviour.createReadStream(path);
        const content = files.get(path);
        if (content === undefined) {
          const failing = new Readable({ read() {} });
          queueMicrotask(() => failing.destroy(notFound(path)));
          return failing;
        }
        return Readable.from([content]);
      },
      createWriteStream: (path) => {
        const chunks: Buffer[] = [];
        return new Writable({
          write(chunk: Buffer, _encoding, callback) {
            chunks.push(chunk);
            callback();
          },
          final(callback) {
            files.set(path, Buffer.concat(chunks));
            callback();
          },
        });
      },
      mkdir: () => Promise.resolve(),
      remove: (path) => {
        files.delete(path);
        return Promise.resolve();
      },
      rename: (from, to) => {
        const content = files.get(from);
        if (content === undefined) return Promise.reject(notFound(from));
        files.delete(from);
        files.set(to, content);
        return Promise.resolve();
      },
    };
  };
  return { factory, spy, files };
}

/** Matches the spec's temporary file of `get` for a destination basename. */
export function isPartFileOf(basename: string, name: string): boolean {
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\.${escaped}\\.[0-9a-f]{16}\\.part$`).test(name);
}

export function namesIn(directory: string): string[] {
  return readdirSync(directory).sort();
}

/** True when the process runs as root, where a mode-based refusal cannot be shown. */
export const isRoot =
  typeof process.getuid === 'function' && process.getuid() === 0;
