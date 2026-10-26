import type { Readable, Writable } from 'node:stream';

export type RemoteEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface RemoteEntry {
  readonly name: string;
  readonly path: string;
  readonly type: RemoteEntryType;
  readonly size: number;
  /** Second precision: SFTP v3 and most stores report whole seconds. */
  readonly modifiedAt: Date;
  /** POSIX mode bits; `undefined` when the back-end does not report them. */
  readonly permissions: number | undefined;
}

export interface MkdirOptions {
  readonly recursive?: boolean;
}

/**
 * The operations every storage back-end offers. Callers (CLI, queue, sync, UI) program against
 * this and `RemoteFsError` only, never against a protocol.
 */
export interface RemoteFileSystem {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  list(path: string): Promise<RemoteEntry[]>;
  stat(path: string): Promise<RemoteEntry>;
  createReadStream(path: string): Readable;
  createWriteStream(path: string): Writable;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}
