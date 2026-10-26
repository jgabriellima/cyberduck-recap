import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { connectedPair } from '../support/harness.js';
import { expectEntry, expectRejects } from '../support/remote-fs-assertions.js';

describe('SftpFileSystem connect and list (AC-3, AC-12)', () => {
  it('AC-3: lists a file, a directory and a symbolic link with their types, size and mtime, without . and ..', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/a.txt'), 'hello');
    await mkdir(fixture.local('/d'));
    await symlink('a.txt', fixture.local('/l'));

    const entries = await fs.list('/');

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      'a.txt',
      'd',
      'l',
    ]);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const file = expectEntry(byName.get('a.txt'), {
      path: '/a.txt',
      type: 'file',
      size: 5,
    });
    const mtime = (await stat(fixture.local('/a.txt'))).mtimeMs;
    expect(file.modifiedAt.getTime()).toBe(Math.floor(mtime / 1000) * 1000);
    expect(file.permissions).toBeTypeOf('number');
    expectEntry(byName.get('d'), { path: '/d', type: 'directory' });
    expectEntry(byName.get('l'), { path: '/l', type: 'symlink' });
  });

  it('AC-3: connecting with a trusted key leaves the known_hosts file unchanged', async () => {
    const { knownHostsPath, fixture } = await connectedPair();
    expect(await readFile(knownHostsPath, 'utf8')).toBe(
      `${fixture.knownHostsLine}\n`,
    );
  });

  it('AC-3: joins entry paths onto a nested directory', async () => {
    const { fixture, fs } = await connectedPair();
    await mkdir(fixture.local('/nested'));
    await writeFile(fixture.local('/nested/x.bin'), Buffer.alloc(3));

    const [entry] = await fs.list('/nested');

    expectEntry(entry, { name: 'x.bin', path: '/nested/x.bin', size: 3 });
  });

  it('AC-12: list rejects with NOT_FOUND for a missing path', async () => {
    const { fs } = await connectedPair();
    await expectRejects(fs.list('/missing'), 'NOT_FOUND', { path: '/missing' });
  });

  it('AC-12: list rejects with NOT_A_DIRECTORY for a file', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/f.txt'), 'x');
    await expectRejects(fs.list('/f.txt'), 'NOT_A_DIRECTORY', {
      path: '/f.txt',
    });
  });
});
