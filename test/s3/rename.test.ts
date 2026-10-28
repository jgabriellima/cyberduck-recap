import { describe, expect, it } from 'vitest';
import { s3Error } from '../support/s3-server.js';
import { bytes, rejection, useS3 } from '../support/s3.js';

const GIB_5 = 5_368_709_120;

describe('rename (AC-19 to AC-21)', () => {
  it('AC-19: rename within and across buckets copies on the server and deletes from', async () => {
    const setup = await useS3({}, { buckets: ['b', 'b2'] });
    const data = bytes(4096, 5);
    const fs = await setup.connected();
    for (const to of ['/b/c/d.txt', '/b2/a.txt']) {
      setup.server.putObject('b', 'a.txt', data);
      setup.server.clearRequests();
      await fs.rename('/b/a.txt', to);
      const [, bucket = '', ...rest] = to.split('/');
      expect(setup.server.getObject(bucket, rest.join('/'))).toEqual(data);
      expect(setup.server.hasObject('b', 'a.txt')).toBe(false);
      const copies = setup.server.requestsOf('CopyObject');
      expect(copies).toHaveLength(1);
      expect(copies[0]?.bodyBytes).toBe(0);
      for (const upload of ['PutObject', 'UploadPart'] as const) {
        expect(setup.server.requestsOf(upload)).toEqual([]);
      }
    }
  });

  it('AC-20: to an existing object or directory rejects ALREADY_EXISTS and changes nothing', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'a.txt', 'from');
    setup.server.putObject('b', 'f', 'target');
    setup.server.putObject('b', 'dir/x', 'x');
    const fs = await setup.connected();
    for (const to of ['/b/f', '/b/dir']) {
      const error = await rejection(
        fs.rename('/b/a.txt', to),
        'ALREADY_EXISTS',
        '/b/a.txt',
      );
      expect(error.targetPath).toBe(to);
    }
    expect(setup.server.getObject('b', 'a.txt')?.toString()).toBe('from');
    expect(setup.server.getObject('b', 'f')?.toString()).toBe('target');
    expect(setup.server.keysOf('b')).toEqual(['a.txt', 'dir/x', 'f']);
  });

  it('AC-20: a to created by another client before the copy gives ALREADY_EXISTS (If-None-Match: *)', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'a.txt', 'from');
    setup.server.fault((request) => {
      if (request.operation === 'CopyObject') {
        setup.server.putObject('b', 'late', 'other client');
      }
      return undefined;
    });
    const fs = await setup.connected();
    const error = await rejection(
      fs.rename('/b/a.txt', '/b/late'),
      'ALREADY_EXISTS',
      '/b/a.txt',
    );
    expect(error.targetPath).toBe('/b/late');
    expect(setup.server.requestsOf('CopyObject')[0]?.ifNoneMatch).toBe('*');
    expect(setup.server.getObject('b', 'late')?.toString()).toBe(
      'other client',
    );
    expect(setup.server.getObject('b', 'a.txt')?.toString()).toBe('from');
    expect(setup.server.requestsOf('DeleteObject')).toEqual([]);
  });

  it('AC-20: a missing from rejects NOT_FOUND; a directory or > 5 GiB from rejects OPERATION_FAILED', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'dir/x', 'x');
    setup.server.putObject('b', 'huge', 'small body', {
      reportedSize: GIB_5 + 1,
    });
    const fs = await setup.connected();
    const missing = await rejection(
      fs.rename('/b/nothing', '/b/t1'),
      'NOT_FOUND',
      '/b/nothing',
    );
    expect(missing.targetPath).toBe('/b/t1');
    const dir = await rejection(
      fs.rename('/b/dir', '/b/t2'),
      'OPERATION_FAILED',
      '/b/dir',
    );
    expect(dir.targetPath).toBe('/b/t2');
    const huge = await rejection(
      fs.rename('/b/huge', '/b/t3'),
      'OPERATION_FAILED',
      '/b/huge',
    );
    expect(huge.targetPath).toBe('/b/t3');
    expect(setup.server.keysOf('b')).toEqual(['dir/x', 'huge']);
    expect(setup.server.requestsOf('CopyObject')).toEqual([]);
  });

  it('AC-21: / or a bucket path as from or to rejects INVALID_ARGUMENT with no request', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'a.txt', 'from');
    const wide = await setup.connected();
    const scoped = await setup.connected({ bucket: 'b' });
    setup.server.clearRequests();
    const cases = [
      [wide, '/', '/b/x'],
      [wide, '/b/a.txt', '/'],
      [wide, '/b', '/b/x'],
      [wide, '/b/a.txt', '/b'],
      [scoped, '/', '/x'],
      [scoped, '/a.txt', '/'],
    ] as const;
    for (const [fs, from, to] of cases) {
      await rejection(fs.rename(from, to), 'INVALID_ARGUMENT');
    }
    expect(setup.server.requests).toEqual([]);
  });

  it('AC-21: a copy that succeeds and a delete that fails reject OPERATION_FAILED: both exist', async () => {
    const setup = await useS3();
    const data = bytes(2048, 11);
    setup.server.putObject('b', 'a.txt', data);
    setup.server.fault((request) =>
      request.operation === 'DeleteObject'
        ? s3Error('InternalError')
        : undefined,
    );
    const fs = await setup.connected();
    const error = await rejection(
      fs.rename('/b/a.txt', '/b/c.txt'),
      'OPERATION_FAILED',
    );
    expect(error.message).toContain('s3://b/a.txt');
    expect(error.message).toContain('s3://b/c.txt');
    expect(error.message).toMatch(/both .*now exist/);
    expect(setup.server.getObject('b', 'c.txt')).toEqual(data);
    expect(setup.server.getObject('b', 'a.txt')).toEqual(data);
  });
});
