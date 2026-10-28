import { describe, expect, it } from 'vitest';
import { rejection, useS3 } from '../support/s3.js';

describe('stat (AC-9)', () => {
  it('AC-9: / is a directory in both modes and sends no request', async () => {
    const setup = await useS3();
    for (const overrides of [{}, { bucket: 'b' }]) {
      const fs = await setup.connected(overrides);
      setup.server.clearRequests();
      const entry = await fs.stat('/');
      expect(entry.type).toBe('directory');
      expect(setup.server.requests).toEqual([]);
    }
  });

  it('AC-9: a bucket and a prefix with only keys under it are directories', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'dir/x', 'x');
    const fs = await setup.connected();
    expect((await fs.stat('/b')).type).toBe('directory');
    const dir = await fs.stat('/b/dir');
    expect(dir).toMatchObject({
      type: 'directory',
      name: 'dir',
      path: '/b/dir',
    });
  });

  it('AC-9: an object is a file with its size and second-precision modifiedAt', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'a.txt', 'hello', {
      lastModified: new Date('2026-01-02T03:04:05.678Z'),
    });
    const fs = await setup.connected();
    const entry = await fs.stat('/b/a.txt');
    expect(entry).toMatchObject({
      type: 'file',
      name: 'a.txt',
      path: '/b/a.txt',
      size: 5,
    });
    expect(entry.modifiedAt.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  it('AC-9: object k and prefix k/ together stat as a file', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'k', 'abc');
    setup.server.putObject('b', 'k/m', 'm');
    const fs = await setup.connected();
    expect(await fs.stat('/b/k')).toMatchObject({ type: 'file', size: 3 });
  });

  it('AC-9: a missing key and a missing bucket reject with NOT_FOUND and path', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    await rejection(fs.stat('/b/nothing'), 'NOT_FOUND', '/b/nothing');
    await rejection(fs.stat('/missing-bucket'), 'NOT_FOUND', '/missing-bucket');
  });
});
