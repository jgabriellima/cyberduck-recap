import { describe, expect, it } from 'vitest';
import type { RemoteFileSystem } from '../../src/fs/index.js';
import { s3Error } from '../support/s3-server.js';
import {
  expectRemoteError,
  readAll,
  rejection,
  useS3,
  writeAll,
} from '../support/s3.js';

/** Every operation once, each expected to fail with NOT_CONNECTED and send nothing. */
async function everyOperationIsNotConnected(
  fs: RemoteFileSystem,
): Promise<void> {
  await rejection(fs.list('/b'), 'NOT_CONNECTED');
  await rejection(fs.stat('/b/k'), 'NOT_CONNECTED');
  await rejection(fs.mkdir('/b/d'), 'NOT_CONNECTED');
  await rejection(fs.remove('/b/k'), 'NOT_CONNECTED');
  await rejection(fs.rename('/b/k', '/b/j'), 'NOT_CONNECTED');
  const read = await readAll(fs.createReadStream('/b/k'));
  expect(read.errors).toHaveLength(1);
  expectRemoteError(read.errors[0], 'NOT_CONNECTED');
  const write = await writeAll(fs.createWriteStream('/b/k'), Buffer.from('x'));
  expect(write.errors).toHaveLength(1);
  expectRemoteError(write.errors[0], 'NOT_CONNECTED');
  expect(write.finished).toBe(false);
}

describe('connect and disconnect (AC-22)', () => {
  it('AC-22: account-wide connect() sends exactly one ListBuckets probe', async () => {
    const setup = await useS3();
    await setup.connected();
    expect(setup.server.requests.map((r) => r.operation)).toEqual([
      'ListBuckets',
    ]);
  });

  it('AC-22: bucket-scoped connect() sends one ListObjectsV2 with max-keys=1 on the bucket', async () => {
    const setup = await useS3();
    await setup.connected({ bucket: 'b' });
    expect(setup.server.requests).toHaveLength(1);
    const [probe] = setup.server.requests;
    expect(probe).toMatchObject({ operation: 'ListObjectsV2', bucket: 'b' });
    expect(probe?.query['max-keys']).toBe('1');
  });

  it('AC-22: connect() resolves when the probe is answered AccessDenied', async () => {
    const setup = await useS3();
    setup.server.fault(() => s3Error('AccessDenied', 'Access Denied'));
    const fs = await setup.s3();
    await expect(fs.connect()).resolves.toBeUndefined();
  });

  it('AC-22: two concurrent connect() calls send one probe and settle the same way', async () => {
    const setup = await useS3();
    const fs = await setup.s3();
    const results = await Promise.allSettled([fs.connect(), fs.connect()]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(setup.server.requests).toHaveLength(1);

    const failing = await useS3();
    failing.server.fault(() => s3Error('InvalidAccessKeyId'));
    const other = await failing.s3();
    const failed = await Promise.allSettled([other.connect(), other.connect()]);
    expect(failed.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    const reasons = failed.map((r) =>
      r.status === 'rejected'
        ? (r.reason as { code?: unknown }).code
        : undefined,
    );
    expect(reasons).toEqual(['AUTH_FAILED', 'AUTH_FAILED']);
    expect(failing.server.requests).toHaveLength(1);
  });

  it('AC-22: connect() while connected sends nothing', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    setup.server.clearRequests();
    await fs.connect();
    expect(setup.server.requests).toEqual([]);
  });

  it('AC-22: every operation before connect() and after disconnect() is NOT_CONNECTED, no request', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'k', 'data');
    const fs = await setup.s3();
    await everyOperationIsNotConnected(fs);
    expect(setup.server.requests).toEqual([]);
    await fs.connect();
    await fs.disconnect();
    setup.server.clearRequests();
    await everyOperationIsNotConnected(fs);
    expect(setup.server.requests).toEqual([]);
  });

  it('AC-22: connect() after disconnect() sends a new probe and works again', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'k', 'data');
    const fs = await setup.connected();
    await fs.disconnect();
    setup.server.clearRequests();
    await fs.connect();
    expect(setup.server.requests.map((r) => r.operation)).toEqual([
      'ListBuckets',
    ]);
    expect((await fs.stat('/b/k')).type).toBe('file');
  });
});
