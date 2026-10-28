import { describe, expect, it } from 'vitest';
import type { RemoteFsError } from '../../src/fs/index.js';
import { s3Error } from '../support/s3-server.js';
import {
  onlyError,
  readAll,
  rejection,
  useS3,
  writeAll,
} from '../support/s3.js';

describe('permission denied (AC-40, AC-53)', () => {
  it('AC-40: each operation denied gives PERMISSION_DENIED with path, AccessDenied and its permission', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'k', 'old');
    setup.server.putObject('b', 'dir/x', 'x');
    const fs = await setup.connected();
    // After the probe, every request is denied: whichever request an operation sends first.
    setup.server.fault(() => s3Error('AccessDenied', 'Access Denied'));
    const check = (error: RemoteFsError, permissions: string[]): void => {
      expect(error.message).toContain('AccessDenied');
      for (const permission of permissions)
        expect(error.message).toContain(permission);
    };
    check(await rejection(fs.list('/b/dir'), 'PERMISSION_DENIED', '/b/dir'), [
      's3:ListBucket',
    ]);
    check(await rejection(fs.list('/'), 'PERMISSION_DENIED', '/'), [
      's3:ListAllMyBuckets',
    ]);
    check(await rejection(fs.stat('/b/k'), 'PERMISSION_DENIED', '/b/k'), [
      's3:GetObject',
      's3:ListBucket',
    ]);
    check(await rejection(fs.mkdir('/b/d'), 'PERMISSION_DENIED', '/b/d'), [
      's3:PutObject',
    ]);
    check(
      await rejection(
        fs.mkdir('/newbucket'),
        'PERMISSION_DENIED',
        '/newbucket',
      ),
      ['s3:CreateBucket'],
    );
    check(await rejection(fs.remove('/b/k'), 'PERMISSION_DENIED', '/b/k'), [
      's3:DeleteObject',
    ]);
    check(await rejection(fs.remove('/b'), 'PERMISSION_DENIED', '/b'), [
      's3:DeleteBucket',
    ]);
    check(
      await rejection(fs.rename('/b/k', '/b/j'), 'PERMISSION_DENIED', '/b/k'),
      ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
    );
    const read = await readAll(fs.createReadStream('/b/k'));
    check(onlyError(read, 'PERMISSION_DENIED', '/b/k'), ['s3:GetObject']);
    const write = await writeAll(
      fs.createWriteStream('/b/k'),
      Buffer.from('new bytes'),
    );
    check(onlyError(write, 'PERMISSION_DENIED', '/b/k'), ['s3:PutObject']);
    expect(write.finished).toBe(false);
    expect(setup.server.getObject('b', 'k')?.toString()).toBe('old');
  });

  it('AC-40: stat of a missing key answered 403 with no body is PERMISSION_DENIED, not NOT_FOUND', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    // S3 answers a missing key with 403 when the caller lacks s3:ListBucket.
    setup.server.fault((request) =>
      request.operation === 'HeadObject'
        ? { kind: 'raw', status: 403 }
        : request.operation === 'ListObjectsV2'
          ? s3Error('AccessDenied', 'Access Denied')
          : undefined,
    );
    await rejection(fs.stat('/b/missing'), 'PERMISSION_DENIED', '/b/missing');
  });

  it('AC-53: a read of an archived object gives OPERATION_FAILED with InvalidObjectState, no permission', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'cold', 'frozen');
    const fs = await setup.connected();
    setup.server.fault((request) =>
      request.operation === 'GetObject'
        ? s3Error(
            'InvalidObjectState',
            'The operation is not valid for the object storage class',
          )
        : undefined,
    );
    const outcome = await readAll(fs.createReadStream('/b/cold'));
    const error = onlyError(outcome, 'OPERATION_FAILED', '/b/cold');
    expect(error.message).toContain('InvalidObjectState');
    expect(error.message).toContain('/b/cold');
    // The criterion: no S3 permission is named. The object URL s3://b/cold keeps its scheme.
    expect(error.message).not.toMatch(/s3:[A-Za-z]/);
    expect(error.message.replaceAll('s3://', '')).not.toContain('s3:');
  });
});
