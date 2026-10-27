import { describe, expect, it } from 'vitest';
import { importsOf, typeScriptFiles } from '../support/imports.js';

describe('src/text is a leaf (FEATURE-2 design, Option 3A)', () => {
  it('no module under src/text imports anything', async () => {
    const files = await typeScriptFiles('src/text');
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      expect(await importsOf(file), file).toEqual([]);
    }
  });
});
