/**
 * ATK-96 (upload buffer copies): the rework copies each chunk into a part the uploader owns,
 * whose first capacity (64 KiB) doubles up to the part size, and cuts a chunk where a part ends.
 * Those are new edges: a part that grows while bytes are in it, a chunk that crosses one or more
 * part ends, a part that is exactly full when the next byte comes. At each of them the caller
 * reuses its buffer once the write callback has run (Node's Writable contract), so the stored
 * object must still be the bytes written at each write (AC-11: a write stream stores the bytes
 * exactly), and a write after the end must be refused, not stored.
 */
import { describe, expect, it } from 'vitest';
import type { Writable } from 'node:stream';
import { MIB, sha256, useS3 } from '../support/s3.js';

const PART = 16 * MIB;

function writeOnce(stream: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

function end(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(() => resolve());
  });
}

/** Fills `buffer` with a pattern that differs per write and per byte position. */
function pattern(buffer: Buffer, write: number): void {
  for (let index = 0; index < buffer.length; index += 1) {
    buffer[index] = (write * 31 + index * 7) & 0xff;
  }
}

describe('The uploader-owned parts store what was written at each write', () => {
  const cases: readonly (readonly [string, readonly number[]])[] = [
    // 70 KiB in 1000-byte writes: the first part grows past 64 KiB while bytes are in it.
    ['many small writes across the first growth', Array<number>(70).fill(1000)],
    // One write larger than two parts: one chunk is cut at two part ends.
    ['one write over two part ends', [2 * PART + 12_345]],
    // A part exactly full, then one byte: the full part leaves only when that byte arrives.
    ['a part exactly full, then one byte', [PART, 1]],
    // Writes that each end inside a part and the next one crosses the end.
    ['writes that straddle the part ends', [10 * MIB, 10 * MIB, 10 * MIB, 3]],
  ];
  for (const [label, sizes] of cases) {
    it(`${label}: one reused buffer, refilled after each write callback`, async () => {
      const setup = await useS3();
      const fs = await setup.connected();
      const key = `owned/${label.replaceAll(' ', '-')}`;
      const stream = fs.createWriteStream(`/b/${key}`);
      const largest = Math.max(...sizes);
      const buffer = Buffer.alloc(largest);
      const expected: Buffer[] = [];
      for (const [write, size] of sizes.entries()) {
        const chunk = buffer.subarray(0, size);
        pattern(chunk, write);
        expected.push(Buffer.from(chunk));
        await writeOnce(stream, chunk);
        // The caller owns its buffer again: it overwrites it at once.
        buffer.fill(0x7a);
      }
      await end(stream);
      const stored = setup.server.getObject('b', key) ?? Buffer.alloc(0);
      const total = sizes.reduce((sum, size) => sum + size, 0);
      expect(stored.length).toBe(total);
      expect(sha256(stored)).toBe(sha256(Buffer.concat(expected)));
    }, 60_000);
  }

  it('a write after end is refused and the stored object keeps only the bytes before it', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    const stream = fs.createWriteStream('/b/owned/after-end');
    const buffer = Buffer.alloc(4096, 0x41);
    await writeOnce(stream, buffer);
    await end(stream);
    const refused = await new Promise<unknown>((resolve) => {
      stream.once('error', resolve);
      stream.write(Buffer.alloc(4096, 0x42), (error) => {
        if (error) resolve(error);
      });
    });
    expect(refused).toBeInstanceOf(Error);
    const stored =
      setup.server.getObject('b', 'owned/after-end') ?? Buffer.alloc(0);
    expect(sha256(stored)).toBe(sha256(Buffer.alloc(4096, 0x41)));
  }, 30_000);
});
