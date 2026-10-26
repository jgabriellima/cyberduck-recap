/**
 * Adversarial: a man-in-the-middle and a careless confirmer against host-key verification. Each
 * test is an attack that succeeds only if a key is trusted or recorded that should not be, or if a
 * credential leaves the process before the key is judged.
 */
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { SftpFileSystem } from '../../src/index.js';
import type { HostKeyInfo } from '../../src/sftp/options.js';
import { parseKnownHosts, matchHost } from '../../src/sftp/known-hosts.js';
import { newFs, sentinel, tempDir, useServer } from '../support/harness.js';
import {
  generateKeyOfType,
  startHostileServer,
  type HostileServerOptions,
} from '../support/hostile-sftp-server.js';
import { generateKey } from '../support/sftp-server.js';
import { expectRejects } from '../support/remote-fs-assertions.js';

async function useHostile(options: HostileServerOptions) {
  const server = await startHostileServer(options);
  onTestFinished(() => server.close());
  return server;
}

async function absent(path: string): Promise<boolean> {
  return access(path).then(
    () => false,
    () => true,
  );
}

describe('ATK-1: a server that shows a key it cannot sign with (S-2)', () => {
  it('a confirmed but unproven key is never recorded and no credential is sent', async () => {
    const password = sentinel();
    const server = await useHostile({ password, forgeHostKeySignature: true });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    const confirmHostKey = vi.fn(() => Promise.resolve(true));
    const fs = newFs(server, knownHostsPath, { password, confirmHostKey });

    await expectRejects(fs.connect(), 'CONNECTION_FAILED');

    // The person did say yes: the attack reached the point where a naive client records the key.
    expect(confirmHostKey).toHaveBeenCalledTimes(1);
    expect(server.stats.authAttempts).toBe(0);
    expect(await absent(knownHostsPath)).toBe(true);
    await expectRejects(fs.list('/'), 'NOT_CONNECTED');
  });

  it('a trusted key whose holder cannot sign is refused before any credential', async () => {
    const password = sentinel();
    const server = await useHostile({ password, forgeHostKeySignature: true });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    await writeFile(knownHostsPath, `${server.knownHostsLine}\n`);
    const fs = newFs(server, knownHostsPath, { password });

    await expectRejects(fs.connect(), 'CONNECTION_FAILED');

    expect(server.stats.authAttempts).toBe(0);
  });
});

describe('ATK-2: host-key type downgrade by an impostor', () => {
  it.each(['ecdsa', 'rsa'] as const)(
    'an impostor presenting a %s key for a host known by its Ed25519 key is HOST_KEY_CHANGED, never asked',
    async (type) => {
      const password = sentinel();
      const server = await useHostile({
        password,
        hostKey: generateKeyOfType(type),
      });
      const genuine = generateKey();
      const knownHostsPath = join(await tempDir(), 'known_hosts');
      const contents = `[127.0.0.1]:${server.port} ${genuine.publicKey}\n`;
      await writeFile(knownHostsPath, contents);
      const confirmHostKey = vi.fn(() => Promise.resolve(true));
      const fs = newFs(server, knownHostsPath, { password, confirmHostKey });

      const error = await expectRejects(fs.connect(), 'HOST_KEY_CHANGED');

      expect(error.expectedFingerprints).toEqual([genuine.fingerprint]);
      expect(error.presentedFingerprint).toBe(server.hostKey.fingerprint);
      expect(confirmHostKey).not.toHaveBeenCalled();
      expect(server.stats.authAttempts).toBe(0);
      expect(await readFile(knownHostsPath, 'utf8')).toBe(contents);
    },
  );
});

describe('ATK-3: a confirmation that is truthy but not true', () => {
  it.each([
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['an object', { ok: true }],
    ['a boxed true', Object(true) as unknown],
    ['a thenable of true', { then: (r: (v: unknown) => void) => r('yes') }],
  ])('%s refuses the key', async (_label, answer) => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    const fs = newFs(fixture, knownHostsPath, {
      password,
      confirmHostKey: () => Promise.resolve(answer),
    });

    await expectRejects(fs.connect(), 'HOST_KEY_UNKNOWN');

    expect(fixture.stats.authAttempts).toBe(0);
    expect(await absent(knownHostsPath)).toBe(true);
  });
});

describe('ATK-4: disconnect() from inside a pending confirmation', () => {
  it('a later "true" records nothing, sends no credential and leaves the instance disconnected', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    let disconnected: Promise<void> | undefined;
    const fs: SftpFileSystem = newFs(fixture, knownHostsPath, {
      password,
      confirmHostKey: async () => {
        // The person cancels the session, then the prompt answers yes anyway.
        disconnected = fs.disconnect();
        await disconnected;
        return true;
      },
    });

    await expectRejects(fs.connect(), 'CONNECTION_FAILED');
    await disconnected;

    expect(fixture.stats.authAttempts).toBe(0);
    expect(await absent(knownHostsPath)).toBe(true);
    await expectRejects(fs.list('/'), 'NOT_CONNECTED');
  });

  it('a confirmation answered after the attempt was cancelled cannot resurrect it', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    let answer: ((value: boolean) => void) | undefined;
    let markAsked: () => void = () => undefined;
    const asked = new Promise<void>((resolveAsked) => {
      markAsked = resolveAsked;
    });
    const fs = newFs(fixture, knownHostsPath, {
      password,
      confirmHostKey: () =>
        new Promise<boolean>((resolveAnswer) => {
          answer = resolveAnswer;
          markAsked();
        }),
    });
    const connecting = fs.connect();
    await asked;

    const disconnecting = fs.disconnect();
    answer?.(true);
    await expectRejects(connecting, 'CONNECTION_FAILED');
    await disconnecting;

    expect(fixture.stats.authAttempts).toBe(0);
    expect(fixture.stats.sessions).toBe(0);
    expect(await absent(knownHostsPath)).toBe(true);
  });
});

describe('ATK-5: concurrent confirmations of one unknown host', () => {
  it('concurrent connect() calls on one instance ask once and record one line', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    const confirmHostKey = vi.fn<(key: HostKeyInfo) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    const fs = newFs(fixture, knownHostsPath, { password, confirmHostKey });

    await Promise.all([fs.connect(), fs.connect(), fs.connect()]);

    expect(confirmHostKey).toHaveBeenCalledTimes(1);
    expect(fixture.stats.sessions).toBe(1);
    expect(await readFile(knownHostsPath, 'utf8')).toBe(
      `${fixture.knownHostsLine}\n`,
    );
  });

  it('parallel instances appending at once leave only whole, trusted lines', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    // An existing file without a final newline is the case where a careless append glues lines.
    const other = `other.example ${generateKey().publicKey}`;
    await writeFile(knownHostsPath, other);
    const instances = Array.from({ length: 6 }, () =>
      newFs(fixture, knownHostsPath, {
        password,
        confirmHostKey: () => Promise.resolve(true),
      }),
    );

    await Promise.all(instances.map((fs) => fs.connect()));

    const text = await readFile(knownHostsPath, 'utf8');
    const lines = text.split('\n').filter((line) => line !== '');
    expect(lines[0]).toBe(other);
    for (const line of lines.slice(1)) {
      expect(line).toBe(fixture.knownHostsLine);
    }
    const entries = parseKnownHosts(text);
    expect(entries).toHaveLength(lines.length);
    expect(
      matchHost(entries, '127.0.0.1', fixture.port, fixture.hostKey.blob).kind,
    ).toBe('trusted');
    const later = newFs(fixture, knownHostsPath, { password });
    await later.connect();
  });
});
