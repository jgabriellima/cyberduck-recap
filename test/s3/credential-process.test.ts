/**
 * The back-end's own credential_process runner (design Option 4C): it knows the exit code, never
 * shows the process's output or command, and stops a process that does not finish in time.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ProcessFailure,
  parseProcessOutput,
  runCredentialProcess,
} from '../../src/s3/credential-process.js';
import { sentinel, tempDir } from '../support/harness.js';

async function command(source: string): Promise<string> {
  const script = join(await tempDir(), 'process.mjs');
  await writeFile(script, source);
  return `"${process.execPath}" "${script}"`;
}

async function failure(promise: Promise<unknown>): Promise<ProcessFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProcessFailure);
    return error as ProcessFailure;
  }
  throw new Error('expected a ProcessFailure');
}

describe('runCredentialProcess', () => {
  it('gives the keys of a Version 1 document', async () => {
    const keys = await runCredentialProcess(
      await command(
        `process.stdout.write(JSON.stringify({ Version: 1, AccessKeyId: 'AKIA1', SecretAccessKey: 's', SessionToken: 't' }));`,
      ),
      10_000,
    );
    expect(keys).toEqual({
      accessKeyId: 'AKIA1',
      secretAccessKey: 's',
      sessionToken: 't',
    });
  });

  it('reports the exit code and none of the output', async () => {
    const secret = sentinel();
    const error = await failure(
      runCredentialProcess(
        await command(
          `process.stdout.write('${secret}'); process.stderr.write('${secret}'); process.exitCode = 3;`,
        ),
        10_000,
      ),
    );
    expect(error.problem).toEqual({ kind: 'exit', code: 3 });
    expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(
      secret,
    );
  });

  it('reports invalid output as such, with none of it', async () => {
    const secret = sentinel();
    const error = await failure(
      runCredentialProcess(
        await command(`process.stdout.write('{not json ${secret}');`),
        10_000,
      ),
    );
    expect(error.problem).toEqual({ kind: 'invalid' });
    expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(
      secret,
    );
  });

  it('stops a process that does not finish within the bound', async () => {
    const error = await failure(
      runCredentialProcess(
        await command(
          "import { createServer } from 'node:net'; createServer().listen(0, '127.0.0.1');",
        ),
        300,
      ),
    );
    expect(error.problem).toEqual({ kind: 'timeout', timeoutMs: 300 });
  });
});

describe('parseProcessOutput', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  const document = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      Version: 1,
      AccessKeyId: 'AKIA1',
      SecretAccessKey: 's',
      ...extra,
    });

  it('keeps an Expiration in the future', () => {
    expect(
      parseProcessOutput(document({ Expiration: '2026-10-01T01:00:00Z' }), now),
    ).toEqual({
      accessKeyId: 'AKIA1',
      secretAccessKey: 's',
      expiration: new Date('2026-10-01T01:00:00Z'),
    });
  });

  it.each([
    ['a past Expiration', document({ Expiration: '2026-09-30T00:00:00Z' })],
    ['an invalid Expiration', document({ Expiration: 'tomorrow' })],
    [
      'another Version',
      JSON.stringify({ Version: 2, AccessKeyId: 'A', SecretAccessKey: 's' }),
    ],
    ['no secret key', JSON.stringify({ Version: 1, AccessKeyId: 'A' })],
    ['an empty session token', document({ SessionToken: '' })],
    ['a JSON array', '[]'],
  ])('refuses %s as printed no valid credentials', (_label, text) => {
    let caught: unknown;
    try {
      parseProcessOutput(text, now);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProcessFailure);
    expect((caught as ProcessFailure).problem).toEqual({ kind: 'invalid' });
  });
});
