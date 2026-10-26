/**
 * Adversarial, BUG-1 rework round 5: attacks the code 83fb6aa added.
 * - `MalformedReplyError.copyOf` must give our own text for any hostile `what`.
 * - The "unexpected client failure" catch-all must not hide a real failure or keep a raw cause.
 * - `Number(status)` must not let a hostile status put raw text into a message.
 * - The implementer claims no server value reaches the forged-RemoteFsError passthrough. These
 *   attacks hand a forged RemoteFsError to every request kind and check what the caller gets.
 * The waits count event-loop turns, never milliseconds, so host load cannot change the outcome.
 * This file holds no raw character of the unsafe ranges: every one is a `\u` escape.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteFsError } from '../../src/index.js';
import {
  MalformedReplyError,
  SFTP_STATUS,
  SftpStatusError,
  toRemoteFsError,
  type OperationContext,
} from '../../src/sftp/error-map.js';
import {
  list,
  mkdir,
  remove,
  rename,
  stat,
} from '../../src/sftp/operations.js';
import { Session } from '../../src/sftp/session.js';
import {
  CHUNK_SIZE,
  createSftpReadStream,
  createSftpWriteStream,
} from '../../src/sftp/streams.js';
import { FakeTransport, statusError } from '../support/fake-channel.js';

/* eslint-disable no-control-regex -- the set under test is control and format characters */
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
/* eslint-enable no-control-regex */

const HOSTILE = 'a\u202eb\u2066c\u2028d\u0007e\u009bf';
const HANDLE = Buffer.from('h1');
const CONTEXT: OperationContext = { operation: 'stat', path: '/x' };
const KNOWN_PARTS = [
  'file handle',
  'directory handle',
  'directory entries',
  'attributes',
  'data',
];

function trap(): never {
  throw new Error('trap\u202e');
}

async function settleWithin(turns: number, done: () => boolean): Promise<void> {
  for (let i = 0; i < turns && !done(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

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
  await settleWithin(30, () => outcome !== 'pending');
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

function expectTypedAndSafe(outcome: unknown): RemoteFsError {
  expect(outcome).not.toBe('pending');
  expect(outcome).toBeInstanceOf(RemoteFsError);
  const error = outcome as RemoteFsError;
  expect(Object.getPrototypeOf(error)).toBe(RemoteFsError.prototype);
  expect(typeof error.message).toBe('string');
  expect(error.message).not.toMatch(UNSAFE);
  if (error.path !== undefined) expect(error.path).not.toMatch(UNSAFE);
  if (error.cause !== undefined) {
    expect(String((error.cause as Error).message)).not.toMatch(UNSAFE);
  }
  return error;
}

function forgedMalformed(what: unknown): MalformedReplyError {
  return Object.create(MalformedReplyError.prototype, {
    what: { value: what, enumerable: true },
    message: { value: HOSTILE, enumerable: true },
  }) as MalformedReplyError;
}

function forgedStatus(status: unknown, serverText: unknown = ''): unknown {
  return Object.create(SftpStatusError.prototype, {
    status: { value: status, enumerable: true },
    serverText: { value: serverText, enumerable: true },
    message: { value: HOSTILE, enumerable: true },
  });
}

/** A RemoteFsError look-alike carrying server text in its message and path. */
function forgedRemoteFsError(): unknown {
  return Object.create(RemoteFsError.prototype, {
    code: { value: 'NOT_FOUND', enumerable: true },
    message: { value: HOSTILE, enumerable: true },
    path: { value: `/${HOSTILE}`, enumerable: true },
  });
}

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable(
    new MalformedReplyError('data'),
    {},
  );
  revoke();
  return proxy;
}

describe('ATK-56: copyOf keeps only a known part, whatever the hostile reply holds in `what`', () => {
  const hostileWhats: [string, () => unknown][] = [
    [
      'a Proxy whose get trap throws',
      () => new Proxy(forgedMalformed('data'), { get: trap }),
    ],
    [
      'a getter that throws',
      () =>
        Object.create(MalformedReplyError.prototype, {
          what: { get: trap },
        }) as unknown,
    ],
    ['a String object of a known part', () => forgedMalformed(Object('data'))],
    [
      'a near miss with a format character',
      () => forgedMalformed('data\u202e'),
    ],
    ['a near miss in case', () => forgedMalformed('Data')],
    ['a near miss with a space', () => forgedMalformed(' data')],
    ['a near miss with a NUL', () => forgedMalformed('data\u0000')],
    [
      'an object whose toString gives a known part',
      () => forgedMalformed({ toString: () => 'data' }),
    ],
    ['a Symbol', () => forgedMalformed(Symbol('data'))],
    ['the hostile text', () => forgedMalformed(HOSTILE)],
    ['a revoked Proxy', revokedProxy],
    ['null', () => null],
  ];

  it.each(hostileWhats)(
    '%s gives a fresh error with our own text',
    (_label, make) => {
      const original = make();
      let copy: MalformedReplyError | undefined;
      expect(() => {
        copy = MalformedReplyError.copyOf(original);
      }).not.toThrow();
      expect(copy === original).toBe(false);
      expect(Object.getPrototypeOf(copy)).toBe(MalformedReplyError.prototype);
      expect(KNOWN_PARTS.concat('valid payload')).toContain(copy?.what);
      expect(copy?.message).toBe(`the server's reply carried no ${copy?.what}`);
      expect(copy?.message).not.toMatch(UNSAFE);
    },
  );

  it('a known part is kept, read once, even from a getter that turns hostile afterwards', () => {
    let reads = 0;
    const original = Object.create(MalformedReplyError.prototype, {
      what: {
        get: () => {
          reads += 1;
          return reads === 1 ? 'attributes' : HOSTILE;
        },
      },
    }) as unknown;
    const copy = MalformedReplyError.copyOf(original);
    expect(copy.what).toBe('attributes');
    expect(copy.message).toBe("the server's reply carried no attributes");
    expect(reads).toBe(1);
  });

  it('through a session, a forged reply with a hostile `what` maps to a safe stat error', async () => {
    const transport = new FakeTransport();
    const session = new Session(transport);
    const result = stat(session, '/x');
    transport.sftp.take('stat')[0]?.reply(forgedMalformed(HOSTILE));
    const mapped = expectTypedAndSafe(await outcomeOf(result));
    expect(mapped.code).toBe('OPERATION_FAILED');
    expect(mapped.message).toBe(
      "stat /x: the server's reply carried no valid payload",
    );
    expect(session.isOpen).toBe(true);
  });
});

describe('ATK-57: the catch-all hides no real failure and keeps no raw cause', () => {
  it.each([
    [
      'a Proxy over a status error whose get trap throws',
      () => new Proxy(new SftpStatusError(2, HOSTILE), { get: trap }),
    ],
    [
      'a status error whose status getter throws',
      () =>
        Object.create(SftpStatusError.prototype, {
          status: { get: trap },
          serverText: { value: HOSTILE },
        }) as unknown,
    ],
    ['a revoked Proxy', revokedProxy],
    [
      'a Proxy whose getPrototypeOf trap throws',
      () =>
        new Proxy(new RemoteFsError('NOT_FOUND', HOSTILE), {
          getPrototypeOf: trap,
        }),
    ],
  ])(
    '%s gives OPERATION_FAILED with our text, our path and no cause',
    (_label, make) => {
      let mapped: RemoteFsError | undefined;
      expect(() => {
        mapped = toRemoteFsError(make(), CONTEXT);
      }).not.toThrow();
      const error = expectTypedAndSafe(mapped);
      expect(error.code).toBe('OPERATION_FAILED');
      expect(error.message).toBe('stat /x: unexpected client failure');
      expect(error.path).toBe('/x');
      expect(error.cause).toBeUndefined();
    },
  );

  it.each([
    null,
    undefined,
    0,
    '',
    HOSTILE,
    Symbol(HOSTILE),
    Object.create(null) as unknown,
  ])(
    'a non-error value %s maps without a throw and without its text',
    (value) => {
      const error = expectTypedAndSafe(toRemoteFsError(value, CONTEXT));
      expect(error.code).toBe('OPERATION_FAILED');
      expect(error.cause).toBeUndefined();
    },
  );

  it('a real session loss during stat stays CONNECTION_LOST, with the path', async () => {
    const transport = new FakeTransport();
    const session = new Session(transport);
    const result = stat(session, '/x');
    transport.emitClose();
    const error = expectTypedAndSafe(await outcomeOf(result));
    expect(error.code).toBe('CONNECTION_LOST');
    expect(error.path).toBe('/x');
  });

  it('a real disconnect during stat stays NOT_CONNECTED, with the path', async () => {
    const transport = new FakeTransport();
    const session = new Session(transport);
    const result = stat(session, '/x');
    void session.disconnect();
    const error = expectTypedAndSafe(await outcomeOf(result));
    expect(error.code).toBe('NOT_CONNECTED');
    expect(error.path).toBe('/x');
  });

  it('real replies keep their own codes: NOT_FOUND, PERMISSION_DENIED and a malformed part', async () => {
    const replies: [unknown, string, string][] = [
      [
        statusError(SFTP_STATUS.NO_SUCH_FILE, HOSTILE),
        'NOT_FOUND',
        'no such file',
      ],
      [
        statusError(SFTP_STATUS.PERMISSION_DENIED, HOSTILE),
        'PERMISSION_DENIED',
        'permission denied',
      ],
      [
        new MalformedReplyError('attributes'),
        'OPERATION_FAILED',
        'carried no attributes',
      ],
    ];
    for (const [reply, code, text] of replies) {
      const transport = new FakeTransport();
      const session = new Session(transport);
      const result = stat(session, '/x');
      transport.sftp.take('stat')[0]?.reply(reply as Error);
      const error = expectTypedAndSafe(await outcomeOf(result));
      expect(error.code).toBe(code);
      expect(error.message).toContain(text);
      expect(error.message).not.toContain('unexpected client failure');
    }
  });

  it('a real loss during a WRITE errors the stream with CONNECTION_LOST', async () => {
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
    transport.emitClose();
    await settleWithin(20, () => streamError !== undefined);
    const error = expectTypedAndSafe(streamError);
    expect(error.code).toBe('CONNECTION_LOST');
    expect(error.path).toBe('/f');
  });
});

describe('ATK-58: Number(status) lets no hostile status into the message', () => {
  it.each([
    [
      'an object whose valueOf is 4 and toString is hostile',
      { valueOf: () => 4, toString: () => HOSTILE },
      'server status 4',
    ],
    [
      'an object with only a hostile toString',
      { toString: () => HOSTILE },
      'server status NaN',
    ],
    ['a hostile string', HOSTILE, 'server status NaN'],
    ['a BigInt', 10n, 'server status 10'],
    ['a Number object of 2', Object(2) as unknown, 'server status 2'],
    ['NaN', Number.NaN, 'server status NaN'],
  ])('%s gives a safe message', (_label, status, text) => {
    const error = expectTypedAndSafe(
      toRemoteFsError(forgedStatus(status), CONTEXT),
    );
    expect(error.code).toBe('OPERATION_FAILED');
    expect(error.message).toBe(`stat /x: ${text}`);
  });

  it.each([
    ['a Symbol', Symbol(HOSTILE)],
    ['an object whose toPrimitive throws', { [Symbol.toPrimitive]: trap }],
    [
      'an object whose valueOf and toString return objects',
      { valueOf: () => ({}), toString: () => ({}) },
    ],
  ])('%s falls to the catch-all, never a throw', (_label, status) => {
    let mapped: RemoteFsError | undefined;
    expect(() => {
      mapped = toRemoteFsError(forgedStatus(status), CONTEXT);
    }).not.toThrow();
    const error = expectTypedAndSafe(mapped);
    expect(error.message).toBe('stat /x: unexpected client failure');
  });

  it('a status error whose serverText is a Symbol gives a safe message, never a throw', () => {
    const error = expectTypedAndSafe(
      toRemoteFsError(forgedStatus(4, Symbol(HOSTILE)), CONTEXT),
    );
    expect(error.code).toBe('OPERATION_FAILED');
  });

  it('a hostile status with hostile server text escapes the text', () => {
    const error = expectTypedAndSafe(
      toRemoteFsError(forgedStatus({ valueOf: () => 4 }, HOSTILE), CONTEXT),
    );
    expect(error.message).toContain('server said "');
  });
});

describe('ATK-59: no request path hands a server value to the forged-RemoteFsError passthrough', () => {
  const forgeries: [string, () => unknown][] = [
    ['a forged RemoteFsError', forgedRemoteFsError],
    [
      'a real RemoteFsError with a hostile path',
      () => new RemoteFsError('NOT_FOUND', HOSTILE, { path: `/${HOSTILE}` }),
    ],
    [
      'a real RemoteFsError with a hostile path and a numeric code',
      () =>
        Object.assign(
          new RemoteFsError('NOT_FOUND', HOSTILE, { path: `/${HOSTILE}` }),
          {
            code: SFTP_STATUS.NO_SUCH_FILE,
          },
        ),
    ],
  ];

  function expectOurs(outcome: unknown, forged: unknown, path: string): void {
    expect(outcome === forged).toBe(false);
    const error = expectTypedAndSafe(outcome);
    expect(error.path).toBe(path);
    expect(error.message).not.toContain(HOSTILE);
  }

  it.each(forgeries)('stat: %s', async (_label, make) => {
    const forged = make();
    const transport = new FakeTransport();
    const result = stat(new Session(transport), '/x');
    transport.sftp.take('stat')[0]?.reply(forged as Error);
    expectOurs(await outcomeOf(result), forged, '/x');
  });

  it.each(forgeries)('remove (LSTAT): %s', async (_label, make) => {
    const forged = make();
    const transport = new FakeTransport();
    const result = remove(new Session(transport), '/x');
    transport.sftp.take('lstat')[0]?.reply(forged as Error);
    expectOurs(await outcomeOf(result), forged, '/x');
  });

  it.each(forgeries)('remove (UNLINK): %s', async (_label, make) => {
    const forged = make();
    const transport = new FakeTransport();
    transport.sftp.responders['lstat'] = () => ({ value: { mode: 0o100644 } });
    const result = remove(new Session(transport), '/x');
    await settleWithin(20, () => transport.sftp.pending.length > 0);
    transport.sftp.take('unlink')[0]?.reply(forged as Error);
    expectOurs(await outcomeOf(result), forged, '/x');
  });

  it.each(forgeries)('rename (RENAME): %s', async (_label, make) => {
    const forged = make();
    const transport = new FakeTransport();
    transport.sftp.responders['lstat'] = () => ({
      error: statusError(SFTP_STATUS.NO_SUCH_FILE),
    });
    const result = rename(new Session(transport), '/a', '/b');
    await settleWithin(20, () => transport.sftp.pending.length > 0);
    transport.sftp.take('rename')[0]?.reply(forged as Error);
    expectOurs(await outcomeOf(result), forged, '/a');
  });

  it.each(forgeries)('mkdir: %s', async (_label, make) => {
    const forged = make();
    const transport = new FakeTransport();
    const result = mkdir(new Session(transport), '/d');
    transport.sftp.take('mkdir')[0]?.reply(forged as Error);
    expectOurs(await outcomeOf(result), forged, '/d');
  });

  it.each(forgeries)('list (OPENDIR): %s', async (_label, make) => {
    const forged = make();
    const transport = new FakeTransport();
    const result = list(new Session(transport), '/d');
    transport.sftp.take('opendir')[0]?.reply(forged as Error);
    expectOurs(await outcomeOf(result), forged, '/d');
  });

  it.each(forgeries)('list (READDIR): %s', async (_label, make) => {
    const forged = make();
    const transport = new FakeTransport();
    transport.sftp.responders['opendir'] = () => ({ value: HANDLE });
    transport.sftp.responders['close'] = () => ({});
    const result = list(new Session(transport), '/d');
    await settleWithin(20, () => transport.sftp.pending.length > 0);
    transport.sftp.take('readdir')[0]?.reply(forged as Error);
    expectOurs(await outcomeOf(result), forged, '/d');
  });

  function expectNoneIsForged(
    outcome: unknown,
    forged: unknown,
    path: string,
  ): void {
    expectOurs(outcome, forged, path);
  }

  async function streamError(
    stream: Readable | Writable,
    reply: (transport: FakeTransport) => void,
    transport: FakeTransport,
  ): Promise<unknown> {
    let caught: unknown;
    stream.on('error', (e: unknown) => {
      caught = e;
    });
    await settleWithin(20, () => transport.sftp.pending.length > 0);
    reply(transport);
    await settleWithin(30, () => caught !== undefined);
    return caught;
  }

  it.each(forgeries)('read stream (OPEN): %s', async (_label, make) => {
    const forged = make();
    const transport = new FakeTransport();
    const stream = createSftpReadStream(new Session(transport), '/f');
    stream.resume();
    const caught = await streamError(
      stream,
      (t) => t.sftp.take('open')[0]?.reply(forged as Error),
      transport,
    );
    expectNoneIsForged(caught, forged, '/f');
    expect(unhandled).toEqual([]);
  });

  it.each(forgeries)('write stream (OPEN): %s', async (_label, make) => {
    const forged = make();
    const transport = new FakeTransport();
    const stream = createSftpWriteStream(new Session(transport), '/f');
    const caught = await streamError(
      stream,
      (t) => t.sftp.take('open')[0]?.reply(forged as Error),
      transport,
    );
    expectNoneIsForged(caught, forged, '/f');
    expect(unhandled).toEqual([]);
  });

  it.each(forgeries)('read stream (READ): %s', async (_label, make) => {
    const forged = make();
    const transport = new FakeTransport();
    transport.sftp.responders['open'] = () => ({ value: HANDLE });
    const stream = createSftpReadStream(new Session(transport), '/f');
    stream.resume();
    const caught = await streamError(
      stream,
      (t) => t.sftp.takeOne('read')?.reply(forged as Error),
      transport,
    );
    expectOurs(caught, forged, '/f');
    expect(stream.destroyed).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it.each(forgeries)('write stream (WRITE): %s', async (_label, make) => {
    const forged = make();
    const transport = new FakeTransport();
    transport.sftp.responders['open'] = () => ({ value: HANDLE });
    const stream = createSftpWriteStream(new Session(transport), '/f');
    stream.write(Buffer.from('payload'));
    const caught = await streamError(
      stream,
      (t) => t.sftp.take('write')[0]?.reply(forged as Error),
      transport,
    );
    expectOurs(caught, forged, '/f');
    expect(stream.destroyed).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it.each(forgeries)('write stream (CLOSE): %s', async (_label, make) => {
    const forged = make();
    const transport = new FakeTransport();
    transport.sftp.responders['open'] = () => ({ value: HANDLE });
    transport.sftp.responders['write'] = () => ({});
    const stream = createSftpWriteStream(new Session(transport), '/f');
    stream.end(Buffer.from('payload'));
    const caught = await streamError(
      stream,
      (t) => t.sftp.take('close')[0]?.reply(forged as Error),
      transport,
    );
    expectOurs(caught, forged, '/f');
    expect(unhandled).toEqual([]);
  });
});

describe('ATK-60: the AC-14 census still holds, and no new read of a foreign message appeared', () => {
  const SRC = join(import.meta.dirname, '../../src');

  async function sourceLines(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await sourceLines(path)));
      else if (entry.name.endsWith('.ts')) {
        for (const line of (await readFile(path, 'utf8')).split('\n')) {
          out.push(`${path.slice(SRC.length)}: ${line.trim()}`);
        }
      }
    }
    return out;
  }

  it('the 5 sanitizeServerText and serverText hits are the ones the spec lists', async () => {
    const hits = (await sourceLines(SRC)).filter((line) =>
      /sanitizeServerText\(|\.serverText/.test(line),
    );
    expect(hits.map((hit) => hit.replace(/^[^:]+: /, '')).sort()).toEqual(
      [
        'export function sanitizeServerText(text: string): string {',
        'this.serverText = serverText;',
        'const text = sanitizeServerText(serverText);',
        'return mapStatus(error.status, error.serverText, context);',
        "error instanceof Error ? sanitizeServerText(error.message) : 'unknown';",
      ].sort(),
    );
  });

  it('every read of a message is one of the 4 known reads', async () => {
    const hits = (await sourceLines(SRC))
      .filter((line) => /\.message\b|'message'/.test(line))
      .filter((line) => !/^[^:]+: (\/\/|\*)/.test(line));
    expect(hits.map((hit) => hit.replace(/^[^:]+: /, '')).sort()).toEqual(
      [
        '/encrypted/i.test(withoutPassphrase.message);',
        "const message = readProperty(error, 'message');",
        'MalformedReplyError.copyOf(error).message,',
        "error instanceof Error ? sanitizeServerText(error.message) : 'unknown';",
      ].sort(),
    );
  });
});

describe('ATK-61: a burst of hostile WRITE replies errors the stream once and leaves nothing hanging', () => {
  it('16 in-flight WRITEs answered with mixed hostile errors settle with one typed error', async () => {
    const transport = new FakeTransport();
    const session = new Session(transport);
    transport.sftp.responders['open'] = () => ({ value: HANDLE });
    const stream = createSftpWriteStream(session, '/f');
    const errors: unknown[] = [];
    stream.on('error', (e: unknown) => errors.push(e));
    stream.write(Buffer.alloc(CHUNK_SIZE * 16, 1));
    await settleWithin(20, () => transport.sftp.pending.length >= 16);
    const writes = transport.sftp.take('write');
    expect(writes.length).toBeGreaterThan(1);
    const hostile: (() => unknown)[] = [
      () => new Proxy(new MalformedReplyError('data'), { get: trap }),
      revokedProxy,
      forgedRemoteFsError,
      () => forgedMalformed(HOSTILE),
      () => forgedStatus({ [Symbol.toPrimitive]: trap }),
      () => statusError(SFTP_STATUS.FAILURE, HOSTILE),
    ];
    writes.forEach((write, index) => {
      expect(() => {
        write.reply(hostile[index % hostile.length]?.() as Error);
      }).not.toThrow();
    });
    await settleWithin(30, () => errors.length > 0);
    await settleWithin(10, () => false);
    expect(errors).toHaveLength(1);
    expectTypedAndSafe(errors[0]);
    expect(stream.destroyed).toBe(true);
    expect(unhandled).toEqual([]);
    expect(transport.sftp.pending.filter((p) => p.kind === 'write')).toEqual(
      [],
    );
  });
});

describe('ATK-62: a connection that ends while a stream opens errors it with one RemoteFsError', () => {
  const endings: [string, string, (t: FakeTransport, s: Session) => void][] = [
    ['the transport closes', 'CONNECTION_LOST', (t) => t.emitClose()],
    [
      'the OPEN reply carries no status',
      'CONNECTION_LOST',
      (t) =>
        t.sftp.take('open')[0]?.reply(new Error('No response from server')),
    ],
    ['disconnect() is called', 'NOT_CONNECTED', (_t, s) => void s.disconnect()],
  ];
  const kinds: [string, (s: Session) => Readable | Writable][] = [
    ['read', (s) => createSftpReadStream(s, '/f').resume()],
    ['write', (s) => createSftpWriteStream(s, '/f')],
  ];

  const reasons: Record<string, string> = {
    CONNECTION_LOST: 'the connection was lost',
    NOT_CONNECTED: 'not connected',
  };

  for (const [kind, create] of kinds) {
    it.each(endings)(`${kind} stream: %s`, async (_label, code, end) => {
      const transport = new FakeTransport();
      const session = new Session(transport);
      const stream = create(session);
      const errors: unknown[] = [];
      let closes = 0;
      stream.on('error', (e: unknown) => errors.push(e));
      stream.on('close', () => {
        closes += 1;
      });
      await settleWithin(20, () => transport.sftp.pending.length > 0);
      end(transport, session);
      await settleWithin(30, () => errors.length > 0);
      await settleWithin(10, () => false);
      expect(errors).toHaveLength(1);
      // Callers branch on `code` (fs/errors.ts): an AggregateError has none.
      const error = expectTypedAndSafe(errors[0]);
      expect(error.code).toBe(code);
      expect(error.path).toBe('/f');
      // AC-19: the library's own text only, so no text of the ending error (a host, a port,
      // 'No response from server') reaches the caller, neither in the message nor in a cause.
      expect(error.message).toBe(`${kind} /f: ${reasons[code]}`);
      expect(error.message).not.toContain('No response from server');
      expect(error.cause).toBeUndefined();
      expect(stream.destroyed).toBe(true);
      expect(closes).toBe(1);
      expect(unhandled).toEqual([]);
    });
  }
});
