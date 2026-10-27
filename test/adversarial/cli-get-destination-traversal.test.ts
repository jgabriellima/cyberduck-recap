/**
 * Adversarial (FEATURE-2): the local destination of `get` comes only from the command line. A URL
 * whose percent-encoded path decodes to a `..`, `.` or empty last segment must not make `get` write
 * to the parent of the working directory or onto a directory, and a back-end that reports another
 * name or path for the file must not steer where the bytes land.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../support/harness.js';
import {
  cli,
  memBackend,
  namesIn,
  registry,
  stderrLines,
} from './support/cli-harness.js';

const CONTENT = Buffer.from('remote bytes');

/** A working directory two levels down, so a write to `..` or `../..` shows up. */
async function nested(): Promise<{
  top: string;
  middle: string;
  cwd: string;
  home: string;
}> {
  const home = await tempDir();
  const top = await tempDir();
  const middle = join(top, 'middle');
  const cwd = join(middle, 'cwd');
  await mkdir(cwd, { recursive: true });
  return { top, middle, cwd, home };
}

describe('ATK-2: an encoded path cannot point get at a parent directory', () => {
  it.each([
    ['an encoded slash before ..', 'mem://u@h/a%2F..', '/a/..'],
    ['an encoded slash before .', 'mem://u@h/a%2F.', '/a/.'],
    ['an encoded trailing slash', 'mem://u@h/a%2F', '/a/'],
    ['an encoded .. segment', 'mem://u@h/x/%2E%2E%2F..', '/x/../..'],
    ['two encoded ..', 'mem://u@h/%2E%2E%2F%2E%2E', '/../..'],
  ])(
    '%s exits 2 with no connection and writes nothing',
    async (_label, url) => {
      const { top, middle, cwd, home } = await nested();
      const before = {
        top: namesIn(top),
        middle: namesIn(middle),
        cwd: namesIn(cwd),
      };
      const mem = memBackend({
        files: { '/a': CONTENT, '/x': CONTENT, '/..': CONTENT },
      });
      const run = await cli(['get', url], {
        registry: registry({ mem: mem.factory }),
        cwd,
        home,
      });
      expect(run.code).toBe(2);
      expect(stderrLines(run.stderr)[0]).toMatch(
        /^cyberduck-recap: USAGE: the remote path '.*' has no file name; give a local file path$/,
      );
      expect(mem.spy.connects).toBe(0);
      expect(namesIn(top)).toEqual(before.top);
      expect(namesIn(middle)).toEqual(before.middle);
      expect(namesIn(cwd)).toEqual(before.cwd);
    },
  );

  it('an encoded .. with an existing directory as the local path is refused too', async () => {
    const { middle, cwd, home } = await nested();
    const target = join(cwd, 'into');
    await mkdir(target);
    const mem = memBackend({ files: { '/a': CONTENT } });
    const run = await cli(['get', 'mem://u@h/a%2F..', target], {
      registry: registry({ mem: mem.factory }),
      cwd,
      home,
    });
    expect(run.code).toBe(2);
    expect(mem.spy.connects).toBe(0);
    expect(namesIn(target)).toEqual([]);
    expect(namesIn(cwd)).toEqual(['into']);
    expect(namesIn(middle)).toEqual(['cwd']);
  });

  it('encoded slashes inside the path keep the download in the working directory', async () => {
    const { top, middle, cwd, home } = await nested();
    const mem = memBackend({ files: { '/../../escape': CONTENT } });
    const run = await cli(['get', 'mem://u@h/..%2F..%2Fescape'], {
      registry: registry({ mem: mem.factory }),
      cwd,
      home,
    });
    expect(run.code).toBe(0);
    expect(await readFile(join(cwd, 'escape'))).toEqual(CONTENT);
    expect(namesIn(cwd)).toEqual(['escape']);
    expect(namesIn(middle)).toEqual(['cwd']);
    expect(namesIn(top)).toEqual(['middle']);
  });
});

describe('ATK-2: the back-end cannot choose the local file name', () => {
  it('a hostile stat name and path do not move the download', async () => {
    const { top, middle, cwd, home } = await nested();
    const mem = memBackend({
      files: { '/docs/r.txt': CONTENT },
      stat: () =>
        Promise.resolve({
          name: '../../stolen',
          path: '/../../stolen',
          type: 'file',
          size: CONTENT.length,
          modifiedAt: new Date(0),
          permissions: 0o644,
        }),
      list: () =>
        Promise.resolve([
          {
            name: '../../stolen',
            path: '/../../stolen',
            type: 'file',
            size: CONTENT.length,
            modifiedAt: new Date(0),
            permissions: 0o644,
          },
        ]),
    });
    const run = await cli(['get', 'mem://u@h/docs/r.txt'], {
      registry: registry({ mem: mem.factory }),
      cwd,
      home,
    });
    expect(run.code).toBe(0);
    expect(await readFile(join(cwd, 'r.txt'))).toEqual(CONTENT);
    expect(namesIn(cwd)).toEqual(['r.txt']);
    expect(namesIn(middle)).toEqual(['cwd']);
    expect(namesIn(top)).toEqual(['middle']);
  });
});
