/**
 * A test-only in-memory back-end, registered under the scheme `mem` (FEATURE-2 AC-32). It lives
 * outside `src/` on purpose: the CLI must accept a back-end it has never seen. It records every
 * call and what its factory received, and injects the faults the CLI criteria need.
 */
import { posix } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  RemoteFsError,
  type RemoteEntry,
  type RemoteEntryType,
  type RemoteFileSystem,
} from '../../src/fs/index.js';
import type { BackendFactory } from './cli.js';

type MemNode =
  | { readonly kind: 'file'; data: Buffer; modifiedAt: Date }
  | { readonly kind: 'directory'; modifiedAt: Date }
  | { readonly kind: 'symlink'; target: string; modifiedAt: Date };

export interface MemCalls {
  connect: number;
  disconnect: number;
  list: string[];
  stat: string[];
  read: string[];
  write: string[];
}

export interface MemFaults {
  /** `connect()` rejects with this value. */
  connect?: unknown;
  /** `disconnect()` rejects with this value. */
  disconnect?: unknown;
  /** `list()` rejects with this value. */
  list?: unknown;
  /** A read stream fails with this value after its first byte. */
  read?: unknown;
}

const EPOCH = new Date('2024-01-02T03:04:05.000Z');

/** Normalises a remote path; `.` and relative paths resolve against the login directory `/`. */
function normal(path: string): string {
  return posix.normalize(posix.join('/', path));
}

export class MemBackend {
  readonly nodes = new Map<string, MemNode>([
    ['/', { kind: 'directory', modifiedAt: EPOCH }],
  ]);
  readonly calls: MemCalls = {
    connect: 0,
    disconnect: 0,
    list: [],
    stat: [],
    read: [],
    write: [],
  };
  readonly faults: MemFaults = {};
  /** Every value the factory received, in order. */
  readonly targets: unknown[] = [];
  /** Called inside `connect()`, before it settles. */
  onConnect: (() => void) | undefined;
  #pauseAfter: number | undefined;
  #paused: (() => void) | undefined;
  #pauseReached: (() => void) | undefined;
  readonly #pauseReachedPromise: Promise<void>;

  constructor() {
    this.#pauseReachedPromise = new Promise((resolve) => {
      this.#pauseReached = resolve;
    });
  }

  readonly factory: BackendFactory = (target) => {
    this.targets.push(target);
    return this.#fileSystem();
  };

  file(path: string, data: Buffer | string, modifiedAt = EPOCH): void {
    this.#parents(path);
    this.nodes.set(normal(path), {
      kind: 'file',
      data: Buffer.isBuffer(data) ? data : Buffer.from(data),
      modifiedAt,
    });
  }

  directory(path: string, modifiedAt = EPOCH): void {
    this.#parents(path);
    this.nodes.set(normal(path), { kind: 'directory', modifiedAt });
  }

  symlink(path: string, target: string, modifiedAt = EPOCH): void {
    this.#parents(path);
    this.nodes.set(normal(path), { kind: 'symlink', target, modifiedAt });
  }

  read(path: string): Buffer | undefined {
    const node = this.nodes.get(normal(path));
    return node?.kind === 'file' ? node.data : undefined;
  }

  /** Read streams push this many bytes, then wait for `release()`. */
  pauseAfter(bytes: number): void {
    this.#pauseAfter = bytes;
  }

  /** Resolves once a read stream has pushed its bytes and waits. */
  whenPaused(): Promise<void> {
    return this.#pauseReachedPromise;
  }

  release(): void {
    this.#pauseAfter = undefined;
    this.#paused?.();
  }

  /** The `knownHostsPath` of the last value the factory received. */
  lastKnownHostsPath(): unknown {
    const target = this.targets[this.targets.length - 1] as
      { readonly knownHostsPath?: unknown } | undefined;
    return target?.knownHostsPath;
  }

  #parents(path: string): void {
    let parent = posix.dirname(normal(path));
    const missing: string[] = [];
    while (!this.nodes.has(parent)) {
      missing.unshift(parent);
      parent = posix.dirname(parent);
    }
    for (const directory of missing) {
      this.nodes.set(directory, { kind: 'directory', modifiedAt: EPOCH });
    }
  }

  #entry(path: string, node: MemNode): RemoteEntry {
    const type: RemoteEntryType =
      node.kind === 'file'
        ? 'file'
        : node.kind === 'directory'
          ? 'directory'
          : 'symlink';
    return {
      name: posix.basename(path),
      path,
      type,
      size: node.kind === 'file' ? node.data.length : 0,
      modifiedAt: node.modifiedAt,
      permissions: undefined,
    };
  }

  #fileSystem(): RemoteFileSystem {
    let connected = false;
    const requireConnected = (path: string): void => {
      if (!connected) {
        throw new RemoteFsError('NOT_CONNECTED', 'not connected', { path });
      }
    };
    const notFound = (path: string): RemoteFsError =>
      new RemoteFsError('NOT_FOUND', `no such file: ${path}`, { path });

    return {
      connect: async () => {
        this.calls.connect += 1;
        this.onConnect?.();
        if ('connect' in this.faults) throw this.faults.connect;
        connected = true;
        return Promise.resolve();
      },
      disconnect: async () => {
        this.calls.disconnect += 1;
        connected = false;
        if ('disconnect' in this.faults) throw this.faults.disconnect;
        return Promise.resolve();
      },
      list: async (path) => {
        this.calls.list.push(path);
        if ('list' in this.faults) throw this.faults.list;
        requireConnected(path);
        const directory = normal(path);
        const node = this.nodes.get(directory);
        if (node === undefined) throw notFound(path);
        if (node.kind !== 'directory') {
          throw new RemoteFsError(
            'NOT_A_DIRECTORY',
            `not a directory: ${path}`,
            { path },
          );
        }
        const entries: RemoteEntry[] = [];
        for (const [candidate, child] of this.nodes) {
          if (candidate !== '/' && posix.dirname(candidate) === directory) {
            entries.push(this.#entry(candidate, child));
          }
        }
        return Promise.resolve(entries);
      },
      stat: async (path) => {
        this.calls.stat.push(path);
        requireConnected(path);
        const node = this.nodes.get(normal(path));
        if (node === undefined) throw notFound(path);
        return Promise.resolve(this.#entry(normal(path), node));
      },
      createReadStream: (path) => this.#readStream(path, () => connected),
      createWriteStream: (path) => this.#writeStream(path, () => connected),
      mkdir: async (path) => {
        requireConnected(path);
        if (this.nodes.has(normal(path))) {
          throw new RemoteFsError('ALREADY_EXISTS', `exists: ${path}`, {
            path,
          });
        }
        this.directory(path);
        return Promise.resolve();
      },
      remove: async (path) => {
        requireConnected(path);
        if (!this.nodes.delete(normal(path))) throw notFound(path);
        return Promise.resolve();
      },
      rename: async (from, to) => {
        requireConnected(from);
        const node = this.nodes.get(normal(from));
        if (node === undefined) throw notFound(from);
        this.nodes.delete(normal(from));
        this.nodes.set(normal(to), node);
        return Promise.resolve();
      },
    };
  }

  #readStream(path: string, isConnected: () => boolean): Readable {
    this.calls.read.push(path);
    let offset = 0;
    const stream: Readable = new Readable({
      read: (): void => {
        const fail = (error: unknown): void => {
          stream.destroy(error as Error);
        };
        if (!isConnected()) {
          fail(new RemoteFsError('NOT_CONNECTED', 'not connected', { path }));
          return;
        }
        const node = this.nodes.get(normal(path));
        if (node === undefined) {
          fail(
            new RemoteFsError('NOT_FOUND', `no such file: ${path}`, { path }),
          );
          return;
        }
        if (node.kind === 'directory') {
          fail(
            new RemoteFsError('IS_A_DIRECTORY', `is a directory: ${path}`, {
              path,
            }),
          );
          return;
        }
        if (node.kind !== 'file') {
          fail(
            new RemoteFsError('OPERATION_FAILED', `not a file: ${path}`, {
              path,
            }),
          );
          return;
        }
        if (offset > 0 && 'read' in this.faults) {
          fail(this.faults.read);
          return;
        }
        const push = (limit: number): void => {
          if (offset >= node.data.length) {
            stream.push(null);
            return;
          }
          const end = Math.min(limit, node.data.length);
          const chunk = node.data.subarray(offset, end);
          offset = end;
          stream.push(chunk);
        };
        const pause = this.pauseLimit();
        if (pause !== undefined) {
          if (offset < pause) {
            push(pause);
            return;
          }
          this.waitForRelease(() => push(offset + 65_536));
          return;
        }
        if (offset === 0 && 'read' in this.faults) {
          push(1);
          return;
        }
        push(offset + 65_536);
      },
    });
    return stream;
  }

  /** @internal The byte count read streams stop at, while paused. */
  pauseLimit(): number | undefined {
    return this.#pauseAfter;
  }

  /** @internal Parks a read stream until `release()`. */
  waitForRelease(resume: () => void): void {
    this.#paused = () => {
      this.#paused = undefined;
      resume();
    };
    this.#pauseReached?.();
  }

  #writeStream(path: string, isConnected: () => boolean): Writable {
    this.calls.write.push(path);
    const chunks: Buffer[] = [];
    return new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        chunks.push(chunk);
        callback();
      },
      final: (callback) => {
        if (!isConnected()) {
          callback(
            new RemoteFsError('NOT_CONNECTED', 'not connected', { path }),
          );
          return;
        }
        const parent = this.nodes.get(posix.dirname(normal(path)));
        if (parent?.kind !== 'directory') {
          callback(
            new RemoteFsError('NOT_FOUND', `no such directory for ${path}`, {
              path,
            }),
          );
          return;
        }
        this.file(path, Buffer.concat(chunks));
        callback();
      },
    });
  }
}

/** A fresh `mem` back-end and its factory, for one test. */
export function memBackend(): MemBackend {
  return new MemBackend();
}
