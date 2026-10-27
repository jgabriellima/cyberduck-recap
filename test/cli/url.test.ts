import { mkdir } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cli, testRegistry, useCliServer } from '../support/cli.js';
import { sentinel, tempDir } from '../support/harness.js';
import { memBackend } from '../support/mem-backend.js';

// Records the options the SFTP factory builds, without changing what SftpFileSystem does; with
// `block` set, connect() fails before any network traffic, so no test resolves a real host name.
const captured = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  block: false,
}));

vi.mock('../../src/sftp/sftp-file-system.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/sftp/sftp-file-system.js')>();
  const { RemoteFsError } = await import('../../src/fs/errors.js');
  class RecordingSftpFileSystem extends original.SftpFileSystem {
    constructor(
      options: ConstructorParameters<typeof original.SftpFileSystem>[0],
    ) {
      captured.options.push({ ...options });
      super(options);
    }

    override connect(): Promise<void> {
      if (captured.block) {
        return Promise.reject(
          new RemoteFsError('CONNECTION_FAILED', 'blocked by the test'),
        );
      }
      return super.connect();
    }
  }
  return { ...original, SftpFileSystem: RecordingSftpFileSystem };
});

afterEach(() => {
  captured.options.length = 0;
  captured.block = false;
});

describe('URL handling (FEATURE-2 AC-3, AC-4)', () => {
  it.each([
    ['mem://u@h', '.'],
    ['mem://u@h/', '/'],
    ['mem://u@h/a/b', '/a/b'],
    ['mem://u@h/a%20b', '/a b'],
    ['mem://u@h/%C3%A9', '/é'],
  ])(
    'AC-3: maps the URL path to the remote path (%s -> %s)',
    async (url, remotePath) => {
      const mem = memBackend();

      await cli(['ls', url], {
        env: { CYBERDUCK_RECAP_PASSWORD: sentinel() },
        registry: testRegistry({ mem: mem.factory }),
      });

      expect(mem.calls.list).toEqual([remotePath]);
    },
  );

  it('AC-4: passes host and port from the URL to the back-end (the server)', async () => {
    const server = await useCliServer();
    await mkdir(server.fixture.local('/dir'));

    const result = await cli(
      ['ls', '--known-hosts', server.knownHostsPath, server.url('/dir')],
      { env: server.env },
    );

    expect(result.code).toBe(0);
    expect(server.fixture.stats.connections).toBe(1);
    expect(captured.options[0]).toMatchObject({
      host: '127.0.0.1',
      port: server.fixture.port,
      username: 'tester',
    });
  });

  it.each([
    ['sftp://tester@[::1]:2222/', '::1', 2222],
    ['sftp://tester@example.com/', 'example.com', 22],
  ])(
    'AC-4: passes host and port from the URL to the back-end (%s)',
    async (url, host, port) => {
      captured.block = true;
      const knownHosts = `${await tempDir()}/known_hosts`;

      await cli(['ls', '--known-hosts', knownHosts, url], {
        env: { CYBERDUCK_RECAP_PASSWORD: sentinel() },
      });

      expect(captured.options).toHaveLength(1);
      const options = captured.options[0] ?? {};
      expect(options['host']).toBe(host);
      // SftpFileSystem's own default port is 22, so an omitted port also gives 22.
      expect(options['port'] ?? 22).toBe(port);
    },
  );
});
