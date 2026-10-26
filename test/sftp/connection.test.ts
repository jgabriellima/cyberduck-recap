import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { onTestFinished, describe, expect, it } from 'vitest';
import type { SftpFileSystem } from '../../src/index.js';
import {
  connectedPair,
  newFs,
  sentinel,
  tempDir,
  trustingKnownHosts,
  useServer,
} from '../support/harness.js';
import {
  expectRejects,
  expectRemoteFsError,
  expectStreamError,
  readAll,
  sha256,
  streamOutcome,
} from '../support/remote-fs-assertions.js';
import { startSilentServer, unusedPort } from '../support/sftp-server.js';

const FIVE_MIB = 5 * 1024 * 1024;
const ONE_MIB = 1024 * 1024;

function everyOperation(
  fs: SftpFileSystem,
): [string, () => Promise<unknown>][] {
  return [
    ['list', () => fs.list('/')],
    ['stat', () => fs.stat('/a')],
    ['mkdir', () => fs.mkdir('/a')],
    ['remove', () => fs.remove('/a')],
    ['rename', () => fs.rename('/a', '/b')],
    ['createReadStream', () => streamFailure(fs.createReadStream('/a'))],
    [
      'createWriteStream',
      () => {
        const stream = fs.createWriteStream('/a');
        stream.end(Buffer.from('x'));
        return streamFailure(stream);
      },
    ],
  ];
}

function streamFailure(stream: Readable | Writable): Promise<never> {
  return new Promise((_resolve, reject) => {
    stream.on('error', reject);
  });
}

describe('connection failures (AC-19)', () => {
  it('nothing listening on the port is CONNECTION_FAILED', async () => {
    const fs = newFs(
      { host: '127.0.0.1', port: await unusedPort() },
      join(await tempDir(), 'known_hosts'),
      { password: sentinel() },
    );

    await expectRejects(fs.connect(), 'CONNECTION_FAILED');
  });

  it('a peer that never sends a banner is CONNECTION_FAILED within connectTimeoutMs plus 2 s', async () => {
    const silent = await startSilentServer();
    onTestFinished(() => silent.close());
    const fs = newFs(
      { host: '127.0.0.1', port: silent.port },
      join(await tempDir(), 'known_hosts'),
      { password: sentinel(), connectTimeoutMs: 500 },
    );
    const started = Date.now();

    const error = await expectRejects(fs.connect(), 'CONNECTION_FAILED');

    expect(Date.now() - started).toBeLessThan(2500);
    expect(error.message).toMatch(/timed out/);
    expect(silent.connections()).toBe(1);
  });
});

describe('connection lost (AC-20, AC-24)', () => {
  it('AC-20: a drop during a 5 MiB download emits CONNECTION_LOST; later calls are NOT_CONNECTED; connect() works again', async () => {
    const { fixture, fs } = await connectedPair();
    const content = randomBytes(FIVE_MIB);
    await writeFile(fixture.local('/big.bin'), content);
    fixture.dropAfterBytes(ONE_MIB);

    await expectStreamError(
      fs.createReadStream('/big.bin'),
      'CONNECTION_LOST',
      {
        path: '/big.bin',
      },
    );

    await expectRejects(fs.list('/'), 'NOT_CONNECTED');
    fixture.dropAfterBytes(Number.POSITIVE_INFINITY);
    await fs.connect();
    const names = (await fs.list('/')).map((entry) => entry.name);
    expect(names).toEqual(['big.bin']);
    expect(sha256(await readAll(fs.createReadStream('/big.bin')))).toBe(
      sha256(content),
    );
  });

  it('AC-20: a list in flight when the socket closes rejects with CONNECTION_LOST', async () => {
    const { fixture, fs } = await connectedPair();
    fixture.stall();
    const before = fixture.stats.requests;

    const listing = fs.list('/');
    await fixture.waitUntil(() => fixture.stats.requests > before);
    fixture.dropAll();

    await expectRejects(listing, 'CONNECTION_LOST', { path: '/' });
    await expectRejects(fs.stat('/'), 'NOT_CONNECTED');
    fixture.resume();
    await fs.connect();
    await expect(fs.list('/')).resolves.toEqual([]);
  });

  it('AC-24: a drop during a 5 MiB upload emits CONNECTION_LOST and never finish; later calls are NOT_CONNECTED', async () => {
    const { fixture, fs } = await connectedPair();
    fixture.dropAfterBytes(ONE_MIB);
    const stream = fs.createWriteStream('/upload.bin');
    stream.end(randomBytes(FIVE_MIB));

    await expectStreamError(stream, 'CONNECTION_LOST', { path: '/upload.bin' });

    await expectRejects(fs.mkdir('/x'), 'NOT_CONNECTED');
  });

  // A caller that awaits an upload through end()'s callback must hear of the loss there too:
  // otherwise it waits forever for a file that will never be complete.
  it('AC-24: an upload awaited through end(data, callback) gets CONNECTION_LOST in the callback and never finishes', async () => {
    const { fixture, fs } = await connectedPair();
    fixture.dropAfterBytes(ONE_MIB);
    const stream = fs.createWriteStream('/upload.bin');
    let finished = false;
    stream.on('finish', () => {
      finished = true;
    });
    const emitted = new Promise<unknown>((resolve) =>
      stream.on('error', resolve),
    );

    const ended = await new Promise<unknown>((resolve) => {
      stream.end(randomBytes(FIVE_MIB), (error?: Error | null) =>
        resolve(error),
      );
    });

    expectRemoteFsError(ended, 'CONNECTION_LOST', { path: '/upload.bin' });
    expectRemoteFsError(await emitted, 'CONNECTION_LOST', {
      path: '/upload.bin',
    });
    expect(finished).toBe(false);
    await expectRejects(fs.stat('/'), 'NOT_CONNECTED');
  });
});

describe('lifecycle (AC-21)', () => {
  it('every operation before connect() is NOT_CONNECTED', async () => {
    const fixture = await useServer({ password: sentinel() });
    const fs = newFs(fixture, await trustingKnownHosts(fixture), {
      password: sentinel(),
    });

    for (const [, operation] of everyOperation(fs)) {
      await expectRejects(operation(), 'NOT_CONNECTED');
    }
    expect(fixture.stats.connections).toBe(0);
  });

  it('every operation after disconnect() is NOT_CONNECTED', async () => {
    const { fs } = await connectedPair();
    await fs.disconnect();

    for (const [, operation] of everyOperation(fs)) {
      await expectRejects(operation(), 'NOT_CONNECTED');
    }
  });

  it('disconnect() resolves when never connected and when called twice', async () => {
    const fixture = await useServer({ password: sentinel() });
    const idle = newFs(fixture, await trustingKnownHosts(fixture), {
      password: sentinel(),
    });
    await expect(idle.disconnect()).resolves.toBeUndefined();

    const { fs } = await connectedPair();
    await fs.disconnect();
    await expect(fs.disconnect()).resolves.toBeUndefined();
  });

  it('connect() while connected resolves and the server sees a single session', async () => {
    const { fixture, fs } = await connectedPair();

    await fs.connect();

    expect(fixture.stats.sessions).toBe(1);
    expect(fixture.stats.connections).toBe(1);
  });
});

describe('concurrent calls (AC-29)', () => {
  it('two connect() calls share one session', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const fs = newFs(fixture, await trustingKnownHosts(fixture), { password });

    await Promise.all([fs.connect(), fs.connect()]);

    expect(fixture.stats.sessions).toBe(1);
    expect(fixture.stats.connections).toBe(1);
  });

  it('two connect() calls with a wrong password both reject with AUTH_FAILED', async () => {
    const fixture = await useServer({ password: sentinel() });
    const fs = newFs(fixture, await trustingKnownHosts(fixture), {
      password: sentinel(),
    });

    const first = fs.connect();
    const second = fs.connect();

    await expectRejects(first, 'AUTH_FAILED');
    await expectRejects(second, 'AUTH_FAILED');
    expect(fixture.stats.connections).toBe(1);
  });

  it('disconnect() during a download and an open upload fails both streams with NOT_CONNECTED', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/big.bin'), randomBytes(FIVE_MIB));
    const download = fs.createReadStream('/big.bin');
    // Paused after its first chunk, so the download is still open when disconnect() runs.
    await new Promise((resolve) => download.once('data', resolve));
    download.pause();
    const downloadOutcome = streamOutcome(download);
    const upload = fs.createWriteStream('/upload.bin');
    const uploadOutcome = streamOutcome(upload);
    upload.write(randomBytes(64 * 1024));
    await fixture.waitUntil(() => fixture.stats.bytesTransferred > 0);

    await expect(fs.disconnect()).resolves.toBeUndefined();

    const downloaded = await downloadOutcome;
    expect(downloaded.finished).toBe(false);
    expectRemoteFsError(downloaded.error, 'NOT_CONNECTED', {
      path: '/big.bin',
    });
    const uploaded = await uploadOutcome;
    expect(uploaded.finished).toBe(false);
    expectRemoteFsError(uploaded.error, 'NOT_CONNECTED', {
      path: '/upload.bin',
    });
  });
});
