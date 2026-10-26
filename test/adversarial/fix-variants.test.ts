/**
 * Adversarial, second round: variants of the defects fixed after the first round (ATK-11, ATK-20,
 * ATK-21) that the fixes might miss — other malformed replies, other connect/disconnect
 * interleavings, and streams torn down while their caller is not yet (or only just) listening.
 */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { RemoteFsError, type SftpFileSystem } from '../../src/index.js';
import {
  connectedPair,
  newFs,
  sentinel,
  tempDir,
  useServer,
} from '../support/harness.js';
import {
  STATUS,
  startHostileServer,
  type HostileSftp,
} from '../support/hostile-sftp-server.js';
import { waitUntil } from '../support/sftp-server.js';

const FILE = { mode: 0o100644, size: 3, uid: 0, gid: 0, atime: 0, mtime: 0 };
const DIR = { ...FILE, mode: 0o040755 };

type Sabotage = 'bare-ok' | 'attrs' | 'handle';

/**
 * A small well-behaved server (`/f` a file, `/d` a directory) whose next reply to a chosen request
 * type can be sabotaged once: a bare OK status, an ATTRS reply, or a HANDLE reply.
 */
function scriptedServer(
  sabotage: Map<string, Sabotage>,
  counts: Map<string, number>,
) {
  return (sftp: HostileSftp): void => {
    const answer = (event: string, id: number, normal: () => void): void => {
      counts.set(event, (counts.get(event) ?? 0) + 1);
      const how = sabotage.get(event);
      if (how === undefined) {
        normal();
        return;
      }
      sabotage.delete(event);
      if (how === 'bare-ok') sftp.status(id, STATUS.OK, 'OK');
      else if (how === 'attrs') sftp.attrs(id, FILE);
      else sftp.handle(id, Buffer.from([9, 9, 9, 9]));
    };
    const attrsOf = (id: number, path: string): void => {
      if (path === '/f') sftp.attrs(id, FILE);
      else if (path === '/d' || path === '/') sftp.attrs(id, DIR);
      else sftp.status(id, STATUS.NO_SUCH_FILE, 'No such file');
    };
    let listed = false;
    sftp.on('STAT', (id, path) => answer('STAT', id, () => attrsOf(id, path)));
    sftp.on('LSTAT', (id, path) =>
      answer('LSTAT', id, () => attrsOf(id, path)),
    );
    sftp.on('OPENDIR', (id) =>
      answer('OPENDIR', id, () => {
        listed = false;
        sftp.handle(id, Buffer.from([0, 0, 0, 2]));
      }),
    );
    sftp.on('READDIR', (id) =>
      answer('READDIR', id, () => {
        if (listed) {
          sftp.status(id, STATUS.EOF, 'EOF');
          return;
        }
        listed = true;
        sftp.name(id, [{ filename: 'f', longname: 'f', attrs: FILE }]);
      }),
    );
    sftp.on('OPEN', (id) =>
      answer('OPEN', id, () => sftp.handle(id, Buffer.from([0, 0, 0, 1]))),
    );
    sftp.on('READ', (id) =>
      answer('READ', id, () => sftp.status(id, STATUS.EOF, 'EOF')),
    );
    for (const event of [
      'WRITE',
      'CLOSE',
      'MKDIR',
      'RMDIR',
      'REMOVE',
      'RENAME',
    ] as const) {
      sftp.on(event, (id: number) =>
        answer(event, id, () => sftp.status(id, STATUS.OK, 'OK')),
      );
    }
  };
}

async function scriptedPair() {
  const sabotage = new Map<string, Sabotage>();
  const counts = new Map<string, number>();
  const password = sentinel();
  const server = await startHostileServer({
    password,
    serve: scriptedServer(sabotage, counts),
  });
  onTestFinished(() => server.close());
  const knownHostsPath = join(await tempDir(), 'known_hosts');
  await writeFile(knownHostsPath, `${server.knownHostsLine}\n`);
  const fs = newFs(server, knownHostsPath, { password });
  await fs.connect();
  return { server, fs, sabotage, counts, knownHostsPath, password };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function streamFailure(
  stream: NodeJS.ReadableStream | NodeJS.WritableStream,
): Promise<unknown> {
  return new Promise((resolve) => {
    stream.on('error', resolve);
    stream.on('finish', () => resolve('finished'));
    stream.on('end', () => resolve('ended'));
  });
}

describe('ATK-22: malformed replies to every request that must carry a value', () => {
  const cases: [
    string,
    string,
    Sabotage,
    (fs: SftpFileSystem) => Promise<unknown>,
  ][] = [
    ['remove, LSTAT bare OK', 'LSTAT', 'bare-ok', (fs) => fs.remove('/f')],
    [
      'rename, target LSTAT bare OK',
      'LSTAT',
      'bare-ok',
      (fs) => fs.rename('/f', '/g'),
    ],
    [
      'recursive mkdir, STAT bare OK',
      'STAT',
      'bare-ok',
      (fs) => fs.mkdir('/d/x', { recursive: true }),
    ],
    ['list, OPENDIR bare OK', 'OPENDIR', 'bare-ok', (fs) => fs.list('/d')],
    [
      'list, OPENDIR answered with ATTRS',
      'OPENDIR',
      'attrs',
      (fs) => fs.list('/d'),
    ],
    [
      'list, READDIR answered with ATTRS',
      'READDIR',
      'attrs',
      (fs) => fs.list('/d'),
    ],
    [
      'list, READDIR answered with a HANDLE',
      'READDIR',
      'handle',
      (fs) => fs.list('/d'),
    ],
    ['stat, STAT bare OK', 'STAT', 'bare-ok', (fs) => fs.stat('/f')],
    [
      'read stream, OPEN answered with ATTRS',
      'OPEN',
      'attrs',
      (fs) => streamFailure(fs.createReadStream('/f').resume()),
    ],
    [
      'write stream, OPEN bare OK',
      'OPEN',
      'bare-ok',
      (fs) => streamFailure(writeEnd(fs.createWriteStream('/w'))),
    ],
    [
      'write stream, OPEN answered with ATTRS',
      'OPEN',
      'attrs',
      (fs) => streamFailure(writeEnd(fs.createWriteStream('/w'))),
    ],
  ];

  it.each(cases)(
    '%s fails with a typed error and leaves the session usable',
    async (_label, event, how, run) => {
      const { fs, sabotage, counts } = await scriptedPair();
      sabotage.set(event, how);

      const outcome = await run(fs).then(
        (value) => value,
        (error: unknown) => error,
      );

      expect(outcome).toBeInstanceOf(RemoteFsError);
      expect((outcome as RemoteFsError).code).toBe('OPERATION_FAILED');
      // A malformed reply is the server's fault, not a lost connection.
      expect((await fs.stat('/f')).type).toBe('file');
      // rename never goes ahead on a target it could not check: no-overwrite holds.
      expect(counts.get('RENAME') ?? 0).toBe(0);
    },
  );
});

function writeEnd(stream: NodeJS.WritableStream): NodeJS.WritableStream {
  stream.end(randomBytes(70_000));
  return stream;
}

describe('ATK-23: connect/disconnect interleavings', () => {
  it('connect, disconnect, connect, disconnect, connect leaves one live session and no leaked one', async () => {
    const { server, fs } = await scriptedPair();
    await fs.disconnect();
    await waitUntil(() => server.liveConnections() === 0);

    const calls = [
      fs.connect(),
      fs.disconnect(),
      fs.connect(),
      fs.disconnect(),
      fs.connect(),
    ];
    const last = calls.pop() as Promise<void>;
    await Promise.allSettled(calls);
    await last;

    expect((await fs.stat('/f')).type).toBe('file');
    // Abandoned attempts that completed their handshake must close their own sessions.
    await waitUntil(() => server.liveConnections() === 1);
  });

  it('disconnect and connect again while connected replaces the session; the old one closes', async () => {
    const { server, fs } = await scriptedPair();

    const disconnecting = fs.disconnect();
    const reconnecting = fs.connect();
    await disconnecting;
    await reconnecting;

    expect((await fs.stat('/f')).type).toBe('file');
    await waitUntil(() => server.liveConnections() === 1);
  });

  it('a stream of the old session fails NOT_CONNECTED and does not disturb the new session', async () => {
    const { fs } = await scriptedPair();
    const old = fs.createWriteStream('/w');
    const oldOutcome = streamFailure(old);
    old.write(randomBytes(10));

    const disconnecting = fs.disconnect();
    const reconnecting = fs.connect();
    await Promise.all([disconnecting, reconnecting]);

    const outcome = await oldOutcome;
    expect(outcome).toBeInstanceOf(RemoteFsError);
    expect((outcome as RemoteFsError).code).toBe('NOT_CONNECTED');
    expect((await fs.list('/d')).map((entry) => entry.name)).toEqual(['f']);
  });

  it('reconnecting while an abandoned confirmation is pending: the late answer records nothing', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    const answers: ((value: boolean) => void)[] = [];
    let asked = 0;
    const fs = newFs(fixture, knownHostsPath, {
      password,
      confirmHostKey: () =>
        new Promise<boolean>((resolve) => {
          asked += 1;
          answers.push(resolve);
        }),
    });

    const first = failure(fs.connect());
    await waitUntil(() => asked === 1);
    const disconnecting = fs.disconnect();
    const second = fs.connect();
    await disconnecting;
    await waitUntil(() => asked === 2);
    answers[1]?.(true);
    await second;
    answers[0]?.(true);

    expect(await first).toBeInstanceOf(RemoteFsError);
    expect(await readFile(knownHostsPath, 'utf8')).toBe(
      `${fixture.knownHostsLine}\n`,
    );
    expect(fixture.stats.sessions).toBe(1);
  });
});

describe('ATK-24: streams torn down while the caller is only just listening', () => {
  it('an upload awaited through end(data, callback) is told it failed: the callback gets NOT_CONNECTED', async () => {
    const { fixture, fs } = await connectedPair();
    const stream = fs.createWriteStream('/up.bin');
    let errorEvent: unknown;
    const ended = new Promise<unknown>((resolve) => {
      stream.end(randomBytes(6 * 1024 * 1024), (error?: Error | null) =>
        resolve(error ?? 'ok'),
      );
    });
    await fixture.waitUntil(() => fixture.stats.bytesTransferred > 0);
    expect(stream.writableFinished).toBe(false);

    const disconnecting = fs.disconnect();
    // The caller attaches its error handler in the same tick, after calling disconnect().
    stream.on('error', (error) => {
      errorEvent = error;
    });
    await disconnecting;
    const result = await ended;

    expect(result).toBeInstanceOf(RemoteFsError);
    expect((result as RemoteFsError).code).toBe('NOT_CONNECTED');
    expect(errorEvent).toBeInstanceOf(RemoteFsError);
    expect(stream.writableFinished).toBe(false);
  });

  it('a download whose error handler is attached right after disconnect() receives NOT_CONNECTED', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/d.bin'), randomBytes(4 * 1024 * 1024));
    const stream = fs.createReadStream('/d.bin');
    let ended = false;
    // Nobody reads: the stream fills its buffer and stays open, so it cannot end before the cut.
    stream.on('readable', () => undefined);
    stream.on('end', () => {
      ended = true;
    });
    await fixture.waitUntil(() => fixture.stats.bytesTransferred > 0);

    const disconnecting = fs.disconnect();
    const errored = new Promise<unknown>((resolve) =>
      stream.on('error', resolve),
    );
    await disconnecting;

    const error = await errored;
    expect(error).toBeInstanceOf(RemoteFsError);
    expect((error as RemoteFsError).code).toBe('NOT_CONNECTED');
    expect(ended).toBe(false);
  });
});
