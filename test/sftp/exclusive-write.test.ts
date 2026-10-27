import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { connectedPair } from '../support/harness.js';
import {
  expectStreamError,
  writeAll,
} from '../support/remote-fs-assertions.js';

describe('an exclusive write stream (FEATURE-2 design 6A)', () => {
  it('creates a new file', async () => {
    const { fixture, fs } = await connectedPair();

    await writeAll(
      fs.createWriteStream('/new.bin', { exclusive: true }),
      Buffer.from('new bytes'),
    );

    expect(await readFile(fixture.local('/new.bin'), 'utf8')).toBe('new bytes');
  });

  it('fails with ALREADY_EXISTS over an existing file, which keeps its bytes', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/taken.bin'), 'earlier bytes');

    const stream = fs.createWriteStream('/taken.bin', { exclusive: true });
    stream.end(Buffer.from('later'));
    await expectStreamError(stream, 'ALREADY_EXISTS', { path: '/taken.bin' });

    expect(await readFile(fixture.local('/taken.bin'), 'utf8')).toBe(
      'earlier bytes',
    );
  });

  it('still replaces an existing file without the option', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/taken.bin'), 'earlier bytes');

    await writeAll(fs.createWriteStream('/taken.bin'), Buffer.from('later'));

    expect(await readFile(fixture.local('/taken.bin'), 'utf8')).toBe('later');
  });
});
