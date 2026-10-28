/**
 * No request waits for a socket (design SC-3, Option 10B): 20 read streams that hold their
 * connections open, paused by their consumers, block neither a `stat`, a `list` nor a write, and
 * `disconnect()` during an upload still sends the abort and settles. Under the first record's
 * agent (`maxSockets: 16`) the 17th request waited for a socket with no bound.
 */
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MIB, bytes, useS3, writeAll } from '../support/s3.js';

const TIMEOUT_MS = 1000;
const SLACK_MS = 2000;
const READERS = 20;

/** Settles `promise` and returns how long it took, in milliseconds. */
async function timed(promise: Promise<unknown>): Promise<number> {
  const started = performance.now();
  await promise;
  return performance.now() - started;
}

/** Read streams that each received data and then stopped: their consumers never read on. */
async function pausedReaders(
  open: () => Readable,
  count: number,
): Promise<Readable[]> {
  const streams = Array.from({ length: count }, open);
  for (const stream of streams) {
    // An ended instance fails the paused streams; the test does not read their outcome.
    stream.on('error', () => undefined);
  }
  await Promise.all(streams.map((stream) => once(stream, 'readable')));
  return streams;
}

describe('A saturated pool of open reads blocks no other request (SC-3)', () => {
  it(`stat, list and a 1 KiB write each settle within timeoutMs + ${SLACK_MS} ms beside ${READERS} paused reads`, async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'big', bytes(20 * MIB));
    const fs = await setup.connected({ timeoutMs: TIMEOUT_MS });
    const readers = await pausedReaders(
      () => fs.createReadStream('/b/big'),
      READERS,
    );
    expect(setup.server.requestsOf('GetObject')).toHaveLength(READERS);

    expect(await timed(fs.stat('/b/big'))).toBeLessThan(TIMEOUT_MS + SLACK_MS);
    expect(await timed(fs.list('/b'))).toBeLessThan(TIMEOUT_MS + SLACK_MS);
    const write = writeAll(fs.createWriteStream('/b/small'), bytes(1024));
    expect(await timed(write)).toBeLessThan(TIMEOUT_MS + SLACK_MS);
    expect((await write).errors).toEqual([]);
    expect(setup.server.getObject('b', 'small')).toEqual(bytes(1024));

    for (const reader of readers) reader.destroy();
  }, 30_000);

  it(`disconnect() during a 20 MiB upload sends the abort and resolves within 3 x timeoutMs + ${SLACK_MS} ms`, async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'big', bytes(20 * MIB));
    const fs = await setup.connected({ timeoutMs: TIMEOUT_MS });
    await pausedReaders(() => fs.createReadStream('/b/big'), READERS);
    // The part never gets a reply: the upload is in progress when disconnect() comes.
    setup.server.fault((request) =>
      request.operation === 'UploadPart' ? { kind: 'stall' } : undefined,
    );
    const upload = writeAll(fs.createWriteStream('/b/up'), bytes(20 * MIB));
    await setup.server.waitForRequest((r) => r.operation === 'UploadPart');

    const elapsed = await timed(fs.disconnect());

    expect(elapsed).toBeLessThan(3 * TIMEOUT_MS + SLACK_MS);
    expect(setup.server.requestsOf('AbortMultipartUpload')).toHaveLength(1);
    expect((await upload).errors).toHaveLength(1);
    expect(setup.server.hasObject('b', 'up')).toBe(false);
  }, 30_000);
});
