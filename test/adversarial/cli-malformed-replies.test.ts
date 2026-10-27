/**
 * Adversarial (FEATURE-2), topic "malformed reply part names": a trusted SFTP server whose reply
 * lacks the part its request needs (handle, attributes, entries, data). The back-end names that
 * part in a MalformedReplyError and maps it to OPERATION_FAILED; the CLI must turn it into exit 22
 * and one error line that names the part. A CLI that lets it through as a non-RemoteFsError
 * reports a server fault as a defect of the program (INTERNAL, exit 1), which sends people to file
 * bug reports for a broken server.
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
  RAW_ESCAPED_SET,
  cli,
  namesIn,
  registry,
  stderrLines,
  type CliRun,
} from './support/cli-harness.js';

const FILE_HANDLE = Buffer.from([0, 0, 0, 1]);
const DIR_HANDLE = Buffer.from([0, 0, 0, 2]);
const FILE_BYTES = Buffer.from('remote file content\n');

const FILE_ATTRS = {
  mode: 0o100644,
  size: FILE_BYTES.length,
  uid: 0,
  gid: 0,
  atime: 0,
  mtime: 0,
};
const DIR_ATTRS = { ...FILE_ATTRS, mode: 0o040755, size: 0 };

type Handler = (sftp: HostileSftp, id: number, ...args: unknown[]) => void;

interface Script {
  /** Replaces the well-formed answer for one request type. */
  readonly override?: Readonly<Record<string, Handler>>;
  /** Remote paths that exist as files; '/' and '/dir' are directories. */
  readonly files?: readonly string[];
}

interface Served {
  readonly server: HostileServer;
  /** Request types the server received, in order: what the CLI asked for. */
  readonly requests: string[];
}

/**
 * A server that answers every request the CLI may make, so a test hangs only when the CLI does:
 * a request the script left unanswered would stall the client and hide the real outcome.
 */
async function serve(script: Script): Promise<Served & { password: string }> {
  const password = sentinel();
  const requests: string[] = [];
  const files = new Set(script.files ?? []);
  const attrsOf = (sftp: HostileSftp, id: number, path: string): void => {
    if (path === '/' || path === '/dir') sftp.attrs(id, DIR_ATTRS);
    else if (files.has(path)) sftp.attrs(id, FILE_ATTRS);
    else sftp.status(id, STATUS.NO_SUCH_FILE, 'No such file');
  };
  let listed = false;
  const base: Record<string, Handler> = {
    REALPATH: (sftp, id) =>
      sftp.name(id, [{ filename: '/', longname: '/', attrs: DIR_ATTRS }]),
    STAT: (sftp, id, path) => attrsOf(sftp, id, String(path)),
    LSTAT: (sftp, id, path) => attrsOf(sftp, id, String(path)),
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
    OPENDIR: (sftp, id) => sftp.handle(id, DIR_HANDLE),
    READDIR: (sftp, id) => {
      if (listed) {
        sftp.status(id, STATUS.EOF, 'EOF');
        return;
      }
      listed = true;
      sftp.name(id, [
        { filename: 'a.txt', longname: 'a.txt', attrs: FILE_ATTRS },
      ]);
    },
  };
  for (const ok of [
    'CLOSE',
    'SETSTAT',
    'FSETSTAT',
    'REMOVE',
    'RENAME',
    'MKDIR',
    'RMDIR',
  ]) {
    base[ok] = (sftp, id) => sftp.status(id, STATUS.OK, 'OK');
  }
  const handlers = { ...base, ...script.override };

  const server = await startHostileServer({
    password,
    serve: (sftp) => {
      for (const [type, handler] of Object.entries(handlers)) {
        sftp.on(type, (id: number, ...args: unknown[]) => {
          requests.push(type);
          handler(sftp, id, ...args);
        });
      }
    },
  });
  onTestFinished(() => server.close());
  return { server, requests, password };
}

async function run(
  served: Served & { password: string },
  args: (url: (path: string) => string) => string[],
  cwd: string,
): Promise<CliRun> {
  const knownHosts = join(await tempDir(), 'known_hosts');
  await writeFile(knownHosts, `${served.server.knownHostsLine}\n`);
  const url = (path: string): string =>
    `sftp://tester@127.0.0.1:${served.server.port}${path}`;
  const [command = '', ...rest] = args(url);
  return cli([command, '--known-hosts', knownHosts, ...rest], {
    registry: registry(),
    cwd,
    home: cwd,
    env: { CYBERDUCK_RECAP_PASSWORD: served.password },
  });
}

/**
 * The part is our own word for what the reply lacked: the person reads it to tell a broken server
 * from a refused request, so the line must carry it and nothing the server chose.
 */
function expectOneMalformedLine(result: CliRun, part: string): void {
  expect(result.code).toBe(22);
  expect(result.stdout).toBe('');
  const lines = stderrLines(result.stderr);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^cyberduck-recap: OPERATION_FAILED: /);
  expect(lines[0]).toContain(part);
  expect(RAW_ESCAPED_SET.test(result.stderr.replace(/\n$/, ''))).toBe(false);
  expect(result.stderr).not.toMatch(/^\s+at /m);
}

const bareOk: Handler = (sftp, id) => sftp.status(id, STATUS.OK, 'OK');

describe('ATK-7: ls against a reply without its part', () => {
  it.each([
    ['OPENDIR', 'directory handle'],
    ['READDIR', 'directory entries'],
  ])(
    '%s answered with a bare OK names the %s in one line, exit 22',
    async (request, part) => {
      const served = await serve({ override: { [request]: bareOk } });
      const result = await run(
        served,
        (url) => ['ls', url('/dir')],
        await tempDir(),
      );

      expectOneMalformedLine(result, part);
    },
  );
});

describe('ATK-7: get against a reply without its part', () => {
  it('OPEN answered with a bare OK names the file handle and leaves no file behind', async () => {
    const served = await serve({
      files: ['/f.bin'],
      override: { OPEN: bareOk },
    });
    const cwd = await tempDir();
    const result = await run(
      served,
      (url) => ['get', url('/f.bin'), join(cwd, 'f.bin')],
      cwd,
    );

    expectOneMalformedLine(result, 'file handle');
    // A temporary file left by a failed get is a second outcome the person must clean up.
    expect(namesIn(cwd)).toEqual([]);
  });

  it('READ answered with a bare OK (no data, no EOF) exits 22, no hang, no file', async () => {
    // ssh2 turns a bare OK to READ into a zero-byte success; the stream must give up, not spin.
    const served = await serve({
      files: ['/f.bin'],
      override: { READ: bareOk },
    });
    const cwd = await tempDir();
    const result = await run(
      served,
      (url) => ['get', url('/f.bin'), join(cwd, 'f.bin')],
      cwd,
    );

    expect(result.code).toBe(22);
    const lines = stderrLines(result.stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^cyberduck-recap: OPERATION_FAILED: /);
    expect(namesIn(cwd)).toEqual([]);
  });
});

describe('ATK-7: put against a reply without its part', () => {
  it('STAT answered with a bare OK names the attributes and writes nothing remote', async () => {
    // put decides "directory" and "exists" from the stat; a reply that answers neither must
    // stop the upload, or a file the person did not mean to replace is overwritten.
    const served = await serve({
      override: { STAT: bareOk, LSTAT: bareOk, FSTAT: bareOk },
    });
    const cwd = await tempDir();
    const local = join(cwd, 'up.bin');
    await writeFile(local, 'local bytes');
    const result = await run(
      served,
      (url) => ['put', local, url('/up.bin')],
      cwd,
    );

    expectOneMalformedLine(result, 'attributes');
    expect(served.requests).not.toContain('OPEN');
    expect(served.requests).not.toContain('WRITE');
  });

  it('OPEN answered with a bare OK names the file handle and never reports success', async () => {
    const served = await serve({ override: { OPEN: bareOk } });
    const cwd = await tempDir();
    const local = join(cwd, 'up.bin');
    await writeFile(local, 'local bytes');
    const result = await run(
      served,
      (url) => ['put', local, url('/up.bin')],
      cwd,
    );

    expectOneMalformedLine(result, 'file handle');
    expect(served.requests).not.toContain('WRITE');
  });
});
