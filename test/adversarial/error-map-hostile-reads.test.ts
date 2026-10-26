/**
 * Adversarial, BUG-1 rework round 3: `readProperty` now guards the reads in `sanitizedCause`,
 * `statusOf` and `classifyConnectError`. These attacks feed the guarded reads the values an ssh2
 * callback could hand them: revoked proxies, proxies with `has`/`ownKeys`/`getPrototypeOf` traps,
 * cross-realm errors, objects that pass `instanceof Error` through a forged prototype, and
 * getters that return a different value on each read. They also check that ordinary errors map to
 * the same typed errors as before, and that the caller of `statusOf` in `Session.request` does not
 * read the same hostile object unguarded. The contract under attack: nothing throws, no raw unsafe
 * character comes out, and every request settles. This file holds no raw character of those
 * ranges: every one is written as a `\u` escape.
 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { RemoteFsError } from '../../src/index.js';
import {
  classifyConnectError,
  MalformedReplyError,
  sanitizedCause,
  SFTP_STATUS,
  SftpStatusError,
  statusOf,
  toRemoteFsError,
} from '../../src/sftp/error-map.js';
import { Session } from '../../src/sftp/session.js';
import { FakeTransport, statusError } from '../support/fake-channel.js';

/* eslint-disable no-control-regex -- the set under test is control and format characters */
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
/* eslint-enable no-control-regex */

const HOSTILE = 'a\u202eb\u2066c\u2028d\u0007e\u009bf';

/** Runs every guarded read on `error`; none may throw, and the cause must be safe. */
function expectGuarded(error: unknown): Error {
  let threw: unknown;
  let cause: unknown;
  let status: unknown;
  let classified: unknown;
  try {
    cause = sanitizedCause(error);
    status = statusOf(error);
    classified = classifyConnectError(error as never);
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeUndefined();
  expect(cause).toBeInstanceOf(Error);
  const message = (cause as Error).message;
  expect(typeof message).toBe('string');
  expect(message).not.toMatch(UNSAFE);
  expect(message.length).toBeLessThanOrEqual(256);
  const code = (cause as { code?: unknown }).code;
  expect(
    code === undefined || typeof code === 'string' || typeof code === 'number',
  ).toBe(true);
  expect(status === undefined || typeof status === 'number').toBe(true);
  expect(['AUTH_FAILED', 'CONNECTION_FAILED']).toContain(classified);
  return cause as Error;
}

const trap = (): never => {
  throw new Error('trap\u202e');
};

describe('ATK-42: proxies with every kind of throwing trap', () => {
  it('a revoked proxy around an Error gives a safe cause, no status and a connection failure', () => {
    const { proxy, revoke } = Proxy.revocable(
      Object.assign(new Error(HOSTILE), {
        code: 2,
        level: 'client-authentication',
      }),
      {},
    );
    revoke();
    const cause = expectGuarded(proxy);
    expect(cause.message).toBe('unknown');
    expect(statusOf(proxy)).toBeUndefined();
    expect(classifyConnectError(proxy as never)).toBe('CONNECTION_FAILED');
  });

  it('a revoked proxy around a function gives a safe cause', () => {
    const { proxy, revoke } = Proxy.revocable(() => HOSTILE, {});
    revoke();
    expectGuarded(proxy);
  });

  it('has, ownKeys and getOwnPropertyDescriptor traps that throw do not escape', () => {
    const proxy = new Proxy(Object.assign(new Error(HOSTILE), { code: 4 }), {
      has: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
      defineProperty: trap,
    });
    const cause = expectGuarded(proxy);
    expect(cause.message).toBe('a\\u202eb\\u2066c\\u2028d\\x07e\\x9bf');
    expect(statusOf(proxy)).toBe(4);
  });

  it('a getPrototypeOf trap that returns Error.prototype with a throwing get does not escape', () => {
    const proxy = new Proxy(
      {},
      { getPrototypeOf: () => Error.prototype, get: trap },
    );
    const cause = expectGuarded(proxy);
    expect(cause.message).toBe('unknown');
  });

  it('a prototype chain whose second link throws does not escape', () => {
    const deep = new Proxy({}, { getPrototypeOf: trap });
    const proxy = new Proxy({}, { getPrototypeOf: () => deep });
    expectGuarded(proxy);
  });

  it('a proxy whose get trap returns another throwing proxy for every key does not escape', () => {
    const inner = new Proxy({}, { get: trap, getPrototypeOf: trap });
    const proxy = new Proxy(new Error('x'), { get: () => inner });
    const cause = expectGuarded(proxy);
    expect(cause.message).not.toMatch(UNSAFE);
    expect(statusOf(proxy)).toBeUndefined();
  });
});

describe('ATK-43: cross-realm and forged errors', () => {
  it('an Error from another realm gives a safe cause and keeps its status and level', () => {
    const foreign = runInNewContext(
      `Object.assign(new Error(${JSON.stringify(HOSTILE)}), { code: 3, level: 'client-authentication' })`,
    ) as unknown;
    expect(foreign instanceof Error).toBe(false);
    const cause = expectGuarded(foreign);
    expect(cause.message).not.toMatch(UNSAFE);
    expect((cause as { code?: unknown }).code).toBe(3);
    expect(statusOf(foreign)).toBe(3);
    expect(classifyConnectError(foreign as never)).toBe('AUTH_FAILED');
  });

  it('a cross-realm Error whose message getter throws does not escape', () => {
    const foreign = runInNewContext(
      `const e = new Error('x'); Object.defineProperty(e, 'message', { get() { throw new Error('m\\u202e'); } }); e`,
    ) as unknown;
    expectGuarded(foreign);
  });

  it('an object with Error.prototype and a hostile message passes instanceof and is escaped', () => {
    const forged = Object.create(Error.prototype, {
      message: { value: HOSTILE },
      code: { value: 'ECONNRESET' },
    }) as unknown;
    expect(forged instanceof Error).toBe(true);
    const cause = expectGuarded(forged);
    expect(cause.message).toBe('a\\u202eb\\u2066c\\u2028d\\x07e\\x9bf');
    expect((cause as { code?: unknown }).code).toBe('ECONNRESET');
  });

  it('a subclass with a hostile static Symbol.hasInstance does not change the Error check', () => {
    class Liar extends Error {
      static override [Symbol.hasInstance](): never {
        throw new Error('hasInstance\u202e');
      }
    }
    const cause = expectGuarded(new Liar(HOSTILE));
    expect(cause.message).toBe('a\\u202eb\\u2066c\\u2028d\\x07e\\x9bf');
  });

  it('a Symbol.toPrimitive message that returns format characters is escaped', () => {
    const error = new Error('placeholder');
    Object.defineProperty(error, 'message', {
      value: { [Symbol.toPrimitive]: () => HOSTILE },
    });
    const cause = expectGuarded(error);
    expect(cause.message).toBe('a\\u202eb\\u2066c\\u2028d\\x07e\\x9bf');
  });
});

describe('ATK-44: getters that return a different value on each read', () => {
  function flipping(values: readonly unknown[]): () => unknown {
    let index = 0;
    return () => values[index++ % values.length];
  }

  it('a code that flips between a number, a hostile string and an object keeps a safe type', () => {
    for (let start = 0; start < 3; start += 1) {
      const values = [2, HOSTILE, { toString: trap }];
      const rotated = [...values.slice(start), ...values.slice(0, start)];
      const error = new Error('m');
      Object.defineProperty(error, 'code', { get: flipping(rotated) });
      expectGuarded(error);
    }
  });

  it('a message that flips between safe and hostile text is escaped whichever read wins', () => {
    for (let start = 0; start < 2; start += 1) {
      const values = start === 0 ? ['safe', HOSTILE] : [HOSTILE, 'safe'];
      const error = new Error('placeholder');
      Object.defineProperty(error, 'message', { get: flipping(values) });
      expectGuarded(error);
    }
  });

  it('a level that is client-authentication on one read only gives one of the two codes', () => {
    const error = new Error('m');
    Object.defineProperty(error, 'level', {
      get: flipping(['client-authentication', 'client-socket']),
    });
    const first = classifyConnectError(error);
    const second = classifyConnectError(error);
    expect(new Set([first, second])).toEqual(
      new Set(['AUTH_FAILED', 'CONNECTION_FAILED']),
    );
  });
});

describe('ATK-45: ordinary errors keep their classification', () => {
  const context = { operation: 'remove', path: '/srv/a' };

  it('statusOf reads a numeric code and nothing else', () => {
    expect(statusOf(statusError(SFTP_STATUS.NO_SUCH_FILE))).toBe(2);
    expect(statusOf(statusError(0))).toBe(0);
    expect(
      statusOf(Object.assign(new Error('x'), { code: 'ENOENT' })),
    ).toBeUndefined();
    expect(statusOf(new Error('No response from server'))).toBeUndefined();
    for (const value of [undefined, null, 2, '2', true, Symbol('s'), 2n]) {
      expect(statusOf(value)).toBeUndefined();
    }
  });

  it('statusOf reads a code inherited from a prototype, as ssh2 subclasses may set it', () => {
    class Coded extends Error {
      get code(): number {
        return 3;
      }
    }
    expect(statusOf(new Coded('x'))).toBe(3);
  });

  it('classifyConnectError keeps AUTH_FAILED only for client-authentication', () => {
    const auth = Object.assign(
      new Error('All configured authentication methods failed'),
      {
        level: 'client-authentication',
      },
    );
    expect(classifyConnectError(auth)).toBe('AUTH_FAILED');
    for (const level of [
      'client-socket',
      'client-timeout',
      'protocol',
      undefined,
      1,
    ]) {
      expect(
        classifyConnectError(Object.assign(new Error('x'), { level })),
      ).toBe('CONNECTION_FAILED');
    }
    expect(classifyConnectError(null as never)).toBe('CONNECTION_FAILED');
  });

  it('sanitizedCause keeps a plain message and a string or numeric code, nothing else', () => {
    const cause = sanitizedCause(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:22'), {
        code: 'ECONNREFUSED',
        config: { password: 'secret' },
      }),
    );
    expect(cause.message).toBe('connect ECONNREFUSED 127.0.0.1:22');
    expect((cause as { code?: unknown }).code).toBe('ECONNREFUSED');
    expect(Object.keys(cause)).toEqual(['code']);
    expect(
      (sanitizedCause(statusError(4, 'Failure')) as { code?: unknown }).code,
    ).toBe(4);
    expect(sanitizedCause('a string').message).toBe('unknown');
    expect(
      Object.keys(sanitizedCause(Object.assign(new Error('x'), { code: {} }))),
    ).toEqual([]);
  });

  it('toRemoteFsError maps every status to the same typed code as before', () => {
    const expected: [number, string][] = [
      [SFTP_STATUS.NO_SUCH_FILE, 'NOT_FOUND'],
      [SFTP_STATUS.PERMISSION_DENIED, 'PERMISSION_DENIED'],
      [SFTP_STATUS.FILE_ALREADY_EXISTS, 'ALREADY_EXISTS'],
      [SFTP_STATUS.NO_CONNECTION, 'CONNECTION_LOST'],
      [SFTP_STATUS.CONNECTION_LOST, 'CONNECTION_LOST'],
      [SFTP_STATUS.FAILURE, 'OPERATION_FAILED'],
      [SFTP_STATUS.OP_UNSUPPORTED, 'OPERATION_FAILED'],
    ];
    for (const [status, code] of expected) {
      const error = toRemoteFsError(
        new SftpStatusError(status, HOSTILE),
        context,
      );
      expect(error).toBeInstanceOf(RemoteFsError);
      expect(error.code).toBe(code);
      expect(error.message).not.toMatch(UNSAFE);
    }
    expect(
      toRemoteFsError(new MalformedReplyError('handle'), context).code,
    ).toBe('OPERATION_FAILED');
    expect(toRemoteFsError(new Error(HOSTILE), context).message).not.toMatch(
      UNSAFE,
    );
  });
});

describe('ATK-46: Session.request reads a hostile ssh2 error only through guarded reads', () => {
  function stat(session: Session): Promise<unknown> {
    return session.request((sftp, done) => sftp.stat('/x', done));
  }

  /** Replies with `error`; the callback must not throw and the request must settle. */
  async function replyWith(error: unknown): Promise<unknown> {
    const transport = new FakeTransport();
    const session = new Session(transport);
    const result = stat(session);
    let threw: unknown;
    try {
      transport.sftp.take('stat')[0]?.reply(error as Error);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeUndefined();
    const settled = await Promise.race([
      result.then(
        () => 'resolved',
        (caught: unknown) => caught,
      ),
      new Promise((resolve) => setImmediate(() => resolve('pending'))),
    ]);
    expect(settled).not.toBe('pending');
    expect(settled).not.toBe('resolved');
    await session.disconnect?.().catch(() => undefined);
    return settled;
  }

  it('a status error whose message getter throws settles the request and does not throw', async () => {
    const error = statusError(SFTP_STATUS.FAILURE);
    Object.defineProperty(error, 'message', { get: trap });
    const settled = await replyWith(error);
    expect(
      settled instanceof SftpStatusError || settled instanceof RemoteFsError,
    ).toBe(true);
  });

  it('a proxy whose getPrototypeOf trap throws settles the request and does not throw', async () => {
    const error = new Proxy(statusError(SFTP_STATUS.FAILURE), {
      getPrototypeOf: trap,
    });
    const settled = await replyWith(error);
    expect(
      settled instanceof SftpStatusError || settled instanceof RemoteFsError,
    ).toBe(true);
  });

  it('a status error with a hostile message settles with the status and escapes it once mapped', async () => {
    const settled = await replyWith(statusError(SFTP_STATUS.FAILURE, HOSTILE));
    expect(settled).toBeInstanceOf(SftpStatusError);
    const mapped = toRemoteFsError(settled, { operation: 'stat', path: '/x' });
    expect(mapped.code).toBe('OPERATION_FAILED');
    expect(mapped.message).not.toMatch(UNSAFE);
    expect(mapped.message).toContain('a\\u202eb');
  });
});
