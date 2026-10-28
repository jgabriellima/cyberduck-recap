/**
 * AC-1: the public API and the error contract. The type check runs the TypeScript compiler on a
 * small program at run time, so this file type-checks before src/s3 exists and fails until it does.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, onTestFinished } from 'vitest';
import { REMOTE_FS_ERROR_CODES, RemoteFsError } from '../../src/fs/index.js';
import { REPOSITORY_ROOT } from '../support/imports.js';
import { loadIndex, readAll, rejection, useS3 } from '../support/s3.js';

describe('S3FileSystem is a RemoteFileSystem in the public API (AC-1)', () => {
  it('AC-1: src/index.ts exports S3FileSystem', async () => {
    const index = await loadIndex();
    expect(typeof index.S3FileSystem).toBe('function');
  });

  it('AC-1: S3FileSystemOptions is exported and an instance type-checks as RemoteFileSystem', async () => {
    const dir = await mkdtemp(join(REPOSITORY_ROOT, 'test', '.contract-'));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, 'contract.ts');
    await writeFile(
      file,
      [
        "import { S3FileSystem, type RemoteFileSystem, type S3FileSystemOptions } from '../../src/index.js';",
        "const options: S3FileSystemOptions = { bucket: 'b', region: 'us-east-1', timeoutMs: 1000 };",
        'const fs: RemoteFileSystem = new S3FileSystem(options);',
        'export { fs };',
        '',
      ].join('\n'),
    );
    const program = ts.createProgram([file], {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: ['node'],
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      noEmit: true,
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.file?.fileName === file)
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      );
    expect(diagnostics).toEqual([]);
  }, 60_000);

  it('AC-1: errors are RemoteFsError with one of the 13 codes', async () => {
    expect(REMOTE_FS_ERROR_CODES).toHaveLength(13);
    const setup = await useS3();
    const fs = await setup.s3();
    // Before connect(): NOT_CONNECTED, a rejection and a stream error.
    const early = await rejection(fs.list('/b'), 'NOT_CONNECTED');
    expect(early).toBeInstanceOf(RemoteFsError);
    await fs.connect();
    const missing = await rejection(fs.stat('/b/nothing'), 'NOT_FOUND');
    expect(REMOTE_FS_ERROR_CODES).toContain(missing.code);
    const outcome = await readAll(fs.createReadStream('/b/nothing'));
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toBeInstanceOf(RemoteFsError);
    expect(REMOTE_FS_ERROR_CODES).toContain(
      (outcome.errors[0] as RemoteFsError).code,
    );
  });
});
