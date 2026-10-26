import { describe, expect, it } from 'vitest';
import { importsOf, isSsh2, typeScriptFiles } from '../support/imports.js';

// Replacing ssh2 must stay a rewrite of these two places only (C-3, M-8).
const ALLOWED = ['src/sftp/', 'test/support/'];

describe('ssh2 is confined to the SFTP back-end and the test fixture (G-7)', () => {
  it('no file outside src/sftp and test/support imports ssh2', async () => {
    const files = [
      ...(await typeScriptFiles('src')),
      ...(await typeScriptFiles('test')),
    ];
    const offenders: string[] = [];

    for (const file of files) {
      if (ALLOWED.some((prefix) => file.startsWith(prefix))) continue;
      const specifiers = await importsOf(file);
      if (specifiers.some(isSsh2)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it('the check recognises ssh2 subpath imports', () => {
    expect(isSsh2('ssh2')).toBe(true);
    expect(isSsh2('ssh2/lib/protocol/SFTP.js')).toBe(true);
    expect(isSsh2('ssh2-sftp-client')).toBe(false);
  });

  it('the SFTP back-end is where ssh2 is actually used', async () => {
    const files = await typeScriptFiles('src/sftp');
    const users: string[] = [];
    for (const file of files) {
      if ((await importsOf(file)).some(isSsh2)) users.push(file);
    }
    expect(users).toContain('src/sftp/connection.ts');
  });
});
