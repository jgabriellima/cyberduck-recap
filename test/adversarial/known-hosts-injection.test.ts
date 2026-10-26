/**
 * Adversarial: a crafted host value or a crafted known_hosts file trying to make the client trust a
 * key nobody confirmed for this host and port, or to write a line that trusts something else.
 */
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RemoteFsError, SftpFileSystem } from '../../src/index.js';
import {
  formatKnownHostLine,
  lineRoundTrips,
  parseKnownHosts,
} from '../../src/sftp/known-hosts.js';
import { newFs, sentinel, tempDir, useServer } from '../support/harness.js';
import { expectRejects } from '../support/remote-fs-assertions.js';
import { generateKey } from '../support/sftp-server.js';

describe('ATK-6: a host value that would inject into known_hosts (G-1, G-2)', () => {
  const password = sentinel();
  it.each([
    ['a host list', '127.0.0.1,evil.example'],
    [
      'a newline and a second entry',
      `127.0.0.1\nevil.example ssh-ed25519 AAAA`,
    ],
    ['a carriage return', '127.0.0.1\r'],
    ['a space', 'good.example evil.example'],
    ['a tab', 'good.example\tevil.example'],
    ['a hashed-entry marker', '|1|c2FsdA==|aGFzaA=='],
    ['a bracketed host and port', '[127.0.0.1]:22'],
    ['a wildcard', '*'],
    ['a single-character wildcard', 'host?.example'],
    ['a negation', '!evil.example'],
    ['a marker line', '@cert-authority'],
    ['a comment', '#host'],
    ['a NUL', 'good.example\u0000evil'],
    ['a fullwidth homoglyph', 'ｅvil.example'],
    ['a zone-scoped IPv6 address', 'fe80::1%en0'],
    ['a leading hyphen', '-oProxyCommand=evil'],
    ['an empty label', 'good..example'],
    ['a trailing dot', 'good.example.'],
    ['an overlong name', `${'a'.repeat(63)}.`.repeat(4) + 'com'],
    ['a line separator', 'good.example evil'],
  ])('%s is INVALID_ARGUMENT naming host, never the value', (_label, host) => {
    let caught: unknown;
    try {
      new SftpFileSystem({
        host,
        username: 'tester',
        password,
        knownHostsPath: '/nonexistent/known_hosts',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RemoteFsError);
    const error = caught as RemoteFsError;
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('host');
    expect(error.message).not.toContain(host);
    expect(error.message).not.toContain(password);
  });

  it('a line that would not round-trip is refused even if a host slipped past validation', () => {
    const key = generateKey();
    for (const host of ['a,b', 'a\nb', 'a b', '|1|x|y', '*']) {
      const line = formatKnownHostLine(host, 22, key.blob);
      expect(lineRoundTrips(line, host, 22, key.blob), host).toBe(false);
    }
  });
});

describe('ATK-7: known_hosts lines that must never grant trust', () => {
  it.each([
    [
      'a @cert-authority line',
      (h: string, k: string) => `@cert-authority ${h} ${k}`,
    ],
    ['a @revoked line', (h: string, k: string) => `@revoked ${h} ${k}`],
    ['a wildcard pattern', (_h: string, k: string) => `[127.0.0.*]:* ${k}`],
    ['a ? pattern', (h: string, k: string) => `${h.replace('1]', '?]')} ${k}`],
    ['a negated pattern', (h: string, k: string) => `!${h} ${k}`],
    [
      'the bare host for a non-22 port',
      (_h: string, k: string) => `127.0.0.1 ${k}`,
    ],
    ['the host inside a comment', (h: string, k: string) => `# ${h} ${k}`],
    [
      'the host after a leading space and hash',
      (h: string, k: string) => `   #${h} ${k}`,
    ],
    [
      'a key-type field that lies about the blob',
      (h: string, k: string) => `${h} ssh-rsa ${k.split(' ')[1] ?? ''}`,
    ],
    [
      'the host as a suffix of another name',
      (h: string, k: string) => `x${h} ${k}`,
    ],
    ['the host followed by a NUL', (h: string, k: string) => `${h}\u0000 ${k}`],
  ])('%s is not trust: the key is unknown', async (_label, line) => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    const field = `[127.0.0.1]:${fixture.port}`;
    const contents = `${line(field, fixture.hostKey.publicKey)}\n`;
    await writeFile(knownHostsPath, contents);
    const fs = newFs(fixture, knownHostsPath, { password });

    await expectRejects(fs.connect(), 'HOST_KEY_UNKNOWN');

    expect(fixture.stats.authAttempts).toBe(0);
    expect(await readFile(knownHostsPath, 'utf8')).toBe(contents);
  });

  it('a hashed entry for another port of the same host does not match', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    const { createHmac, randomBytes } = await import('node:crypto');
    const salt = randomBytes(20);
    const hash = createHmac('sha1', salt).update('127.0.0.1').digest();
    await writeFile(
      knownHostsPath,
      `|1|${salt.toString('base64')}|${hash.toString('base64')} ${fixture.hostKey.publicKey}\n`,
    );
    const fs = newFs(fixture, knownHostsPath, { password });

    await expectRejects(fs.connect(), 'HOST_KEY_UNKNOWN');
    expect(fixture.stats.authAttempts).toBe(0);
  });

  it('a recorded line is exactly one plain entry for this host and port', () => {
    const key = generateKey();
    const line = formatKnownHostLine('Example.COM', 2222, key.blob);
    expect(line).toBe(`[example.com]:2222 ${key.publicKey}`);
    expect(parseKnownHosts(line)).toHaveLength(1);
  });
});

describe('ATK-8: a known_hosts path that is not a regular file', () => {
  it('a directory is CONNECTION_FAILED naming the path, with no credential sent', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    await mkdir(knownHostsPath);
    const confirmHostKey = vi.fn(() => Promise.resolve(true));
    const fs = newFs(fixture, knownHostsPath, { password, confirmHostKey });

    const error = await expectRejects(fs.connect(), 'CONNECTION_FAILED');

    expect(error.message).toContain(knownHostsPath);
    expect(confirmHostKey).not.toHaveBeenCalled();
    expect(fixture.stats.authAttempts).toBe(0);
    expect(fixture.stats.connections).toBe(0);
  });

  it('a symlink loop is CONNECTION_FAILED with no credential sent', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const dir = await tempDir();
    const knownHostsPath = join(dir, 'known_hosts');
    await symlink(join(dir, 'loop'), knownHostsPath);
    await symlink(knownHostsPath, join(dir, 'loop'));
    const fs = newFs(fixture, knownHostsPath, { password });

    await expectRejects(fs.connect(), 'CONNECTION_FAILED');
    expect(fixture.stats.authAttempts).toBe(0);
  });

  it('a confirmed key is not written through a dangling symlink into a missing directory', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const dir = await tempDir();
    const knownHostsPath = join(dir, 'known_hosts');
    await symlink(join(dir, 'missing', 'target'), knownHostsPath);
    const fs = newFs(fixture, knownHostsPath, {
      password,
      confirmHostKey: () => Promise.resolve(true),
    });

    const error = await expectRejects(fs.connect(), 'CONNECTION_FAILED');
    expect(error.message).toContain(knownHostsPath);
    expect(fixture.stats.authAttempts).toBe(0);
  });
});
