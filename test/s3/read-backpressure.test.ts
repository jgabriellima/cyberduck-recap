/**
 * The read stream's idle watchdog runs only while the consumer wants data (design SC-8): a
 * consumer that pauses gets no false CONNECTION_LOST, and a body that stops while data is wanted
 * fails within timeoutMs. The timers are faked (the clock is outside the project); the body is a
 * stream the test feeds.
 */
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteFsError } from '../../src/fs/index.js';
import { S3Errors } from '../../src/s3/errors.js';
import { readPath } from '../../src/s3/paths.js';
import { S3ReadStream } from '../../src/s3/read-stream.js';
import { SecretSet } from '../../src/s3/secrets.js';
import type { S3Transport } from '../../src/s3/transport.js';

const TIMEOUT_MS = 300;
const CHUNK = 64 * 1024;

function streamOver(body: PassThrough, length: number): S3ReadStream {
  const transport = {
    getObject: () => Promise.resolve({ body, contentLength: length }),
  } as unknown as S3Transport;
  return new S3ReadStream({
    context: {
      transport,
      errors: new S3Errors(new SecretSet(), {
        endpointHost: 'host',
        keySource: 'environment',
        timeoutMs: TIMEOUT_MS,
      }),
      bucket: undefined,
    },
    location: readPath('/b/k', undefined),
    scope: { signal: new AbortController().signal, cleanup: () => undefined },
    timeoutMs: TIMEOUT_MS,
  });
}

/** Lets the stream's ticks and callbacks run, with no timer. */
async function turn(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the read stream watchdog (SC-8)', () => {
  it('a consumer that stops reading for 10 × timeoutMs gets every byte and no error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = new PassThrough();
    const data = Buffer.alloc(3 * CHUNK, 7);
    const stream = streamOver(body, data.length);
    const errors: unknown[] = [];
    stream.on('error', (error) => errors.push(error));
    body.write(data.subarray(0, 2 * CHUNK));
    await once(stream, 'readable');
    // The consumer reads nothing: the stream's buffer is full, the body is paused, and time
    // passes. (A consumer that drains the buffer asks for more, and the watchdog runs then.)
    await turn();
    vi.advanceTimersByTime(10 * TIMEOUT_MS);
    await turn();
    expect(errors).toEqual([]);
    const received: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => received.push(chunk));
    body.end(data.subarray(2 * CHUNK));
    await once(stream, 'end');
    expect(Buffer.concat(received).equals(data)).toBe(true);
    expect(errors).toEqual([]);
  });

  it('a body that stops while the consumer reads fails CONNECTION_LOST after timeoutMs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = new PassThrough();
    const stream = streamOver(body, 4 * CHUNK);
    const errors: unknown[] = [];
    stream.on('error', (error) => errors.push(error));
    stream.on('data', () => undefined);
    body.write(Buffer.alloc(CHUNK));
    await turn();
    vi.advanceTimersByTime(TIMEOUT_MS - 1);
    await turn();
    expect(errors).toEqual([]);
    vi.advanceTimersByTime(1);
    await turn();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RemoteFsError);
    expect(errors[0]).toMatchObject({ code: 'CONNECTION_LOST', path: '/b/k' });
  });
});
