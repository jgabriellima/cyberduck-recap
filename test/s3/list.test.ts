import { describe, expect, it } from 'vitest';
import type { RemoteEntry } from '../../src/fs/index.js';
import { rejection, useS3 } from '../support/s3.js';

function shape(entries: readonly RemoteEntry[]): string[] {
  return entries
    .map(
      (entry) =>
        `${entry.type} ${entry.name} ${entry.path} ${entry.size} ${entry.modifiedAt.toISOString()} ${String(entry.permissions)}`,
    )
    .sort();
}

/** The objects of AC-6 in bucket `b`. */
function seedAc6(server: Awaited<ReturnType<typeof useS3>>['server']): void {
  server.putObject('b', 'a.txt', 'hello', {
    lastModified: new Date('2026-01-02T03:04:05.678Z'),
  });
  server.putObject('b', 'dir/', '');
  server.putObject('b', 'dir/x', 'x', {
    lastModified: new Date('2026-02-03T04:05:06.789Z'),
  });
  server.putObject('b', 'dir/sub/y', 'y');
  server.putObject('b', 'deep/z', 'z');
}

const EPOCH = new Date(0).toISOString();

describe('list (AC-5 to AC-8)', () => {
  it('AC-5: account-wide, /, . and empty list every bucket over 3 pages as directories', async () => {
    const names = ['alpha', 'b', 'beta', 'gamma', 'delta', 'eps', 'zeta'];
    const setup = await useS3({ bucketPageSize: 3 }, { buckets: names });
    const fs = await setup.connected();
    const expected = names
      .map((name) => `directory ${name} /${name} 0 ${EPOCH} undefined`)
      .sort();
    for (const path of ['/', '.', '']) {
      setup.server.clearRequests();
      const entries = await fs.list(path);
      expect(shape(entries), path).toEqual(expected);
      for (const entry of entries) {
        expect(entry.modifiedAt.getTime()).toBe(0);
        expect(entry.permissions).toBeUndefined();
      }
      // Seven buckets in pages of three: the back-end followed all three pages.
      expect(setup.server.requestsOf('ListBuckets')).toHaveLength(3);
    }
  });

  it('AC-6: account-wide list of /b, /b/dir and /b/dir/ gives exactly the direct entries', async () => {
    const setup = await useS3();
    seedAc6(setup.server);
    const fs = await setup.connected();
    expect(shape(await fs.list('/b'))).toEqual(
      [
        'file a.txt /b/a.txt 5 2026-01-02T03:04:05.000Z undefined',
        `directory dir /b/dir 0 ${EPOCH} undefined`,
        `directory deep /b/deep 0 ${EPOCH} undefined`,
      ].sort(),
    );
    const dir = [
      'file x /b/dir/x 1 2026-02-03T04:05:06.000Z undefined',
      `directory sub /b/dir/sub 0 ${EPOCH} undefined`,
    ].sort();
    expect(shape(await fs.list('/b/dir'))).toEqual(dir);
    expect(shape(await fs.list('/b/dir/'))).toEqual(dir);
  });

  it('AC-6: a bucket-scoped instance gives the same entries without /b', async () => {
    const setup = await useS3();
    seedAc6(setup.server);
    const fs = await setup.connected({ bucket: 'b' });
    expect(shape(await fs.list('/'))).toEqual(
      [
        'file a.txt /a.txt 5 2026-01-02T03:04:05.000Z undefined',
        `directory dir /dir 0 ${EPOCH} undefined`,
        `directory deep /deep 0 ${EPOCH} undefined`,
      ].sort(),
    );
    expect(shape(await fs.list('/dir'))).toEqual(
      [
        'file x /dir/x 1 2026-02-03T04:05:06.000Z undefined',
        `directory sub /dir/sub 0 ${EPOCH} undefined`,
      ].sort(),
    );
  });

  it('AC-7: 2,500 objects over 3 pages give 2,500 entries with no duplicate', async () => {
    const setup = await useS3({ listPageSize: 1000 });
    for (let index = 0; index < 2500; index += 1) {
      setup.server.putObject(
        'b',
        `many/f${String(index).padStart(4, '0')}`,
        '',
      );
    }
    const fs = await setup.connected();
    setup.server.clearRequests();
    const entries = await fs.list('/b/many');
    expect(entries).toHaveLength(2500);
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(2500);
    expect(setup.server.requestsOf('ListObjectsV2')).toHaveLength(3);
  });

  it('AC-7: an object k and a prefix k/ give a file and a directory both named k', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'p/k', 'data');
    setup.server.putObject('b', 'p/k/m', 'more');
    const fs = await setup.connected();
    const entries = await fs.list('/b/p');
    expect(
      entries.map((entry) => `${entry.type} ${entry.name}`).sort(),
    ).toEqual(['directory k', 'file k']);
  });

  it("AC-7: keys e//x, e/./y and e/../z give no entry named '', . or ..", async () => {
    const setup = await useS3();
    for (const key of ['e//x', 'e/./y', 'e/../z', 'e/ok']) {
      setup.server.putObject('b', key, '');
    }
    const fs = await setup.connected();
    const names = (await fs.list('/b/e')).map((entry) => entry.name);
    for (const bad of ['', '.', '..']) expect(names).not.toContain(bad);
    expect(names).toContain('ok');
  });

  it('AC-8: an empty bucket and a folder with only its marker list as []', async () => {
    const setup = await useS3({}, { buckets: ['b', 'empty'] });
    setup.server.putObject('b', 'only/', '');
    const fs = await setup.connected();
    expect(await fs.list('/empty')).toEqual([]);
    expect(await fs.list('/b/only')).toEqual([]);
  });

  it('AC-8: NOT_A_DIRECTORY for a file, NOT_FOUND for a missing key and bucket', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'a.txt', 'hello');
    const fs = await setup.connected();
    await rejection(fs.list('/b/a.txt'), 'NOT_A_DIRECTORY', '/b/a.txt');
    await rejection(fs.list('/b/nothing'), 'NOT_FOUND', '/b/nothing');
    await rejection(fs.list('/missing-bucket'), 'NOT_FOUND', '/missing-bucket');
  });
});
