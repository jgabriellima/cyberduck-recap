/**
 * Adversarial: transfers that fail halfway, consumers that stop reading, and callers that tear the
 * session down at the worst moment. An upload may only `finish` when the server has every byte; a
 * download may only `end` with every byte; nothing may hang or buffer without bound.
 */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { connectedPair, newFs, sentinel, tempDir } from '../support/harness.js';
import { STATUS, startHostileServer } from '../support/hostile-sftp-server.js';
import {
  expectRejects,
  expectStreamError,
  readAll,
  sha256,
  streamOutcome,
} from '../support/remote-fs-assertions.js';

const MiB = 1024 * 1024;

describe('ATK-14: an upload refused halfway never reports success', () => {
  it('a path denied mid-upload errors with PERMISSION_DENIED and never finishes', async () => {
    const { fixture, fs } = await connectedPair();
    const stream = fs.createWriteStream('/up.bin');
    const outcome = streamOutcome(stream);
    stream.write(randomBytes(256 * 1024));
    await fixture.waitUntil(() => fixture.stats.bytesTransferred > 0);

    fixture.deny('/up.bin');
    stream.end(randomBytes(2 * MiB));
    const { error, finished } = await outcome;

    expect(finished).toBe(false);
    expect(error).toMatchObject({ code: 'PERMISSION_DENIED', path: '/up.bin' });
  });

  it('a server that acknowledges every write but fails CLOSE never lets the upload finish', async () => {
    const password = sentinel();
    let closes = 0;
    const server = await startHostileServer({
      password,
      serve: (sftp) => {
        sftp.on('OPEN', (id) => sftp.handle(id, Buffer.from([1])));
        sftp.on('WRITE', (id) => sftp.status(id, STATUS.OK, 'OK'));
        sftp.on('CLOSE', (id) => {
          closes += 1;
          sftp.status(id, STATUS.FAILURE, 'disk full on close');
        });
      },
    });
    onTestFinished(() => server.close());
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    await writeFile(knownHostsPath, `${server.knownHostsLine}\n`);
    const fs = newFs(server, knownHostsPath, { password });
    await fs.connect();

    const stream = fs.createWriteStream('/f');
    const outcome = streamOutcome(stream);
    stream.end(randomBytes(MiB));
    const { error, finished } = await outcome;

    expect(closes).toBe(1);
    expect(finished).toBe(false);
    expect(error).toMatchObject({ code: 'OPERATION_FAILED', path: '/f' });
  });

  it('a write to a path the server denies from the start leaves no finish and a typed error', async () => {
    const { fixture, fs } = await connectedPair();
    fixture.deny('/no.bin');

    await expectStreamError(
      writeAndEnd(fs.createWriteStream('/no.bin')),
      'PERMISSION_DENIED',
      { path: '/no.bin' },
    );
  });
});

function writeAndEnd<T extends NodeJS.WritableStream>(stream: T): T {
  stream.end(randomBytes(64 * 1024));
  return stream;
}

describe('ATK-15: a consumer that stops reading', () => {
  it('a paused 8 MiB download stops requesting at the window plus the buffer, not the file size', async () => {
    const { fixture, fs } = await connectedPair();
    const content = randomBytes(8 * MiB);
    await writeFile(fixture.local('/big.bin'), content);

    const stream = fs.createReadStream('/big.bin');
    // Observed from creation, so an error during cleanup never goes unhandled.
    void streamOutcome(stream);
    stream.pause();
    // Nothing consumes: the stream fills its buffer and must then stop asking the server.
    stream.on('readable', () => undefined);
    await fixture.waitUntil(
      () => stream.readableLength >= stream.readableHighWaterMark,
    );
    // Round trips on the same channel: reads the stream had in flight are answered by now.
    for (let i = 0; i < 3; i += 1) await fs.stat('/big.bin');
    const readsSettled = fixture.stats.requestsByType['READ'] ?? 0;
    for (let i = 0; i < 3; i += 1) await fs.stat('/big.bin');

    // Only READs measure the attack: the session's liveness probe (a REALPATH when a reply is late
    // under load) is other traffic on the same channel, not the stream asking for data.
    expect(fixture.stats.requestsByType['READ'] ?? 0).toBe(readsSettled);
    // A full buffer plus at most one window of 16 × 32 KiB answered behind it, twice over at most.
    expect(fixture.stats.bytesTransferred).toBeLessThanOrEqual(
      2 * (stream.readableHighWaterMark + 16 * 32 * 1024),
    );

    stream.removeAllListeners('readable');
    const data = await readAll(stream);
    expect(sha256(data)).toBe(sha256(content));
  });
});

describe('ATK-16: tearing the session down at the worst moment', () => {
  it('disconnect() before the upload has even opened its handle fails it with NOT_CONNECTED, no finish', async () => {
    const { fixture, fs } = await connectedPair();
    const stream = fs.createWriteStream('/early.bin');
    const outcome = streamOutcome(stream);
    stream.end(randomBytes(MiB));

    await fs.disconnect();
    const { error, finished } = await outcome;

    expect(finished).toBe(false);
    expect(error).toMatchObject({ code: 'NOT_CONNECTED' });
    // Whatever reached the server before the cut is not a complete file reported as done.
    const local = await readFile(fixture.local('/early.bin')).catch(() =>
      Buffer.alloc(0),
    );
    expect(local.length).toBeLessThan(MiB);
  });

  it('disconnect() before a download has opened its handle fails it with NOT_CONNECTED, no end', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/d.bin'), randomBytes(MiB));
    const stream = fs.createReadStream('/d.bin');

    const disconnecting = fs.disconnect();
    await expectStreamError(stream, 'NOT_CONNECTED', { path: '/d.bin' });
    await disconnecting;
  });

  it('connect, disconnect, connect without awaiting ends connected with one live session', async () => {
    const { fixture, fs } = await connectedPair();
    await fs.disconnect();

    const first = fs.connect();
    const second = fs.disconnect();
    const third = fs.connect();
    await Promise.allSettled([first, second]);
    await third;

    await writeFile(fixture.local('/x'), 'x');
    expect((await fs.stat('/x')).size).toBe(1);
  });

  it('operations racing a dropped socket all settle with CONNECTION_LOST or NOT_CONNECTED', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/f'), 'f');
    const calls = Array.from({ length: 50 }, (_, i) =>
      i % 2 === 0 ? fs.stat('/f') : fs.list('/'),
    );
    const settled = Promise.allSettled(calls);

    fixture.dropAll();
    const results = await settled;
    const late = await Promise.allSettled([fs.stat('/f'), fs.list('/')]);

    for (const result of results) {
      if (result.status === 'rejected') {
        expect(['CONNECTION_LOST', 'NOT_CONNECTED']).toContain(
          (result.reason as { code?: unknown }).code,
        );
      }
    }
    for (const result of late) {
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason).toMatchObject({
        code: 'NOT_CONNECTED',
      });
    }
    await expectRejects(fs.mkdir('/m'), 'NOT_CONNECTED');
  });
});
