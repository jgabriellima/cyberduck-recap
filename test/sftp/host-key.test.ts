import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RemoteFsError, SftpFileSystem } from '../../src/index.js';
import { fingerprint, keyType } from '../../src/sftp/host-key.js';
import type { HostKeyInfo } from '../../src/sftp/options.js';
import { generateKey } from '../support/sftp-server.js';
import { newFs, sentinel, tempDir, useServer } from '../support/harness.js';
import { expectRejects } from '../support/remote-fs-assertions.js';

async function readIfExists(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch(() => undefined);
}

describe('host-key helpers', () => {
  it('fingerprint is SHA256: plus the unpadded base64 SHA-256 of the key blob', () => {
    const key = generateKey();
    const expected = createHash('sha256').update(key.blob).digest('base64');

    expect(fingerprint(key.blob)).toBe(`SHA256:${expected.replace(/=+$/, '')}`);
    expect(fingerprint(key.blob)).not.toContain('=');
  });

  it('keyType reads the first SSH string of the blob', () => {
    expect(keyType(generateKey().blob)).toBe('ssh-ed25519');
    expect(keyType(Buffer.from([0, 0, 0, 9, 1]))).toBeUndefined();
    expect(keyType(Buffer.alloc(2))).toBeUndefined();
  });
});

describe('unknown host key (AC-14)', () => {
  const refusals: [string, (() => Promise<boolean>) | undefined][] = [
    ['no confirmHostKey', undefined],
    ['confirmHostKey resolving false', () => Promise.resolve(false)],
    ['confirmHostKey rejecting', () => Promise.reject(new Error('no'))],
    [
      'confirmHostKey throwing synchronously',
      () => {
        throw new Error('no');
      },
    ],
    [
      'confirmHostKey resolving a truthy non-true value',
      () => Promise.resolve('yes' as unknown as boolean),
    ],
  ];

  it.each(refusals)(
    'with %s: HOST_KEY_UNKNOWN, zero auth attempts, known_hosts still absent',
    async (_label, confirmHostKey) => {
      const fixture = await useServer({ password: sentinel() });
      const knownHostsPath = join(await tempDir(), 'known_hosts');
      const fs = newFs(fixture, knownHostsPath, {
        password: sentinel(),
        confirmHostKey,
      });

      await expectRejects(fs.connect(), 'HOST_KEY_UNKNOWN');

      expect(fixture.stats.authAttempts).toBe(0);
      expect(await readIfExists(knownHostsPath)).toBeUndefined();
    },
  );

  it('an entry for another port of the same host does not make the key trusted', async () => {
    const fixture = await useServer({ password: sentinel() });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    const content = `[127.0.0.1]:${fixture.port + 1} ${fixture.hostKey.publicKey}\n127.0.0.1 ${fixture.hostKey.publicKey}\n`;
    await writeFile(knownHostsPath, content);
    const fs = newFs(fixture, knownHostsPath, { password: sentinel() });

    await expectRejects(fs.connect(), 'HOST_KEY_UNKNOWN');

    expect(fixture.stats.authAttempts).toBe(0);
    expect(await readFile(knownHostsPath, 'utf8')).toBe(content);
  });
});

describe('confirmed host key (AC-15)', () => {
  it('calls confirmHostKey once with the key details, records one line with mode 0600, and trusts it next time', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    const confirmHostKey = vi.fn<(key: HostKeyInfo) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    const fs = newFs(fixture, knownHostsPath, { password, confirmHostKey });

    await fs.connect();

    expect(confirmHostKey).toHaveBeenCalledTimes(1);
    expect(confirmHostKey).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: fixture.port,
      keyType: 'ssh-ed25519',
      fingerprint: fixture.hostKey.fingerprint,
    });
    const lines = (await readFile(knownHostsPath, 'utf8')).split('\n');
    expect(lines).toEqual([fixture.knownHostsLine, '']);
    expect((await stat(knownHostsPath)).mode & 0o777).toBe(0o600);

    const again = newFs(fixture, knownHostsPath, { password });
    await again.connect();
    expect(fixture.stats.sessions).toBe(2);
  });

  it('appends to an existing file, adding the missing final newline first', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    const other = `other.example ${generateKey().publicKey}`;
    await writeFile(knownHostsPath, other);
    const fs = newFs(fixture, knownHostsPath, {
      password,
      confirmHostKey: () => Promise.resolve(true),
    });

    await fs.connect();

    expect(await readFile(knownHostsPath, 'utf8')).toBe(
      `${other}\n${fixture.knownHostsLine}\n`,
    );
  });
});

describe('changed host key (AC-16)', () => {
  it('is refused with both fingerprints, never asks, sends no credential and leaves the file alone', async () => {
    const fixture = await useServer({ password: sentinel() });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    const recorded = generateKey();
    const content = `[127.0.0.1]:${fixture.port} ${recorded.publicKey}\n`;
    await writeFile(knownHostsPath, content);
    const confirmHostKey = vi.fn(() => Promise.resolve(true));
    const fs = newFs(fixture, knownHostsPath, {
      password: sentinel(),
      confirmHostKey,
    });

    const error = await expectRejects(fs.connect(), 'HOST_KEY_CHANGED');

    expect(error.expectedFingerprints).toEqual([recorded.fingerprint]);
    expect(error.presentedFingerprint).toBe(fixture.hostKey.fingerprint);
    expect(error.message).toContain(fixture.hostKey.fingerprint);
    expect(confirmHostKey).not.toHaveBeenCalled();
    expect(fixture.stats.authAttempts).toBe(0);
    expect(await readFile(knownHostsPath, 'utf8')).toBe(content);
  });
});

describe('verification cannot be turned off (AC-17)', () => {
  it.each([
    ['knownHostsPath missing', { knownHostsPath: undefined }],
    ['hostVerifier given', { hostVerifier: () => true }],
    ['strictHostKeyChecking given', { strictHostKeyChecking: false }],
  ])(
    'the constructor throws INVALID_ARGUMENT with %s and nothing reaches the server',
    async (_label, overrides) => {
      const fixture = await useServer({ password: sentinel() });
      const options: Record<string, unknown> = {
        host: fixture.host,
        port: fixture.port,
        username: 'tester',
        password: sentinel(),
        knownHostsPath: join(await tempDir(), 'known_hosts'),
        ...overrides,
      };

      let thrown: unknown;
      try {
        new SftpFileSystem(options as never);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(RemoteFsError);
      expect((thrown as RemoteFsError).code).toBe('INVALID_ARGUMENT');
      expect(fixture.stats.connections).toBe(0);
    },
  );

  it('an unreadable known_hosts file is CONNECTION_FAILED with zero auth attempts', async () => {
    const fixture = await useServer({ password: sentinel() });
    // A directory exists but cannot be read as a file, whatever user runs the tests.
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    await mkdir(knownHostsPath);
    const fs = newFs(fixture, knownHostsPath, { password: sentinel() });

    const error = await expectRejects(fs.connect(), 'CONNECTION_FAILED');

    expect(error.message).toContain(knownHostsPath);
    expect(fixture.stats.authAttempts).toBe(0);
  });
});

describe('the timeout pauses while a person decides (AC-27)', () => {
  it('a confirmation slower than connectTimeoutMs still connects and records the key', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    const fs = newFs(fixture, knownHostsPath, {
      password,
      connectTimeoutMs: 300,
      // The 900 ms delay is the condition under test (three times the timeout), not a wait.
      confirmHostKey: () =>
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 900)),
    });

    await fs.connect();

    expect(await readFile(knownHostsPath, 'utf8')).toBe(
      `${fixture.knownHostsLine}\n`,
    );
  });

  it('a server that closes while confirmation is pending fails the connection and records nothing', async () => {
    const fixture = await useServer({ password: sentinel() });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    let answer: (value: boolean) => void = () => undefined;
    let asked = false;
    const fs = newFs(fixture, knownHostsPath, {
      password: sentinel(),
      confirmHostKey: () =>
        new Promise<boolean>((resolve) => {
          asked = true;
          answer = resolve;
        }),
    });

    const connecting = fs.connect();
    await fixture.waitUntil(() => asked);
    fixture.dropAll();
    await expectRejects(connecting, 'CONNECTION_FAILED');
    answer(true);
    // Whatever the late answer would trigger runs on the next turns; give them a chance to.
    await new Promise((resolve) => setImmediate(resolve));

    expect(await readIfExists(knownHostsPath)).toBeUndefined();
    expect(fixture.stats.authAttempts).toBe(0);
  });
});

describe('a confirmed key that cannot be recorded (AC-28)', () => {
  it('is CONNECTION_FAILED naming the known_hosts path, with no credential sent', async () => {
    const fixture = await useServer({ password: sentinel() });
    const knownHostsPath = join(await tempDir(), 'no-such-dir', 'known_hosts');
    const fs = newFs(fixture, knownHostsPath, {
      password: sentinel(),
      confirmHostKey: () => Promise.resolve(true),
    });

    const error = await expectRejects(fs.connect(), 'CONNECTION_FAILED');

    expect(error.message).toContain(knownHostsPath);
    expect(fixture.stats.authAttempts).toBe(0);
  });
});
