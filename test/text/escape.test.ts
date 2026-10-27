import { describe, expect, it } from 'vitest';
import { escapeUnsafeText } from '../../src/text/escape.js';
import { sanitizeServerText } from '../../src/sftp/sanitize.js';

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

// cyberduck/standard.sanitised-server-text, written out from the standard.
const ESCAPED = [
  ...range(0x00, 0x1f),
  ...range(0x7f, 0x9f),
  0x2028,
  0x2029,
  ...range(0x202a, 0x202e),
  ...range(0x2066, 0x2069),
];
const NEIGHBOURS = [0x20, 0x7e, 0xa0, 0x2027, 0x202f, 0x2065, 0x206a];

const hex = (codePoint: number, width: number): string =>
  codePoint.toString(16).padStart(width, '0');

describe('escapeUnsafeText (src/text/escape.ts)', () => {
  it.each(ESCAPED)('escapes code point %i of the set', (codePoint) => {
    const expected =
      codePoint <= 0xff ? `\\x${hex(codePoint, 2)}` : `\\u${hex(codePoint, 4)}`;

    expect(escapeUnsafeText(`a${String.fromCodePoint(codePoint)}b`)).toBe(
      `a${expected}b`,
    );
  });

  it.each(NEIGHBOURS)('leaves the neighbour %i unchanged', (codePoint) => {
    const text = `a${String.fromCodePoint(codePoint)}b`;

    expect(escapeUnsafeText(text)).toBe(text);
  });

  it('has no length cap, unlike sanitizeServerText', () => {
    const text = String.fromCodePoint(0x1b).repeat(300);

    expect(escapeUnsafeText(text)).toHaveLength(1200);
    expect(sanitizeServerText(text)).toHaveLength(256);
    expect(sanitizeServerText(text)).toBe(escapeUnsafeText(text).slice(0, 256));
  });
});
