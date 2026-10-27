import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIB_5,
  USAGE_HINT,
  bytes,
  cli,
  errorLine,
  isWindows,
  serverFile,
  startCli,
  testRegistry,
  useCliServer,
} from '../support/cli.js';
import { sentinel, tempDir } from '../support/harness.js';
import { memBackend } from '../support/mem-backend.js';
import { waitUntil } from '../support/sftp-server.js';
import { existsSync, readdirSync } from 'node:fs';

const memEnv = { CYBERDUCK_RECAP_PASSWORD: 'mem-password' };

function withMem(): {
  mem: ReturnType<typeof memBackend>;
  registry: ReturnType<typeof testRegistry>;
} {
  const mem = memBackend();
  return { mem, registry: testRegistry({ mem: mem.factory }) };
}

/** The mode a file gets when created with the default 0o666 under this process's umask. */
async function defaultFileMode(): Promise<number> {
  const probe = join(await tempDir(), 'probe');
  await writeFile(probe, '');
  return (await stat(probe)).mode & 0o777;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('cyberduck-recap get (FEATURE-2 AC-5 to AC-9, AC-41, AC-42)', () => {
  it.each([0, 1, MIB_5])(
    'AC-5: downloads byte-identical content (%i bytes)',
    async (length) => {
      const server = await useCliServer();
      const data = bytes(length);
      await serverFile(server.fixture, '/file.bin', data);
      const destination = join(await tempDir(), 'file.bin');

      const result = await cli(
        [
          'get',
          '--known-hosts',
          server.knownHostsPath,
          server.url('/file.bin'),
          destination,
        ],
        { env: server.env },
      );

      expect((await readFile(destination)).equals(data)).toBe(true);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    },
    60_000,
  );

  it.each(['a', 'b', 'c'] as const)(
    'AC-6: chooses the local destination (case %s)',
    async (variant) => {
      const { mem, registry } = withMem();
      mem.file('/docs/r.pdf', 'remote bytes');
      const cwd = await tempDir();
      const directory = await tempDir();
      const plain = join(await tempDir(), 'other.bin');
      const cases = {
        a: { args: [] as string[], expected: join(cwd, 'r.pdf') },
        b: { args: [directory], expected: join(directory, 'r.pdf') },
        c: { args: [plain], expected: plain },
      };
      const { args, expected } = cases[variant];

      const result = await cli(['get', 'mem://u@h/docs/r.pdf', ...args], {
        cwd,
        env: memEnv,
        registry,
      });

      expect(result.code).toBe(0);
      expect(await readFile(expected, 'utf8')).toBe('remote bytes');
    },
  );

  it('AC-6: refuses a destination in a missing directory', async () => {
    const { mem, registry } = withMem();
    mem.file('/docs/r.pdf', 'remote bytes');

    const result = await cli(
      ['get', 'mem://u@h/docs/r.pdf', '/no/such/dir/file'],
      { env: memEnv, registry },
    );

    expect(result.code).toBe(3);
    expect(errorLine(result)).toBe(
      'cyberduck-recap: LOCAL_FILE: the directory /no/such/dir does not exist',
    );
    expect(mem.calls.connect).toBe(0);
    expect(mem.calls.read).toEqual([]);
    expect(existsSync('/no/such/dir')).toBe(false);
  });

  const noBasename = (path: string): string =>
    `cyberduck-recap: USAGE: the remote path '${path}' has no file name; give a local file path`;

  it.each([
    ['mem://u@h/', '/'],
    ['mem://u@h/a/.', '/a/'],
    ['mem://u@h/a/..', '/'],
    ['mem://u@h/a/', '/a/'],
    ['mem://u@h', '.'],
  ])(
    'AC-7: refuses a remote path without a usable basename (%s)',
    async (url, shown) => {
      for (const withDirectory of [false, true]) {
        const { mem, registry } = withMem();
        const cwd = await tempDir();
        const args = withDirectory ? [url, await tempDir()] : [url];

        const result = await cli(['get', ...args], {
          cwd,
          env: memEnv,
          registry,
        });

        expect(result.code).toBe(2);
        expect(result.stderrLines[0]).toBe(noBasename(shown));
        expect(result.stderrLines[1]).toBe(USAGE_HINT);
        expect(mem.calls.connect).toBe(0);
        expect(await readdir(cwd)).toEqual([]);
      }
    },
  );

  it.each(['a file', 'a link to a file', 'a link to a missing file'] as const)(
    'AC-8: refuses to replace a local file without --overwrite (%s)',
    async (kind) => {
      const { mem, registry } = withMem();
      mem.file('/r.bin', 'remote bytes');
      const directory = await tempDir();
      const destination = join(directory, 'r.bin');
      const target = join(directory, 'target');
      if (kind === 'a file') {
        await writeFile(destination, 'local bytes');
      } else {
        if (kind === 'a link to a file') {
          await writeFile(target, 'target bytes');
        }
        await symlink(target, destination);
      }

      const result = await cli(['get', 'mem://u@h/r.bin', destination], {
        env: memEnv,
        registry,
      });

      expect(result.code).toBe(3);
      expect(errorLine(result)).toBe(
        `cyberduck-recap: LOCAL_FILE: ${destination} exists; give --overwrite to replace it`,
      );
      expect(mem.calls.connect).toBe(0);
      if (kind === 'a file') {
        expect(await readFile(destination, 'utf8')).toBe('local bytes');
      } else {
        expect(await readlink(destination)).toBe(target);
        if (kind === 'a link to a file') {
          expect(await readFile(target, 'utf8')).toBe('target bytes');
        } else {
          expect(existsSync(target)).toBe(false);
        }
      }
    },
  );

  it('AC-8: replaces a local file with --overwrite', async () => {
    const { mem, registry } = withMem();
    mem.file('/r.bin', 'remote bytes');
    const destination = join(await tempDir(), 'r.bin');
    await writeFile(destination, 'local bytes, longer than the remote ones');

    const result = await cli(
      ['get', '--overwrite', 'mem://u@h/r.bin', destination],
      { env: memEnv, registry },
    );

    expect(result.code).toBe(0);
    expect(await readFile(destination, 'utf8')).toBe('remote bytes');
  });

  const failures = [
    { name: 'the remote path does not exist', exit: 16 },
    { name: 'the remote path is a directory', exit: 20 },
    { name: 'the connection drops after 65 536 bytes', exit: 14 },
  ] as const;

  it.each(
    failures.flatMap((failure) => [
      { ...failure, existing: false },
      { ...failure, existing: true },
    ]),
  )(
    'AC-9: leaves the destination unchanged when the download fails ($name, existing destination: $existing)',
    async ({ name, exit, existing }) => {
      const server = await useCliServer();
      await serverFile(server.fixture, '/big.bin', bytes(MIB_5));
      await mkdir(server.fixture.local('/folder'));
      const remote = {
        'the remote path does not exist': '/missing.bin',
        'the remote path is a directory': '/folder',
        'the connection drops after 65 536 bytes': '/big.bin',
      }[name];
      if (name === 'the connection drops after 65 536 bytes') {
        server.fixture.dropAfterBytes(65_536);
      }
      const directory = await tempDir();
      const destination = join(directory, 'download.bin');
      const earlier = Buffer.from(sentinel());
      if (existing) await writeFile(destination, earlier);
      const before = (await readdir(directory)).sort();

      const result = await cli(
        [
          'get',
          ...(existing ? ['--overwrite'] : []),
          '--known-hosts',
          server.knownHostsPath,
          server.url(remote),
          destination,
        ],
        { env: server.env },
      );

      expect(result.code).toBe(exit);
      expect((await readdir(directory)).sort()).toEqual(before);
      if (existing) {
        expect((await readFile(destination)).equals(earlier)).toBe(true);
      } else {
        expect(existsSync(destination)).toBe(false);
      }
    },
    60_000,
  );

  it.skipIf(isWindows)(
    'AC-41: writes the download to a private temporary file',
    async () => {
      const { mem, registry } = withMem();
      mem.file('/f.bin', bytes(10));
      mem.pauseAfter(1);
      const directory = await tempDir();
      const destination = join(directory, 'f.bin');
      const temporary = new RegExp(
        `^\\.${escapeRegExp('f.bin')}\\.[0-9a-f]{16}\\.part$`,
      );

      const started = await startCli(['get', 'mem://u@h/f.bin', destination], {
        env: memEnv,
        registry,
      });
      await mem.whenPaused();
      await waitUntil(() =>
        readdirSync(directory).some((name) => temporary.test(name)),
      );

      const names = await readdir(directory);
      expect(names).toHaveLength(1);
      const [name = ''] = names;
      expect(name).toMatch(temporary);
      expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);

      mem.release();
      const result = await started.done;
      expect(result.code).toBe(0);
      expect(await readdir(directory)).toEqual(['f.bin']);
      expect((await readFile(destination)).equals(bytes(10))).toBe(true);
    },
  );

  it.skipIf(isWindows)(
    'AC-41: gives the downloaded file the default mode',
    async () => {
      const { mem, registry } = withMem();
      mem.file('/f.bin', bytes(10));
      const destination = join(await tempDir(), 'f.bin');

      const result = await cli(['get', 'mem://u@h/f.bin', destination], {
        env: memEnv,
        registry,
      });

      expect(result.code).toBe(0);
      expect((await stat(destination)).mode & 0o777).toBe(
        await defaultFileMode(),
      );
    },
  );

  it.skipIf(isWindows)(
    'AC-41: keeps the mode of an overwritten file',
    async () => {
      const { mem, registry } = withMem();
      mem.file('/f.bin', bytes(10));
      const destination = join(await tempDir(), 'f.bin');
      await writeFile(destination, 'old');
      await chmod(destination, 0o600);

      const result = await cli(
        ['get', '--overwrite', 'mem://u@h/f.bin', destination],
        { env: memEnv, registry },
      );

      expect(result.code).toBe(0);
      expect((await readFile(destination)).equals(bytes(10))).toBe(true);
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
    },
  );

  it('AC-42: replaces a symbolic link, not its target, with --overwrite', async () => {
    const { mem, registry } = withMem();
    mem.file('/f.bin', 'remote bytes');
    const directory = await tempDir();
    const target = join(directory, 'target.txt');
    const destination = join(directory, 'f.bin');
    await writeFile(target, 'target bytes');
    await symlink(target, destination);

    const result = await cli(
      ['get', '--overwrite', 'mem://u@h/f.bin', destination],
      { env: memEnv, registry },
    );

    expect(result.code).toBe(0);
    const after = await lstat(destination);
    expect(after.isSymbolicLink()).toBe(false);
    expect(after.isFile()).toBe(true);
    expect(await readFile(destination, 'utf8')).toBe('remote bytes');
    expect(await readFile(target, 'utf8')).toBe('target bytes');
  });
});
