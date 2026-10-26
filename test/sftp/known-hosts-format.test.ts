import { createHmac, randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RemoteFsError } from '../../src/index.js';
import { fingerprint } from '../../src/sftp/host-key.js';
import {
  appendKnownHost,
  formatKnownHostLine,
  hostField,
  knownKeyTypes,
  lineRoundTrips,
  matchHost,
  parseKnownHosts,
  readKnownHosts,
} from '../../src/sftp/known-hosts.js';
import { serverHostKeyAlgorithms } from '../../src/sftp/algorithms.js';
import { generateKey } from '../support/sftp-server.js';
import { tempDir } from '../support/harness.js';

const key = generateKey();
const other = generateKey();

function hashed(field: string): string {
  const salt = randomBytes(20);
  const hash = createHmac('sha1', salt).update(field).digest();
  return `|1|${salt.toString('base64')}|${hash.toString('base64')}`;
}

describe('known_hosts parsing and matching', () => {
  it('uses the bare host for port 22 and [host]:port otherwise, lower-cased', () => {
    expect(hostField('Example.ORG', 22)).toBe('example.org');
    expect(hostField('Example.ORG', 2222)).toBe('[example.org]:2222');
  });

  it('skips blank, comment, marker and malformed lines', () => {
    const entries = parseKnownHosts(
      [
        '',
        '   ',
        '# comment',
        `@revoked example.org ${key.publicKey}`,
        `@cert-authority example.org ${key.publicKey}`,
        'only-one-field',
        'example.org ssh-ed25519',
        `example.org ssh-ed25519 not*base64`,
        `example.org ecdsa-sha2-nistp256 ${key.publicKey.split(' ')[1] ?? ''}`,
        `|1|bad|hash ${key.publicKey}`,
        `example.org ${key.publicKey}`,
      ].join('\n'),
    );

    expect(entries).toHaveLength(1);
  });

  it('reports trusted, unknown and changed', () => {
    const entries = parseKnownHosts(`example.org ${key.publicKey}\n`);

    expect(matchHost(entries, 'example.org', 22, key.blob).kind).toBe(
      'trusted',
    );
    expect(matchHost(entries, 'example.org', 2222, key.blob).kind).toBe(
      'unknown',
    );
    expect(matchHost(entries, 'other.example', 22, key.blob).kind).toBe(
      'unknown',
    );
    expect(matchHost(entries, 'example.org', 22, other.blob)).toEqual({
      kind: 'changed',
      expectedFingerprints: [key.fingerprint],
    });
  });

  it('matches hashed entries and comma-separated lists', () => {
    const entries = parseKnownHosts(
      `${hashed('[example.org]:2222')} ${key.publicKey}\na.example,EXAMPLE.org ${other.publicKey}\n`,
    );

    expect(matchHost(entries, 'example.org', 2222, key.blob).kind).toBe(
      'trusted',
    );
    expect(matchHost(entries, 'Example.Org', 22, other.blob).kind).toBe(
      'trusted',
    );
  });

  it('never lets wildcard or negated patterns grant trust', () => {
    const entries = parseKnownHosts(
      `*.example ${key.publicKey}\n!a.example ${key.publicKey}\n`,
    );

    expect(matchHost(entries, 'a.example', 22, key.blob).kind).toBe('unknown');
  });

  it('lists the key types known for the host, and prefers them in the handshake', () => {
    const entries = parseKnownHosts(`example.org ${key.publicKey}\n`);
    const types = knownKeyTypes(entries, 'example.org', 22);

    expect(types).toEqual(['ssh-ed25519']);
    expect(serverHostKeyAlgorithms(['ecdsa-sha2-nistp384'])[0]).toBe(
      'ecdsa-sha2-nistp384',
    );
    expect(serverHostKeyAlgorithms(['ssh-rsa']).slice(0, 2)).toEqual([
      'rsa-sha2-512',
      'rsa-sha2-256',
    ]);
    expect(serverHostKeyAlgorithms([])).not.toContain('ssh-rsa');
  });
});

describe('known_hosts round trip (G-2)', () => {
  it('a formatted line reads back as one plain entry for exactly this host, port and key', () => {
    const line = formatKnownHostLine('Example.org', 2222, key.blob);

    expect(line).toBe(`[example.org]:2222 ${key.publicKey}`);
    expect(lineRoundTrips(line, 'example.org', 2222, key.blob)).toBe(true);
  });

  it.each([
    ['a host list', 'a.example,b.example'],
    ['an injected line', 'a.example ssh-ed25519 AAAA\nb.example'],
    ['a hashed marker', '|1|x|y'],
    ['a space', 'a b'],
  ])('refuses a line built from %s', (_label, host) => {
    const line = formatKnownHostLine(host, 22, key.blob);
    expect(lineRoundTrips(line, host, 22, key.blob)).toBe(false);
  });

  it('appendKnownHost refuses to write a line that does not round-trip', async () => {
    const path = join(await tempDir(), 'known_hosts');
    await writeFile(path, '');

    await expect(
      appendKnownHost(path, 'a.example,b.example', 22, key.blob),
    ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });

    expect(await readFile(path, 'utf8')).toBe('');
  });

  it('appendKnownHost creates a missing file with mode 0600', async () => {
    const path = join(await tempDir(), 'known_hosts');

    await appendKnownHost(path, 'example.org', 22, key.blob);

    expect(await readFile(path, 'utf8')).toBe(`example.org ${key.publicKey}\n`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('readKnownHosts treats a missing file as empty and an unreadable one as CONNECTION_FAILED', async () => {
    const dir = await tempDir();

    await expect(readKnownHosts(join(dir, 'absent'))).resolves.toEqual([]);
    const error = await readKnownHosts(dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteFsError);
    expect((error as RemoteFsError).code).toBe('CONNECTION_FAILED');
    expect((error as RemoteFsError).message).toContain(dir);
  });

  it('fingerprints of changed keys are deduplicated', () => {
    const entries = parseKnownHosts(
      `example.org ${key.publicKey}\nexample.org ${key.publicKey}\n`,
    );
    expect(matchHost(entries, 'example.org', 22, other.blob)).toEqual({
      kind: 'changed',
      expectedFingerprints: [fingerprint(key.blob)],
    });
  });
});
