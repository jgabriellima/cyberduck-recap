import { mkdir, writeFile } from 'node:fs/promises';
import { describe, it } from 'vitest';
import { connectedPair } from '../support/harness.js';
import {
  expectRejects,
  expectStreamError,
} from '../support/remote-fs-assertions.js';

describe('SftpFileSystem PERMISSION_DENIED (AC-13)', () => {
  it('list', async () => {
    const { fixture, fs } = await connectedPair();
    await mkdir(fixture.local('/secret'));
    fixture.deny('/secret');

    await expectRejects(fs.list('/secret'), 'PERMISSION_DENIED', {
      path: '/secret',
    });
  });

  it('stat', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/secret'), 'x');
    fixture.deny('/secret');

    await expectRejects(fs.stat('/secret'), 'PERMISSION_DENIED', {
      path: '/secret',
    });
  });

  it('createReadStream', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/secret'), 'x');
    fixture.deny('/secret');

    await expectStreamError(
      fs.createReadStream('/secret'),
      'PERMISSION_DENIED',
      {
        path: '/secret',
      },
    );
  });

  it('createWriteStream', async () => {
    const { fixture, fs } = await connectedPair();
    fixture.deny('/secret');
    const stream = fs.createWriteStream('/secret');
    stream.end(Buffer.from('x'));

    await expectStreamError(stream, 'PERMISSION_DENIED', { path: '/secret' });
  });

  it('mkdir', async () => {
    const { fixture, fs } = await connectedPair();
    fixture.deny('/secret');

    await expectRejects(fs.mkdir('/secret'), 'PERMISSION_DENIED', {
      path: '/secret',
    });
  });

  it('remove', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/secret'), 'x');
    fixture.deny('/secret');

    await expectRejects(fs.remove('/secret'), 'PERMISSION_DENIED', {
      path: '/secret',
    });
  });

  it('rename, when the source is denied', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/secret'), 'x');
    fixture.deny('/secret');

    await expectRejects(fs.rename('/secret', '/free'), 'PERMISSION_DENIED', {
      path: '/secret',
      targetPath: '/free',
    });
  });

  it('rename, when the target is denied', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/free'), 'x');
    fixture.deny('/secret');

    await expectRejects(fs.rename('/free', '/secret'), 'PERMISSION_DENIED', {
      path: '/free',
      targetPath: '/secret',
    });
  });
});
