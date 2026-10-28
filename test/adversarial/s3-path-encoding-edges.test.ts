/**
 * Adversarial (FEATURE-3, ATK-83): paths the key encoding cannot carry as they are. The spec
 * refuses U+0000 in a path with INVALID_ARGUMENT and no request, for every operation and for both
 * paths of a rename. A lone surrogate has no UTF-8 form: encoding it throws a URIError in
 * `encodeURIComponent`, or turns it into U+FFFD and so names another key. A bucket segment with
 * `?` or `#` would end the path of a path-style URL and send the request to bucket `b`. Each must
 * be a typed RemoteFsError (AC-1), a stream emits exactly one error, and no object is written at a
 * key or in a bucket the caller did not name.
 */
import { describe, expect, it } from 'vitest';
import {
  REMOTE_FS_ERROR_CODES,
  RemoteFsError,
  type RemoteFileSystem,
} from '../../src/fs/index.js';
import {
  readAll,
  rejection,
  useS3,
  writeAll,
  type StreamOutcome,
} from '../support/s3.js';

type Operation = readonly [
  string,
  (fs: RemoteFileSystem, path: string) => Promise<unknown>,
];

/** Every operation, each reduced to a promise that settles with its outcome. */
const OPERATIONS: readonly Operation[] = [
  ['list', (fs, path) => fs.list(path)],
  ['stat', (fs, path) => fs.stat(path)],
  ['mkdir', (fs, path) => fs.mkdir(path)],
  ['remove', (fs, path) => fs.remove(path)],
  ['rename from', (fs, path) => fs.rename(path, '/b/target')],
  ['rename to', (fs, path) => fs.rename('/b/source', path)],
  [
    'read stream',
    (fs, path) => streamFailure(readAll(fs.createReadStream(path))),
  ],
  [
    'write stream',
    (fs, path) =>
      streamFailure(
        writeAll(fs.createWriteStream(path), Buffer.from('payload')),
      ),
  ],
];

/** Rejects with the stream's error when it emitted exactly one; else fails the test. */
async function streamFailure(outcome: Promise<StreamOutcome>): Promise<void> {
  const settled = await outcome;
  expect(settled.errors).toHaveLength(1);
  expect(settled.finished).toBe(false);
  expect(settled.ended).toBe(false);
  throw settled.errors[0];
}

async function typedFailure(promise: Promise<unknown>): Promise<RemoteFsError> {
  let caught: unknown;
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (error) {
    caught = error;
  }
  expect(resolved, 'expected a rejection').toBe(false);
  expect(caught).not.toBeInstanceOf(URIError);
  expect(caught).toBeInstanceOf(RemoteFsError);
  expect(REMOTE_FS_ERROR_CODES).toContain((caught as RemoteFsError).code);
  return caught as RemoteFsError;
}

describe('ATK-83: U+0000 in any path is INVALID_ARGUMENT and sends no request', () => {
  it.each(OPERATIONS)('%s', async (_label, operation) => {
    const setup = await useS3();
    setup.server.putObject('b', 'source', 'bytes');
    const fs = await setup.connected();
    setup.server.clearRequests();
    await rejection(operation(fs, '/b/a\u0000b'), 'INVALID_ARGUMENT');
    expect(setup.server.requests).toHaveLength(0);
  });
});

describe('ATK-83: a lone surrogate in a path is a typed error, never another key', () => {
  it.each(OPERATIONS)('%s', async (_label, operation) => {
    const setup = await useS3();
    setup.server.putObject('b', 'source', 'bytes');
    const fs = await setup.connected();
    for (const path of ['/b/a\uD800b', '/b/\uDC00']) {
      await typedFailure(operation(fs, path));
    }
    // U+FFFD is what a lone surrogate becomes when it is encoded as UTF-8 anyway.
    expect(setup.server.keysOf('b').filter((key) => key.includes('�'))).toEqual(
      [],
    );
    expect(setup.server.getObject('b', 'source')?.toString()).toBe('bytes');
  });
});

describe('ATK-83: a bucket segment with ? or # does not reach bucket b', () => {
  it.each(['/b?x=1/k', '/b#x/k', '/b%3Fx/k'])(
    'a write stream to %j writes nothing in bucket b',
    async (path) => {
      const setup = await useS3();
      const fs = await setup.connected();
      setup.server.clearRequests();
      const outcome = await writeAll(
        fs.createWriteStream(path),
        Buffer.from('payload'),
      );
      expect(outcome.errors).toHaveLength(1);
      expect(outcome.finished).toBe(false);
      expect(outcome.errors[0]).toBeInstanceOf(RemoteFsError);
      expect(setup.server.keysOf('b')).toEqual([]);
      const creating = setup.server.requests.filter(
        (r) =>
          r.operation === 'PutObject' ||
          r.operation === 'CreateMultipartUpload',
      );
      expect(creating.filter((r) => r.bucket === 'b')).toEqual([]);
    },
  );
});
