/**
 * Adversarial, third round: the liveness probe added for AC-20 (a REALPATH sent when requests are
 * outstanding and the connection has been quiet for a second) and the reworked stream teardown.
 * A hostile or merely slow server must not turn the probe into a false CONNECTION_LOST or a pile of
 * requests, and a torn-down stream must report NOT_CONNECTED to every way a caller can ask.
 */
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { describe, expect, it, onTestFinished } from 'vitest';
import { RemoteFsError } from '../../src/index.js';
import { connectedPair, newFs, sentinel, tempDir } from '../support/harness.js';
import {
  STATUS,
  startHostileServer,
  type HostileSftp,
} from '../support/hostile-sftp-server.js';
import { waitUntil } from '../support/sftp-server.js';

const MiB = 1024 * 1024;
const FILE = { mode: 0o100644, size: 3, uid: 0, gid: 0, atime: 0, mtime: 0 };

interface SlowServer {
  /** Requests received, by type. */
  readonly counts: Map<string, number>;
}

/**
 * A healthy server that is slow: STAT is answered only after `statDelayMs` (the slowness is the
 * condition under test, not a wait), REALPATH as `realpath` says, and READ from `content`.
 */
async function slowPair(options: {
  statDelayMs: number;
  realpath: 'answer' | 'never' | 'fail';
  content?: Buffer;
}) {
  const counts = new Map<string, number>();
  const content = options.content ?? Buffer.alloc(0);
  const count = (event: string): void => {
    counts.set(event, (counts.get(event) ?? 0) + 1);
  };
  const timers = new Set<NodeJS.Timeout>();
  const serve = (sftp: HostileSftp): void => {
    sftp.on('STAT', (id) => {
      count('STAT');
      const timer = setTimeout(() => {
        timers.delete(timer);
        sftp.attrs(id, FILE);
      }, options.statDelayMs);
      timers.add(timer);
    });
    sftp.on('REALPATH', (id) => {
      count('REALPATH');
      if (options.realpath === 'answer') {
        sftp.name(id, [{ filename: '/', longname: '/', attrs: {} as never }]);
      } else if (options.realpath === 'fail') {
        sftp.status(id, STATUS.FAILURE, 'no');
      }
    });
    sftp.on('OPEN', (id) => {
      count('OPEN');
      sftp.handle(id, Buffer.from([0, 0, 0, 1]));
    });
    sftp.on('READ', (id, _handle, offset, length) => {
      count('READ');
      if (offset >= content.length) sftp.status(id, STATUS.EOF, 'EOF');
      else sftp.data(id, content.subarray(offset, offset + length));
    });
    sftp.on('CLOSE', (id) => sftp.status(id, STATUS.OK, 'OK'));
  };
  const password = sentinel();
  const server = await startHostileServer({ password, serve });
  onTestFinished(async () => {
    for (const timer of timers) clearTimeout(timer);
    await server.close();
  });
  const knownHostsPath = join(await tempDir(), 'known_hosts');
  await writeFile(knownHostsPath, `${server.knownHostsLine}\n`);
  const fs = newFs(server, knownHostsPath, { password });
  await fs.connect();
  const slow: SlowServer = { counts };
  return { fs, server, slow };
}

describe('ATK-25: the liveness probe against a slow or hostile server', () => {
  it.each(['answer', 'never', 'fail'] as const)(
    'a healthy server slower than the probe interval (REALPATH: %s) is never cut off',
    async (realpath) => {
      const { fs, slow } = await slowPair({ statDelayMs: 2500, realpath });

      const entry = await fs.stat('/f');

      expect(entry.type).toBe('file');
      // About one probe per quiet second, never more.
      expect(slow.counts.get('REALPATH') ?? 0).toBeGreaterThanOrEqual(1);
      expect(slow.counts.get('REALPATH') ?? 0).toBeLessThanOrEqual(3);
      // The session is still up after the slow reply.
      expect((await fs.stat('/f')).type).toBe('file');
    },
    15_000,
  );

  it('fifty slow requests at once still get one probe per quiet second, not one per request', async () => {
    const { fs, slow } = await slowPair({
      statDelayMs: 2500,
      realpath: 'never',
    });

    const entries = await Promise.all(
      Array.from({ length: 50 }, () => fs.stat('/f')),
    );

    expect(entries.every((entry) => entry.type === 'file')).toBe(true);
    expect(slow.counts.get('REALPATH') ?? 0).toBeLessThanOrEqual(3);
  }, 15_000);

  it('an idle session is never probed', async () => {
    const { fs, slow } = await slowPair({ statDelayMs: 0, realpath: 'answer' });
    await fs.stat('/f');

    // Two round trips spaced past the probe interval by a slow one in between would probe; idle
    // time with nothing outstanding must not.
    const before = slow.counts.get('REALPATH') ?? 0;
    await fs.stat('/f');
    await fs.stat('/f');

    expect(slow.counts.get('REALPATH') ?? 0).toBe(before);
    expect(before).toBe(0);
  });
});

describe('ATK-26: backpressure under slow replies (what ATK-15 counts)', () => {
  it('a paused download sends no READ while slow requests make the session probe itself', async () => {
    const content = randomBytes(8 * MiB);
    const { fs, slow } = await slowPair({
      statDelayMs: 1500,
      realpath: 'answer',
      content,
    });
    const stream = fs.createReadStream('/big.bin');
    void finished(stream).catch(() => undefined);
    stream.on('readable', () => undefined);
    await waitUntil(
      () => stream.readableLength >= stream.readableHighWaterMark,
    );
    // In-flight reads are answered at once by this server; one quick round trip settles them.
    const readsAtFull = await settledReads(slow);

    await fs.stat('/big.bin');
    await fs.stat('/big.bin');

    // The probe adds REALPATH traffic while a reply is late; the stream asks for nothing more.
    expect(slow.counts.get('REALPATH') ?? 0).toBeGreaterThanOrEqual(1);
    expect(slow.counts.get('READ')).toBe(readsAtFull);
    stream.destroy();
  }, 15_000);
});

async function settledReads(slow: SlowServer): Promise<number> {
  let previous = -1;
  await waitUntil(() => {
    const now = slow.counts.get('READ') ?? 0;
    const stable = now === previous;
    previous = now;
    return stable;
  });
  return previous;
}

describe('ATK-27: every way a caller can learn a stream was torn down', () => {
  it('a listener attached after disconnect() resolved still learns the outcome through errored/finished()', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/d.bin'), randomBytes(4 * MiB));
    const read = fs.createReadStream('/d.bin');
    read.on('readable', () => undefined);
    // Swallow the next-tick error so the late observers below are what is under test.
    read.on('error', () => undefined);
    const write = fs.createWriteStream('/w.bin');
    write.on('error', () => undefined);
    write.write(randomBytes(MiB));
    await fixture.waitUntil(() => fixture.stats.bytesTransferred > 0);

    await fs.disconnect();
    await new Promise((resolve) => setImmediate(resolve));

    for (const stream of [read, write]) {
      expect(stream.destroyed).toBe(true);
      expect(stream.errored).toBeInstanceOf(RemoteFsError);
      expect((stream.errored as RemoteFsError).code).toBe('NOT_CONNECTED');
      const late = await finished(stream).then(
        () => 'finished',
        (error: unknown) => error,
      );
      expect((late as RemoteFsError).code).toBe('NOT_CONNECTED');
    }
    expect(write.writableFinished).toBe(false);
  });

  it('end(callback) called after the teardown is still answered with an error', async () => {
    const { fixture, fs } = await connectedPair();
    const write = fs.createWriteStream('/w.bin');
    write.on('error', () => undefined);
    write.write(randomBytes(MiB));
    await fixture.waitUntil(() => fixture.stats.bytesTransferred > 0);
    await fs.disconnect();

    const answer = await new Promise<unknown>((resolve) =>
      write.end((error?: Error | null) => resolve(error ?? 'ok')),
    );

    expect(answer).toBeInstanceOf(Error);
    expect(write.writableFinished).toBe(false);
  });

  it('a stream the caller destroyed first reports the caller’s error once, not a second teardown error', async () => {
    const { fixture, fs } = await connectedPair();
    const write = fs.createWriteStream('/w.bin');
    const errors: unknown[] = [];
    write.on('error', (error) => errors.push(error));
    write.write(randomBytes(MiB));
    await fixture.waitUntil(() => fixture.stats.bytesTransferred > 0);
    const mine = new Error('caller cancelled');

    write.destroy(mine);
    await fs.disconnect();
    await new Promise((resolve) => setImmediate(resolve));

    expect(errors).toEqual([mine]);
  });

  it('an upload parked on a full window and destroyed without an error never finishes and answers end(cb)', async () => {
    const { fixture, fs } = await connectedPair();
    const write = fs.createWriteStream('/parked.bin');
    let finishedEvent = false;
    write.on('finish', () => {
      finishedEvent = true;
    });
    write.on('error', () => undefined);
    // Once the file is open, a stalled server acknowledges nothing: the window fills and the
    // next chunk waits for room.
    write.write(randomBytes(32 * 1024));
    await fixture.waitUntil(() => fixture.stats.bytesTransferred > 0);
    fixture.stall();
    const writesBefore = fixture.stats.requestsByType['WRITE'] ?? 0;
    const answered = new Promise<unknown>((resolve) =>
      write.end(randomBytes(2 * MiB), (error?: Error | null) =>
        resolve(error ?? 'ok'),
      ),
    );
    await fixture.waitUntil(
      () => (fixture.stats.requestsByType['WRITE'] ?? 0) >= writesBefore + 16,
    );

    write.destroy();
    const answer = await answered;

    expect(answer).toBeInstanceOf(Error);
    expect(finishedEvent).toBe(false);
    fixture.resume();
  });
});
