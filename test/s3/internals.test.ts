/** The test seams stay out of the public API (design Option 11C, MA-11). */
import { describe, expect, it } from 'vitest';
import { setS3Internals } from '../../src/s3/internals.js';
import { MAX_PARTS } from '../../src/s3/upload.js';
import { loadIndex, useS3 } from '../support/s3.js';

describe('the S3 test seams', () => {
  it('the package index exports S3FileSystem and no seam', async () => {
    const index = await loadIndex();
    expect(typeof index.S3FileSystem).toBe('function');
    expect(index).not.toHaveProperty('setS3Internals');
    expect(index).not.toHaveProperty('internalsOf');
  });

  it('the public constructor takes one parameter', async () => {
    const index = await loadIndex();
    expect(
      (index.S3FileSystem as (...args: unknown[]) => unknown).length,
    ).toBeLessThanOrEqual(1);
  });

  it('refuses a part limit outside 1..MAX_PARTS, and any seam after connect()', async () => {
    const setup = await useS3();
    const fs = await setup.s3();
    expect(() => setS3Internals(fs, { partLimit: 0 })).toThrow(TypeError);
    expect(() => setS3Internals(fs, { partLimit: MAX_PARTS + 1 })).toThrow(
      TypeError,
    );
    expect(() => setS3Internals(fs, { partLimit: 1.5 })).toThrow(TypeError);
    setS3Internals(fs, { partLimit: 3 });
    await fs.connect();
    expect(() => setS3Internals(fs, { partLimit: 2 })).toThrow(TypeError);
  });
});
