/**
 * ATK-94 (upload buffer copies): a Writable's caller owns its chunk again once the write
 * callback has run (Node's stream contract), and a copy loop that reads into one reused buffer
 * relies on it. The rework made the uploader keep views of the caller's chunks instead of a copy,
 * so the bytes stored must still be the bytes the caller wrote at each write, whatever the caller
 * does with its buffer after that write's callback (AC-11: a write stream stores the bytes
 * exactly).
 */
import { describe, expect, it } from 'vitest';
import type { Writable } from 'node:stream';
import { MIB, sha256, useS3 } from '../support/s3.js';

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

describe('The upload stores what was written, not what the caller later puts in its buffer', () => {
  for (const [label, size, count] of [
    ['one PutObject (2 x 1 KiB)', 1024, 2],
    ['a multipart upload (3 x 7 MiB)', 7 * MIB, 3],
  ] as const) {
    it(`${label}: one reused buffer, refilled after each write callback`, async () => {
      const setup = await useS3();
      const fs = await setup.connected();
      const key = `reuse/${String(size)}`;
      const stream = fs.createWriteStream(`/b/${key}`);
      const buffer = Buffer.alloc(size);
      const expected: Buffer[] = [];
      for (let index = 0; index < count; index += 1) {
        buffer.fill(0x41 + index);
        expected.push(Buffer.from(buffer));
        await writeOnce(stream, buffer);
      }
      // The caller reuses its buffer for something else before the end.
      buffer.fill(0x7a);
      await end(stream);
      const stored = setup.server.getObject('b', key) ?? Buffer.alloc(0);
      expect(stored.length).toBe(size * count);
      expect(sha256(stored)).toBe(sha256(Buffer.concat(expected)));
    }, 30_000);
  }
});
