import type { Readable, Writable } from 'node:stream';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  REMOTE_FS_ERROR_CODES,
  RemoteFsError,
  SftpFileSystem,
  type RemoteEntry,
  type RemoteFileSystem,
  type RemoteFsErrorCode,
  type WriteStreamOptions,
} from '../../src/index.js';

const SPEC_CODES = [
  'AUTH_FAILED',
  'HOST_KEY_UNKNOWN',
  'HOST_KEY_CHANGED',
  'CONNECTION_FAILED',
  'CONNECTION_LOST',
  'NOT_CONNECTED',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'ALREADY_EXISTS',
  'NOT_A_DIRECTORY',
  'IS_A_DIRECTORY',
  'INVALID_ARGUMENT',
  'OPERATION_FAILED',
] as const;

describe('public contract (AC-1)', () => {
  it('RemoteFsError codes are exactly the thirteen codes of the spec', () => {
    expectTypeOf<RemoteFsErrorCode>().toEqualTypeOf<
      (typeof SPEC_CODES)[number]
    >();
    expectTypeOf<RemoteFsError['code']>().toEqualTypeOf<
      (typeof SPEC_CODES)[number]
    >();
    expect([...REMOTE_FS_ERROR_CODES].sort()).toEqual([...SPEC_CODES].sort());
  });

  it('RemoteFsError is an Error and a RemoteFsError, with its details', () => {
    const error = new RemoteFsError('NOT_FOUND', 'stat /x: no such file', {
      path: '/x',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RemoteFsError);
    expect(error.name).toBe('RemoteFsError');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.path).toBe('/x');
    expect(error.targetPath).toBeUndefined();
    expect(Object.keys(error)).not.toContain('targetPath');
  });

  it('SftpFileSystem is assignable to RemoteFileSystem', () => {
    expectTypeOf<SftpFileSystem>().toExtend<RemoteFileSystem>();
    const fs: RemoteFileSystem = new SftpFileSystem({
      host: 'example.org',
      username: 'tester',
      password: 'dummy-password',
      knownHostsPath: '/tmp/known_hosts',
    });
    expect(fs).toBeInstanceOf(SftpFileSystem);
  });

  it('RemoteFileSystem has the operations of the spec with their signatures', () => {
    expectTypeOf<RemoteFileSystem['connect']>().toEqualTypeOf<
      () => Promise<void>
    >();
    expectTypeOf<RemoteFileSystem['disconnect']>().toEqualTypeOf<
      () => Promise<void>
    >();
    expectTypeOf<RemoteFileSystem['list']>().toEqualTypeOf<
      (path: string) => Promise<RemoteEntry[]>
    >();
    expectTypeOf<RemoteFileSystem['stat']>().toEqualTypeOf<
      (path: string) => Promise<RemoteEntry>
    >();
    expectTypeOf<RemoteFileSystem['createReadStream']>().toEqualTypeOf<
      (path: string) => Readable
    >();
    // FEATURE-2 (design 6A) adds the optional `{ exclusive }` of an upload that must not replace.
    expectTypeOf<RemoteFileSystem['createWriteStream']>().toEqualTypeOf<
      (path: string, options?: WriteStreamOptions) => Writable
    >();
    expectTypeOf<RemoteFileSystem['remove']>().toEqualTypeOf<
      (path: string) => Promise<void>
    >();
    expectTypeOf<RemoteFileSystem['rename']>().toEqualTypeOf<
      (from: string, to: string) => Promise<void>
    >();
    expectTypeOf<RemoteFileSystem['mkdir']>()
      .parameter(0)
      .toEqualTypeOf<string>();
  });

  it('RemoteEntry has the fields of the spec', () => {
    expectTypeOf<RemoteEntry>().toEqualTypeOf<{
      readonly name: string;
      readonly path: string;
      readonly type: 'file' | 'directory' | 'symlink' | 'other';
      readonly size: number;
      readonly modifiedAt: Date;
      readonly permissions: number | undefined;
    }>();
  });
});
