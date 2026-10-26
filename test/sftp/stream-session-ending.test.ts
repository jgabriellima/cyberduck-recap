/**
 * BUG-2 AC-20: the ATK-62 fix changes how a stream ends while its OPEN is pending. These tests pin
 * the endings that must not change with it: a session ending after OPEN, a status reply to OPEN,
 * and a stream created on a session that has already closed. Each one errors the stream once.
 * The waits count event-loop turns, never milliseconds, so host load cannot change the outcome.
 */
import type { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteFsError } from '../../src/index.js';
import { Session } from '../../src/sftp/session.js';
import {
  createSftpReadStream,
  createSftpWriteStream,
} from '../../src/sftp/streams.js';
import { FakeTransport, statusError } from '../support/fake-channel.js';

const HANDLE = Buffer.from([1, 2, 3, 4]);
const NO_SUCH_FILE = 2;

async function settleWithin(turns: number, done: () => boolean): Promise<void> {
  for (let i = 0; i < turns && !done(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

interface Observed {
  readonly errors: unknown[];
  closes: number;
}

function observe(stream: Readable | Writable): Observed {
  const observed: Observed = { errors: [], closes: 0 };
  stream.on('error', (error: unknown) => observed.errors.push(error));
  stream.on('close', () => {
    observed.closes += 1;
  });
  return observed;
}

/** Waits for the first error, then 10 more turns, so a second error or close would show. */
async function expectOneError(
  stream: Readable | Writable,
  observed: Observed,
  code: string,
): Promise<void> {
  await settleWithin(30, () => observed.errors.length > 0);
  await settleWithin(10, () => false);
  expect(observed.errors).toHaveLength(1);
  const error = observed.errors[0];
  expect(error).toBeInstanceOf(RemoteFsError);
  expect(Object.getPrototypeOf(error)).toBe(RemoteFsError.prototype);
  expect((error as RemoteFsError).code).toBe(code);
  expect((error as RemoteFsError).path).toBe('/f');
  expect(stream.destroyed).toBe(true);
  expect(unhandled).toEqual([]);
}

function openedSession(): { transport: FakeTransport; session: Session } {
  const transport = new FakeTransport();
  transport.sftp.responders['open'] = () => ({ value: HANDLE });
  transport.sftp.responders['close'] = () => ({});
  return { transport, session: new Session(transport) };
}

const endings: [string, string, (t: FakeTransport, s: Session) => void][] = [
  ['the transport closes', 'CONNECTION_LOST', (t) => t.emitClose()],
  ['disconnect() is called', 'NOT_CONNECTED', (_t, s) => void s.disconnect()],
];

describe('AC-20: a session ending after OPEN still errors the stream once', () => {
  it.each(endings)(
    'read stream with a READ in flight: %s',
    async (_label, code, end) => {
      const { transport, session } = openedSession();
      const stream = createSftpReadStream(session, '/f').resume();
      const observed = observe(stream);
      await settleWithin(20, () =>
        transport.sftp.pending.some((request) => request.kind === 'read'),
      );
      expect(
        transport.sftp.pending.some((request) => request.kind === 'read'),
      ).toBe(true);
      end(transport, session);
      await expectOneError(stream, observed, code);
    },
  );

  it.each(endings)(
    'write stream with a WRITE in flight: %s',
    async (_label, code, end) => {
      const { transport, session } = openedSession();
      const stream = createSftpWriteStream(session, '/f');
      const observed = observe(stream);
      stream.write(Buffer.from('payload'));
      await settleWithin(20, () =>
        transport.sftp.pending.some((request) => request.kind === 'write'),
      );
      expect(
        transport.sftp.pending.some((request) => request.kind === 'write'),
      ).toBe(true);
      end(transport, session);
      await expectOneError(stream, observed, code);
    },
  );
});

describe('AC-20: an OPEN answered with a status still errors the stream once with the mapped code', () => {
  const kinds: [string, (s: Session) => Readable | Writable][] = [
    ['read', (s) => createSftpReadStream(s, '/f').resume()],
    ['write', (s) => createSftpWriteStream(s, '/f')],
  ];

  it.each(kinds)(
    '%s stream: NO_SUCH_FILE becomes NOT_FOUND',
    async (_kind, create) => {
      const transport = new FakeTransport();
      transport.sftp.responders['open'] = () => ({
        error: statusError(NO_SUCH_FILE, 'No such file'),
      });
      const stream = create(new Session(transport));
      const observed = observe(stream);
      await expectOneError(stream, observed, 'NOT_FOUND');
    },
  );
});

describe('AC-20: a stream created on a closed session still errors once with NOT_CONNECTED', () => {
  const kinds: [string, (s: Session) => Readable | Writable][] = [
    ['read', (s) => createSftpReadStream(s, '/f').resume()],
    ['write', (s) => createSftpWriteStream(s, '/f')],
  ];

  it.each(kinds)('%s stream after disconnect()', async (_kind, create) => {
    const transport = new FakeTransport();
    const session = new Session(transport);
    await session.disconnect();
    const stream = create(session);
    const observed = observe(stream);
    await expectOneError(stream, observed, 'NOT_CONNECTED');
  });
});
