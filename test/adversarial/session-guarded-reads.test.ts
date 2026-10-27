/**
 * Adversarial, BUG-1 rework round 4: `Session.request` now reads a failed reply only through
 * `isMalformedReply` and `messageOf`. These attacks aim at what those two guards decide, and at
 * the code that trusts their decision afterwards:
 * - `messageOf` returns '' for a throwing or non-string message: the mapped error must still say
 *   which status the server sent, and no hostile value may reach the message.
 * - `isMalformedReply` returns false for a Proxy whose getPrototypeOf trap throws: the request
 *   must still settle with a typed error, and the session must not leave a request or stream
 *   pending.
 * - `isMalformedReply` returns true for anything whose prototype chain says so: the raw object
 *   then reaches `toRemoteFsError`, in operations and in stream callbacks. Its reads there must be
 *   guarded and its text sanitised, or the caller gets an untyped throw, an unhandled rejection or
 *   raw format characters.
 * The waits count event-loop turns, never milliseconds, so host load cannot change the outcome.
 * This file holds no raw character of the unsafe ranges: every one is a `\u` escape.
 */
import type { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteFsError } from '../../src/index.js';
import {
  MalformedReplyError,
  SFTP_STATUS,
  SftpStatusError,
} from '../../src/sftp/error-map.js';
import { stat } from '../../src/sftp/operations.js';
import { Session } from '../../src/sftp/session.js';
import { createSftpWriteStream } from '../../src/sftp/streams.js';
import { FakeTransport, statusError } from '../support/fake-channel.js';

/* eslint-disable no-control-regex -- the set under test is control and format characters */
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
/* eslint-enable no-control-regex */

const HOSTILE = 'a\u202eb\u2066c\u2028d\u0007e\u009bf';
const HANDLE = Buffer.from('h1');

function trap(): never {
  throw new Error('trap\u202e');
}

/** Lets `turns` macrotask turns pass, or fewer once `done` holds: a bound on work, not on time. */
async function settleWithin(turns: number, done: () => boolean): Promise<void> {
  for (let i = 0; i < turns && !done(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The outcome of `promise` after a bounded number of turns: 'pending' if it never settled. */
async function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  let outcome: unknown = 'pending';
  promise.then(
    () => {
      outcome = 'resolved';
    },
    (caught: unknown) => {
      outcome = caught;
    },
  );
  await settleWithin(20, () => outcome !== 'pending');
  return outcome;
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

/** Runs `stat('/x')` and answers its STAT with `error`; returns what the operation settled with. */
async function statRepliedWith(error: unknown): Promise<{
  outcome: unknown;
  session: Session;
  transport: FakeTransport;
}> {
  const transport = new FakeTransport();
  const session = new Session(transport);
  const result = stat(session, '/x');
  let threw: unknown;
  try {
    transport.sftp.take('stat')[0]?.reply(error as Error);
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeUndefined();
  const outcome = await outcomeOf(result);
  return { outcome, session, transport };
}

function expectTypedAndSafe(outcome: unknown): RemoteFsError {
  expect(outcome).not.toBe('pending');
  expect(outcome).toBeInstanceOf(RemoteFsError);
  const error = outcome as RemoteFsError;
  expect(error.message).not.toMatch(UNSAFE);
  return error;
}

/** A MalformedReplyError look-alike: its prototype chain passes `instanceof`, its fields do not. */
function forgedMalformed(message: unknown): MalformedReplyError {
  return Object.create(MalformedReplyError.prototype, {
    message: { value: message, enumerable: true },
  }) as MalformedReplyError;
}

describe('ATK-51: messageOf returning an empty text keeps the status and lets no hostile value through', () => {
  it('a status error whose message getter throws maps to OPERATION_FAILED naming status 4', async () => {
    const error = statusError(SFTP_STATUS.FAILURE);
    Object.defineProperty(error, 'message', { get: trap });
    const { outcome } = await statRepliedWith(error);
    const mapped = expectTypedAndSafe(outcome);
    expect(mapped.code).toBe('OPERATION_FAILED');
    expect(mapped.message).toContain('server status 4');
    expect(mapped.path).toBe('/x');
  });

  it.each([
    ['a Symbol', Symbol(HOSTILE)],
    ['an object with a hostile toString', { toString: () => HOSTILE }],
    ['a String object', Object(HOSTILE) as unknown],
    ['a number', 42],
  ])(
    'a status message that is %s maps to a safe error naming the status',
    async (_label, message) => {
      const error = statusError(SFTP_STATUS.FAILURE);
      Object.defineProperty(error, 'message', { value: message });
      const { outcome } = await statRepliedWith(error);
      const mapped = expectTypedAndSafe(outcome);
      expect(mapped.code).toBe('OPERATION_FAILED');
      expect(mapped.message).toMatch(/server status 4|server said "/u);
    },
  );

  it('a message getter that turns hostile on its second read is read once and escaped', async () => {
    let reads = 0;
    const error = statusError(SFTP_STATUS.FAILURE);
    Object.defineProperty(error, 'message', {
      get: () => {
        reads += 1;
        return reads === 1 ? 'denied' : HOSTILE;
      },
    });
    const { outcome } = await statRepliedWith(error);
    const mapped = expectTypedAndSafe(outcome);
    expect(mapped.message).toContain('server said "denied"');
    expect(reads).toBe(1);
  });

  it('a status code getter that changes type on its second read is read once', async () => {
    let reads = 0;
    const error = new Error(HOSTILE);
    Object.defineProperty(error, 'code', {
      get: () => {
        reads += 1;
        return reads === 1 ? SFTP_STATUS.PERMISSION_DENIED : 'ECONNRESET';
      },
    });
    const { outcome } = await statRepliedWith(error);
    const mapped = expectTypedAndSafe(outcome);
    expect(mapped.code).toBe('PERMISSION_DENIED');
    expect(reads).toBe(1);
  });
});

describe('ATK-52: isMalformedReply returning false on a hostile proxy settles everything with typed errors', () => {
  it('a malformed-reply proxy whose getPrototypeOf throws settles stat with a RemoteFsError', async () => {
    const error = new Proxy(new MalformedReplyError('handle'), {
      getPrototypeOf: trap,
    });
    const { outcome } = await statRepliedWith(error);
    expectTypedAndSafe(outcome);
  });

  it('the misclassified reply leaves no other request, stream or listener pending', async () => {
    const transport = new FakeTransport();
    const session = new Session(transport);
    let lost = 0;
    session.onLost(() => {
      lost += 1;
    });
    const first = stat(session, '/x');
    const second = stat(session, '/y');
    const [request] = transport.sftp.take('stat');
    request?.reply(
      new Proxy(new MalformedReplyError('attributes'), {
        getPrototypeOf: trap,
      }),
    );

    const outcomes = await Promise.all([outcomeOf(first), outcomeOf(second)]);
    for (const outcome of outcomes) expectTypedAndSafe(outcome);
    // A reply with no status is a channel failure: the session ends once, and nothing hangs.
    expect(session.isOpen).toBe(false);
    expect(lost).toBe(1);
    expect(transport.destroyed).toBeGreaterThan(0);
    expect(unhandled).toEqual([]);
  });
});

describe('ATK-53: a forged malformed reply cannot carry raw server text into the error', () => {
  it('an object whose prototype is MalformedReplyError.prototype and whose message is hostile maps to a safe error', async () => {
    const { outcome } = await statRepliedWith(forgedMalformed(HOSTILE));
    const mapped = expectTypedAndSafe(outcome);
    expect(mapped.code).toBe('OPERATION_FAILED');
  });

  it('a forged malformed reply with a non-string message maps to a RemoteFsError whose message is a string', async () => {
    const { outcome } = await statRepliedWith(
      forgedMalformed({ toString: trap }),
    );
    const mapped = expectTypedAndSafe(outcome);
    expect(typeof mapped.message).toBe('string');
  });

  it('a forged malformed reply with 4096 characters of text gives a capped message', async () => {
    const { outcome } = await statRepliedWith(
      forgedMalformed('\u202e'.repeat(4096)),
    );
    const mapped = expectTypedAndSafe(outcome);
    expect(mapped.message.length).toBeLessThanOrEqual(512);
  });
});

describe('ATK-54: a malformed-reply proxy whose get trap throws still maps to a typed error', () => {
  it('stat rejects with a RemoteFsError, never with the trap error', async () => {
    const error = new Proxy(new MalformedReplyError('attributes'), {
      get: trap,
    });
    const { outcome } = await statRepliedWith(error);
    expectTypedAndSafe(outcome);
  });
});

describe('ATK-55: a hostile WRITE reply errors the write stream, never an unhandled rejection or a hang', () => {
  async function writeRepliedWith(error: unknown): Promise<{
    streamError: unknown;
    stream: Writable;
  }> {
    const transport = new FakeTransport();
    const session = new Session(transport);
    transport.sftp.responders['open'] = () => ({ value: HANDLE });
    const stream = createSftpWriteStream(session, '/f');
    let streamError: unknown;
    stream.on('error', (e: unknown) => {
      streamError = e;
    });
    stream.write(Buffer.from('payload'));
    await settleWithin(20, () => transport.sftp.pending.length > 0);
    const [write] = transport.sftp.take('write');
    expect(write).toBeDefined();
    write?.reply(error as Error);
    await settleWithin(20, () => streamError !== undefined);
    return { streamError, stream };
  }

  it('a forged malformed reply with a hostile message errors the stream with a safe RemoteFsError', async () => {
    const { streamError, stream } = await writeRepliedWith(
      forgedMalformed(HOSTILE),
    );
    expect(unhandled).toEqual([]);
    expect(stream.destroyed).toBe(true);
    expectTypedAndSafe(streamError);
  });

  it('a malformed-reply proxy whose get trap throws errors the stream with a RemoteFsError', async () => {
    const { streamError, stream } = await writeRepliedWith(
      new Proxy(new MalformedReplyError('handle'), { get: trap }),
    );
    expect(unhandled).toEqual([]);
    expect(stream.destroyed).toBe(true);
    expectTypedAndSafe(streamError);
  });

  it('a status reply with a throwing message getter errors the stream naming the status', async () => {
    const error = statusError(SFTP_STATUS.FAILURE);
    Object.defineProperty(error, 'message', { get: trap });
    const { streamError } = await writeRepliedWith(error);
    expect(unhandled).toEqual([]);
    const mapped = expectTypedAndSafe(streamError);
    expect(mapped.message).toContain('server status 4');
    expect(streamError).not.toBeInstanceOf(SftpStatusError);
  });
});
