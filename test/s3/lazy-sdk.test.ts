/**
 * The SDK loads only when an S3 instance connects (design Option 8B, CO-2): the static import
 * graph of the package index and of the composition module reaches no @aws-sdk/ or @smithy/
 * module, so `sftp`, `--help` and SFTP library users load none of it.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT } from '../support/imports.js';

/** The specifiers of the static imports and re-exports of a file; `import()` is left out. */
function staticImports(source: string): string[] {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.ES2023);
  const out: string[] = [];
  for (const statement of file.statements) {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      out.push(statement.moduleSpecifier.text);
    }
  }
  return out;
}

async function reachable(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() ?? '';
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.startsWith('src/')) continue;
    const source = await readFile(join(REPOSITORY_ROOT, file), 'utf8');
    for (const specifier of staticImports(source)) {
      if (specifier.startsWith('.')) {
        const target = relative(
          REPOSITORY_ROOT,
          resolve(
            REPOSITORY_ROOT,
            dirname(file),
            specifier.replace(/\.js$/, '.ts'),
          ),
        )
          .split('\\')
          .join('/');
        queue.push(target);
      } else {
        seen.add(specifier);
      }
    }
  }
  return seen;
}

describe('the SDK is loaded lazily', () => {
  it.each(['src/index.ts', 'src/backends.ts'])(
    'the static import graph of %s reaches no SDK module',
    async (entry) => {
      const graph = await reachable(entry);
      expect(graph.has('src/s3/s3-file-system.ts')).toBe(true);
      expect(graph.has('src/s3/sdk.ts')).toBe(false);
      expect(
        [...graph].filter(
          (name) => name.startsWith('@aws-sdk/') || name.startsWith('@smithy/'),
        ),
      ).toEqual([]);
    },
  );
});
