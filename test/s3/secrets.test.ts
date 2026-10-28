/** The secret set and the server-text point of src/s3/errors.ts (design Option 6A, SE-1). */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { S3Errors } from '../../src/s3/errors.js';
import { SecretSet } from '../../src/s3/secrets.js';
import { sentinel } from '../support/harness.js';
import { loadS3FileSystem } from '../support/s3.js';

function errorsWith(...secrets: string[]): S3Errors {
  const set = new SecretSet();
  for (const secret of secrets) set.add(secret);
  return new S3Errors(set, {
    endpointHost: 'host',
    keySource: 'environment',
    timeoutMs: 1000,
  });
}

describe('SecretSet.redact', () => {
  it('replaces a secret every time it appears', () => {
    const secret = sentinel();
    const set = new SecretSet();
    set.add(secret);
    expect(set.redact(`a ${secret} b ${secret}`)).toBe('a *** b ***');
  });

  it('replaces the escaped form of a secret with a control character', () => {
    const secret = `ab\u0007${sentinel()}`;
    const set = new SecretSet();
    set.add(secret);
    expect(set.redact(`x ab\\x07${secret.slice(3)} y`)).toBe('x *** y');
  });

  it('replaces the longest first, so no part of an overlapping secret is left', () => {
    const long = sentinel();
    const short = long.slice(0, 20);
    const set = new SecretSet();
    set.add(short);
    set.add(long);
    const out = set.redact(`${long}|${short}`);
    expect(out).toBe('***|***');
  });

  it('ignores what is no secret: undefined, a number, an empty string', () => {
    const set = new SecretSet();
    set.add(undefined);
    set.add(42);
    set.add('');
    expect(set.redact('unchanged')).toBe('unchanged');
  });
});

describe('serverText and fail: the one output point', () => {
  it('redacts before it cuts, so a cut never leaves part of a secret', () => {
    const secret = sentinel();
    const errors = errorsWith(secret);
    const text = `${'x'.repeat(490)}${secret}`;
    const shown = errors.serverText(text);
    expect(shown).not.toContain(secret.slice(0, 10));
    expect(shown).toBe(`${'x'.repeat(490)}***`);
  });

  it('a message built anywhere with a secret leaves fail() redacted, with no cause', () => {
    const secret = sentinel();
    const error = errorsWith(secret).fail(
      'OPERATION_FAILED',
      `refused ${secret}`,
      {
        path: '/b/k',
      },
    );
    expect(error.message).toBe('refused ***');
    expect(error.cause).toBeUndefined();
    expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(
      secret,
    );
  });

  it('an instance shows none of its secrets when inspected', async () => {
    const S3FileSystem = await loadS3FileSystem();
    const secret = sentinel();
    const token = sentinel();
    const fs = new S3FileSystem({
      credentials: {
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: secret,
        sessionToken: token,
      },
    });
    const shown = inspect(fs, { depth: 10, showHidden: true });
    expect(shown).not.toContain(secret);
    expect(shown).not.toContain(token);
  });
});
