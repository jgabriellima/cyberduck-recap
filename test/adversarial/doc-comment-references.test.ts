/**
 * ATK-93 (design record drift): a doc comment that names a file or a function the code no longer
 * has misleads the next reader (standard records-follow-changes). The review found this twice by
 * hand: a support module named a test that did not exist, and `src/s3/errors.ts` named a
 * function `codeText` that did not exist. This attack checks the property over every comment of
 * the repository's code at once, not one site: every repository path a comment names exists, and
 * every function a comment in src/ names as `name()` is defined in src/.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** The comment text of a TypeScript file: `//` tails and `/* ... *\/` blocks. */
function comments(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(
    /\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/[^\n]*/g,
  )) {
    found.push(match[0]);
  }
  return found;
}

/** The text with its comments removed, so a definition is never found in a comment. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/[^\n]*/g, '');
}

const LANGUAGE = new Set(['import', 'require', 'super']);

const SRC = sources(join(ROOT, 'src'));
const ALL = [...SRC, ...sources(join(ROOT, 'test'))];

describe('Doc comments name only files and functions that exist', () => {
  it('every src/ or test/ path a comment names exists (an import specifier .js names its .ts)', () => {
    const missing: string[] = [];
    for (const file of ALL) {
      for (const comment of comments(readFileSync(file, 'utf8'))) {
        for (const match of comment.matchAll(
          /\b((?:src|test)\/[A-Za-z0-9_./-]+?\.(?:ts|js|json))\b/g,
        )) {
          const named = match[1] ?? '';
          const path = join(ROOT, named.replace(/\.js$/, '.ts'));
          if (!existsSync(path) && !existsSync(join(ROOT, named))) {
            missing.push(`${relative(ROOT, file)}: ${named}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every `name()` a comment in src/ names is a function or method defined in src/', () => {
    const definitions = SRC.map((file) =>
      code(readFileSync(file, 'utf8')),
    ).join('\n');
    const undefinedNames: string[] = [];
    let checked = 0;
    for (const file of SRC) {
      for (const comment of comments(readFileSync(file, 'utf8'))) {
        for (const match of comment.matchAll(
          /`#?([A-Za-z_$][A-Za-z0-9_$]*)\(\)`/g,
        )) {
          const name = match[1] ?? '';
          // Language forms, not functions of the code.
          if (LANGUAGE.has(name)) continue;
          checked += 1;
          const defined = new RegExp(
            `(?:function\\s*\\*?\\s*|\\b(?:const|let)\\s+)${name}\\b|^\\s*(?:(?:public|private|protected|static|override|async|get|set|readonly)\\s+)*#?${name}\\s*[(<]|\\b${name}\\s*[:=]\\s*(?:async\\s*)?(?:\\(|function)`,
            'm',
          );
          if (!defined.test(definitions)) {
            undefinedNames.push(`${relative(ROOT, file)}: ${name}()`);
          }
        }
      }
    }
    expect(undefinedNames).toEqual([]);
    // The check is live: the comments of src/ do name functions this way.
    expect(checked).toBeGreaterThan(0);
  });
});
