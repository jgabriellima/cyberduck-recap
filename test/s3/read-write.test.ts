import { describe, expect, it } from 'vitest';
import {
  MIB,
  bytes,
  onlyError,
  readAll,
  sha256,
  useS3,
  writeAll,
} from '../support/s3.js';

const CREATING = ['PutObject', 'CreateMultipartUpload'] as const;

describe('read and write streams (AC-10 to AC-12)', () => {
  it('AC-10: a read stream gives the exact bytes of 0 B, 1 B and 20 MiB objects', async () => {
    const setup = await useS3();
    const sizes = [0, 1, 20 * MIB];
    for (const size of sizes) {
      setup.server.putObject('b', `obj-${size}`, bytes(size, size % 251));
    }
    const fs = await setup.connected();
    for (const size of sizes) {
      const outcome = await readAll(fs.createReadStream(`/b/obj-${size}`));
      expect(outcome.errors).toEqual([]);
      expect(outcome.ended).toBe(true);
      expect(sha256(outcome.data)).toBe(sha256(bytes(size, size % 251)));
    }
  }, 30_000);

  it('AC-10: directories emit IS_A_DIRECTORY and a missing key NOT_FOUND, one error, no data', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'dir/x', 'x');
    const fs = await setup.connected();
    const cases = [
      ['/', 'IS_A_DIRECTORY'],
      ['/b', 'IS_A_DIRECTORY'],
      ['/b/dir', 'IS_A_DIRECTORY'],
      ['/b/nothing', 'NOT_FOUND'],
    ] as const;
    for (const [path, code] of cases) {
      const outcome = await readAll(fs.createReadStream(path));
      onlyError(outcome, code, path);
      expect(outcome.dataEvents, path).toBe(0);
      expect(outcome.ended, path).toBe(false);
    }
  });

  it('AC-11: a write stream stores 0 B, 1 B and 20 MiB exactly, finish after the completing request', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    for (const size of [0, 1, 20 * MIB]) {
      const key = `new/deep/k${size}`;
      const data = bytes(size, 3);
      const stream = fs.createWriteStream(`/b/${key}`);
      let completedBeforeFinish = false;
      stream.on('finish', () => {
        const completing = [
          ...setup.server.requestsOf('PutObject', key),
          ...setup.server.requestsOf('CompleteMultipartUpload', key),
        ];
        completedBeforeFinish =
          completing.length > 0 && setup.server.hasObject('b', key);
      });
      const outcome = await writeAll(stream, data);
      expect(outcome.errors, key).toEqual([]);
      expect(outcome.finished, key).toBe(true);
      expect(completedBeforeFinish, key).toBe(true);
      expect(sha256(setup.server.getObject('b', key) ?? Buffer.alloc(1))).toBe(
        sha256(data),
      );
    }
    const big = 'new/deep/k20971520';
    expect(setup.server.requestsOf('CreateMultipartUpload', big)).toHaveLength(
      1,
    );
    expect(
      setup.server.requestsOf('UploadPart', big).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      setup.server.requestsOf('CompleteMultipartUpload', big),
    ).toHaveLength(1);
  }, 30_000);

  it('AC-11: a write to an existing key replaces it when exclusive is not set', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'k', 'old bytes');
    const fs = await setup.connected();
    const outcome = await writeAll(fs.createWriteStream('/b/k'), bytes(10, 9));
    expect(outcome.errors).toEqual([]);
    expect(setup.server.getObject('b', 'k')).toEqual(bytes(10, 9));
  });

  it('AC-12: writes to /, /b and a prefix emit IS_A_DIRECTORY and create nothing', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'dir/x', 'x');
    const fs = await setup.connected();
    for (const path of ['/', '/b', '/b/dir']) {
      const outcome = await writeAll(fs.createWriteStream(path), bytes(1024));
      onlyError(outcome, 'IS_A_DIRECTORY', path);
      expect(outcome.finished, path).toBe(false);
    }
    for (const operation of CREATING) {
      expect(setup.server.requestsOf(operation)).toEqual([]);
    }
    expect(setup.server.hasObject('b', 'dir')).toBe(false);
  });

  it('AC-12: a write to a missing bucket emits NOT_FOUND with path', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    const outcome = await writeAll(
      fs.createWriteStream('/missing-bucket/k'),
      bytes(1024),
    );
    onlyError(outcome, 'NOT_FOUND', '/missing-bucket/k');
    expect(outcome.finished).toBe(false);
  });
});
