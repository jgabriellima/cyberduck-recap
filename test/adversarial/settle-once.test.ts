/**
 * Adversarial, BUG-2: attacks the settle-once construct callback that the ATK-62 fix added.
 * - ATK-66: a handle the server grants after the stream stopped wanting it is closed, once, and
 *   the quiet close never throws or rejects unhandled, even when the CLOSE itself fails.
 * - ATK-67: a session that ends while a failed OPEN is being explained (the follow-up stat) gives
 *   one typed error, and the explanation still gives NOT_FOUND and IS_A_DIRECTORY otherwise.
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

const HANDLE = Buffer.from('late-handle');
const DIRECTORY_MODE = 0o040755;

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
  errors: unknown[];
  closes: () => number;
}

function observe(stream: Readable | Writable): Observed {
  const errors: unknown[] = [];
  let closes = 0;
  stream.on('error', (e: unknown) => errors.push(e));
  stream.on('close', () => {
    closes += 1;
  });
  return { errors, closes: () => closes };
}

function expectOneTyped(observed: Observed, code: string, path: string): void {
  expect(observed.errors).toHaveLength(1);
  const error = observed.errors[0];
  expect(error).not.toBeInstanceOf(AggregateError);
  expect(error).toBeInstanceOf(RemoteFsError);
  expect((error as RemoteFsError).code).toBe(code);
  expect((error as RemoteFsError).path).toBe(path);
}

const kinds: [string, (s: Session, path: string) => Readable | Writable][] = [
  ['read', (s, path) => createSftpReadStream(s, path).resume()],
  ['write', (s, path) => createSftpWriteStream(s, path)],
];

function closesOf(transport: FakeTransport, handle: Buffer): number {
  return transport.sftp.pending.filter(
    (p) =>
      p.kind === 'close' && Buffer.compare(p.args[0] as Buffer, handle) === 0,
  ).length;
}

describe('ATK-66: a handle granted after the stream stopped wanting it is closed and never leaks', () => {
  it.each(kinds)(
    '%s stream: caller destroy() during OPEN, then the server grants a handle',
    async (_kind, create) => {
      const transport = new FakeTransport();
      const session = new Session(transport);
      const stream = create(session, '/f');
      const observed = observe(stream);
      await settleWithin(20, () => transport.sftp.pending.length > 0);
      stream.destroy();
      transport.sftp.takeOne('open')?.reply(undefined, HANDLE);
      await settleWithin(30, () => closesOf(transport, HANDLE) > 0);
      await settleWithin(10, () => false);
      // A handle left open is a server-side leak for the session's lifetime: exactly one CLOSE.
      expect(closesOf(transport, HANDLE)).toBe(1);
      expect(observed.errors).toEqual([]);
      expect(observed.closes()).toBe(1);
      // The quiet close must swallow its own failure: no error event, no unhandled rejection.
      transport.sftp
        .takeOne('close')
        ?.reply(statusError(4, 'close failed\u001b[2J'));
      await settleWithin(10, () => false);
      expect(observed.errors).toEqual([]);
      expect(unhandled).toEqual([]);
      expect(session.isOpen).toBe(true);
    },
  );

  it.each(kinds)(
    '%s stream: the OPEN reply and the transport close land in the same tick',
    async (_kind, create) => {
      const transport = new FakeTransport();
      const session = new Session(transport);
      const stream = create(session, '/f');
      const observed = observe(stream);
      await settleWithin(20, () => transport.sftp.pending.length > 0);
      transport.sftp.takeOne('open')?.reply(undefined, HANDLE);
      transport.emitClose();
      await settleWithin(30, () => observed.closes() > 0);
      await settleWithin(10, () => false);
      // The handle resolved first but the ending reached the stream first: one typed loss, and no
      // CLOSE sent on a session that is gone (it would only reject with NOT_CONNECTED).
      expectOneTyped(observed, 'CONNECTION_LOST', '/f');
      expect(stream.destroyed).toBe(true);
      expect(observed.closes()).toBe(1);
      expect(closesOf(transport, HANDLE)).toBe(0);
      expect(unhandled).toEqual([]);
    },
  );
});

describe('ATK-67: a session ending while a failed OPEN is explained gives one typed error', () => {
  it.each(kinds)(
    '%s stream: OPEN fails with FAILURE, the transport closes during the stat',
    async (_kind, create) => {
      const transport = new FakeTransport();
      transport.sftp.responders['open'] = () => ({
        error: statusError(4, 'failure'),
      });
      const session = new Session(transport);
      const stream = create(session, '/d');
      const observed = observe(stream);
      await settleWithin(20, () =>
        transport.sftp.pending.some((p) => p.kind === 'stat'),
      );
      expect(transport.sftp.pending.map((p) => p.kind)).toEqual(['stat']);
      transport.emitClose();
      await settleWithin(30, () => observed.closes() > 0);
      await settleWithin(10, () => false);
      expectOneTyped(observed, 'CONNECTION_LOST', '/d');
      expect(observed.closes()).toBe(1);
      expect(unhandled).toEqual([]);
    },
  );

  it.each(kinds)(
    '%s stream: without an ending, the stat still diagnoses a directory',
    async (_kind, create) => {
      const transport = new FakeTransport();
      transport.sftp.responders['open'] = () => ({
        error: statusError(4, 'failure'),
      });
      transport.sftp.responders['stat'] = () => ({
        value: { mode: DIRECTORY_MODE },
      });
      const session = new Session(transport);
      const stream = create(session, '/d');
      const observed = observe(stream);
      await settleWithin(30, () => observed.closes() > 0);
      await settleWithin(10, () => false);
      expectOneTyped(observed, 'IS_A_DIRECTORY', '/d');
      expect(unhandled).toEqual([]);
    },
  );

  it.each(kinds)(
    '%s stream: NO_SUCH_FILE stays NOT_FOUND with no follow-up stat',
    async (_kind, create) => {
      const transport = new FakeTransport();
      transport.sftp.responders['open'] = () => ({
        error: statusError(2, 'no such file‮'),
      });
      const session = new Session(transport);
      const stream = create(session, '/missing');
      const observed = observe(stream);
      await settleWithin(30, () => observed.closes() > 0);
      await settleWithin(10, () => false);
      expectOneTyped(observed, 'NOT_FOUND', '/missing');
      expect((observed.errors[0] as RemoteFsError).message).not.toMatch(/‮/u);
      expect(transport.sftp.pending).toEqual([]);
      expect(unhandled).toEqual([]);
    },
  );
});
