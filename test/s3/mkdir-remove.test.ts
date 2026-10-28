import { describe, expect, it } from 'vitest';
import { rejection, useS3 } from '../support/s3.js';

describe('mkdir (AC-15, AC-16, AC-46)', () => {
  it('AC-15: mkdir writes one zero-byte marker d/, then d is a listed directory', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    setup.server.clearRequests();
    await fs.mkdir('/b/d');
    const puts = setup.server.requestsOf('PutObject');
    expect(puts.map((r) => [r.key, r.bodyBytes])).toEqual([['d/', 0]]);
    expect(setup.server.getObject('b', 'd/')).toEqual(Buffer.alloc(0));
    expect((await fs.stat('/b/d')).type).toBe('directory');
    expect((await fs.list('/b')).map((e) => `${e.type} ${e.name}`)).toContain(
      'directory d',
    );
  });

  it('AC-15: non-recursive mkdir rejects ALREADY_EXISTS for a file, a directory and /', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'f', 'data');
    setup.server.putObject('b', 'dir/x', 'x');
    const fs = await setup.connected();
    await rejection(fs.mkdir('/b/f'), 'ALREADY_EXISTS', '/b/f');
    await rejection(fs.mkdir('/b/dir'), 'ALREADY_EXISTS', '/b/dir');
    await rejection(fs.mkdir('/'), 'ALREADY_EXISTS', '/');
    expect(setup.server.requestsOf('PutObject')).toEqual([]);
  });

  it('AC-15: non-recursive mkdir rejects NOT_FOUND under a missing parent and a missing bucket', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    await rejection(fs.mkdir('/b/x/y'), 'NOT_FOUND', '/b/x/y');
    await rejection(
      fs.mkdir('/missing-bucket/d'),
      'NOT_FOUND',
      '/missing-bucket/d',
    );
    expect(setup.server.requestsOf('PutObject')).toEqual([]);
  });

  it('AC-15: recursive mkdir writes only the marker x/y/; of a directory it writes nothing', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'dir/x', 'x');
    const fs = await setup.connected();
    setup.server.clearRequests();
    await fs.mkdir('/b/x/y', { recursive: true });
    expect(setup.server.requestsOf('PutObject').map((r) => r.key)).toEqual([
      'x/y/',
    ]);
    expect(setup.server.keysOf('b')).toEqual(['dir/x', 'x/y/']);
    setup.server.clearRequests();
    await fs.mkdir('/b/dir', { recursive: true });
    await fs.mkdir('/', { recursive: true });
    expect(setup.server.requestsOf('PutObject')).toEqual([]);
  });

  it('AC-16: mkdir of a bucket sends CreateBucket with the region, none for us-east-1', async () => {
    const setup = await useS3();
    const west = await setup.connected({ region: 'eu-west-1' });
    await west.mkdir('/newbucket');
    const [create] = setup.server.requestsOf('CreateBucket');
    expect(create?.bucket).toBe('newbucket');
    expect(create?.bodyText ?? '').toMatch(
      /<LocationConstraint>eu-west-1<\/LocationConstraint>/,
    );
    expect(setup.server.buckets.has('newbucket')).toBe(true);

    const east = await setup.connected({ region: 'us-east-1' });
    setup.server.clearRequests();
    await east.mkdir('/eastbucket');
    const [plain] = setup.server.requestsOf('CreateBucket');
    expect(plain?.bodyText ?? '').not.toContain('LocationConstraint');
  });

  it('AC-16: mkdir of an existing bucket rejects ALREADY_EXISTS; recursive of an owned one resolves', async () => {
    for (const code of [
      'BucketAlreadyExists',
      'BucketAlreadyOwnedByYou',
    ] as const) {
      const setup = await useS3({ existingBucketCode: code });
      const fs = await setup.connected();
      await rejection(fs.mkdir('/b'), 'ALREADY_EXISTS', '/b');
    }
    const owned = await useS3({
      existingBucketCode: 'BucketAlreadyOwnedByYou',
    });
    const fs = await owned.connected();
    await expect(fs.mkdir('/b', { recursive: true })).resolves.toBeUndefined();
  });

  it('AC-46: recursive mkdir onto a file or under a file rejects ALREADY_EXISTS at the file', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'a.txt', 'hello');
    const fs = await setup.connected();
    const before = await fs.list('/b');
    setup.server.clearRequests();
    await rejection(
      fs.mkdir('/b/a.txt', { recursive: true }),
      'ALREADY_EXISTS',
      '/b/a.txt',
    );
    await rejection(
      fs.mkdir('/b/a.txt/y/z', { recursive: true }),
      'ALREADY_EXISTS',
      '/b/a.txt',
    );
    await rejection(fs.mkdir('/b/a.txt/y'), 'NOT_FOUND', '/b/a.txt/y');
    expect(setup.server.requestsOf('PutObject')).toEqual([]);
    expect(await fs.list('/b')).toEqual(before);
  });
});

describe('remove (AC-17, AC-18)', () => {
  it('AC-17: remove deletes object k and keeps the keys under k/', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'k', 'data');
    setup.server.putObject('b', 'k/m', 'more');
    const fs = await setup.connected();
    await fs.remove('/b/k');
    expect(setup.server.keysOf('b')).toEqual(['k/m']);
  });

  it('AC-17: remove of a folder with only its marker deletes the marker', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'only/', '');
    const fs = await setup.connected();
    await fs.remove('/b/only');
    expect(setup.server.keysOf('b')).toEqual([]);
  });

  it('AC-17: remove of a folder with other keys rejects OPERATION_FAILED and deletes nothing', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'full/', '');
    setup.server.putObject('b', 'full/x', 'x');
    const fs = await setup.connected();
    await rejection(fs.remove('/b/full'), 'OPERATION_FAILED', '/b/full');
    expect(setup.server.keysOf('b')).toEqual(['full/', 'full/x']);
    expect(setup.server.requestsOf('DeleteObject')).toEqual([]);
  });

  it('AC-17: remove of a missing key rejects NOT_FOUND and sends no DeleteObject', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    await rejection(fs.remove('/b/nothing'), 'NOT_FOUND', '/b/nothing');
    expect(setup.server.requestsOf('DeleteObject')).toEqual([]);
    expect(setup.server.requestsOf('DeleteObjects')).toEqual([]);
  });

  it('AC-18: remove of an empty bucket deletes it; of a full bucket rejects and keeps it', async () => {
    const setup = await useS3({}, { buckets: ['b', 'empty'] });
    setup.server.putObject('b', 'k', 'data');
    const fs = await setup.connected();
    await fs.remove('/empty');
    expect(setup.server.buckets.has('empty')).toBe(false);
    await rejection(fs.remove('/b'), 'OPERATION_FAILED', '/b');
    expect(setup.server.keysOf('b')).toEqual(['k']);
  });

  it('AC-18: remove(/) rejects INVALID_ARGUMENT in both modes and sends no request', async () => {
    const setup = await useS3();
    for (const overrides of [{}, { bucket: 'b' }]) {
      const fs = await setup.connected(overrides);
      setup.server.clearRequests();
      await rejection(fs.remove('/'), 'INVALID_ARGUMENT');
      expect(setup.server.requests).toEqual([]);
    }
  });
});
