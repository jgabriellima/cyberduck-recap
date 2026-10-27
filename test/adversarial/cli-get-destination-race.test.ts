/**
 * Adversarial (FEATURE-2): the check that the destination of `get` is absent happens before the
 * download, but the file appears on disk only at the end. A file or a symbolic link that another
 * process puts at the destination while the download runs must not be replaced without
 * `--overwrite` (the final rename must not overwrite it), and with `--overwrite` a link put there
 * must be replaced itself, never written through into its target.
 */
import {
  lstat,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../support/harness.js';
import { waitUntil } from '../support/sftp-server.js';
import {
  cli,
  isPartFileOf,
  memBackend,
  namesIn,
  registry,
  stderrLines,
} from './support/cli-harness.js';

const HEAD = Buffer.from('r');
const TAIL = Buffer.from('emote bytes');
const REMOTE = Buffer.concat([HEAD, TAIL]);

/** A download that sends one byte, then waits until the test releases the rest. */
function gatedDownload(): {
  mem: ReturnType<typeof memBackend>;
  release: () => void;
} {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const mem = memBackend({
    files: { '/r.txt': REMOTE },
    createReadStream: () => {
      let step = 0;
      return new Readable({
        read() {
          if (step === 0) {
            step = 1;
            this.push(HEAD);
          } else if (step === 1) {
            step = 2;
            void gate.then(() => {
              this.push(TAIL);
              this.push(null);
            });
          }
        },
      });
    },
  });
  return { mem, release: () => release() };
}

async function waitForPartFile(directory: string): Promise<void> {
  await waitUntil(() =>
    namesIn(directory).some((name) => isPartFileOf('r.txt', name)),
  );
}

describe('ATK-3: a destination that appears during the download', () => {
  it('a file put there is not replaced without --overwrite', async () => {
    const cwd = await tempDir();
    const home = await tempDir();
    const dest = join(cwd, 'r.txt');
    const { mem, release } = gatedDownload();
    const running = cli(['get', 'mem://u@h/r.txt'], {
      registry: registry({ mem: mem.factory }),
      cwd,
      home,
    });
    await waitForPartFile(cwd);
    await writeFile(dest, 'planted by another process');
    release();
    const run = await running;

    expect(run.code).toBe(3);
    expect(stderrLines(run.stderr)[0]).toMatch(
      /^cyberduck-recap: LOCAL_FILE: /,
    );
    expect(await readFile(dest, 'utf8')).toBe('planted by another process');
    expect(namesIn(cwd)).toEqual(['r.txt']);
    expect(mem.spy.disconnects).toBe(1);
  });

  it('a symbolic link put there is not replaced and its target is not written', async () => {
    const cwd = await tempDir();
    const home = await tempDir();
    const outside = await tempDir();
    const victim = join(outside, 'victim');
    await writeFile(victim, 'victim bytes');
    const dest = join(cwd, 'r.txt');
    const { mem, release } = gatedDownload();
    const running = cli(['get', 'mem://u@h/r.txt'], {
      registry: registry({ mem: mem.factory }),
      cwd,
      home,
    });
    await waitForPartFile(cwd);
    await symlink(victim, dest);
    release();
    const run = await running;

    expect(run.code).toBe(3);
    expect((await lstat(dest)).isSymbolicLink()).toBe(true);
    expect(await readlink(dest)).toBe(victim);
    expect(await readFile(victim, 'utf8')).toBe('victim bytes');
    expect(namesIn(cwd)).toEqual(['r.txt']);
  });

  it('with --overwrite, a link swapped in for the file is replaced, not written through', async () => {
    const cwd = await tempDir();
    const home = await tempDir();
    const outside = await tempDir();
    const victim = join(outside, 'victim');
    await writeFile(victim, 'victim bytes');
    const dest = join(cwd, 'r.txt');
    await writeFile(dest, 'old local bytes');
    const { mem, release } = gatedDownload();
    const running = cli(['get', '--overwrite', 'mem://u@h/r.txt'], {
      registry: registry({ mem: mem.factory }),
      cwd,
      home,
    });
    await waitForPartFile(cwd);
    await rm(dest);
    await symlink(victim, dest);
    release();
    const run = await running;

    expect(run.code).toBe(0);
    expect((await lstat(dest)).isFile()).toBe(true);
    expect(await readFile(dest)).toEqual(REMOTE);
    expect(await readFile(victim, 'utf8')).toBe('victim bytes');
    expect(namesIn(cwd)).toEqual(['r.txt']);
  });
});
