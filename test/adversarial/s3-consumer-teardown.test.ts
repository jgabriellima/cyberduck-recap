/**
 * Adversarial (FEATURE-3, verify round): what the S3 read stream exposes that AC-32 and AC-34 do
 * not reach. ATK-86: the consumer abandons a download (destroy()) halfway, or before the GetObject
 * reply comes; the body must not stay open and the instance must keep working
 * (cyberduck/standard.untrusted-server-replies: no leaked stream). ATK-87: a GetObject reply of one
 * generation arrives after disconnect() and a new connect(); it must not reach the new generation.
 */
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  MIB,
  bytes,
  onlyError,
  readAll,
  sha256,
  useS3,
} from '../support/s3.js';

const BIG = 20 * MIB;

/** A promise and the function that resolves it. */
function gate(): { until: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { until, release };
}

describe('ATK-86: the consumer abandons a download', () => {
  it('destroy() after the first chunk closes the stream with no error and stops the body', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'big', bytes(BIG));
    setup.server.putObject('b', 'small', bytes(1000, 3));
    const fs = await setup.connected();

    const stream = fs.createReadStream('/b/big');
    const errors: unknown[] = [];
    stream.on('error', (error) => errors.push(error));
    await once(stream, 'data');
    const closed = once(stream, 'close');
    stream.destroy();
    await closed;

    const get = setup.server.requestsOf('GetObject', 'big')[0];
    expect(get).toBeDefined();
    await setup.server.responseSettled(get!);
    expect(get!.connectionClosedEarly).toBe(true);
    expect(get!.responseBytesSent).toBeLessThan(BIG);
    expect(errors).toHaveLength(0);

    const after = await readAll(fs.createReadStream('/b/small'));
    expect(after.errors).toHaveLength(0);
    expect(sha256(after.data)).toBe(sha256(bytes(1000, 3)));
  }, 30_000);

  it('destroy() before the GetObject reply: the late body is not read to its end', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'big', bytes(BIG));
    const fs = await setup.connected();
    const { until, release } = gate();
    const removeFault = setup.server.fault((request) =>
      request.operation === 'GetObject' ? { kind: 'hold', until } : undefined,
    );

    const stream = fs.createReadStream('/b/big');
    const errors: unknown[] = [];
    let dataEvents = 0;
    stream.on('error', (error) => errors.push(error));
    stream.on('data', () => {
      dataEvents += 1;
    });
    const get = await setup.server.waitForRequest(
      (r) => r.operation === 'GetObject',
    );
    const closed = once(stream, 'close');
    stream.destroy();
    release();
    await setup.server.responseSettled(get);
    await closed;

    expect(get.connectionClosedEarly).toBe(true);
    expect(get.responseBytesSent).toBeLessThan(BIG);
    expect(dataEvents).toBe(0);
    expect(errors).toHaveLength(0);

    removeFault();
    const again = await readAll(fs.createReadStream('/b/big'));
    expect(again.errors).toHaveLength(0);
    expect(again.data.length).toBe(BIG);
  }, 30_000);
});

describe('ATK-87: a reply of an ended generation after a new connect()', () => {
  it('settles the old stream once with NOT_CONNECTED, sends it no byte, and the new one reads', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'big', bytes(BIG));
    const fs = await setup.connected();
    const { until, release } = gate();
    const removeFault = setup.server.fault((request) =>
      request.operation === 'GetObject' && request.key === 'big'
        ? { kind: 'hold', until }
        : undefined,
    );

    const old = readAll(fs.createReadStream('/b/big'));
    const get = await setup.server.waitForRequest(
      (r) => r.operation === 'GetObject',
    );
    await fs.disconnect();
    removeFault();
    await fs.connect();
    release();
    await setup.server.responseSettled(get);

    const outcome = await old;
    onlyError(outcome, 'NOT_CONNECTED', '/b/big');
    expect(outcome.dataEvents).toBe(0);
    expect(outcome.ended).toBe(false);
    expect(get.connectionClosedEarly).toBe(true);
    expect(get.responseBytesSent).toBeLessThan(BIG);

    const fresh = await readAll(fs.createReadStream('/b/big'));
    expect(fresh.errors).toHaveLength(0);
    expect(sha256(fresh.data)).toBe(sha256(bytes(BIG)));
  }, 30_000);
});
