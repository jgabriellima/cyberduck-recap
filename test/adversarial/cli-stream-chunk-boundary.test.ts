/**
 * Adversarial (FEATURE-2), topic "stream chunk size documentation": the SFTP streams split a
 * transfer into CHUNK_SIZE requests with WINDOW of them in flight. An off-by-one at a chunk edge,
 * or a short or long READ reply that shifts the next offset, corrupts a file without any error, so
 * `get` and `put` must stay byte-identical at every edge. The doc comments are the only record of
 * why the numbers are what they are; FEATURE-1 shipped a comment that no longer matched the
 * constant, so the figures they state are checked here against the code.
 */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { CHUNK_SIZE, WINDOW } from '../../src/sftp/streams.js';
import { sentinel, tempDir, useServer } from '../support/harness.js';
import {
  STATUS,
  startHostileServer,
  type HostileSftp,
} from '../support/hostile-sftp-server.js';
import { cli, namesIn, registry, stderrLines } from './support/cli-harness.js';

const KIB = 1024;
// 32 KiB is the size every SFTP v3 server must accept, and the size FEATURE-1 first documented:
// its edges are where a client that still assumes it would go wrong.
const SFTP_V3_MINIMUM = 32 * KIB;

const SIZES = [
  CHUNK_SIZE - 1,
  CHUNK_SIZE,
  CHUNK_SIZE + 1,
  2 * CHUNK_SIZE,
  SFTP_V3_MINIMUM - 1,
  SFTP_V3_MINIMUM,
  SFTP_V3_MINIMUM + 1,
  WINDOW * CHUNK_SIZE,
  WINDOW * CHUNK_SIZE + 1,
];

async function sftpSetup(): Promise<{
  fixture: Awaited<ReturnType<typeof useServer>>;
  env: Record<string, string>;
  cwd: string;
  knownHosts: string;
}> {
  const password = sentinel();
  const fixture = await useServer({ password });
  const cwd = await tempDir();
  const knownHosts = join(cwd, 'known_hosts');
  await writeFile(knownHosts, `${fixture.knownHostsLine}\n`);
  return {
    fixture,
    env: { CYBERDUCK_RECAP_PASSWORD: password },
    cwd,
    knownHosts,
  };
}

describe('ATK-8: transfers across the stream chunk boundary', () => {
  it.each(SIZES)(
    'get of %i bytes is byte-identical',
    async (size) => {
      const { fixture, env, cwd, knownHosts } = await sftpSetup();
      const data = randomBytes(size);
      await writeFile(fixture.local('/edge.bin'), data);
      const destination = join(cwd, 'edge.bin');

      const result = await cli(
        [
          'get',
          '--known-hosts',
          knownHosts,
          `sftp://tester@127.0.0.1:${fixture.port}/edge.bin`,
          destination,
        ],
        { registry: registry(), cwd, home: cwd, env },
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect((await readFile(destination)).equals(data)).toBe(true);
    },
    30_000,
  );

  it.each(SIZES)(
    'put of %i bytes is byte-identical',
    async (size) => {
      const { fixture, env, cwd, knownHosts } = await sftpSetup();
      const data = randomBytes(size);
      const local = join(cwd, 'edge.bin');
      await writeFile(local, data);

      const result = await cli(
        [
          'put',
          '--known-hosts',
          knownHosts,
          local,
          `sftp://tester@127.0.0.1:${fixture.port}/edge.bin`,
        ],
        { registry: registry(), cwd, home: cwd, env },
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect((await readFile(fixture.local('/edge.bin'))).equals(data)).toBe(
        true,
      );
    },
    30_000,
  );
});

const FILE_HANDLE = Buffer.from([0, 0, 0, 1]);

/**
 * A server that answers READ with a length other than the one asked for. A client that advances
 * its offset by the requested length, not by the bytes received, writes a file with a hole or a
 * repeat at every chunk edge, and still exits 0.
 */
async function oddReadServer(
  data: Buffer,
  replyLength: (requested: number) => number,
): Promise<{ port: number; knownHostsLine: string; password: string }> {
  const password = sentinel();
  const attrs = {
    mode: 0o100644,
    size: data.length,
    uid: 0,
    gid: 0,
    atime: 0,
    mtime: 0,
  };
  const server = await startHostileServer({
    password,
    serve: (sftp: HostileSftp) => {
      sftp.on('OPEN', (id) => sftp.handle(id, FILE_HANDLE));
      sftp.on('FSTAT', (id) => sftp.attrs(id, attrs));
      sftp.on('STAT', (id) => sftp.attrs(id, attrs));
      sftp.on('LSTAT', (id) => sftp.attrs(id, attrs));
      sftp.on('CLOSE', (id) => sftp.status(id, STATUS.OK, 'OK'));
      sftp.on('READ', (id, _handle, offset, length) => {
        if (offset >= data.length) {
          sftp.status(id, STATUS.EOF, 'EOF');
          return;
        }
        const end = Math.min(data.length, offset + replyLength(length));
        sftp.data(id, data.subarray(offset, end));
      });
    },
  });
  onTestFinished(() => server.close());
  return { port: server.port, knownHostsLine: server.knownHostsLine, password };
}

describe('ATK-8: a server that returns short or long READ replies', () => {
  it.each([
    ['half of each request', (requested: number) => Math.ceil(requested / 2)],
    [
      'one byte less than asked',
      (requested: number) => Math.max(1, requested - 1),
    ],
    ['1 KiB more than asked', (requested: number) => requested + KIB],
  ])(
    'get through %s is byte-identical across 3 chunks',
    async (_label, replyLength) => {
      const data = randomBytes(3 * CHUNK_SIZE + 7);
      const server = await oddReadServer(data, replyLength);
      const cwd = await tempDir();
      const knownHosts = join(cwd, 'known_hosts');
      await writeFile(knownHosts, `${server.knownHostsLine}\n`);
      const destination = join(cwd, 'odd.bin');

      const result = await cli(
        [
          'get',
          '--known-hosts',
          knownHosts,
          `sftp://tester@127.0.0.1:${server.port}/odd.bin`,
          destination,
        ],
        {
          registry: registry(),
          cwd,
          home: cwd,
          env: { CYBERDUCK_RECAP_PASSWORD: server.password },
        },
      );

      // A reply the client cannot use may fail the command, but only as one typed line: never
      // as a truncated or shifted file reported as a success.
      if (result.code === 0) {
        expect(result.stderr).toBe('');
        expect((await readFile(destination)).equals(data)).toBe(true);
      } else {
        expect(result.code).toBe(22);
        expect(stderrLines(result.stderr)).toHaveLength(1);
        expect(namesIn(cwd)).toEqual(['known_hosts']);
      }
    },
    30_000,
  );
});

/** The doc comment directly above `export const <name>` in streams.ts. */
async function docCommentOf(name: string): Promise<string> {
  const path = fileURLToPath(
    new URL('../../src/sftp/streams.ts', import.meta.url),
  );
  const source = await readFile(path, 'utf8');
  const match = new RegExp(
    String.raw`/\*\*((?:(?!\*/)[\s\S])*)\*/\s*export const ${name}\b`,
  ).exec(source);
  expect(match, `no doc comment above ${name}`).not.toBeNull();
  return (match?.[1] ?? '').replace(/^\s*\* ?/gm, '').replace(/\s+/g, ' ');
}

describe('ATK-8: the stream doc comments state the numbers the code uses', () => {
  it('CHUNK_SIZE is under every limit its comment gives as the reason for it', async () => {
    const comment = await docCommentOf('CHUNK_SIZE');
    const kib = /Under the (\d+) KiB/.exec(comment);
    const perRequest = /\((\d+) bytes less (\d+) of packet overhead\)/.exec(
      comment,
    );

    expect(
      kib,
      'the comment no longer states the SFTP v3 limit',
    ).not.toBeNull();
    expect(
      perRequest,
      'the comment no longer states the ssh2 limit',
    ).not.toBeNull();
    expect(CHUNK_SIZE).toBeLessThanOrEqual(Number(kib?.[1]) * KIB);
    expect(CHUNK_SIZE).toBeLessThanOrEqual(
      Number(perRequest?.[1]) - Number(perRequest?.[2]),
    );
  });

  it('the bytes in flight the WINDOW comment states are WINDOW times CHUNK_SIZE', async () => {
    // "At most 512 KiB" survived the change from 32 KiB to 31 KiB chunks; a figure that is only
    // an upper bound by accident misleads whoever tunes the window next.
    const comment = await docCommentOf('WINDOW');
    const stated = /(\d+) KiB in flight/.exec(comment);

    expect(
      stated,
      'the comment no longer states the bytes in flight',
    ).not.toBeNull();
    expect(Number(stated?.[1]) * KIB).toBe(WINDOW * CHUNK_SIZE);
  });
});
