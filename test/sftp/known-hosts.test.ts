import { createHmac, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newFs, sentinel, tempDir, useServer } from '../support/harness.js';
import type { SftpServerFixture } from '../support/sftp-server.js';

async function connectsWith(
  fixture: SftpServerFixture,
  password: string,
  content: string,
): Promise<void> {
  const knownHostsPath = join(await tempDir(), 'known_hosts');
  await writeFile(knownHostsPath, content);
  await newFs(fixture, knownHostsPath, { password }).connect();
}

function hashedHost(field: string): string {
  const salt = randomBytes(20);
  const hash = createHmac('sha1', salt).update(field).digest();
  return `|1|${salt.toString('base64')}|${hash.toString('base64')}`;
}

describe('known_hosts matching (AC-18)', () => {
  it('trusts a key under a hashed entry', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });

    await connectsWith(
      fixture,
      password,
      `${hashedHost(`[127.0.0.1]:${fixture.port}`)} ${fixture.hostKey.publicKey}\n`,
    );

    expect(fixture.stats.sessions).toBe(1);
  });

  it('trusts a key under a comma-separated host list', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });

    await connectsWith(
      fixture,
      password,
      `example.org,[127.0.0.1]:${fixture.port},other.example ${fixture.hostKey.publicKey}\n`,
    );

    expect(fixture.stats.sessions).toBe(1);
  });

  it('matches host names case-insensitively', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    await writeFile(
      knownHostsPath,
      `[LOCALHOST]:${fixture.port} ${fixture.hostKey.publicKey}\n`,
    );

    await newFs(fixture, knownHostsPath, {
      password,
      host: 'localhost',
    }).connect();

    expect(fixture.stats.sessions).toBe(1);
  });

  it('trusts a [127.0.0.1]:port entry among comment, blank and malformed lines', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const content = [
      '# a comment',
      '',
      'malformed-line-without-key',
      `[127.0.0.1]:${fixture.port} ssh-ed25519 !!!not-base64!!!`,
      `[127.0.0.1]:${fixture.port} ssh-rsa ${fixture.hostKey.publicKey.split(' ')[1] ?? ''}`,
      `@cert-authority [127.0.0.1]:${fixture.port} ${fixture.hostKey.publicKey}`,
      `[127.0.0.1]:${fixture.port} ${fixture.hostKey.publicKey} a comment`,
      '',
    ].join('\n');

    await connectsWith(fixture, password, content);

    expect(fixture.stats.sessions).toBe(1);
  });
});
