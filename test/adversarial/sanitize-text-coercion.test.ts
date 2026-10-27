/**
 * Adversarial, BUG-1 rework: `sanitizeServerText` now coerces a non-string through `textOf`, and
 * `sanitizedCause` relies on it for an Error whose message is not a string. These attacks feed the
 * coercion hostile values: objects whose conversion returns format characters, returns a
 * non-string, throws, or is huge; symbols; bigints; proxies that throw on every access; and errors
 * whose getters throw. The contract under attack: nothing throws, the result is a string, and no raw
 * unsafe character comes out. This file holds no raw character of those ranges: every one is
 * written as a `\u` escape.
 */
import { describe, expect, it } from 'vitest';
import { sanitizedCause } from '../../src/sftp/error-map.js';
import { sanitizeServerText } from '../../src/sftp/sanitize.js';

const CAP = 256;

/* eslint-disable no-control-regex -- the set under test is control and format characters */
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
/* eslint-enable no-control-regex */

const HOSTILE = 'a\u202eb\u2066c\u2028d\u0007e\u009bf';

/** The text and the outcome of `fn`, never an escaped exception. */
function safely(fn: () => string): { threw: unknown; text: unknown } {
  try {
    return { threw: undefined, text: fn() };
  } catch (error) {
    return { threw: error, text: undefined };
  }
}

function expectSafeText(fn: () => string): string {
  const outcome = safely(fn);
  expect(outcome.threw).toBeUndefined();
  expect(typeof outcome.text).toBe('string');
  const text = outcome.text as string;
  expect(text).not.toMatch(UNSAFE);
  expect(text.length).toBeLessThanOrEqual(CAP);
  return text;
}

function expectSafeCause(error: unknown): void {
  let cause: unknown;
  let threw: unknown;
  try {
    cause = sanitizedCause(error);
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeUndefined();
  expect(cause).toBeInstanceOf(Error);
  expect(typeof (cause as Error).message).toBe('string');
  expect((cause as Error).message).not.toMatch(UNSAFE);
}

/** A proxy whose every trap throws, so any access, conversion or `instanceof` on it fails. */
function hostileProxy(target: object = {}): object {
  const fail = (): never => {
    throw new Error('trap\u202e');
  };
  return new Proxy(target, {
    get: fail,
    has: fail,
    getPrototypeOf: fail,
    getOwnPropertyDescriptor: fail,
    ownKeys: fail,
    apply: fail,
  });
}

const asText = (value: unknown): string => sanitizeServerText(value as string);

describe('ATK-36: a conversion that returns format characters is still escaped', () => {
  it.each([
    ['toString', { toString: () => HOSTILE }],
    ['Symbol.toPrimitive', { [Symbol.toPrimitive]: () => HOSTILE }],
    [
      'valueOf after a toString that returns an object',
      { toString: () => ({}), valueOf: () => HOSTILE },
    ],
    ['a String wrapper', new String(HOSTILE)],
    ['an array of hostile parts', ['\u202e', '\u2029', '\u0000']],
    ['an Error', new Error(HOSTILE)],
  ])('%s yields the escaped text, never the raw characters', (_l, value) => {
    const text = expectSafeText(() => asText(value));
    expect(text).toMatch(/\\u202e|\\u2029|\\x00/u);
  });

  it('the exact escaping of a toString result matches that of the same string', () => {
    expect(asText({ toString: () => HOSTILE })).toBe(
      sanitizeServerText(HOSTILE),
    );
  });
});

describe('ATK-37: a conversion that fails or returns a non-string never throws', () => {
  it.each([
    [
      'toString returns an object',
      { toString: () => ({}), valueOf: () => ({}) },
    ],
    [
      'Symbol.toPrimitive returns an object',
      { [Symbol.toPrimitive]: () => ({}) },
    ],
    [
      'toString throws',
      {
        toString: () => {
          throw new Error('boom\u202e');
        },
      },
    ],
    [
      'Symbol.toPrimitive throws',
      {
        [Symbol.toPrimitive]: () => {
          throw new TypeError('boom');
        },
      },
    ],
    ['a null-prototype object', Object.create(null) as object],
    ['toString is not callable', { toString: 42, valueOf: 'x' }],
    [
      'toString returns a symbol',
      { [Symbol.toPrimitive]: () => Symbol('s\u202e') },
    ],
  ])('%s gives a safe string', (_l, value) => {
    expectSafeText(() => asText(value));
  });

  it('a toString that throws a non-Error value still gives a safe string', () => {
    expectSafeText(() =>
      asText({
        toString: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- the attack throws a non-Error
          throw '\u202e';
        },
      }),
    );
  });
});

describe('ATK-38: primitives that are not strings', () => {
  it.each([
    ['a Symbol with a hostile description', Symbol(HOSTILE)],
    ['a Symbol with no description', Symbol()],
    ['a registered Symbol', Symbol.for('\u2066x')],
    ['a BigInt', 10n ** 400n],
    ['a negative BigInt', -1n],
    ['NaN', Number.NaN],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['-0', -0],
    ['true', true],
    ['undefined', undefined],
    ['null', null],
    ['a function', () => 'x'],
    ['an invalid Date', new Date(Number.NaN)],
  ])('%s gives a safe string', (_l, value) => {
    expectSafeText(() => asText(value));
  });

  it('a Symbol keeps its description, escaped', () => {
    expect(asText(Symbol('x\u202ey'))).toBe('Symbol(x\\u202ey)');
  });
});

describe('ATK-39: proxies that throw on every access', () => {
  it('sanitizeServerText of a throwing proxy gives a safe string', () => {
    expectSafeText(() => asText(hostileProxy()));
  });

  it('sanitizeServerText of a throwing proxy around a function gives a safe string', () => {
    expectSafeText(() => asText(hostileProxy(() => 'x')));
  });

  it('sanitizedCause of a throwing proxy returns a safe cause', () => {
    expectSafeCause(hostileProxy());
  });

  it('sanitizedCause of a throwing proxy around a real Error returns a safe cause', () => {
    expectSafeCause(hostileProxy(new Error(HOSTILE)));
  });
});

describe('ATK-40: an Error whose getters throw inside sanitizedCause', () => {
  it('a message getter that throws gives a safe cause', () => {
    const error = new Error('placeholder');
    Object.defineProperty(error, 'message', {
      get(): never {
        throw new Error('getter\u202e');
      },
    });
    expectSafeCause(error);
  });

  it('a message getter that returns a throwing object gives a safe cause', () => {
    const error = new Error('placeholder');
    Object.defineProperty(error, 'message', {
      get: () => ({
        toString: () => {
          throw new Error('x');
        },
      }),
    });
    expectSafeCause(error);
  });

  it('a message getter that returns a hostile Symbol gives a safe cause', () => {
    const error = new Error('placeholder');
    Object.defineProperty(error, 'message', { value: Symbol(HOSTILE) });
    expectSafeCause(error);
  });

  it('a code getter that throws gives a safe cause', () => {
    const error = new Error(HOSTILE);
    Object.defineProperty(error, 'code', {
      get(): never {
        throw new Error('code\u202e');
      },
    });
    expectSafeCause(error);
  });
});

describe('ATK-41: a huge conversion result stays capped and safe', () => {
  // The size, not a clock, bounds these: 256 KiB is 1024 times the cap, so a missing cap or a
  // per-character blow-up still fails, and a loaded host cannot make the test time out.
  it('a toString returning 256 KiB of format characters gives at most 256 safe characters', () => {
    const huge = '\u202e\u2029\u0000\u009b'.repeat(1 << 16);
    const text = expectSafeText(() => asText({ toString: () => huge }));
    expect(text.length).toBe(CAP);
  });

  it('a 20001-digit BigInt gives at most 256 safe characters', () => {
    const text = expectSafeText(() => asText(10n ** 20_000n));
    expect(text.length).toBe(CAP);
  });

  it('sanitizedCause of an Error whose message is a huge hostile object stays capped', () => {
    const error = new Error('placeholder');
    Object.defineProperty(error, 'message', {
      value: { toString: () => '\u2066'.repeat(1 << 18) },
    });
    expectSafeCause(error);
    expect(sanitizedCause(error).message.length).toBeLessThanOrEqual(CAP);
  });
});
