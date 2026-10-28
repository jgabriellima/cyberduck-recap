import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { s3Error } from '../support/s3-server.js';
import { rejection, useS3 } from '../support/s3.js';

describe('retry is bounded (AC-33)', () => {
  it('AC-33: SlowDown on every request makes list reject OPERATION_FAILED after at most 3 requests, within 10 s', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    setup.server.clearRequests();
    setup.server.fault(() =>
      s3Error('SlowDown', 'Please reduce your request rate.'),
    );
    const started = performance.now();
    const error = await rejection(fs.list('/b'), 'OPERATION_FAILED', '/b');
    const elapsed = performance.now() - started;
    expect(error.message).toContain('SlowDown');
    expect(setup.server.requests.length).toBeGreaterThanOrEqual(1);
    expect(setup.server.requests.length).toBeLessThanOrEqual(3);
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);
});
