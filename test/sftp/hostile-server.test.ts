import { mkdir, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  isValidEntryName,
  sanitizeServerText,
} from '../../src/sftp/sanitize.js';
import { connectedPair } from '../support/harness.js';
import {
  expectRejects,
  expectStreamError,
} from '../support/remote-fs-assertions.js';

describe('entry names from a hostile server (G-3)', () => {
  it.each([
    ['a slash', ['fine', 'evil/../../etc']],
    ['a NUL', ['fine', 'a\0b']],
    ['an empty name', ['fine', '']],
  ])(
    'a name with %s fails the whole list with OPERATION_FAILED',
    async (_label, names) => {
      const { fixture, fs } = await connectedPair();
      fixture.hostileNames(names);

      const error = await expectRejects(fs.list('/'), 'OPERATION_FAILED', {
        path: '/',
      });

      expect(error.message).toContain('invalid entry name');
    },
  );

  it('names that are legal POSIX segments pass through', async () => {
    const { fixture, fs } = await connectedPair();
    fixture.hostileNames(['with space', 'tab\there', '..hidden']);

    const names = (await fs.list('/')).map((entry) => entry.name).sort();

    expect(names).toEqual(['..hidden', 'tab\there', 'with space']);
  });

  it('isValidEntryName accepts one segment only', () => {
    expect(isValidEntryName('a.txt')).toBe(true);
    expect(isValidEntryName('')).toBe(false);
    expect(isValidEntryName('a/b')).toBe(false);
    expect(isValidEntryName('a\0')).toBe(false);
  });
});

describe('server status text (G-4)', () => {
  it('escapes control characters and cuts the text before it enters a message', async () => {
    const { fixture, fs } = await connectedPair();
    await mkdir(fixture.local('/full'));
    await writeFile(fixture.local('/full/a'), 'x');
    fixture.hostileStatusText(
      `\u001b[2J\u001b[31mred\u001b[0m\nFAKE LOG LINE\r\u0085${'z'.repeat(600)}`,
    );

    const error = await expectRejects(fs.remove('/full'), 'OPERATION_FAILED');

    const controls = [...error.message].filter((c) => {
      const code = c.charCodeAt(0);
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    });
    expect(controls).toEqual([]);
    expect(error.message).toContain('\\x1b[31mred');
    expect(error.message).toContain('\\x0aFAKE LOG LINE\\x0d\\x85');
    expect(error.message.length).toBeLessThan(256 + 100);
  });

  it('escapes bidi and separator characters in a hostile status message', async () => {
    const { fixture, fs } = await connectedPair();
    await mkdir(fixture.local('/full'));
    await writeFile(fixture.local('/full/a'), 'x');
    fixture.hostileStatusText(
      'evil\u202etxt.exe \u2066host\u2069\u2028FAKE LOG LINE\u2029end',
    );

    const error = await expectRejects(fs.remove('/full'), 'OPERATION_FAILED');

    for (const escape of [
      '\\u202e',
      '\\u2066',
      '\\u2069',
      '\\u2028',
      '\\u2029',
    ]) {
      expect(error.message).toContain(escape);
    }
    expect(error.message).not.toMatch(
      /[\u2028\u2029\u202a-\u202e\u2066-\u2069]/u,
    );
  });

  it('sanitizeServerText keeps plain text and caps the length at 256', () => {
    expect(sanitizeServerText('Failure')).toBe('Failure');
    expect(sanitizeServerText('\u007f')).toBe('\\x7f');
    expect(sanitizeServerText('y'.repeat(1000))).toHaveLength(256);
  });
});

describe('zero-length reads (G-5)', () => {
  it('a read stream fails with OPERATION_FAILED instead of looping forever', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/f'), 'content');
    fixture.zeroLengthReads();

    const error = await expectStreamError(
      fs.createReadStream('/f'),
      'OPERATION_FAILED',
      { path: '/f' },
    );

    expect(error.message).toContain('empty reads');
  });
});
