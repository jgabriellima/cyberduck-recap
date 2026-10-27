/**
 * Adversarial (FEATURE-2, ATK-74): a URL with a password typed as the `--known-hosts` value. The
 * rework of the review sends every typed path through `shownUrl`; the known_hosts path reaches
 * three more lines than the two hints: the host-key prompt of AC-24 and the two back-end error
 * lines that name the file (it cannot be read, the host key cannot be recorded). The spec excludes
 * a password in stderr or in an error line (AC-19, "excluded"), wherever the person typed it.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli, FakeInput, useCliServer } from '../support/cli.js';
import { sentinel, tempDir } from '../support/harness.js';
import {
  cli as adversarialCli,
  memBackend,
  registry,
} from './support/cli-harness.js';

describe('ATK-74: a URL typed as --known-hosts never shows its password', () => {
  it('without a terminal: the HOST_KEY_UNKNOWN hint redacts it', async () => {
    const server = await useCliServer();
    const secret = sentinel();
    const cwd = await tempDir();
    const result = await cli(
      ['ls', '--known-hosts', `sftp://u:${secret}@h/kh`, server.url('/')],
      { env: server.env, cwd, stdin: new FakeInput(false) },
    );
    expect(result.code).toBe(11);
    expect(result.stderr).toContain('***@h/kh');
    expect(result.stderr).not.toContain(secret);
    expect(result.stdout).not.toContain(secret);
  });

  it('on a terminal: the host-key prompt does not show it', async () => {
    const server = await useCliServer();
    const secret = sentinel();
    const cwd = await tempDir();
    const stdin = new FakeInput(true);
    stdin.type('no\n');
    const result = await cli(
      ['ls', '--known-hosts', `sftp://u:${secret}@h/kh`, server.url('/')],
      { env: server.env, cwd, stdin },
    );
    expect(result.code).toBe(11);
    expect(result.stderr).toContain('Type yes to trust it and record it in');
    expect(result.stderr).not.toContain(secret);
  });

  it('a known_hosts file that cannot be read: the error line does not show it', async () => {
    const server = await useCliServer();
    const secret = sentinel();
    const cwd = await tempDir();
    // A path below a regular file: reading it fails with ENOTDIR, not ENOENT.
    const file = join(cwd, 'plain');
    await writeFile(file, 'x');
    const result = await cli(
      [
        'ls',
        '--known-hosts',
        `${file}/sftp://u:${secret}@h/kh`,
        server.url('/'),
      ],
      { env: server.env, cwd, stdin: new FakeInput(false) },
    );
    expect(result.code).toBe(13);
    expect(result.stderr).toMatch(/^cyberduck-recap: CONNECTION_FAILED: /);
    expect(result.stderr).not.toContain(secret);
  });

  it('a host key that cannot be recorded: the error line does not show it', async () => {
    const server = await useCliServer();
    const secret = sentinel();
    const cwd = await tempDir();
    const stdin = new FakeInput(true);
    stdin.type('yes\n');
    // The directory `sftp:/u:<secret>@h` does not exist, so the append fails.
    const result = await cli(
      ['ls', '--known-hosts', `sftp://u:${secret}@h/kh`, server.url('/')],
      { env: server.env, cwd, stdin },
    );
    expect(result.code).toBe(13);
    expect(result.stderr).toContain('could not record the host key');
    expect(result.stderr).not.toContain(secret);
  });
});

describe('ATK-74: a URL typed as the get destination never shows its password', () => {
  it.each([
    ['as the last segment', (s: string) => `sftp://u:${s}@h`],
    ['with a final slash', (s: string) => `sftp://u:${s}@h/`],
    ['inside a deeper path', (s: string) => `x/sftp://u:${s}@h/f`],
  ])('%s: exit 3, no connection, no secret', async (_label, destinationOf) => {
    const cwd = await tempDir();
    const mem = memBackend({ files: { '/r.txt': Buffer.from('remote') } });
    const secret = sentinel();
    const run = await adversarialCli(
      ['get', 'mem://u@h/r.txt', destinationOf(secret)],
      { registry: registry({ mem: mem.factory }), cwd, home: cwd },
    );
    expect(run.code).toBe(3);
    expect(run.stderr).toMatch(/^cyberduck-recap: LOCAL_FILE: /);
    expect(run.stderr).not.toContain(secret);
    expect(run.stdout).not.toContain(secret);
    expect(mem.spy.connects).toBe(0);
  });
});
