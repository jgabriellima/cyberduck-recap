import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { APP_NAME } from './index.js';

describe('package entry', () => {
  it('exposes the application name declared by the package manifest', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { name: string };

    expect(APP_NAME).toBe(manifest.name);
  });
});
