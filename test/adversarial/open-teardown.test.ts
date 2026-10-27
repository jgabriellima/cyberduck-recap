/**
 * Adversarial, BUG-2: attacks the ATK-62 fix from the sides the ATK-62 block does not cover.
 * - A caller that destroys a stream while its OPEN is pending, then loses the session.
 * - Two streams that open on one session when the session ends: each gets its own error.
 * - A fix that silences the session-end path before OPEN must not silence it after OPEN.
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
import { FakeTransport } from '../support/fake-channel.js';

const HANDLE = Buffer.from('h1');

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

function expectOneTyped(
  observed: Observed,
  code: string,
  path: string,
): RemoteFsError {
  expect(observed.errors).toHaveLength(1);
  const error = observed.errors[0];
  expect(error).toBeInstanceOf(RemoteFsError);
  expect(Object.getPrototypeOf(error)).toBe(RemoteFsError.prototype);
  const typed = error as RemoteFsError;
  expect(typed.code).toBe(code);
  expect(typed.path).toBe(path);
  return typed;
}

const kinds: [string, (s: Session, path: string) => Readable | Writable][] = [
  ['read', (s, path) => createSftpReadStream(s, path).resume()],
  ['write', (s, path) => createSftpWriteStream(s, path)],
];

describe('ATK-63: a caller that destroys a stream during OPEN, then loses the session', () => {
  it.each(kinds)(
    '%s stream: no AggregateError, at most one typed error, one close',
    async (_kind, create) => {
      const transport = new FakeTransport();
      const session = new Session(transport);
      const stream = create(session, '/f');
      const observed = observe(stream);
      await settleWithin(20, () => transport.sftp.pending.length > 0);
      stream.destroy();
      transport.emitClose();
      await settleWithin(30, () => observed.closes() > 0);
      await settleWithin(10, () => false);
      // The caller asked for the teardown, so silence is right; what is never right is a
      // second error or an untyped one that a code-branching caller cannot read.
      expect(observed.errors.length).toBeLessThanOrEqual(1);
      for (const error of observed.errors) {
        expect(error).not.toBeInstanceOf(AggregateError);
        expect(error).toBeInstanceOf(RemoteFsError);
        expect((error as RemoteFsError).path).toBe('/f');
      }
      expect(stream.destroyed).toBe(true);
      expect(observed.closes()).toBe(1);
      expect(unhandled).toEqual([]);
    },
  );
});

describe('ATK-64: streams that open together on one session each get their own single error', () => {
  it('a read and a write stream with OPEN pending, then the transport closes', async () => {
    const transport = new FakeTransport();
    const session = new Session(transport);
    const reader = createSftpReadStream(session, '/a').resume();
    const writer = createSftpWriteStream(session, '/b');
    const read = observe(reader);
    const write = observe(writer);
    await settleWithin(20, () => transport.sftp.pending.length >= 2);
    transport.emitClose();
    await settleWithin(
      30,
      () => read.errors.length > 0 && write.errors.length > 0,
    );
    await settleWithin(10, () => false);
    // A fix that dedupes errors per session instead of per stream would cross the two paths.
    expect(expectOneTyped(read, 'CONNECTION_LOST', '/a').message).toBe(
      'read /a: the connection was lost',
    );
    expect(expectOneTyped(write, 'CONNECTION_LOST', '/b').message).toBe(
      'write /b: the connection was lost',
    );
    expect(reader.destroyed).toBe(true);
    expect(writer.destroyed).toBe(true);
    expect(read.closes()).toBe(1);
    expect(write.closes()).toBe(1);
    expect(unhandled).toEqual([]);
  });
});

describe('ATK-65: the session-end path still errors a stream whose OPEN succeeded', () => {
  const endings: [string, string, (t: FakeTransport, s: Session) => void][] = [
    ['the transport closes', 'CONNECTION_LOST', (t) => t.emitClose()],
    ['disconnect() is called', 'NOT_CONNECTED', (_t, s) => void s.disconnect()],
  ];

  for (const [kind, create] of kinds) {
    it.each(endings)(`${kind} stream: %s`, async (_label, code, end) => {
      const transport = new FakeTransport();
      transport.sftp.responders['open'] = () => ({ value: HANDLE });
      const session = new Session(transport);
      const stream = create(session, '/f');
      const observed = observe(stream);
      // Opened means the next request (a READ, or nothing for an idle writer) is underway.
      await settleWithin(
        20,
        () =>
          kind === 'write' ||
          transport.sftp.pending.some((p) => p.kind === 'read'),
      );
      await settleWithin(5, () => false);
      end(transport, session);
      await settleWithin(30, () => observed.errors.length > 0);
      await settleWithin(10, () => false);
      expectOneTyped(observed, code, '/f');
      expect(stream.destroyed).toBe(true);
      expect(observed.closes()).toBe(1);
      expect(unhandled).toEqual([]);
    });
  }
});
