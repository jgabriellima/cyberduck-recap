import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { inspect } from 'node:util';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import { RemoteFsError, SftpFileSystem } from '../../src/index.js';
import {
  newFs,
  sentinel,
  tempDir,
  trustingKnownHosts,
  useServer,
} from '../support/harness.js';
import {
  generateKey,
  startSilentServer,
  unusedPort,
  type SftpServerFixture,
} from '../support/sftp-server.js';

// Random per run: no credential is ever written in the source (S-6).
const password = sentinel();
const passphrase = sentinel();
const encryptedKey = generateKey(passphrase);
const plainKey = generateKey();
const unparseableKey = `/var/keys/id-${sentinel()}`;
const SECRETS = [
  password,
  passphrase,
  encryptedKey.privateKey,
  plainKey.privateKey,
  unparseableKey,
];

function leaks(text: string): string | undefined {
  for (const secret of SECRETS) {
    for (let i = 0; i + 16 <= secret.length; i += 1) {
      const piece = secret.slice(i, i + 16);
      if (text.includes(piece)) return piece;
    }
  }
  return undefined;
}

function expectNoSecrets(label: string, error: unknown): void {
  expect(error, `${label}: an error was produced`).toBeInstanceOf(
    RemoteFsError,
  );
  const typed = error as RemoteFsError;
  const renderings = {
    inspect: inspect(typed, { depth: Infinity }),
    json: JSON.stringify(typed),
    message: typed.message,
    stack: typed.stack ?? '',
  };
  for (const [how, text] of Object.entries(renderings)) {
    expect(leaks(text), `${label} (${how})`).toBeUndefined();
  }
}

function expectInstanceClean(label: string, fs: SftpFileSystem): void {
  expect(
    leaks(inspect(fs, { depth: Infinity })),
    `${label} inspect`,
  ).toBeUndefined();
  expect(leaks(JSON.stringify(fs)), `${label} JSON`).toBeUndefined();
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function streamError(stream: Readable | Writable): Promise<unknown> {
  return new Promise((resolve) => {
    stream.on('error', resolve);
    if ('resume' in stream) stream.resume();
  });
}

async function knownHostsFor(fixture: SftpServerFixture): Promise<string> {
  return trustingKnownHosts(fixture);
}

describe('no secret leaks (AC-22)', () => {
  let spies: { name: string; spy: { mock: { calls: unknown[] } } }[] = [];

  beforeEach(() => {
    spies = [
      { name: 'stdout', spy: vi.spyOn(process.stdout, 'write') },
      { name: 'stderr', spy: vi.spyOn(process.stderr, 'write') },
      ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(
        (method) => ({
          name: `console.${method}`,
          spy: vi.spyOn(console, method),
        }),
      ),
    ];
  });

  afterEach(() => {
    // The library writes nothing anywhere: errors are its only output.
    for (const { name, spy } of spies) {
      expect(spy.mock.calls, name).toEqual([]);
    }
    vi.restoreAllMocks();
  });

  it('authentication and key errors (AC-5, AC-26)', async () => {
    const fixture = await useServer({
      password: sentinel(),
      authorizedKeys: [generateKey()],
    });
    const knownHostsPath = await knownHostsFor(fixture);
    const cases: [string, Record<string, unknown>][] = [
      ['wrong password', { password }],
      ['rejected key', { privateKey: plainKey.privateKey }],
      [
        'rejected encrypted key',
        { privateKey: encryptedKey.privateKey, passphrase },
      ],
      [
        'wrong passphrase',
        { privateKey: generateKey(sentinel()).privateKey, passphrase },
      ],
      ['missing passphrase', { privateKey: encryptedKey.privateKey }],
      ['unparseable key', { privateKey: unparseableKey }],
    ];
    for (const [label, overrides] of cases) {
      const fs = newFs(fixture, knownHostsPath, overrides);
      expectInstanceClean(`${label} before connect`, fs);
      const error = await rejection(fs.connect());
      expectNoSecrets(label, error);
      expect((error as RemoteFsError).code).toBe('AUTH_FAILED');
      expectInstanceClean(`${label} after failure`, fs);
    }
  });

  it('host-key and connection errors (AC-14 to AC-17, AC-19, AC-27, AC-28)', async () => {
    const fixture = await useServer({ password });
    const dir = await tempDir();
    const changedPath = join(dir, 'changed');
    await writeFile(
      changedPath,
      `[127.0.0.1]:${fixture.port} ${generateKey().publicKey}\n`,
    );
    const unreadablePath = join(dir, 'unreadable');
    await mkdir(unreadablePath);
    const silent = await startSilentServer();
    onTestFinished(() => silent.close());

    const errors: [string, unknown][] = [];
    const attempt = async (
      label: string,
      target: { host: string; port: number },
      knownHostsPath: string,
      overrides: Record<string, unknown> = {},
    ): Promise<void> => {
      const fs = newFs(target, knownHostsPath, { password, ...overrides });
      errors.push([label, await rejection(fs.connect())]);
      expectInstanceClean(label, fs);
    };

    await attempt('unknown key', fixture, join(dir, 'absent'));
    await attempt('unknown key refused', fixture, join(dir, 'absent'), {
      confirmHostKey: () => Promise.resolve(false),
    });
    await attempt('changed key', fixture, changedPath, {
      privateKey: encryptedKey.privateKey,
      passphrase,
      password: undefined,
    });
    await attempt('unreadable known_hosts', fixture, unreadablePath);
    await attempt(
      'unwritable known_hosts',
      fixture,
      join(dir, 'missing', 'kh'),
      {
        confirmHostKey: () => Promise.resolve(true),
      },
    );
    await attempt(
      'refused',
      { host: '127.0.0.1', port: await unusedPort() },
      join(dir, 'x'),
    );
    await attempt(
      'timeout',
      { host: '127.0.0.1', port: silent.port },
      join(dir, 'x'),
      {
        connectTimeoutMs: 200,
      },
    );

    let asked = false;
    const closing = newFs(fixture, join(dir, 'pending'), {
      password,
      confirmHostKey: () =>
        new Promise<boolean>(() => {
          asked = true;
        }),
    });
    const pending = rejection(closing.connect());
    await fixture.waitUntil(() => asked);
    fixture.dropAll();
    errors.push(['closed during confirmation', await pending]);

    for (const [label, error] of errors) expectNoSecrets(label, error);
  });

  it('option errors (AC-17, AC-25)', () => {
    const base = {
      host: '127.0.0.1',
      username: 'tester',
      knownHostsPath: '/tmp/kh',
    };
    const cases: Record<string, unknown>[] = [
      { ...base, password, privateKey: plainKey.privateKey },
      { ...base, password, passphrase },
      { ...base, password, port: '22' },
      { ...base, password, hostVerifier: password },
      {
        ...base,
        privateKey: encryptedKey.privateKey,
        passphrase,
        connectTimeoutMs: -1,
      },
      { ...base, password, host: `${password}/not-a-host` },
      { ...base, password, username: 7 },
    ];
    for (const options of cases) {
      let thrown: unknown;
      try {
        new SftpFileSystem(options as never);
      } catch (error) {
        thrown = error;
      }
      expectNoSecrets('options', thrown);
    }
  });

  it('operation, stream and lifecycle errors, and the instance through its life (AC-6 to AC-13, AC-20, AC-21, AC-24, AC-29, AC-30)', async () => {
    const fixture = await useServer({ authorizedKeys: [encryptedKey] });
    const fs = newFs(fixture, await knownHostsFor(fixture), {
      privateKey: encryptedKey.privateKey,
      passphrase,
    });
    const errors: [string, unknown][] = [];
    errors.push(['before connect', await rejection(fs.list('/'))]);
    expectInstanceClean('before connect', fs);

    await fs.connect();
    expectInstanceClean('connected', fs);
    await mkdir(fixture.local('/dir'));
    await writeFile(fixture.local('/dir/a'), 'x');
    await writeFile(fixture.local('/file'), 'x');
    await writeFile(fixture.local('/big'), randomBytes(2 * 1024 * 1024));
    fixture.deny('/denied');

    errors.push(['NOT_FOUND', await rejection(fs.stat('/missing'))]);
    errors.push(['NOT_A_DIRECTORY', await rejection(fs.list('/file'))]);
    errors.push(['PERMISSION_DENIED', await rejection(fs.list('/denied'))]);
    errors.push(['ALREADY_EXISTS', await rejection(fs.mkdir('/dir'))]);
    errors.push([
      'ALREADY_EXISTS rename',
      await rejection(fs.rename('/file', '/dir')),
    ]);
    errors.push(['OPERATION_FAILED', await rejection(fs.remove('/dir'))]);
    errors.push([
      'read NOT_FOUND',
      await streamError(fs.createReadStream('/missing')),
    ]);
    errors.push([
      'IS_A_DIRECTORY',
      await streamError(fs.createReadStream('/dir')),
    ]);
    const writeToDir = fs.createWriteStream('/dir');
    writeToDir.end(Buffer.from('x'));
    errors.push(['write IS_A_DIRECTORY', await streamError(writeToDir)]);

    fixture.dropAfterBytes(256 * 1024);
    errors.push([
      'CONNECTION_LOST',
      await streamError(fs.createReadStream('/big')),
    ]);
    errors.push(['NOT_CONNECTED after loss', await rejection(fs.stat('/'))]);
    fixture.dropAfterBytes(Number.POSITIVE_INFINITY);

    await fs.connect();
    const upload = fs.createWriteStream('/up');
    const uploadError = streamError(upload);
    upload.write(Buffer.from('partial'));
    await fs.disconnect();
    errors.push(['NOT_CONNECTED on disconnect', await uploadError]);
    errors.push(['after disconnect', await rejection(fs.remove('/file'))]);
    expectInstanceClean('after disconnect', fs);

    for (const [label, error] of errors) expectNoSecrets(label, error);
  });

  // The failures that carry an ssh2 error as `cause` from a live session (a lost upload, a list
  // cut off mid-flight, a shared failed connect, streams torn down by disconnect) are the ones
  // most likely to drag the client's configuration, and with it the credentials, into an error.
  it('connection-loss and concurrency errors (AC-20, AC-24, AC-29)', async () => {
    // The secret password is the wrong one here, and the session runs on the secret key and
    // passphrase, so every sentinel is held by an instance whose errors are inspected.
    const fixture = await useServer({
      password: sentinel(),
      authorizedKeys: [encryptedKey],
    });
    const knownHostsPath = await knownHostsFor(fixture);
    const errors: [string, unknown][] = [];

    const failing = newFs(fixture, knownHostsPath, { password });
    const first = rejection(failing.connect());
    const second = rejection(failing.connect());
    errors.push(['concurrent AUTH_FAILED 1', await first]);
    errors.push(['concurrent AUTH_FAILED 2', await second]);

    const fs = newFs(fixture, knownHostsPath, {
      privateKey: encryptedKey.privateKey,
      passphrase,
    });
    await fs.connect();
    fixture.dropAfterBytes(256 * 1024);
    const upload = fs.createWriteStream('/lost.bin');
    const uploadLost = streamError(upload);
    upload.end(randomBytes(2 * 1024 * 1024));
    errors.push(['upload CONNECTION_LOST', await uploadLost]);
    expectInstanceClean('after loss', fs);
    fixture.dropAfterBytes(Number.POSITIVE_INFINITY);

    await fs.connect();
    fixture.stall();
    const before = fixture.stats.requests;
    const listing = rejection(fs.list('/'));
    await fixture.waitUntil(() => fixture.stats.requests > before);
    fixture.dropAll();
    errors.push(['list CONNECTION_LOST', await listing]);
    fixture.resume();

    await fs.connect();
    await writeFile(fixture.local('/big'), randomBytes(2 * 1024 * 1024));
    const download = fs.createReadStream('/big');
    await new Promise((resolve) => download.once('data', resolve));
    download.pause();
    const downloadError = new Promise((resolve) =>
      download.on('error', resolve),
    );
    await fs.disconnect();
    errors.push(['download NOT_CONNECTED on disconnect', await downloadError]);

    expect(errors.map(([, error]) => (error as RemoteFsError).code)).toEqual([
      'AUTH_FAILED',
      'AUTH_FAILED',
      'CONNECTION_LOST',
      'CONNECTION_LOST',
      'NOT_CONNECTED',
    ]);
    for (const [label, error] of errors) expectNoSecrets(label, error);
  });
});
