/**
 * Adversarial (FEATURE-2), topic "session lifecycle": the SFTP session ends while the CLI waits on
 * it, through the real back-end (cyberduck/standard.session-ending-settles-once). The transport
 * closes before an OPEN gets its reply, or in the middle of the READ or WRITE window; the SFTP
 * channel alone ends in the middle of a READ. Each pending request and stream must settle once
 * with one typed error, so the CLI writes one CONNECTION_LOST line (exit 14) and resolves: never
 * INTERNAL, a second error line, a hang, or a temporary file left in the destination directory.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { sentinel, tempDir } from '../support/harness.js';
import {
  STATUS,
  startHostileServer,
  type HostileServer,
  type HostileSftp,
} from '../support/hostile-sftp-server.js';
import {
  cli,
  namesIn,
  registry,
  stderrLines,
  type CliRun,
} from './support/cli-harness.js';

const FILE_HANDLE = Buffer.from([0, 0, 0, 1]);
// Several READ and WRITE requests, so the end lands while some are still in flight.
const FILE_BYTES = Buffer.alloc(512 * 1024, 0x61);
const FILE_ATTRS = {
  mode: 0o100644,
  size: FILE_BYTES.length,
  uid: 0,
  gid: 0,
  atime: 0,
  mtime: 0,
};
const DIR_ATTRS = { ...FILE_ATTRS, mode: 0o040755, size: 0 };

/** How the session ends: the whole transport, or only the SFTP channel. */
type Ending = 'transport' | 'channel';

interface Plan {
  /** The request that ends the session instead of its reply. */
  readonly endAt: 'OPEN' | 'READ' | 'WRITE';
  /** How many requests of that type get a normal reply first. */
  readonly after: number;
  readonly ending: Ending;
}

interface Served {
  readonly server: HostileServer;
  readonly password: string;
}

type Handler = (sftp: HostileSftp, id: number, ...args: unknown[]) => void;

async function serve(plan: Plan): Promise<Served> {
  const password = sentinel();
  let seen = 0;
  let ended = false;
  const end = (sftp: HostileSftp): void => {
    if (ended) return;
    ended = true;
    if (plan.ending === 'channel') sftp.end();
    // The server exists by the time any request arrives.
    else void server.close();
  };
  const exists = (path: string): boolean => path === '/f.bin';
  const handlers: Record<string, Handler> = {
    REALPATH: (sftp, id) =>
      sftp.name(id, [{ filename: '/', longname: '/', attrs: DIR_ATTRS }]),
    STAT: (sftp, id, path) =>
      exists(String(path))
        ? sftp.attrs(id, FILE_ATTRS)
        : sftp.status(id, STATUS.NO_SUCH_FILE, 'No such file'),
    LSTAT: (sftp, id, path) =>
      exists(String(path))
        ? sftp.attrs(id, FILE_ATTRS)
        : sftp.status(id, STATUS.NO_SUCH_FILE, 'No such file'),
    FSTAT: (sftp, id) => sftp.attrs(id, FILE_ATTRS),
    OPEN: (sftp, id) => sftp.handle(id, FILE_HANDLE),
    READ: (sftp, id, _handle, offset, length) => {
      const start = Number(offset);
      if (start >= FILE_BYTES.length) {
        sftp.status(id, STATUS.EOF, 'EOF');
        return;
      }
      sftp.data(id, FILE_BYTES.subarray(start, start + Number(length)));
    },
    WRITE: (sftp, id) => sftp.status(id, STATUS.OK, 'OK'),
  };
  for (const ok of ['CLOSE', 'SETSTAT', 'FSETSTAT', 'REMOVE', 'RENAME']) {
    handlers[ok] = (sftp, id) => sftp.status(id, STATUS.OK, 'OK');
  }
  const server: HostileServer = await startHostileServer({
    password,
    serve: (sftp) => {
      for (const [type, handler] of Object.entries(handlers)) {
        sftp.on(type, (id: number, ...args: unknown[]) => {
          if (ended) return;
          if (type === plan.endAt) {
            seen += 1;
            if (seen > plan.after) {
              end(sftp);
              return;
            }
          }
          handler(sftp, id, ...args);
        });
      }
    },
  });
  onTestFinished(() => server.close());
  return { server, password };
}

async function run(
  served: Served,
  args: string[],
  cwd: string,
): Promise<CliRun> {
  const knownHosts = join(await tempDir(), 'known_hosts');
  await writeFile(knownHosts, `${served.server.knownHostsLine}\n`);
  const [command = '', ...rest] = args;
  return cli([command, '--known-hosts', knownHosts, ...rest], {
    registry: registry(),
    cwd,
    home: cwd,
    env: { CYBERDUCK_RECAP_PASSWORD: served.password },
  });
}

/** One typed error line; hint lines (no code) may follow it, a second error line may not. */
function expectOneLostLine(result: CliRun): void {
  expect(result.code).toBe(14);
  expect(result.stdout).toBe('');
  const errors = stderrLines(result.stderr).filter((line) =>
    /^cyberduck-recap: [A-Z_]+: /.test(line),
  );
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(/^cyberduck-recap: CONNECTION_LOST: /);
  expect(result.stderr).not.toMatch(/AggregateError|^\s+at /m);
}

const url = (served: Served, path: string): string =>
  `sftp://tester@127.0.0.1:${served.server.port}${path}`;

describe('ATK-69: the session ends while get waits on it', () => {
  it.each<Plan>([
    { endAt: 'OPEN', after: 0, ending: 'transport' },
    { endAt: 'READ', after: 1, ending: 'transport' },
    { endAt: 'READ', after: 1, ending: 'channel' },
  ])(
    'at $endAt after $after replies ($ending): exit 14, one line, no file',
    async (plan) => {
      const served = await serve(plan);
      const cwd = await tempDir();
      const result = await run(served, ['get', url(served, '/f.bin')], cwd);

      expectOneLostLine(result);
      expect(namesIn(cwd)).toEqual([]);
    },
  );
});

describe('ATK-69: the session ends while put waits on it', () => {
  it.each<Plan>([
    { endAt: 'OPEN', after: 0, ending: 'transport' },
    { endAt: 'WRITE', after: 1, ending: 'transport' },
  ])(
    'at $endAt after $after replies ($ending): exit 14, one error line',
    async (plan) => {
      const served = await serve(plan);
      const cwd = await tempDir();
      await writeFile(join(cwd, 'up.bin'), FILE_BYTES);
      const result = await run(
        served,
        ['put', 'up.bin', url(served, '/up.bin')],
        cwd,
      );

      expectOneLostLine(result);
    },
  );
});
