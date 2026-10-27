import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../../src/cli/errors.js';
import {
  directoryFiles,
  ensurePrivateDirectory,
} from '../../src/cli/known-hosts-path.js';
import { isWindows } from '../support/cli.js';
import { tempDir } from '../support/harness.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const modeOf = async (path: string): Promise<number> =>
  (await stat(path)).mode & 0o777;

describe('the known_hosts directories (FEATURE-2 AC-27, AC-40, design SC-6)', () => {
  it.skipIf(isWindows)(
    'a directory another process creates first counts as made and keeps its mode',
    async () => {
      const base = await tempDir();
      const target = join(base, 'a', 'b');
      const real = directoryFiles.mkdir;
      vi.spyOn(directoryFiles, 'mkdir').mockImplementation(
        async (path, options) => {
          if (path === join(base, 'a')) {
            // The other process wins the race with its own mode.
            await mkdir(path, { mode: 0o755 });
            throw Object.assign(new Error('exists'), { code: 'EEXIST' });
          }
          return real(path, options);
        },
      );

      await ensurePrivateDirectory(target);

      expect(await modeOf(join(base, 'a'))).toBe(0o755);
      expect(await modeOf(target)).toBe(0o700);
    },
  );

  it('EEXIST on something that is not a directory names the directory it could not create', async () => {
    const base = await tempDir();
    const blocked = join(base, 'file');
    await writeFile(blocked, 'not a directory');
    vi.spyOn(directoryFiles, 'lstat').mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );

    const failure = await ensurePrivateDirectory(blocked).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({
      code: 'LOCAL_FILE',
      message: `cannot create the directory ${blocked}`,
    });
  });
});
