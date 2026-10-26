import {
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { connectedPair } from '../support/harness.js';
import { expectRejects } from '../support/remote-fs-assertions.js';

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

describe('SftpFileSystem mkdir (AC-9)', () => {
  it('creates a directory', async () => {
    const { fixture, fs } = await connectedPair();

    await fs.mkdir('/new');

    expect((await stat(fixture.local('/new'))).isDirectory()).toBe(true);
  });

  it('rejects with ALREADY_EXISTS for an existing path', async () => {
    const { fixture, fs } = await connectedPair();
    await mkdir(fixture.local('/there'));

    await expectRejects(fs.mkdir('/there'), 'ALREADY_EXISTS', {
      path: '/there',
    });
  });

  it('rejects with NOT_FOUND when the parent is missing', async () => {
    const { fs } = await connectedPair();
    await expectRejects(fs.mkdir('/missing/child'), 'NOT_FOUND', {
      path: '/missing/child',
    });
  });

  it('creates every level with recursive: true and resolves again when they exist', async () => {
    const { fixture, fs } = await connectedPair();

    await fs.mkdir('/x/y/z', { recursive: true });
    await fs.mkdir('/x/y/z', { recursive: true });

    expect((await stat(fixture.local('/x/y/z'))).isDirectory()).toBe(true);
  });

  it('recursive mkdir onto an existing file is ALREADY_EXISTS', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/file'), 'x');

    await expectRejects(
      fs.mkdir('/file', { recursive: true }),
      'ALREADY_EXISTS',
    );
  });
});

describe('SftpFileSystem remove (AC-10)', () => {
  it('deletes a file', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/f'), 'x');

    await fs.remove('/f');

    expect(await exists(fixture.local('/f'))).toBe(false);
  });

  it('deletes an empty directory', async () => {
    const { fixture, fs } = await connectedPair();
    await mkdir(fixture.local('/empty'));

    await fs.remove('/empty');

    expect(await exists(fixture.local('/empty'))).toBe(false);
  });

  it('deletes a symbolic link and leaves its target in place', async () => {
    const { fixture, fs } = await connectedPair();
    await mkdir(fixture.local('/target'));
    await writeFile(fixture.local('/target/keep'), 'x');
    await symlink('target', fixture.local('/link'));

    await fs.remove('/link');

    expect(await exists(fixture.local('/link'))).toBe(false);
    expect(await readdir(fixture.local('/target'))).toEqual(['keep']);
  });

  it('rejects with NOT_FOUND for a missing path', async () => {
    const { fs } = await connectedPair();
    await expectRejects(fs.remove('/nope'), 'NOT_FOUND', { path: '/nope' });
  });

  it('rejects with OPERATION_FAILED for a non-empty directory, whose contents remain', async () => {
    const { fixture, fs } = await connectedPair();
    await mkdir(fixture.local('/full'));
    await writeFile(fixture.local('/full/a'), 'x');

    const error = await expectRejects(fs.remove('/full'), 'OPERATION_FAILED', {
      path: '/full',
    });

    expect(error.message).toContain('Failure');
    expect(await readdir(fixture.local('/full'))).toEqual(['a']);
  });
});

describe('SftpFileSystem rename (AC-11)', () => {
  it('moves a file', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/from.txt'), 'content');

    await fs.rename('/from.txt', '/to.txt');

    expect(await exists(fixture.local('/from.txt'))).toBe(false);
    expect(await readFile(fixture.local('/to.txt'), 'utf8')).toBe('content');
  });

  it('moves a directory with its contents', async () => {
    const { fixture, fs } = await connectedPair();
    await mkdir(fixture.local('/src'));
    await writeFile(fixture.local('/src/inner.txt'), 'inner');

    await fs.rename('/src', '/dst');

    expect(await exists(fixture.local('/src'))).toBe(false);
    expect(await readFile(fixture.local('/dst/inner.txt'), 'utf8')).toBe(
      'inner',
    );
  });

  it('rejects with NOT_FOUND when the source is missing', async () => {
    const { fs } = await connectedPair();
    await expectRejects(fs.rename('/ghost', '/any'), 'NOT_FOUND', {
      path: '/ghost',
      targetPath: '/any',
    });
  });

  it('rejects with ALREADY_EXISTS when the target exists, keeping both contents', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/a'), 'source');
    await writeFile(fixture.local('/b'), 'target');

    await expectRejects(fs.rename('/a', '/b'), 'ALREADY_EXISTS', {
      path: '/a',
      targetPath: '/b',
    });

    expect(await readFile(fixture.local('/a'), 'utf8')).toBe('source');
    expect(await readFile(fixture.local('/b'), 'utf8')).toBe('target');
  });
});
