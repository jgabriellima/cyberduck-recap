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

  // The open fails and the follow-up stat fails too: no file is there, so the open's own code
  // stands rather than ALREADY_EXISTS.
  it('keeps NOT_FOUND when the parent directory is missing', async () => {
    const { fs } = await connectedPair();

    const stream = fs.createWriteStream('/missing/new.bin', {
      exclusive: true,
    });
    stream.end(Buffer.from('bytes'));
    await expectStreamError(stream, 'NOT_FOUND', { path: '/missing/new.bin' });
  });

  it('keeps PERMISSION_DENIED when the server refuses the path', async () => {
    const { fixture, fs } = await connectedPair();
    fixture.deny('/secret');

    const stream = fs.createWriteStream('/secret', { exclusive: true });
    stream.end(Buffer.from('bytes'));
    await expectStreamError(stream, 'PERMISSION_DENIED', { path: '/secret' });
  });

  it('still replaces an existing file without the option', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/taken.bin'), 'earlier bytes');

    await writeAll(fs.createWriteStream('/taken.bin'), Buffer.from('later'));

    expect(await readFile(fixture.local('/taken.bin'), 'utf8')).toBe('later');
  });
});
