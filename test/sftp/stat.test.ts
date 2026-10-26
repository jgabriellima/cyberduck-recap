import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { describe, it } from 'vitest';
import { connectedPair } from '../support/harness.js';
import { expectEntry, expectRejects } from '../support/remote-fs-assertions.js';

describe('SftpFileSystem stat (AC-6)', () => {
  it('reports a file with its size', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/f.txt'), '1234567');

    expectEntry(await fs.stat('/f.txt'), {
      name: 'f.txt',
      path: '/f.txt',
      type: 'file',
      size: 7,
    });
  });

  it('reports a directory', async () => {
    const { fixture, fs } = await connectedPair();
    await mkdir(fixture.local('/dir'));

    expectEntry(await fs.stat('/dir'), { name: 'dir', type: 'directory' });
  });

  it("follows a symbolic link to a file and reports the target's type and size", async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/target.txt'), 'abc');
    await symlink('target.txt', fixture.local('/link'));

    expectEntry(await fs.stat('/link'), {
      name: 'link',
      path: '/link',
      type: 'file',
      size: 3,
    });
  });

  it('rejects with NOT_FOUND and the path for a missing path', async () => {
    const { fs } = await connectedPair();
    await expectRejects(fs.stat('/nope'), 'NOT_FOUND', { path: '/nope' });
  });

  it('rejects with NOT_FOUND for a link whose target is missing', async () => {
    const { fixture, fs } = await connectedPair();
    await symlink('gone.txt', fixture.local('/dangling'));

    await expectRejects(fs.stat('/dangling'), 'NOT_FOUND', {
      path: '/dangling',
    });
  });
});
