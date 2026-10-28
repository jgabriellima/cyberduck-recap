import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT } from '../support/imports.js';

// FEATURE-2's promise: a later back-end needs no change in src/cli/ (FEATURE-3 decision 2).
describe('the S3 back-end changes no file under src/cli (AC-3)', () => {
  it('AC-3: git diff --quiet main...HEAD -- src/cli exits 0', () => {
    let status = 0;
    try {
      execFileSync('git', ['diff', '--quiet', 'main...HEAD', '--', 'src/cli'], {
        cwd: REPOSITORY_ROOT,
        stdio: 'ignore',
      });
    } catch (error) {
      status = (error as { status?: number }).status ?? -1;
    }
    expect(status).toBe(0);
  });
});
