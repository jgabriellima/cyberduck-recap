import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT } from '../support/imports.js';

const run = promisify(execFile);

describe('the installed program (FEATURE-2 AC-35)', () => {
  it('AC-35: the bin entry, once built, prints the help', async () => {
    const manifest = JSON.parse(
      await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
    ) as { bin?: Record<string, string> };
    const entry = manifest.bin?.['cyberduck-recap'];
    expect(entry).toBeTypeOf('string');

    // The spec's command: `pnpm run build`, then the bin file with node and --help.
    await run('pnpm', ['run', 'build'], { cwd: REPOSITORY_ROOT });
    const { stdout } = await run(
      process.execPath,
      [join(REPOSITORY_ROOT, entry ?? ''), '--help'],
      { cwd: REPOSITORY_ROOT },
    );

    expect(stdout).toMatch(/cyberduck-recap ls\s+\[options\] <url>/);
    expect(stdout).toMatch(/cyberduck-recap get\s/);
    expect(stdout).toMatch(/cyberduck-recap put\s/);
    expect(stdout).toContain('--identity <file>');
  }, 120_000);
});
