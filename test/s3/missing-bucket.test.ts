import { describe, expect, it } from 'vitest';
import {
  expectRemoteError,
  readAll,
  rejection,
  useS3,
  writeAll,
} from '../support/s3.js';

describe('a bucket that does not exist (AC-39)', () => {
  it('AC-39: bucket-scoped connect() to a missing bucket rejects NOT_FOUND at / after one probe', async () => {
    const setup = await useS3();
    const fs = await setup.s3({ bucket: 'typo' });
    const error = await rejection(fs.connect(), 'NOT_FOUND', '/');
    expect(error.message).toContain('typo');
    expect(error.message).toContain('does not exist');
    expect(setup.server.requests).toHaveLength(1);
  });

  it('AC-39: a bucket deleted after connect() gives NOT_FOUND naming it for each operation', async () => {
    const bucket = 'photos-2026';
    const setup = await useS3({}, { buckets: [bucket] });
    const fs = await setup.connected({ bucket });
    setup.server.removeBucket(bucket);
    const checks: [string, Promise<unknown>][] = [
      ['list', fs.list('/')],
      ['stat', fs.stat('/k')],
      ['mkdir', fs.mkdir('/d')],
    ];
    for (const [label, promise] of checks) {
      const error = await rejection(promise, 'NOT_FOUND');
      expect(error.message, label).toContain(bucket);
    }
    const read = await readAll(fs.createReadStream('/k'));
    expect(read.errors).toHaveLength(1);
    expect(expectRemoteError(read.errors[0], 'NOT_FOUND').message).toContain(
      bucket,
    );
    const write = await writeAll(fs.createWriteStream('/k'), Buffer.from('x'));
    expect(write.errors).toHaveLength(1);
    expect(expectRemoteError(write.errors[0], 'NOT_FOUND').message).toContain(
      bucket,
    );
    setup.server.clearRequests();
    expect((await fs.stat('/')).type).toBe('directory');
    expect(setup.server.requests).toEqual([]);
  });

  it('AC-39: account-wide NOT_FOUND of a missing bucket names it (list, stat, write, mkdir)', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    for (const promise of [
      fs.list('/missing-bucket'),
      fs.stat('/missing-bucket'),
      fs.stat('/missing-bucket/k'),
      fs.mkdir('/missing-bucket/d'),
    ]) {
      const error = await rejection(promise, 'NOT_FOUND');
      expect(error.message).toContain('missing-bucket');
    }
    const write = await writeAll(
      fs.createWriteStream('/missing-bucket/k'),
      Buffer.from('x'),
    );
    expect(write.errors).toHaveLength(1);
    expect(
      expectRemoteError(write.errors[0], 'NOT_FOUND', '/missing-bucket/k')
        .message,
    ).toContain('missing-bucket');
  });
});
