import { describe, expect, it } from 'vitest';
import { toChannel } from '../../src/sftp/connection.js';
import * as operations from '../../src/sftp/operations.js';
import { Session } from '../../src/sftp/session.js';
import {
  createSftpReadStream,
  createSftpWriteStream,
} from '../../src/sftp/streams.js';
import { FakeTransport } from '../support/fake-channel.js';
import {
  expectRejects,
  expectStreamError,
  streamOutcome,
} from '../support/remote-fs-assertions.js';

type Ssh2Sftp = Parameters<typeof toChannel>[0];
type AnyCallback = (...args: unknown[]) => void;

/**
 * ssh2's SFTP object as a server answering every request with a bare OK status: ssh2 then calls
 * back with no error and no value (ATK-11, ATK-21).
 */
function bareOkSftp(): Ssh2Sftp {
  const answerEmpty = (...args: unknown[]): void => {
    const callback = args.at(-1) as AnyCallback;
    queueMicrotask(() => callback(undefined));
  };
  return new Proxy({}, { get: () => answerEmpty }) as unknown as Ssh2Sftp;
}

function sessionOver(sftp: Ssh2Sftp): Session {
  const transport = new FakeTransport();
  return new Session({
    sftp: toChannel(sftp),
    end: () => transport.end(),
    destroy: () => transport.destroy(),
    onClose: (listener) => transport.onClose(listener),
  });
}

describe('replies that lack what the request needs', () => {
  it.each([
    ['stat (no attributes)', (s: Session) => operations.stat(s, '/f')],
    [
      'remove (lstat without attributes)',
      (s: Session) => operations.remove(s, '/f'),
    ],
    [
      'recursive mkdir (stat without attributes)',
      (s: Session) => operations.mkdir(s, '/a/b', { recursive: true }),
    ],
    [
      'list (opendir without a handle)',
      (s: Session) => operations.list(s, '/'),
    ],
    [
      'rename (lstat of the target without attributes)',
      (s: Session) => operations.rename(s, '/a', '/b'),
    ],
  ])(
    '%s rejects with OPERATION_FAILED and keeps the session',
    async (_label, run) => {
      const session = sessionOver(bareOkSftp());

      const error = await expectRejects(run(session), 'OPERATION_FAILED');

      expect(error.message).toContain('reply carried no');
      expect(session.isOpen).toBe(true);
    },
  );

  it('list whose readdir reply carries no names rejects with OPERATION_FAILED', async () => {
    const handle = Buffer.from([1]);
    const sftp = new Proxy(
      {},
      {
        get:
          (_target, method) =>
          (...args: unknown[]) => {
            const callback = args.at(-1) as AnyCallback;
            queueMicrotask(() =>
              method === 'opendir'
                ? callback(undefined, handle)
                : callback(undefined),
            );
          },
      },
    ) as unknown as Ssh2Sftp;

    await expectRejects(
      operations.list(sessionOver(sftp), '/'),
      'OPERATION_FAILED',
      {
        path: '/',
      },
    );
  });

  it('a read stream whose OPEN reply has no handle errors at once instead of hanging', async () => {
    const session = sessionOver(bareOkSftp());

    await expectStreamError(
      createSftpReadStream(session, '/f'),
      'OPERATION_FAILED',
      {
        path: '/f',
      },
    );
  });

  it('a write stream whose OPEN reply has no handle errors and never finishes', async () => {
    const session = sessionOver(bareOkSftp());
    const stream = createSftpWriteStream(session, '/f');
    stream.end(Buffer.alloc(100_000));

    await expectStreamError(stream, 'OPERATION_FAILED', { path: '/f' });
  });

  it('streams refuse a handle that is not a Buffer even from another channel', async () => {
    const transport = new FakeTransport();
    transport.sftp.responders['open'] = () => ({ value: undefined });
    const session = new Session(transport);

    await expectStreamError(
      createSftpReadStream(session, '/f'),
      'OPERATION_FAILED',
    );
  });
});

describe('teardown of abandoned streams', () => {
  it('disconnect() closes a stream nobody listens to without an unhandled error', async () => {
    const transport = new FakeTransport();
    transport.sftp.responders['open'] = () => ({ value: Buffer.from([1]) });
    transport.sftp.responders['close'] = () => ({});
    const session = new Session(transport);
    const stream = createSftpReadStream(session, '/f');
    // Wait for the open, then drop every listener: the caller abandoned the stream.
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (transport.sftp.pending.some((r) => r.kind === 'read')) resolve();
        else setImmediate(check);
      };
      stream.on('readable', () => undefined);
      check();
    });
    stream.removeAllListeners();

    await session.disconnect();

    expect(stream.destroyed).toBe(true);
  });

  it('a listened-to stream still receives NOT_CONNECTED on disconnect()', async () => {
    const transport = new FakeTransport();
    transport.sftp.responders['open'] = () => ({ value: Buffer.from([1]) });
    const session = new Session(transport);
    const stream = createSftpWriteStream(session, '/f');
    const outcome = streamOutcome(stream);
    stream.write(Buffer.from('x'));
    await new Promise((resolve) => setImmediate(resolve));

    await session.disconnect();

    const { error, finished } = await outcome;
    expect(finished).toBe(false);
    expect(error).toMatchObject({ code: 'NOT_CONNECTED', path: '/f' });
  });
});
