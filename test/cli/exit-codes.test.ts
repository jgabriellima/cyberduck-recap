import { mkdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { REMOTE_FS_ERROR_CODES, RemoteFsError } from '../../src/fs/index.js';
import {
  EXIT_CODES,
  cli,
  errorLine,
  serverFile,
  testRegistry,
  useCliServer,
} from '../support/cli.js';
import { sentinel } from '../support/harness.js';
import { memBackend } from '../support/mem-backend.js';
import { unusedPort } from '../support/sftp-server.js';

describe('exit codes (FEATURE-2 AC-15, AC-16)', () => {
  it('AC-15: the table gives every RemoteFsError code a distinct exit code from 10 to 22', () => {
    const exits = REMOTE_FS_ERROR_CODES.map((code) => EXIT_CODES[code]);

    expect(REMOTE_FS_ERROR_CODES).toHaveLength(13);
    expect(new Set(exits).size).toBe(REMOTE_FS_ERROR_CODES.length);
    for (const exit of exits) {
      expect(exit).toBeGreaterThanOrEqual(10);
      expect(exit).toBeLessThanOrEqual(22);
    }
  });

  it.each(REMOTE_FS_ERROR_CODES)(
    'AC-15: maps every RemoteFsError code to its exit code and error line (%s)',
    async (code) => {
      const expectedExit = EXIT_CODES[code];
      // A code that the table does not name fails here until it has an exit code.
      expect(expectedExit, `no exit code for ${code}`).toBeDefined();
      const mem = memBackend();
      mem.faults.list = new RemoteFsError(code, 'm', { path: '/p' });

      const result = await cli(['ls', 'mem://u@h/p'], {
        env: { CYBERDUCK_RECAP_PASSWORD: sentinel() },
        registry: testRegistry({ mem: mem.factory }),
      });

      expect(result.code).toBe(expectedExit);
      expect(result.stderrLines[0]).toBe(`cyberduck-recap: ${code}: m (/p)`);
      expect(errorLine(result)).toBe(`cyberduck-recap: ${code}: m (/p)`);
    },
  );

  it.each([
    ['a wrong password', 'AUTH_FAILED', 10],
    ['ls of a missing path', 'NOT_FOUND', 16],
    ['ls of a denied path', 'PERMISSION_DENIED', 17],
    ['ls of a file', 'NOT_A_DIRECTORY', 19],
    ['a port with no listener', 'CONNECTION_FAILED', 13],
  ] as const)(
    "AC-16: reports the server's failures with their exit codes (%s)",
    async (name, code, exit) => {
      const server = await useCliServer();
      await mkdir(server.fixture.local('/denied'));
      await serverFile(server.fixture, '/file.txt', 'text');
      server.fixture.deny('/denied');
      let url = server.url('/');
      let env: Record<string, string> = server.env;
      if (name === 'a wrong password') {
        env = { CYBERDUCK_RECAP_PASSWORD: sentinel() };
      } else if (name === 'ls of a missing path') {
        url = server.url('/missing');
      } else if (name === 'ls of a denied path') {
        url = server.url('/denied');
      } else if (name === 'ls of a file') {
        url = server.url('/file.txt');
      } else {
        url = `sftp://tester@127.0.0.1:${await unusedPort()}/`;
      }

      const result = await cli(
        ['ls', '--known-hosts', server.knownHostsPath, url],
        { env },
      );

      expect(result.code).toBe(exit);
      expect(errorLine(result).startsWith(`cyberduck-recap: ${code}: `)).toBe(
        true,
      );
    },
  );
});
