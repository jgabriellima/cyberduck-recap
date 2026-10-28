/**
 * `@smithy/core` is a direct dependency at the exact version `@aws-sdk/client-s3` resolves (design
 * CO-8): the lockfile holds one copy, so the tree has one cache of the shared files.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT } from '../support/imports.js';

describe('the SDK versions stay in step', () => {
  it('pnpm-lock.yaml resolves one @smithy/core, the one @aws-sdk/client-s3 uses', async () => {
    const lock = await readFile(
      join(REPOSITORY_ROOT, 'pnpm-lock.yaml'),
      'utf8',
    );
    const versions = new Set(
      [...lock.matchAll(/^ {2}'@smithy\/core@([^']+)':$/gm)].map(
        (match) => match[1],
      ),
    );
    expect(versions.size).toBe(1);
    const snapshot = /^ {2}'@aws-sdk\/client-s3@[^']+':\n((?: {4}.*\n)+)/m.exec(
      lock.slice(lock.indexOf('\nsnapshots:')),
    );
    const used = /'@smithy\/core': ([^\s]+)/.exec(snapshot?.[1] ?? '')?.[1];
    expect(used).toBeDefined();
    expect([...versions]).toEqual([used]);
    const manifest = JSON.parse(
      await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies['@smithy/core']).toBe(used);
  });
});
