/**
 * A body that breaks or stops (AC-32): the read stream ends with one CONNECTION_LOST, a stalled
 * server is bounded by timeoutMs, and the instance keeps working afterwards (S3 has no session).
 */
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { Fault } from '../support/s3-server.js';
import {
  MIB,
  bytes,
  onlyError,
  readAll,
  rejection,
  sha256,
  useS3,
} from '../support/s3.js';

describe('stream integrity (AC-32)', () => {
  const broken: [string, Fault][] = [
    ['a reset after half of 1 MiB', { kind: 'reset-in-body', after: MIB / 2 }],
    [
      'fewer bytes than Content-Length and a close',
      { kind: 'short-body', after: MIB / 2 },
    ],
  ];
  for (const [label, fault] of broken) {
    it(`AC-32: ${label} ends the read stream with one CONNECTION_LOST and no end`, async () => {
      const setup = await useS3();
      setup.server.putObject('b', 'k', bytes(MIB));
      const fs = await setup.connected();
      const remove = setup.server.fault((r) =>
        r.operation === 'GetObject' ? fault : undefined,
      );
      const outcome = await readAll(fs.createReadStream('/b/k'));
      onlyError(outcome, 'CONNECTION_LOST', '/b/k');
      expect(outcome.ended).toBe(false);
      remove();
      const again = await readAll(fs.createReadStream('/b/k'));
      expect(again.errors).toEqual([]);
      expect(sha256(again.data)).toBe(sha256(bytes(MIB)));
    });
  }

  it('AC-32: with timeoutMs 300, a body that stops gives CONNECTION_LOST within 3 s', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'k', bytes(MIB));
    const fs = await setup.connected({ timeoutMs: 300 });
    const remove = setup.server.fault((r) =>
      r.operation === 'GetObject'
        ? { kind: 'stall-in-body', after: 100_000 }
        : undefined,
    );
    const started = performance.now();
    const outcome = await readAll(fs.createReadStream('/b/k'));
    expect(performance.now() - started).toBeLessThan(3000);
    onlyError(outcome, 'CONNECTION_LOST', '/b/k');
    expect(outcome.ended).toBe(false);
    remove();
    expect(sha256((await readAll(fs.createReadStream('/b/k'))).data)).toBe(
      sha256(bytes(MIB)),
    );
  }, 10_000);

  it('AC-32: with timeoutMs 300, a stat that is never answered gives CONNECTION_LOST within 3 s', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'k', 'data');
    const fs = await setup.connected({ timeoutMs: 300 });
    const remove = setup.server.fault(() => ({ kind: 'stall' }));
    const started = performance.now();
    await rejection(fs.stat('/b/k'), 'CONNECTION_LOST', '/b/k');
    expect(performance.now() - started).toBeLessThan(3000);
    remove();
    expect((await fs.stat('/b/k')).type).toBe('file');
  }, 10_000);

  it('AC-32: with timeoutMs 300, a probe that is never answered gives CONNECTION_FAILED within 3 s', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'k', 'data');
    const fs = await setup.s3({ timeoutMs: 300 });
    const remove = setup.server.fault(() => ({ kind: 'stall' }));
    const started = performance.now();
    await rejection(fs.connect(), 'CONNECTION_FAILED');
    expect(performance.now() - started).toBeLessThan(3000);
    remove();
    await fs.connect();
    expect((await fs.stat('/b/k')).type).toBe('file');
  }, 10_000);
});
