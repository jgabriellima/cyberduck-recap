import {
  link,
  readFile,
  readdir,
  readlink,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localFiles } from '../../src/cli/commands/get.js';
import { cli, errorLine, isWindows, testRegistry } from '../support/cli.js';
import { tempDir } from '../support/harness.js';
import { memBackend } from '../support/mem-backend.js';

const env = { CYBERDUCK_RECAP_PASSWORD: 'mem-password' };

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

async function download(destination: string) {
  const mem = memBackend();
  mem.file('/f.bin', 'remote bytes');
  return cli(['get', 'mem://u@h/f.bin', destination], {
    env,
    registry: testRegistry({ mem: mem.factory }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the last step of get (FEATURE-2 design 4C and its fallback 4E)', () => {
  it('a name that appears as a dangling link before the hard link is not replaced', async () => {
    const directory = await tempDir();
    const destination = join(directory, 'f.bin');
    const missing = join(directory, 'nowhere');
    vi.spyOn(localFiles, 'link').mockImplementation(async (from, to) => {
      await symlink(missing, to);
      return link(from, to);
    });

    const result = await download(destination);

    expect(result.code).toBe(3);
    expect(errorLine(result)).toBe(
      `cyberduck-recap: LOCAL_FILE: ${destination} exists; give --overwrite to replace it`,
    );
    expect(await readlink(destination)).toBe(missing);
    expect(await readdir(directory)).toEqual(['f.bin']);
  });

  it.skipIf(isWindows)(
    'without hard links, copies into an exclusively created destination',
    async () => {
      const directory = await tempDir();
      const destination = join(directory, 'f.bin');
      const linkSpy = vi
        .spyOn(localFiles, 'link')
        .mockRejectedValue(errno('EPERM'));
      const probe = join(directory, 'probe');
      await writeFile(probe, '');
      const defaultMode = (await stat(probe)).mode & 0o777;

      const result = await download(destination);

      expect(linkSpy).toHaveBeenCalledOnce();
      expect(result.code).toBe(0);
      expect(await readFile(destination, 'utf8')).toBe('remote bytes');
      expect((await stat(destination)).mode & 0o777).toBe(defaultMode);
      expect((await readdir(directory)).sort()).toEqual(['f.bin', 'probe']);
    },
  );

  it('without hard links, a destination that appeared is still not replaced', async () => {
    const directory = await tempDir();
    const destination = join(directory, 'f.bin');
    vi.spyOn(localFiles, 'link').mockImplementation(async (_from, to) => {
      await writeFile(to, 'planted');
      throw errno('ENOTSUP');
    });

    const result = await download(destination);

    expect(result.code).toBe(3);
    expect(await readFile(destination, 'utf8')).toBe('planted');
    expect(await readdir(directory)).toEqual(['f.bin']);
  });

  it('another link failure is a local file error that leaves nothing behind', async () => {
    const directory = await tempDir();
    const destination = join(directory, 'f.bin');
    vi.spyOn(localFiles, 'link').mockRejectedValue(errno('EIO'));

    const result = await download(destination);

    expect(result.code).toBe(3);
    expect(errorLine(result)).toBe(
      `cyberduck-recap: LOCAL_FILE: cannot write ${destination}`,
    );
    expect(await readdir(directory)).toEqual([]);
  });
});
