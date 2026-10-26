/** Import specifiers of TypeScript sources, static and dynamic, for the boundary tests. */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/** Every specifier a source imports or re-exports, including `import()` and `require()` calls. */
export function importSpecifiers(source: string): string[] {
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map((file) => file.fileName);
}

/** Every `.ts` file under `directory`, as repository-relative POSIX paths. */
export async function typeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(join(REPOSITORY_ROOT, directory), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) =>
      relative(REPOSITORY_ROOT, join(entry.parentPath, entry.name))
        .split(sep)
        .join('/'),
    )
    .sort();
}

export async function importsOf(file: string): Promise<string[]> {
  return importSpecifiers(await readFile(join(REPOSITORY_ROOT, file), 'utf8'));
}

/** Where a relative specifier points, as a repository-relative POSIX path; bare ones unchanged. */
export function resolveSpecifier(file: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  return relative(
    REPOSITORY_ROOT,
    resolve(REPOSITORY_ROOT, dirname(file), specifier),
  )
    .split(sep)
    .join('/');
}

export function isSsh2(specifier: string): boolean {
  return specifier === 'ssh2' || specifier.startsWith('ssh2/');
}
