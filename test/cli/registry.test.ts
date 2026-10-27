import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIB_5, bytes, cli, testRegistry } from '../support/cli.js';
import { sentinel, tempDir } from '../support/harness.js';
import { REPOSITORY_ROOT, typeScriptFiles } from '../support/imports.js';
import { memBackend } from '../support/mem-backend.js';

const env = { CYBERDUCK_RECAP_PASSWORD: sentinel() };

describe('the back-end registry (FEATURE-2 AC-32)', () => {
  it('AC-32: a back-end registered outside src/cli works through ls, get and put', async () => {
    // src/cli knows nothing of the test's scheme: the registry alone makes it usable.
    for (const file of await typeScriptFiles('src/cli')) {
      const text = await readFile(join(REPOSITORY_ROOT, file), 'utf8');
      expect(/['"`]mem(:|['"`])/.test(text), file).toBe(false);
    }

    const mem = memBackend();
    const registry = testRegistry({ mem: mem.factory });
    const when = new Date('2024-05-06T07:08:09.000Z');
    mem.file('/d/a.txt', 'hello', when);
    mem.directory('/d/sub', when);
    mem.symlink('/d/link', 'a.txt', when);

    const listed = await cli(['ls', 'mem://u@h/d'], { env, registry });
    expect(listed.code).toBe(0);
    expect(listed.stderr).toBe('');
    const iso = when.toISOString();
    expect(listed.stdoutLines).toEqual([
      `-\t5\t${iso}\ta.txt`,
      `l\t0\t${iso}\tlink`,
      `d\t0\t${iso}\tsub`,
    ]);

    for (const length of [0, 1, MIB_5]) {
      const data = bytes(length);
      mem.file(`/get-${length}.bin`, data);
      const downloaded = join(await tempDir(), 'down.bin');
      const got = await cli(
        ['get', `mem://u@h/get-${length}.bin`, downloaded],
        {
          env,
          registry,
        },
      );
      expect(got.code).toBe(0);
      expect(got.stdout).toBe('');
      expect(got.stderr).toBe('');
      expect((await readFile(downloaded)).equals(data)).toBe(true);

      const upload = join(await tempDir(), 'up.bin');
      await writeFile(upload, data);
      const put = await cli(['put', upload, `mem://u@h/put-${length}.bin`], {
        env,
        registry,
      });
      expect(put.code).toBe(0);
      expect(put.stdout).toBe('');
      expect(put.stderr).toBe('');
      expect(mem.read(`/put-${length}.bin`)?.equals(data)).toBe(true);
    }

    const help = await cli(['--help'], { env, registry });
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/\bmem\b/);
  }, 60_000);
});
