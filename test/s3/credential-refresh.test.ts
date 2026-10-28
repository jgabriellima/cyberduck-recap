/**
 * The key cache of the credential sources (design SC-11, MA-9): keys stay until 5 minutes before
 * their expiry, then the source runs again; callers that ask at once share one run; a failed run
 * is CredentialsUnavailable with a fixed text and does not stick. The clock is faked (`Date`
 * only), so no test waits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_WINDOW_MS, remembered } from '../../src/s3/credentials.js';
import { SecretSet } from '../../src/s3/secrets.js';
import { CredentialsUnavailable, type S3Keys } from '../../src/s3/transport.js';
import { sentinel } from '../support/harness.js';

const MINUTE = 60_000;
const START = new Date('2026-01-01T00:00:00Z');

function keys(expiresInMs: number | undefined): S3Keys {
  return {
    accessKeyId: 'AKIATESTCACHE',
    secretAccessKey: sentinel(),
    sessionToken: sentinel(),
    ...(expiresInMs === undefined
      ? {}
      : { expiration: new Date(Date.now() + expiresInMs) }),
  };
}

/** A source that hands out the given key sets in turn and counts its runs. */
function source(make: () => S3Keys): {
  inner: () => Promise<S3Keys>;
  runs: () => number;
} {
  let runs = 0;
  return {
    inner: () => {
      runs += 1;
      return Promise.resolve(make());
    },
    runs: () => runs,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('remembered() keeps keys until the refresh window', () => {
  it('the refresh window is 5 minutes', () => {
    expect(REFRESH_WINDOW_MS).toBe(5 * MINUTE);
  });

  it('keys that expire in 10 minutes are reused for 5 minutes, then the source runs again', async () => {
    const counted = source(() => keys(10 * MINUTE));
    const provider = remembered(counted.inner, new SecretSet());

    const first = await provider();
    vi.setSystemTime(START.getTime() + 4 * MINUTE);
    expect(await provider()).toBe(first);
    vi.setSystemTime(START.getTime() + 5 * MINUTE - 1);
    expect(await provider()).toBe(first);
    expect(counted.runs()).toBe(1);

    vi.setSystemTime(START.getTime() + 5 * MINUTE);
    const second = await provider();
    expect(second).not.toBe(first);
    expect(counted.runs()).toBe(2);
  });

  it('keys with no expiry are kept for good', async () => {
    const counted = source(() => keys(undefined));
    const provider = remembered(counted.inner, new SecretSet());
    const first = await provider();
    vi.setSystemTime(START.getTime() + 24 * 60 * MINUTE);
    expect(await provider()).toBe(first);
    expect(counted.runs()).toBe(1);
  });

  it('keys that are already inside the window are fetched again on each call', async () => {
    const counted = source(() => keys(2 * MINUTE));
    const provider = remembered(counted.inner, new SecretSet());
    await provider();
    await provider();
    expect(counted.runs()).toBe(2);
  });

  it('callers that ask during one run share it', async () => {
    let release: (value: S3Keys) => void = () => undefined;
    let runs = 0;
    const provider = remembered(() => {
      runs += 1;
      return new Promise<S3Keys>((resolve) => {
        release = resolve;
      });
    }, new SecretSet());

    const a = provider();
    const b = provider();
    const c = provider();
    expect(runs).toBe(1);
    const given = keys(60 * MINUTE);
    release(given);
    expect(await Promise.all([a, b, c])).toEqual([given, given, given]);
    expect(runs).toBe(1);
  });

  it('the secret and the token of each key set join the secret set', async () => {
    const secrets = new SecretSet();
    const given = keys(60 * MINUTE);
    const provider = remembered(() => Promise.resolve(given), secrets);
    await provider();
    const line = `x ${given.secretAccessKey} y ${given.sessionToken ?? ''} z`;
    expect(secrets.redact(line)).toBe('x *** y *** z');
  });
});

describe('remembered() maps a failed refresh', () => {
  it('any error of the source is CredentialsUnavailable with a fixed text, never its own', async () => {
    const secret = sentinel();
    const provider = remembered(
      () => Promise.reject(new Error(`the process printed ${secret}`)),
      new SecretSet(),
    );
    const error = await provider().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CredentialsUnavailable);
    expect((error as Error).message).toBe('the credential source failed');
    expect(String((error as Error).stack)).not.toContain(secret);
  });

  it('a CredentialsUnavailable of the source passes as it is', async () => {
    const own = new CredentialsUnavailable(
      'the AWS credential chain gave no keys',
    );
    const provider = remembered(() => Promise.reject(own), new SecretSet());
    await expect(provider()).rejects.toBe(own);
  });

  it('a failed refresh does not stick: the next call runs the source again', async () => {
    let runs = 0;
    const first = keys(10 * MINUTE);
    const provider = remembered(() => {
      runs += 1;
      if (runs === 2) return Promise.reject(new Error('expired session'));
      return Promise.resolve(runs === 1 ? first : keys(60 * MINUTE));
    }, new SecretSet());

    expect(await provider()).toBe(first);
    vi.setSystemTime(START.getTime() + 6 * MINUTE);
    await expect(provider()).rejects.toBeInstanceOf(CredentialsUnavailable);
    const third = await provider();
    expect(third).not.toBe(first);
    expect(runs).toBe(3);
  });
});
