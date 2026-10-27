/**
 * Adversarial (FEATURE-2): a download that fails part-way, in every way a back-end or the local
 * disk can fail it, leaves the destination as it was and no temporary file behind (AC-9 names
 * three failures; these are the others). The exit code names the failure, and a failing
 * `disconnect()` after the failure does not replace it.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RemoteFsError } from '../../src/index.js';
import { sentinel, tempDir } from '../support/harness.js';
import {
  cli,
  isRoot,
  memBackend,
  namesIn,
  registry,
  stderrLines,
  type MemBehaviour,
} from './support/cli-harness.js';

const REMOTE = Buffer.alloc(200_000, 0x61);
const EARLIER = Buffer.from('earlier local bytes');

/** Sends 64 KiB, then fails with `error`. */
function failsAfterData(error: Error): () => Readable {
  return () => {
    let sent = false;
    return new Readable({
      read() {
        if (!sent) {
          sent = true;
          this.push(Buffer.alloc(65_536, 0x62));
        } else {
          this.destroy(error);
        }
      },
    });
  };
}

interface Failure {
  readonly label: string;
  readonly behaviour: () => MemBehaviour;
  readonly code: number;
  readonly errorCode: string;
  readonly secret?: string;
}

const secret = sentinel();

const FAILURES: readonly Failure[] = [
  {
    label: 'a typed error after 64 KiB',
    behaviour: () => ({
      createReadStream: failsAfterData(
        new RemoteFsError('CONNECTION_LOST', 'connection lost', {
          path: '/r.txt',
        }),
      ),
    }),
    code: 14,
    errorCode: 'CONNECTION_LOST',
  },
  {
    label: 'an unexpected error after 64 KiB',
    behaviour: () => ({
      createReadStream: failsAfterData(new TypeError(secret)),
    }),
    code: 1,
    errorCode: 'INTERNAL',
    secret,
  },
  {
    label: 'createReadStream that throws',
    behaviour: () => ({
      createReadStream: (path) => {
        throw new RemoteFsError('PERMISSION_DENIED', 'denied', { path });
      },
    }),
    code: 17,
    errorCode: 'PERMISSION_DENIED',
  },
  {
    label: 'a stream that fails before any byte',
    behaviour: () => ({
      createReadStream: (path) => {
        const stream = new Readable({ read() {} });
        queueMicrotask(() =>
          stream.destroy(
            new RemoteFsError('IS_A_DIRECTORY', 'is a directory', { path }),
          ),
        );
        return stream;
      },
    }),
    code: 20,
    errorCode: 'IS_A_DIRECTORY',
  },
  {
    label: 'a typed error, then a disconnect that rejects',
    behaviour: () => ({
      createReadStream: failsAfterData(
        new RemoteFsError('OPERATION_FAILED', 'read failed', {
          path: '/r.txt',
        }),
      ),
      disconnect: () =>
        Promise.reject(new RemoteFsError('CONNECTION_LOST', 'gone')),
    }),
    code: 22,
    errorCode: 'OPERATION_FAILED',
  },
];

describe('ATK-4: a download that fails part-way changes nothing on disk', () => {
  for (const failure of FAILURES) {
    it.each([
      ['no destination', false],
      ['an existing destination with --overwrite', true],
    ])(`${failure.label}, %s`, async (_label, exists) => {
      const cwd = await tempDir();
      const home = await tempDir();
      const dest = join(cwd, 'r.txt');
      if (exists) await writeFile(dest, EARLIER);
      const before = namesIn(cwd);
      const mem = memBackend({
        files: { '/r.txt': REMOTE },
        ...failure.behaviour(),
      });
      const args = exists
        ? ['get', '--overwrite', 'mem://u@h/r.txt']
        : ['get', 'mem://u@h/r.txt'];
      const run = await cli(args, {
        registry: registry({ mem: mem.factory }),
        cwd,
        home,
      });

      expect(run.code).toBe(failure.code);
      const errorLines = stderrLines(run.stderr).filter((line) =>
        /^cyberduck-recap: [A-Z_]+: /.test(line),
      );
      expect(errorLines).toHaveLength(1);
      expect(errorLines[0]).toMatch(
        new RegExp(`^cyberduck-recap: ${failure.errorCode}: `),
      );
      if (failure.secret !== undefined) {
        expect(run.stderr).not.toContain(failure.secret);
      }
      expect(namesIn(cwd)).toEqual(before);
      if (exists) expect(await readFile(dest)).toEqual(EARLIER);
      expect(mem.spy.connects).toBe(1);
      expect(mem.spy.disconnects).toBe(1);
    });
  }
});

describe('ATK-4: a destination directory that cannot hold the download', () => {
  it.skipIf(isRoot)(
    'a read-only directory is a local file error and leaves nothing',
    async () => {
      const cwd = await tempDir();
      const home = await tempDir();
      const directory = join(cwd, 'ro');
      await mkdir(directory);
      await chmod(directory, 0o500);
      const mem = memBackend({ files: { '/r.txt': REMOTE } });
      const run = await cli(['get', 'mem://u@h/r.txt', join(directory, 'r')], {
        registry: registry({ mem: mem.factory }),
        cwd,
        home,
      });
      await chmod(directory, 0o700);

      expect(run.code).toBe(3);
      expect(stderrLines(run.stderr)[0]).toMatch(
        /^cyberduck-recap: LOCAL_FILE: /,
      );
      expect(namesIn(directory)).toEqual([]);
      expect(mem.spy.disconnects).toBe(mem.spy.connects);
    },
  );
});
