/**
 * Adversarial (FEATURE-3, ATK-81): disconnect() at points AC-34 does not reach, under
 * cyberduck/standard.session-ending-settles-once. A rename whose copy reply arrives after the end
 * must not go on to delete `from`; a recursive mkdir whose ancestor check is answered after the
 * end must not write its marker; a connect() whose probe is still in flight settles once, with a
 * typed error, at once and not after `timeoutMs`. No request follows the end except an abort.
 */
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { REMOTE_FS_ERROR_CODES, RemoteFsError } from '../../src/fs/index.js';
import { rejection, useS3 } from '../support/s3.js';

/** A promise and the function that settles it: a server reply the test releases. */
function gate(): { readonly until: Promise<void>; release(): void } {
  let release: () => void = () => undefined;
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { until, release: () => release() };
}

describe('ATK-81: a reply that arrives after disconnect() starts no further step', () => {
  it('rename: a CopyObject answered after the end sends no DeleteObject; from keeps its bytes', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'a.txt', 'original');
    const fs = await setup.connected();
    const copy = gate();
    setup.server.fault((r) =>
      r.operation === 'CopyObject'
        ? { kind: 'hold', until: copy.until }
        : undefined,
    );
    const renaming = rejection(
      fs.rename('/b/a.txt', '/b/c.txt'),
      'NOT_CONNECTED',
      '/b/a.txt',
    );
    const request = await setup.server.waitForRequest(
      (r) => r.operation === 'CopyObject',
    );
    const disconnected = fs.disconnect();
    copy.release();
    await setup.server.responseSettled(request);
    await disconnected;
    const error = await renaming;
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(setup.server.requestsOf('DeleteObject')).toHaveLength(0);
    expect(setup.server.getObject('b', 'a.txt')?.toString()).toBe('original');
  }, 15_000);

  it('recursive mkdir: an ancestor check answered after the end writes no marker', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    const head = gate();
    setup.server.fault((r) =>
      r.operation === 'HeadObject' || r.operation === 'ListObjectsV2'
        ? { kind: 'hold', until: head.until }
        : undefined,
    );
    const making = rejection(
      fs.mkdir('/b/x/y/z', { recursive: true }),
      'NOT_CONNECTED',
      '/b/x/y/z',
    );
    const request = await setup.server.waitForRequest(
      (r) => r.operation === 'HeadObject' || r.operation === 'ListObjectsV2',
    );
    const disconnected = fs.disconnect();
    head.release();
    await setup.server.responseSettled(request);
    await disconnected;
    await making;
    const after = setup.server.requests.filter((r) => r.index > request.index);
    expect(after.map((r) => r.operation)).toEqual([]);
    expect(setup.server.keysOf('b')).toEqual([]);
  }, 15_000);
});

describe('ATK-81: disconnect() while connect() waits for its probe', () => {
  it('both pending connect() calls settle once with one typed error, at once, and connect works again', async () => {
    const setup = await useS3();
    const fs = await setup.s3();
    const removeStall = setup.server.fault((r) =>
      r.operation === 'ListBuckets' ? { kind: 'stall' } : undefined,
    );
    const outcomes: unknown[][] = [[], []];
    const first = fs.connect().then(
      () => outcomes[0]?.push('resolved'),
      (error: unknown) => outcomes[0]?.push(error),
    );
    const second = fs.connect().then(
      () => outcomes[1]?.push('resolved'),
      (error: unknown) => outcomes[1]?.push(error),
    );
    await setup.server.waitForRequest((r) => r.operation === 'ListBuckets');
    const started = performance.now();
    await fs.disconnect();
    await Promise.all([first, second]);
    // timeoutMs is 30000 by default: settling well before it shows that disconnect() ended
    // the probe, not the timer.
    expect(performance.now() - started).toBeLessThan(5000);
    for (const outcome of outcomes) {
      expect(outcome).toHaveLength(1);
      const error = outcome[0];
      expect(error).toBeInstanceOf(RemoteFsError);
      expect(error).not.toBeInstanceOf(AggregateError);
      expect(REMOTE_FS_ERROR_CODES).toContain((error as RemoteFsError).code);
      expect(['NOT_CONNECTED', 'CONNECTION_FAILED']).toContain(
        (error as RemoteFsError).code,
      );
    }
    expect(setup.server.requestsOf('ListBuckets')).toHaveLength(1);

    removeStall();
    await fs.connect();
    await expect(fs.list('/')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'b' })]),
    );
  }, 15_000);
});
