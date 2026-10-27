/**
 * Adversarial (FEATURE-2): the two terminal prompts against input that a real terminal delivers
 * in pieces, ends badly or carries more than one answer. Raw mode is switched off however the
 * password prompt ends, a CR at the end of one chunk and its LF at the start of the next count as
 * one line end even across the two prompts, a multi-byte character split across chunks is one
 * character, and the host-key answer records exactly one line however much follows it. A host in
 * the URL that would put a second line into known_hosts never gets that far.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sentinel, tempDir, useServer } from '../support/harness.js';
import { generateKey, waitUntil } from '../support/sftp-server.js';
import {
  Capture,
  cli,
  fakeTty,
  registry,
  stderrLines,
  type FakeTty,
} from './support/cli-harness.js';

const PASSWORD_PROMPT = 'Password for ';
const HOST_KEY_PROMPT = 'Type yes to trust it';

async function typeAfterPrompt(
  stderr: Capture,
  prompt: string,
  tty: FakeTty,
  chunks: readonly (string | Buffer)[],
): Promise<void> {
  await waitUntil(() => stderr.text().includes(prompt));
  for (const [index, chunk] of chunks.entries()) {
    // One chunk at a time: the CLI sees each piece in its own read, as a terminal delivers it.
    // The last chunk may stay partly unread: bytes after a line end are kept for the next prompt.
    if (index > 0) await waitUntil(() => tty.readableLength === 0);
    tty.write(chunk);
  }
}

async function emptyKnownHosts(): Promise<string> {
  const path = join(await tempDir(), 'known_hosts');
  await writeFile(path, '');
  return path;
}

describe('ATK-5: the password prompt always gives the terminal back', () => {
  it('a stdin error mid-answer switches raw mode off and connects nowhere', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const cwd = await tempDir();
    const knownHosts = join(cwd, 'known_hosts');
    await writeFile(knownHosts, `${fixture.knownHostsLine}\n`);
    const tty = fakeTty();
    const stderr = new Capture();
    const running = cli(
      [
        'ls',
        '--known-hosts',
        knownHosts,
        `sftp://tester@127.0.0.1:${fixture.port}/`,
      ],
      { registry: registry(), cwd, home: cwd, stdin: tty, stderr },
    );
    await typeAfterPrompt(stderr, PASSWORD_PROMPT, tty, [
      password.slice(0, 10),
    ]);
    tty.destroy(new Error('the terminal went away'));
    const run = await running;

    expect(run.code).not.toBe(0);
    expect(tty.rawModeCalls).toEqual([true, false]);
    expect(tty.isRaw).toBe(false);
    expect(run.stderr).not.toContain(password.slice(0, 10));
    expect(fixture.stats.connections).toBe(0);
  });

  it.each([
    ['end of input inside a multi-byte character', [Buffer.from([0xc3])]],
    ['bytes after Ctrl-C', ['\u0003typed-after-cancel\r']],
  ])('%s cancels with raw mode off', async (_label, chunks) => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const cwd = await tempDir();
    const knownHosts = join(cwd, 'known_hosts');
    await writeFile(knownHosts, `${fixture.knownHostsLine}\n`);
    const tty = fakeTty();
    const stderr = new Capture();
    const running = cli(
      [
        'ls',
        '--known-hosts',
        knownHosts,
        `sftp://tester@127.0.0.1:${fixture.port}/`,
      ],
      { registry: registry(), cwd, home: cwd, stdin: tty, stderr },
    );
    await typeAfterPrompt(stderr, PASSWORD_PROMPT, tty, chunks);
    tty.end();
    const run = await running;

    expect(run.code).toBe(130);
    expect(stderrLines(run.stderr)).toContain(
      'cyberduck-recap: CANCELLED: the password prompt was cancelled',
    );
    expect(tty.rawModeCalls).toEqual([true, false]);
    expect(run.stderr).not.toContain('typed-after-cancel');
    expect(fixture.stats.connections).toBe(0);
  });

  it('a password typed in pieces, one split inside a character, authenticates', async () => {
    const password = `${sentinel()}é`;
    const fixture = await useServer({ password });
    const cwd = await tempDir();
    const knownHosts = join(cwd, 'known_hosts');
    await writeFile(knownHosts, `${fixture.knownHostsLine}\n`);
    const bytes = Buffer.from(`${password}\r`, 'utf8');
    const splitInsideE = bytes.length - 2;
    const tty = fakeTty();
    const stderr = new Capture();
    const running = cli(
      [
        'ls',
        '--known-hosts',
        knownHosts,
        `sftp://tester@127.0.0.1:${fixture.port}/`,
      ],
      { registry: registry(), cwd, home: cwd, stdin: tty, stderr },
    );
    await typeAfterPrompt(stderr, PASSWORD_PROMPT, tty, [
      bytes.subarray(0, 5),
      bytes.subarray(5, splitInsideE),
      bytes.subarray(splitInsideE),
    ]);
    const run = await running;

    expect(run.code).toBe(0);
    expect(tty.rawModeCalls).toEqual([true, false]);
    expect(run.stdout + run.stderr).not.toContain(password.slice(0, 12));
  });
});

describe('ATK-5: the host-key answer records exactly one line', () => {
  it('a CR ending the password and its LF in the next chunk are one line end', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const cwd = await tempDir();
    const knownHosts = await emptyKnownHosts();
    const tty = fakeTty();
    const stderr = new Capture();
    const running = cli(
      [
        'ls',
        '--known-hosts',
        knownHosts,
        `sftp://tester@127.0.0.1:${fixture.port}/`,
      ],
      { registry: registry(), cwd, home: cwd, stdin: tty, stderr },
    );
    await typeAfterPrompt(stderr, PASSWORD_PROMPT, tty, [`${password}\r`]);
    await typeAfterPrompt(stderr, HOST_KEY_PROMPT, tty, ['\nyes\n']);
    const run = await running;

    expect(run.code).toBe(0);
    expect(await readFile(knownHosts, 'utf8')).toBe(
      `${fixture.knownHostsLine}\n`,
    );
  });

  it('lines typed after yes are never recorded', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const cwd = await tempDir();
    const knownHosts = await emptyKnownHosts();
    const forged = generateKey();
    const tty = fakeTty();
    const stderr = new Capture();
    const running = cli(
      [
        'ls',
        '--known-hosts',
        knownHosts,
        `sftp://tester@127.0.0.1:${fixture.port}/`,
      ],
      {
        registry: registry(),
        cwd,
        home: cwd,
        stdin: tty,
        stderr,
        env: { CYBERDUCK_RECAP_PASSWORD: password },
      },
    );
    await typeAfterPrompt(stderr, HOST_KEY_PROMPT, tty, [
      `yes\nevil.example ${forged.publicKey}\n@cert-authority * ${forged.publicKey}\r\n`,
    ]);
    const run = await running;

    expect(run.code).toBe(0);
    expect(await readFile(knownHosts, 'utf8')).toBe(
      `${fixture.knownHostsLine}\n`,
    );
  });

  it.each([
    [
      'an encoded line feed',
      (port: number) => `127.0.0.1%0Aevil.example:${port}`,
    ],
    ['a host list', (port: number) => `127.0.0.1,evil.example:${port}`],
    ['an encoded space', (port: number) => `127.0.0.1%20evil.example:${port}`],
    ['an encoded wildcard', (port: number) => `127.0.0.%2A:${port}`],
  ])(
    'a URL host with %s is refused before any prompt or connection',
    async (_label, hostOf) => {
      const password = sentinel();
      const fixture = await useServer({ password });
      const cwd = await tempDir();
      const knownHosts = await emptyKnownHosts();
      const tty = fakeTty();
      tty.write('yes\n');
      const run = await cli(
        [
          'ls',
          '--known-hosts',
          knownHosts,
          `sftp://tester@${hostOf(fixture.port)}/`,
        ],
        {
          registry: registry(),
          cwd,
          home: cwd,
          stdin: tty,
          env: { CYBERDUCK_RECAP_PASSWORD: password },
        },
      );

      expect([2, 21]).toContain(run.code);
      expect(run.stderr).not.toContain(HOST_KEY_PROMPT);
      expect(
        stderrLines(run.stderr).some((line) => line.startsWith('evil')),
      ).toBe(false);
      expect(fixture.stats.connections).toBe(0);
      expect(await readFile(knownHosts, 'utf8')).toBe('');
    },
  );
});
