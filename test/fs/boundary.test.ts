import { describe, expect, it } from 'vitest';
import {
  importSpecifiers,
  importsOf,
  isSsh2,
  resolveSpecifier,
  typeScriptFiles,
} from '../support/imports.js';

describe('src/fs stays protocol-neutral (AC-2)', () => {
  it('the import parser sees static, type-only, re-exported and dynamic imports', () => {
    const specifiers = importSpecifiers(
      [
        "import { Client } from 'ssh2';",
        "import type { X } from '../sftp/session.js';",
        "export * from './errors.js';",
        "const lazy = await import('ssh2/lib/client');",
      ].join('\n'),
    );

    expect(specifiers).toEqual([
      'ssh2',
      '../sftp/session.js',
      './errors.js',
      'ssh2/lib/client',
    ]);
  });

  it('no module under src/fs imports ssh2 or src/sftp, only node built-ins and src/fs itself', async () => {
    const files = await typeScriptFiles('src/fs');
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      for (const specifier of await importsOf(file)) {
        const target = resolveSpecifier(file, specifier);
        expect(isSsh2(specifier), `${file} imports ${specifier}`).toBe(false);
        expect(
          target.startsWith('src/sftp'),
          `${file} imports ${specifier}`,
        ).toBe(false);
        const allowed =
          specifier.startsWith('node:') || target.startsWith('src/fs/');
        expect(allowed, `${file} imports ${specifier}`).toBe(true);
      }
    }
  });
});
