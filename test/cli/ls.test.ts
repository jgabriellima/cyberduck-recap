import { mkdir, symlink } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { cli, serverFile, useCliServer } from '../support/cli.js';
import { newFs } from '../support/harness.js';

describe('cyberduck-recap ls (FEATURE-2 AC-1, AC-2)', () => {
  it('AC-1: lists a directory one entry per line in name order', async () => {
    const server = await useCliServer();
    const { fixture } = server;
    await serverFile(fixture, '/d/a.txt', 'hello');
    await mkdir(fixture.local('/d/sub'));
    await symlink('a.txt', fixture.local('/d/link'));
    // The expected fields come from the back-end itself: the criterion ties each line to the
    // entry's own size and modifiedAt.
    const library = newFs(fixture, server.knownHostsPath, {
      password: server.password,
    });
    await library.connect();
    const entries = new Map(
      (await library.list('/d')).map((entry) => [entry.name, entry]),
    );
    const iso = (name: string): string =>
      entries.get(name)?.modifiedAt.toISOString() ?? 'missing';
    const size = (name: string): number => entries.get(name)?.size ?? -1;

    const result = await cli(
      ['ls', '--known-hosts', server.knownHostsPath, server.url('/d')],
      { env: server.env },
    );

    expect(result.stdout).toBe(
      [
        `-\t5\t${iso('a.txt')}\ta.txt`,
        `l\t${size('link')}\t${iso('link')}\tlink`,
        `d\t${size('sub')}\t${iso('sub')}\tsub`,
        '',
      ].join('\n'),
    );
    expect(result.stdoutLines).toHaveLength(3);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

  it('AC-1: sorts by UTF-16 code unit, upper case before lower case', async () => {
    const server = await useCliServer();
    for (const name of ['b', 'a', 'C']) {
      await serverFile(server.fixture, `/d/${name}`, '');
    }

    const result = await cli(
      ['ls', '--known-hosts', server.knownHostsPath, server.url('/d')],
      { env: server.env },
    );

    expect(result.stdoutLines.map((line) => line.split('\t')[3])).toEqual([
      'C',
      'a',
      'b',
    ]);
    expect(result.code).toBe(0);
  });

  it('AC-2: lists an empty directory as no lines', async () => {
    const server = await useCliServer();
    await mkdir(server.fixture.local('/empty'));

    const result = await cli(
      ['ls', '--known-hosts', server.knownHostsPath, server.url('/empty')],
      { env: server.env },
    );

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });
});
