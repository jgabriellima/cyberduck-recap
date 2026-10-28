/**
 * Adversarial (FEATURE-3, ATK-79): the write stream's part size holds whatever chunk sizes the
 * caller writes. The spec states the part size (16,777,216 bytes) and the one-request limit; AC-43
 * writes in 1 MiB chunks, which divide the part size. Here the chunks do not: chunks that cross a
 * part boundary, one chunk larger than two parts, one-byte chunks, and a last chunk of one byte
 * that ends exactly on the limit. Each upload stores the exact bytes in parts of exactly the
 * stated size (the last part smaller), so the documented size is the size on the wire.
 */
import { describe, expect, it } from 'vitest';
import type { RecordedRequest } from '../support/s3-server.js';
import { MIB, PART, bytes, sha256, useS3, writeAll } from '../support/s3.js';

/** The body size of each UploadPart for `key`, in part-number order. */
function partSizes(requests: readonly RecordedRequest[]): number[] {
  return [...requests]
    .sort((a, b) => Number(a.query.partNumber) - Number(b.query.partNumber))
    .map((request) => request.bodyBytes);
}

describe('ATK-79: part sizes do not follow the caller chunk sizes', () => {
  it('16 MiB + 1 written in chunks of 5 MiB + 7 is two parts: 16,777,216 and 1 bytes', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    const data = bytes(PART + 1, 3);
    const outcome = await writeAll(
      fs.createWriteStream('/b/k'),
      data,
      5 * MIB + 7,
    );
    expect(outcome.errors).toEqual([]);
    expect(outcome.finished).toBe(true);
    expect(partSizes(setup.server.requestsOf('UploadPart', 'k'))).toEqual([
      PART,
      1,
    ]);
    expect(sha256(setup.server.getObject('b', 'k') ?? Buffer.alloc(0))).toBe(
      sha256(data),
    );
  }, 30_000);

  it('40 MiB written as one chunk is three parts: two of 16,777,216 bytes and the rest', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    const data = bytes(40 * MIB, 5);
    const outcome = await writeAll(
      fs.createWriteStream('/b/k'),
      data,
      data.length,
    );
    expect(outcome.errors).toEqual([]);
    expect(outcome.finished).toBe(true);
    expect(partSizes(setup.server.requestsOf('UploadPart', 'k'))).toEqual([
      PART,
      PART,
      40 * MIB - 2 * PART,
    ]);
    expect(sha256(setup.server.getObject('b', 'k') ?? Buffer.alloc(0))).toBe(
      sha256(data),
    );
  }, 30_000);

  it('exactly 16,777,216 bytes ending in a one-byte chunk is one PutObject', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    const data = bytes(PART, 9);
    const outcome = await writeAll(
      fs.createWriteStream('/b/k'),
      data,
      PART - 1,
    );
    expect(outcome.errors).toEqual([]);
    expect(outcome.finished).toBe(true);
    expect(setup.server.requestsOf('CreateMultipartUpload')).toHaveLength(0);
    const puts = setup.server.requestsOf('PutObject', 'k');
    expect(puts.map((request) => request.bodyBytes)).toEqual([PART]);
    expect(sha256(setup.server.getObject('b', 'k') ?? Buffer.alloc(0))).toBe(
      sha256(data),
    );
  }, 30_000);

  it('1 KiB written one byte at a time is one PutObject of 1,024 bytes', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    const data = bytes(1024, 11);
    const outcome = await writeAll(fs.createWriteStream('/b/k'), data, 1);
    expect(outcome.errors).toEqual([]);
    expect(outcome.finished).toBe(true);
    const puts = setup.server.requestsOf('PutObject', 'k');
    expect(puts.map((request) => request.bodyBytes)).toEqual([1024]);
    expect(setup.server.getObject('b', 'k')).toEqual(data);
  });
});
