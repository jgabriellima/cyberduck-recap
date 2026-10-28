/**
 * The one points of src/s3 (design Option 6A, MA-1, MA-10): only errors.ts builds a
 * RemoteFsError, only sdk.ts imports the SDK, and only validation.ts writes a value rule.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPOSITORY_ROOT,
  importsOf,
  typeScriptFiles,
} from '../support/imports.js';

async function filesHolding(pattern: RegExp): Promise<string[]> {
  const out: string[] = [];
  for (const file of await typeScriptFiles('src/s3')) {
    const text = await readFile(join(REPOSITORY_ROOT, file), 'utf8');
    if (pattern.test(text)) out.push(file);
  }
  return out;
}

describe('the one points of the S3 back-end', () => {
  it('only src/s3/errors.ts constructs a RemoteFsError', async () => {
    expect(await filesHolding(/new RemoteFsError\b/)).toEqual([
      'src/s3/errors.ts',
    ]);
  });

  it('only src/s3/sdk.ts imports @aws-sdk/ or @smithy/ (value or type)', async () => {
    const users: string[] = [];
    for (const file of await typeScriptFiles('src/s3')) {
      const specifiers = await importsOf(file);
      if (
        specifiers.some(
          (s) => s.startsWith('@aws-sdk/') || s.startsWith('@smithy/'),
        )
      ) {
        users.push(file);
      }
    }
    expect(users).toEqual(['src/s3/sdk.ts']);
  });

  it('only src/s3/validation.ts holds the region or bucket rule', async () => {
    expect(await filesHolding(/a-z0-9-/)).toEqual(['src/s3/validation.ts']);
    expect(await filesHolding(/'arn:'|"arn:"|`arn:/)).toEqual([
      'src/s3/validation.ts',
    ]);
  });
});
