/**
 * Adversarial (FEATURE-2): a secret that reaches the CLI by a wrong road — in the URL, in an
 * option, in an identity file that is not a key, or inside an unexpected error of a back-end —
 * must never come back on stdout or stderr, whatever error the command line also has. The spec's
 * USAGE lines echo the text the person typed (`invalid URL '<x>'`), which is where a password in
 * that text would leak.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sentinel, tempDir } from '../support/harness.js';
import { generateKey } from '../support/sftp-server.js';
import {
  cli,
  memBackend,
  registry,
  stderrLines,
  type CliRun,
} from './support/cli-harness.js';

function expectNoSecret(run: CliRun, secret: string): void {
  expect(run.stdout).not.toContain(secret);
  expect(run.stderr).not.toContain(secret);
}

async function setup(): Promise<{
  cwd: string;
  mem: ReturnType<typeof memBackend>;
}> {
  const cwd = await tempDir();
  const mem = memBackend({ files: { '/r.txt': Buffer.from('remote') } });
  return { cwd, mem };
}

describe('ATK-1: a secret on the command line is never echoed', () => {
  it.each([
    ['an invalid port', (s: string) => ['ls', `mem://u:${s}@h:65536/`]],
    ['port 0', (s: string) => ['ls', `mem://u:${s}@h:0/`]],
    [
      'an invalid percent-encoding',
      (s: string) => ['ls', `mem://u:${s}@h/%zz`],
    ],
    ['a path with U+0000', (s: string) => ['ls', `mem://u:${s}@h/%00`]],
    ['a scheme with no back-end', (s: string) => ['ls', `ftp://u:${s}@h/`]],
    ['a percent-encoded password', (s: string) => ['ls', `mem://u:%41${s}@h/`]],
    ['too many arguments', (s: string) => ['ls', `mem://u:${s}@h/`, 'extra']],
    [
      'get with three arguments',
      (s: string) => ['get', `mem://u:${s}@h/r.txt`, 'a', 'b'],
    ],
    [
      '--overwrite with ls',
      (s: string) => ['ls', '--overwrite', `mem://u:${s}@h/`],
    ],
    [
      'an unknown command',
      (s: string) => ['copy', `mem://u:${s}@h/r.txt`, 'x'],
    ],
    [
      '--password with a separate value',
      (s: string) => ['ls', '--password', s, 'mem://u@h/'],
    ],
    [
      'a short option glued to its value',
      (s: string) => ['ls', `-p${s}`, 'mem://u@h/'],
    ],
    [
      '--password= with an = inside the value',
      (s: string) => ['ls', `--password=${s}=${s}`, 'mem://u@h/'],
    ],
    ['a URL as the first positional', (s: string) => [`sftp://u:${s}@h/`]],
    [
      'a URL as the first positional after --identity',
      (s: string) => ['--identity', 'k', `sftp://u:${s}@h/`],
    ],
    [
      'a URL typed as an option name',
      (s: string) => ['ls', `--sftp://u:${s}@h/`, 'mem://u@h/'],
    ],
  ])('%s: exit 2, no connection, no secret', async (_label, argsOf) => {
    const { cwd, mem } = await setup();
    const secret = sentinel();
    const run = await cli(argsOf(secret), {
      registry: registry({ mem: mem.factory }),
      cwd,
      home: cwd,
    });
    expect(run.code).toBe(2);
    expect(stderrLines(run.stderr)[0]).toMatch(/^cyberduck-recap: USAGE: /);
    expectNoSecret(run, secret);
    expect(mem.spy.connects).toBe(0);
  });

  it('--help with a password in the URL prints help and never the password', async () => {
    const { cwd, mem } = await setup();
    const secret = sentinel();
    const run = await cli(['ls', `mem://u:${secret}@h/`, '--help'], {
      registry: registry({ mem: mem.factory }),
      cwd,
      home: cwd,
    });
    expect(run.code).toBe(0);
    expectNoSecret(run, secret);
    expect(mem.spy.connects).toBe(0);
  });
});

describe('ATK-1: a URL typed where a local path goes is never echoed with its password', () => {
  it.each([
    [
      'put with the URL as the local file',
      (s: string) => ['put', `sftp://u:${s}@h/f`, 'mem://u@h/'],
    ],
    [
      'get with the URL as the local destination',
      (s: string) => ['get', 'mem://u@h/r.txt', `sftp://u:${s}@h/d/f`],
    ],
    [
      '--identity with the URL as the key file',
      (s: string) => ['ls', '--identity', `sftp://u:${s}@h/k`, 'mem://u@h/'],
    ],
  ])('%s: exit 3, no connection, no secret', async (_label, argsOf) => {
    const { cwd, mem } = await setup();
    const secret = sentinel();
    const run = await cli(argsOf(secret), {
      registry: registry({ mem: mem.factory }),
      cwd,
      home: cwd,
    });
    expect(run.code).toBe(3);
    expect(stderrLines(run.stderr)[0]).toMatch(
      /^cyberduck-recap: LOCAL_FILE: .*\*\*\*@h\//,
    );
    expectNoSecret(run, secret);
    expect(mem.spy.connects).toBe(0);
  });
});

describe('ATK-1: an identity file that is not a usable key is never echoed', () => {
  it.each([
    ['text with a secret in it', (s: string) => `hello ${s}\n`],
    [
      'a public key whose comment is a secret',
      (s: string) => `${generateKey().publicKey} ${s}\n`,
    ],
    [
      'a PEM-looking block around a secret',
      (s: string) =>
        `-----BEGIN OPENSSH PRIVATE KEY-----\n${s}\n-----END OPENSSH PRIVATE KEY-----\n`,
    ],
  ])('%s: exit 10, no connection, no content', async (_label, contentOf) => {
    const { cwd, mem } = await setup();
    const secret = sentinel();
    const file = join(cwd, 'id_test');
    await writeFile(file, contentOf(secret), { mode: 0o600 });
    const run = await cli(['ls', '--identity', file, 'mem://u@h/'], {
      registry: registry({ mem: mem.factory }),
      cwd,
      home: cwd,
    });
    expect(run.code).toBe(10);
    expect(stderrLines(run.stderr)[0]).toMatch(
      /^cyberduck-recap: AUTH_FAILED: /,
    );
    expectNoSecret(run, secret);
    expect(mem.spy.connects).toBe(0);
  });

  it('an encrypted key with a wrong passphrase never echoes the passphrase or the key', async () => {
    const { cwd, mem } = await setup();
    const key = generateKey(sentinel());
    const wrong = sentinel();
    const file = join(cwd, 'id_enc');
    await writeFile(file, key.privateKey, { mode: 0o600 });
    const run = await cli(['ls', '--identity', file, 'mem://u@h/'], {
      registry: registry({ mem: mem.factory }),
      cwd,
      home: cwd,
      env: { CYBERDUCK_RECAP_PASSPHRASE: wrong },
    });
    expect(run.code).toBe(10);
    expectNoSecret(run, wrong);
    const body = key.privateKey.split('\n')[1] ?? '';
    expect(body.length).toBeGreaterThan(0);
    expectNoSecret(run, body);
    expect(mem.spy.connects).toBe(0);
  });

  it('a directory as the identity file is a local file error, not a crash', async () => {
    const { cwd, mem } = await setup();
    const directory = join(cwd, 'keys');
    await mkdir(directory);
    const run = await cli(['ls', '--identity', directory, 'mem://u@h/'], {
      registry: registry({ mem: mem.factory }),
      cwd,
      home: cwd,
    });
    expect(run.code).toBe(3);
    expect(stderrLines(run.stderr)[0]).toBe(
      `cyberduck-recap: LOCAL_FILE: cannot read the identity file ${directory}`,
    );
    expect(mem.spy.connects).toBe(0);
  });
});

describe('ATK-1: a back-end error that carries the credential is never printed', () => {
  it('an unexpected error built from the back-end options stays INTERNAL', async () => {
    const cwd = await tempDir();
    const secret = sentinel();
    const mem = memBackend({
      connect: (target) => {
        throw new TypeError(`bad target ${JSON.stringify(target)}`);
      },
    });
    const run = await cli(['ls', 'mem://u@h/'], {
      registry: registry({ mem: mem.factory }),
      cwd,
      home: cwd,
      env: { CYBERDUCK_RECAP_PASSWORD: secret },
    });
    expect(run.code).toBe(1);
    expect(stderrLines(run.stderr)[0]).toBe(
      'cyberduck-recap: INTERNAL: unexpected error',
    );
    expectNoSecret(run, secret);
  });
});
