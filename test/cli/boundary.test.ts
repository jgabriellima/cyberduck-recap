import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPOSITORY_ROOT,
  importsOf,
  isSsh2,
  resolveSpecifier,
  typeScriptFiles,
} from '../support/imports.js';

// The format characters of cyberduck/standard.sanitised-server-text that AC-30 names.
const FORMAT_CODE_POINTS = [
  0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067,
  0x2068, 0x2069,
];

type Form = 'a' | 'b' | 'c';

/** Does `source` hold a code point of AC-30 in the given form? */
function holdsForm(source: string, form: Form): boolean {
  return FORMAT_CODE_POINTS.some((codePoint) => {
    const hex = codePoint.toString(16);
    if (form === 'a') return source.includes(String.fromCodePoint(codePoint));
    if (form === 'b') {
      return new RegExp(`\\\\u${hex.padStart(4, '0')}`, 'i').test(source);
    }
    return new RegExp(`\\\\u\\{0*${hex}\\}`, 'i').test(source);
  });
}

const FIXTURES: Record<Form, string> = {
  a: `const separator = '${String.fromCodePoint(0x2029)}';`,
  b: 'const unsafe = /[\\u202A-\\u202E]/g;',
  c: "const isolate = '\\u{02066}';",
};

async function source(file: string): Promise<string> {
  return readFile(join(REPOSITORY_ROOT, file), 'utf8');
}

/** A relative import as the `.ts` source file it names. */
function sourceTarget(file: string, specifier: string): string {
  return resolveSpecifier(file, specifier).replace(/\.js$/, '.ts');
}

const inCli = (file: string): boolean => file.startsWith('src/cli/');
const inSftp = (file: string): boolean => file.startsWith('src/sftp/');

/**
 * The escape module of AC-30: a module under src/, outside src/cli/, src/sftp/ and src/fs/, that
 * both src/cli/ and src/sftp/ import and that holds the escaped set.
 */
async function escapeModules(): Promise<string[]> {
  const importers = new Map<string, Set<'cli' | 'sftp'>>();
  for (const file of await typeScriptFiles('src')) {
    if (!inCli(file) && !inSftp(file)) continue;
    for (const specifier of await importsOf(file)) {
      if (!specifier.startsWith('.')) continue;
      const target = sourceTarget(file, specifier);
      if (
        !target.startsWith('src/') ||
        inCli(target) ||
        inSftp(target) ||
        target.startsWith('src/fs/')
      ) {
        continue;
      }
      const set = importers.get(target) ?? new Set();
      set.add(inCli(file) ? 'cli' : 'sftp');
      importers.set(target, set);
    }
  }
  const modules: string[] = [];
  for (const [target, by] of importers) {
    if (by.size !== 2) continue;
    const text = await source(target).catch(() => '');
    if ((['a', 'b', 'c'] as const).some((form) => holdsForm(text, form))) {
      modules.push(target);
    }
  }
  return modules.sort();
}

describe('src/cli boundaries (FEATURE-2 AC-30, AC-31)', () => {
  it.each(['a', 'b', 'c'] as const)(
    'AC-30: src/cli and src/sftp escape text through one function (form %s)',
    async (form) => {
      // The pattern finds a line of its form, so a clean scan below means something.
      expect(holdsForm(FIXTURES[form], form)).toBe(true);

      const modules = await escapeModules();
      expect(modules, 'one shared escape module').toHaveLength(1);
      const [escapeModule = ''] = modules;
      const sanitizeImports = (await importsOf('src/sftp/sanitize.ts')).map(
        (specifier) => sourceTarget('src/sftp/sanitize.ts', specifier),
      );
      expect(sanitizeImports).toContain(escapeModule);

      const files = (await typeScriptFiles('src')).filter(
        (file) => inCli(file) || inSftp(file),
      );
      expect(files.some(inCli)).toBe(true);
      for (const file of files) {
        expect(holdsForm(await source(file), form), file).toBe(false);
      }
    },
  );

  it('AC-31: src/cli imports no protocol library and no back-end', async () => {
    const files = await typeScriptFiles('src/cli');
    expect(files.length).toBeGreaterThan(0);
    const allowedModules = await escapeModules();

    for (const file of files) {
      for (const specifier of await importsOf(file)) {
        expect(isSsh2(specifier), `${file} imports ${specifier}`).toBe(false);
        const target = sourceTarget(file, specifier);
        expect(
          target.startsWith('src/sftp/'),
          `${file} imports ${specifier}`,
        ).toBe(false);
        const allowed =
          specifier.startsWith('node:') ||
          inCli(target) ||
          target.startsWith('src/fs/') ||
          allowedModules.includes(target);
        expect(allowed, `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('AC-31: src/cli names no back-end', async () => {
    const files = await typeScriptFiles('src/cli');
    expect(files.length).toBeGreaterThan(0);
    // The scan finds the word in any letter case.
    expect(/sftp/i.test("import x from 'SFTP';")).toBe(true);

    for (const file of files) {
      expect(/sftp/i.test(await source(file)), file).toBe(false);
    }
  });
});
