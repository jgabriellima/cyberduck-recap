import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIB_5,
  bytes,
  cli,
  errorLine,
  hintFollowsError,
  isRoot,
  isWindows,
  serverFile,
  useCliServer,
} from '../support/cli.js';
import { sentinel, tempDir } from '../support/harness.js';

describe('cyberduck-recap put (FEATURE-2 AC-10 to AC-14)', () => {
  it.each([0, 1, MIB_5])(
    'AC-10: uploads byte-identical content (%i bytes)',
    async (length) => {
      const server = await useCliServer();
      const data = bytes(length);
      const local = join(await tempDir(), 'up.bin');
      await writeFile(local, data);

      const result = await cli(
        [
          'put',
          '--known-hosts',
          server.knownHostsPath,
          local,
          server.url('/up.bin'),
        ],
        { env: server.env },
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(
        (await readFile(server.fixture.local('/up.bin'))).equals(data),
      ).toBe(true);
    },
    60_000,
  );

  it.each([
    ['a', '/dir/', '/dir/x.bin'],
    ['b', '/dir', '/dir/x.bin'],
    ['c', '/dir/new.bin', '/dir/new.bin'],
  ])(
    'AC-11: chooses the remote destination (case %s: %s)',
    async (_case, remotePath, expected) => {
      const server = await useCliServer();
      await mkdir(server.fixture.local('/dir'));
      const local = join(await tempDir(), 'x.bin');
      await writeFile(local, 'local bytes');

      const result = await cli(
        [
          'put',
          '--known-hosts',
          server.knownHostsPath,
          local,
          server.url(remotePath),
        ],
        { env: server.env },
      );

      expect(result.code).toBe(0);
      expect(await readFile(server.fixture.local(expected), 'utf8')).toBe(
        'local bytes',
      );
    },
  );

  it('AC-12: refuses to replace a remote file without --overwrite', async () => {
    const server = await useCliServer();
    await serverFile(server.fixture, '/dir/x.bin', 'remote bytes');
    const local = join(await tempDir(), 'x.bin');
    await writeFile(local, 'local bytes');

    const result = await cli(
      [
        'put',
        '--known-hosts',
        server.knownHostsPath,
        local,
        server.url('/dir/x.bin'),
      ],
      { env: server.env },
    );

    expect(result.code).toBe(18);
    expect(errorLine(result)).toBe(
      'cyberduck-recap: ALREADY_EXISTS: /dir/x.bin exists; give --overwrite to replace it',
    );
    expect(await readFile(server.fixture.local('/dir/x.bin'), 'utf8')).toBe(
      'remote bytes',
    );
  });

  it('AC-12: replaces a remote file with --overwrite', async () => {
    const server = await useCliServer();
    await serverFile(
      server.fixture,
      '/dir/x.bin',
      'remote bytes, longer than the local ones',
    );
    const local = join(await tempDir(), 'x.bin');
    await writeFile(local, 'local bytes');

    const result = await cli(
      [
        'put',
        '--overwrite',
        '--known-hosts',
        server.knownHostsPath,
        local,
        server.url('/dir/x.bin'),
      ],
      { env: server.env },
    );

    expect(result.code).toBe(0);
    expect(await readFile(server.fixture.local('/dir/x.bin'), 'utf8')).toBe(
      'local bytes',
    );
  });

  it('AC-12: an exclusive open refused for another reason keeps its own exit code', async () => {
    const server = await useCliServer();
    const local = join(await tempDir(), 'x.bin');
    await writeFile(local, 'local bytes');

    const result = await cli(
      [
        'put',
        '--known-hosts',
        server.knownHostsPath,
        local,
        server.url('/missing/x.bin'),
      ],
      { env: server.env },
    );

    expect(result.code).toBe(16);
    expect(errorLine(result)).toMatch(/^cyberduck-recap: NOT_FOUND: /);
    expect(errorLine(result)).not.toContain('give --overwrite');
  });

  // A file mode cannot deny root, and Windows has no POSIX modes: the spec skips that case there.
  const unreadableCases = isRoot || isWindows ? [] : (['unreadable'] as const);

  it.each([...(['missing', 'directory'] as const), ...unreadableCases])(
    'AC-13: refuses a local file it cannot read (%s)',
    async (kind) => {
      const server = await useCliServer();
      const directory = await tempDir();
      let local = join(directory, 'missing.bin');
      let expected = `cyberduck-recap: LOCAL_FILE: ${local} does not exist`;
      if (kind === 'directory') {
        local = directory;
        expected = `cyberduck-recap: LOCAL_FILE: ${local} is a directory`;
      } else if (kind === 'unreadable') {
        local = join(directory, 'secret.bin');
        await writeFile(local, sentinel());
        await chmod(local, 0o000);
        expected = `cyberduck-recap: LOCAL_FILE: cannot read ${local}`;
      }

      const result = await cli(
        [
          'put',
          '--known-hosts',
          server.knownHostsPath,
          local,
          server.url('/up.bin'),
        ],
        { env: server.env },
      );

      expect(result.code).toBe(3);
      expect(errorLine(result)).toBe(expected);
      expect(server.fixture.stats.connections).toBe(0);
    },
  );

  it('AC-14: warns that an interrupted upload may leave a partial remote file', async () => {
    const server = await useCliServer();
    const local = join(await tempDir(), 'up.bin');
    await writeFile(local, bytes(MIB_5));
    server.fixture.dropAfterBytes(65_536);

    const result = await cli(
      [
        'put',
        '--known-hosts',
        server.knownHostsPath,
        local,
        server.url('/up.bin'),
      ],
      { env: server.env },
    );

    expect(result.code).toBe(14);
    expect(errorLine(result)).toMatch(/^cyberduck-recap: CONNECTION_LOST: /);
    const hint = 'cyberduck-recap: the remote file /up.bin may be incomplete';
    expect(result.stderrLines).toContain(hint);
    expect(hintFollowsError(result, hint)).toBe(true);
  }, 60_000);
});
