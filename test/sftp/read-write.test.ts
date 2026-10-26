import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { connectedPair } from '../support/harness.js';
import {
  expectStreamError,
  readAll,
  sha256,
  writeAll,
} from '../support/remote-fs-assertions.js';

const FIVE_MIB = 5 * 1024 * 1024;

describe('SftpFileSystem read and write streams (AC-7, AC-8, AC-30)', () => {
  it('AC-7: reads an empty file', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/empty'), Buffer.alloc(0));

    const data = await readAll(fs.createReadStream('/empty'));

    expect(data.length).toBe(0);
  });

  it('AC-7: reads a 5 MiB random binary file byte for byte', async () => {
    const { fixture, fs } = await connectedPair();
    const content = randomBytes(FIVE_MIB);
    await writeFile(fixture.local('/big.bin'), content);

    const data = await readAll(fs.createReadStream('/big.bin'));

    expect(sha256(data)).toBe(sha256(content));
  });

  it('AC-7: reads a file whose size is not a multiple of the chunk size', async () => {
    const { fixture, fs } = await connectedPair();
    const content = randomBytes(100_003);
    await writeFile(fixture.local('/odd.bin'), content);

    expect(sha256(await readAll(fs.createReadStream('/odd.bin')))).toBe(
      sha256(content),
    );
  });

  it('AC-7: a missing path emits NOT_FOUND', async () => {
    const { fs } = await connectedPair();
    await expectStreamError(fs.createReadStream('/missing'), 'NOT_FOUND', {
      path: '/missing',
    });
  });

  it('AC-8: writes a 5 MiB random binary file byte for byte', async () => {
    const { fixture, fs } = await connectedPair();
    const content = randomBytes(FIVE_MIB);

    await writeAll(fs.createWriteStream('/upload.bin'), content);

    expect(sha256(await readFile(fixture.local('/upload.bin')))).toBe(
      sha256(content),
    );
  });

  it('AC-8: writes many small chunks in order', async () => {
    const { fixture, fs } = await connectedPair();
    const stream = fs.createWriteStream('/chunks.txt');
    const parts = Array.from({ length: 200 }, (_, i) => `${i},`);
    const finished = new Promise<void>((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
    for (const part of parts) stream.write(part);
    stream.end();
    await finished;

    expect(await readFile(fixture.local('/chunks.txt'), 'utf8')).toBe(
      parts.join(''),
    );
  });

  it('AC-8: writing 3 bytes over a 10-byte file leaves exactly those 3 bytes', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/ten.txt'), '0123456789');

    await writeAll(fs.createWriteStream('/ten.txt'), Buffer.from('abc'));

    expect(await readFile(fixture.local('/ten.txt'), 'utf8')).toBe('abc');
  });

  it('AC-8: writing under a missing parent directory emits NOT_FOUND', async () => {
    const { fs } = await connectedPair();
    const stream = fs.createWriteStream('/no/such/dir/file');
    stream.end(Buffer.from('x'));

    await expectStreamError(stream, 'NOT_FOUND', { path: '/no/such/dir/file' });
  });

  it('AC-30: reading a directory emits IS_A_DIRECTORY', async () => {
    const { fixture, fs } = await connectedPair();
    await mkdir(fixture.local('/dir'));

    await expectStreamError(fs.createReadStream('/dir'), 'IS_A_DIRECTORY', {
      path: '/dir',
    });
  });

  it('AC-30: writing to an existing directory emits IS_A_DIRECTORY and leaves it untouched', async () => {
    const { fixture, fs } = await connectedPair();
    await mkdir(fixture.local('/dir'));
    await writeFile(fixture.local('/dir/inside.txt'), 'keep');
    const stream = fs.createWriteStream('/dir');
    stream.end(Buffer.from('overwrite?'));

    await expectStreamError(stream, 'IS_A_DIRECTORY', { path: '/dir' });

    expect(await readdir(fixture.local('/dir'))).toEqual(['inside.txt']);
    expect(await readFile(fixture.local('/dir/inside.txt'), 'utf8')).toBe(
      'keep',
    );
  });
});
