import { describe, expect, it } from 'vitest';
import { sanitizeServerText } from '../../src/sftp/sanitize.js';

// Every code point the sanitiser must never return raw (cyberduck/standard.sanitised-server-text).
/* eslint-disable no-control-regex -- the test checks for raw control characters */
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
/* eslint-enable no-control-regex */

function codePoints(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

const UNSAFE_CODE_POINTS = [
  ...codePoints(0x00, 0x1f),
  ...codePoints(0x7f, 0x9f),
  ...codePoints(0x202a, 0x202e),
  0x2028,
  0x2029,
  ...codePoints(0x2066, 0x2069),
];

describe('sanitizeServerText', () => {
  it.each([
    ['\u202a', '\\u202a'],
    ['\u202b', '\\u202b'],
    ['\u202c', '\\u202c'],
    ['\u202d', '\\u202d'],
    ['\u202e', '\\u202e'],
  ])(
    'escapes the bidi embeddings and overrides U+202A-U+202E (%#)',
    (input, expected) => {
      const output = sanitizeServerText(input);
      expect(output).toBe(expected);
      expect(output).toHaveLength(6);
    },
  );

  it.each([
    ['\u2066', '\\u2066'],
    ['\u2067', '\\u2067'],
    ['\u2068', '\\u2068'],
    ['\u2069', '\\u2069'],
  ])('escapes the bidi isolates U+2066-U+2069 (%#)', (input, expected) => {
    const output = sanitizeServerText(input);
    expect(output).toBe(expected);
    expect(output).toHaveLength(6);
  });

  it('escapes the line and paragraph separators U+2028 and U+2029', () => {
    expect(sanitizeServerText('\u2028')).toBe('\\u2028');
    expect(sanitizeServerText('\u2028')).toHaveLength(6);
    expect(sanitizeServerText('\u2029')).toBe('\\u2029');
    expect(sanitizeServerText('\u2029')).toHaveLength(6);
  });

  it.each(['\u2027', '\u202f', '\u2065', '\u206a'])(
    'leaves the code points next to each range unchanged (%#)',
    (input) => {
      const output = sanitizeServerText(input);
      expect(output).toBe(input);
      expect(output).toHaveLength(1);
    },
  );

  it('uses the x form for controls and the u form for format characters', () => {
    expect(sanitizeServerText('\u001b')).toBe('\\x1b');
    expect(sanitizeServerText('\u001b')).toHaveLength(4);
    expect(sanitizeServerText('\u0085')).toBe('\\x85');
    expect(sanitizeServerText('\u0085')).toHaveLength(4);
    expect(sanitizeServerText('\u202e')).toBe('\\u202e');
    expect(sanitizeServerText('\u202e')).toHaveLength(6);
    expect(sanitizeServerText('\u202e')).not.toContain('\\x');
  });

  it.each([
    ['\u0000', '\\x00'],
    ['\u001f', '\\x1f'],
    ['\u007f', '\\x7f'],
    ['\u0080', '\\x80'],
    ['\u009f', '\\x9f'],
    ['\u0020', '\u0020'],
    ['\u00a0', '\u00a0'],
  ])(
    'keeps the C0, DEL and C1 escapes and their boundaries (%#)',
    (input, expected) => {
      expect(sanitizeServerText(input)).toBe(expected);
    },
  );

  it.each([
    'Failure',
    'Directory not empty',
    'café naïve',
    'ファイルが見つかりません',
    '\u05e9\u05dc\u05d5\u05dd',
    '\u0645\u0631\u062d\u0628\u0627',
    '\u{1F4C1}',
    '\u{1F469}\u200d\u{1F4BB}',
  ])(
    'passes ordinary text, non-ASCII letters and emoji unchanged (%#)',
    (input) => {
      expect(sanitizeServerText(input)).toBe(input);
    },
  );

  it('escapes each character in place in mixed text', () => {
    const input = 'a\u202eb\u2028c\u001bd';
    expect(input).toHaveLength(7);

    const output = sanitizeServerText(input);

    expect(output).toBe('a\\u202eb\\u2028c\\x1bd');
    expect(output).toHaveLength(20);
  });

  it('never returns a raw control or format character', () => {
    expect(UNSAFE_CODE_POINTS).toHaveLength(76);
    for (const codePoint of UNSAFE_CODE_POINTS) {
      const character = String.fromCodePoint(codePoint);
      expect(sanitizeServerText(character)).not.toMatch(UNSAFE);
      expect(sanitizeServerText(character.repeat(300))).not.toMatch(UNSAFE);
    }
  });

  it('caps escaped format characters at 256 characters', () => {
    const output = sanitizeServerText('\u202e'.repeat(300));

    expect(output).toHaveLength(256);
    expect(output).not.toContain('\u202e');
  });

  it.each([
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
    ['a number', 42, '42'],
    ['an object', { toString: () => 'a\u202eb' }, 'a\\u202eb'],
    [
      'an object whose toString throws',
      {
        toString: () => {
          throw new Error('no');
        },
      },
      '',
    ],
  ])(
    'a non-string %s at runtime is coerced and escaped, never thrown on',
    (_label, value, expected) => {
      expect(sanitizeServerText(value as unknown as string)).toBe(expected);
    },
  );
});
