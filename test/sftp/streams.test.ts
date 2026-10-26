import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Session } from '../../src/sftp/session.js';
import {
  CHUNK_SIZE,
  WINDOW,
  createSftpReadStream,
  createSftpWriteStream,
} from '../../src/sftp/streams.js';
import {
  FakeTransport,
  statusError,
  type PendingRequest,
} from '../support/fake-channel.js';
import {
  expectStreamError,
  readAll,
  sha256,
  streamOutcome,
} from '../support/remote-fs-assertions.js';
import { waitUntil } from '../support/sftp-server.js';

const EOF = 1;
const FAILURE = 4;
const HANDLE = Buffer.from([1, 2, 3, 4]);

function setup(): { transport: FakeTransport; session: Session } {
  const transport = new FakeTransport();
  transport.sftp.responders['open'] = () => ({ value: HANDLE });
  transport.sftp.responders['close'] = () => ({});
  return { transport, session: new Session(transport) };
}

function answerRead(
  request: PendingRequest,
  file: Buffer,
  limit?: number,
): void {
  const [, position, length] = request.args as [Buffer, number, number];
  if (position >= file.length) {
    request.reply(statusError(EOF, 'EOF'));
    return;
  }
  const end = Math.min(
    position + Math.min(length, limit ?? length),
    file.length,
  );
  request.reply(undefined, file.subarray(position, end));
}

describe('pipelined read stream', () => {
  it('keeps at most WINDOW reads in flight and delivers out-of-order replies in order', async () => {
    const { transport, session } = setup();
    const file = randomBytes(CHUNK_SIZE * 40 + 123);
    const stream = createSftpReadStream(session, '/f');
    const result = readAll(stream);

    while (!stream.readableEnded && !stream.destroyed) {
      await waitUntil(
        () => transport.sftp.pending.length > 0 || stream.readableEnded,
      );
      const reads = transport.sftp.take('read');
      expect(reads.length).toBeLessThanOrEqual(WINDOW);
      for (const request of reads.reverse()) answerRead(request, file);
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(sha256(await result)).toBe(sha256(file));
  });

  it('re-requests the missing range after a short read', async () => {
    const { transport, session } = setup();
    const file = randomBytes(CHUNK_SIZE * 3);
    transport.sftp.responders['read'] = (_handle, position, length) => {
      const start = position as number;
      if (start >= file.length) return { error: statusError(EOF) };
      // Never more than 1000 bytes per reply, as a constrained server might answer.
      const end = Math.min(
        start + Math.min(length as number, 1000),
        file.length,
      );
      return { value: file.subarray(start, end) };
    };

    const data = await readAll(createSftpReadStream(session, '/f'));

    expect(sha256(data)).toBe(sha256(file));
  });

  it('fails with OPERATION_FAILED after three empty replies at one offset', async () => {
    const { transport, session } = setup();
    let reads = 0;
    transport.sftp.responders['read'] = () => {
      reads += 1;
      return { value: Buffer.alloc(0) };
    };

    await expectStreamError(
      createSftpReadStream(session, '/f'),
      'OPERATION_FAILED',
      {
        path: '/f',
      },
    );
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it('a consumer that stops reading stops new requests (backpressure)', async () => {
    const { transport, session } = setup();
    const file = randomBytes(CHUNK_SIZE * 200);
    let reads = 0;
    transport.sftp.responders['read'] = (_handle, position, length) => {
      reads += 1;
      const start = position as number;
      return { value: file.subarray(start, start + (length as number)) };
    };
    const stream = createSftpReadStream(session, '/f');
    // A 'readable' listener that never calls read(): the buffer fills to the high-water mark.
    stream.on('readable', () => undefined);

    await waitUntil(
      () => stream.readableLength >= stream.readableHighWaterMark,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const settled = reads;
    await new Promise((resolve) => setImmediate(resolve));

    expect(reads).toBe(settled);
    expect(reads).toBeLessThanOrEqual(2 * WINDOW);
    stream.destroy();
  });

  it('a FAILURE on a directory becomes IS_A_DIRECTORY', async () => {
    const { transport, session } = setup();
    transport.sftp.responders['read'] = () => ({ error: statusError(FAILURE) });
    transport.sftp.responders['stat'] = () => ({ value: { mode: 0o040755 } });

    await expectStreamError(
      createSftpReadStream(session, '/d'),
      'IS_A_DIRECTORY',
    );
  });

  it('a FAILURE on a file stays OPERATION_FAILED', async () => {
    const { transport, session } = setup();
    transport.sftp.responders['read'] = () => ({
      error: statusError(FAILURE, 'bad'),
    });
    transport.sftp.responders['stat'] = () => ({ value: { mode: 0o100644 } });

    await expectStreamError(
      createSftpReadStream(session, '/f'),
      'OPERATION_FAILED',
    );
  });
});

describe('pipelined write stream', () => {
  it('bounds writes in flight by WINDOW and finishes only after the handle is closed', async () => {
    const { transport, session } = setup();
    delete transport.sftp.responders['close'];
    const content = randomBytes(CHUNK_SIZE * 40 + 7);
    const written = Buffer.alloc(content.length);
    const stream = createSftpWriteStream(session, '/f');
    const outcome = streamOutcome(stream);
    stream.end(content);

    let closeRequest: PendingRequest | undefined;
    while (closeRequest === undefined) {
      await waitUntil(() => transport.sftp.pending.length > 0);
      const writes = transport.sftp.take('write');
      expect(writes.length).toBeLessThanOrEqual(WINDOW);
      for (const request of writes.reverse()) {
        const [, position, data] = request.args as [Buffer, number, Buffer];
        data.copy(written, position);
        request.reply(undefined);
      }
      closeRequest = transport.sftp.take('close')[0];
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(stream.writableFinished).toBe(false);
    closeRequest.reply(undefined);
    const { error, finished } = await outcome;
    expect(error).toBeUndefined();
    expect(finished).toBe(true);
    expect(sha256(written)).toBe(sha256(content));
  });

  it('a failed write errors the stream and never finishes', async () => {
    const { transport, session } = setup();
    transport.sftp.responders['write'] = () => ({
      error: statusError(FAILURE, 'disk full'),
    });
    const stream = createSftpWriteStream(session, '/f');
    stream.end(randomBytes(10));

    const error = await expectStreamError(stream, 'OPERATION_FAILED', {
      path: '/f',
    });
    expect(error.message).toContain('disk full');
  });

  it('a failed close errors the stream and never finishes', async () => {
    const { transport, session } = setup();
    transport.sftp.responders['write'] = () => ({});
    transport.sftp.responders['close'] = () => ({
      error: statusError(FAILURE, 'close failed'),
    });
    const stream = createSftpWriteStream(session, '/f');
    stream.end(randomBytes(10));

    await expectStreamError(stream, 'OPERATION_FAILED', { path: '/f' });
  });

  it('an empty upload opens and closes the file', async () => {
    const { session } = setup();
    const stream = createSftpWriteStream(session, '/empty');
    stream.end();

    const { finished, error } = await streamOutcome(stream);
    expect(error).toBeUndefined();
    expect(finished).toBe(true);
  });

  it('without a session the streams fail with NOT_CONNECTED', async () => {
    await expectStreamError(
      createSftpReadStream(undefined, '/f'),
      'NOT_CONNECTED',
      {
        path: '/f',
      },
    );
    const write = createSftpWriteStream(undefined, '/f');
    write.end(Buffer.from('x'));
    await expectStreamError(write, 'NOT_CONNECTED', { path: '/f' });
  });
});
