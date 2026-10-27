/**
 * FEATURE-2, AC-19 ("excluded": a password in stderr or in an error line). The property under
 * test: whatever writes a line, and whichever form a typed value takes on it, a password the
 * person typed in a URL does not reach the output that `redactingOutput` wraps.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  writeError,
  writeFields,
  writeHint,
  writeLine,
  writePrompt,
  type Output,
} from '../../src/cli/output.js';
import { redactingOutput } from '../../src/cli/redact.js';

const SECRET = 'pw-7f9a9ada8b9c';
const CWD = '/work/dir';

/** Each way a URL with a password can be typed, and the argument list that carries it. */
const typed: readonly (readonly [string, readonly string[], string])[] = [
  ['an operand', ['ls', `sftp://u:${SECRET}@h/`], `sftp://u:${SECRET}@h/`],
  [
    'an option value',
    ['ls', '--known-hosts', `sftp://u:${SECRET}@h/kh`, 'sftp://h/'],
    `sftp://u:${SECRET}@h/kh`,
  ],
  [
    'an option value after =',
    ['ls', `--known-hosts=sftp://u:${SECRET}@h/kh`, 'sftp://h/'],
    `sftp://u:${SECRET}@h/kh`,
  ],
  [
    'a path that holds a URL',
    ['get', 'sftp://h/f', `x/../sftp://u:${SECRET}@h/f`],
    `x/../sftp://u:${SECRET}@h/f`,
  ],
  [
    'a password with a TAB',
    ['ls', '--identity', `sftp://u:${SECRET}\tz@h/`, 'sftp://h/'],
    `sftp://u:${SECRET}\tz@h/`,
  ],
];

/** Each form a line can show the typed value in. */
const shownForms = (value: string): string[] => [value, resolve(CWD, value)];

/** Each way the CLI writes a line. */
const writers: readonly (readonly [string, (o: Output, t: string) => void])[] =
  [
    ['an error line', (o, t) => writeError(o, 'CONNECTION_FAILED', t)],
    ['an error line with a path', (o, t) => writeError(o, 'NOT_FOUND', 'x', t)],
    ['a hint', (o, t) => writeHint(o, `the file ${t} is unknown`)],
    [
      'a prompt',
      (o, t) => writePrompt(o, ['Trust it?', `record it in ${t}: `]),
    ],
    ['a plain line', (o, t) => writeLine(o, t)],
    ['a line of fields', (o, t) => writeFields(o, ['f', t])],
  ];

function capture(): { output: Output; text: () => string } {
  const chunks: string[] = [];
  return {
    output: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
    text: () => chunks.join(''),
  };
}

describe('redactingOutput: no typed password reaches a line', () => {
  for (const [way, args, value] of typed) {
    for (const [kind, write] of writers) {
      it(`typed as ${way}, written as ${kind}`, () => {
        for (const form of shownForms(value)) {
          const sink = capture();
          write(redactingOutput(sink.output, args, CWD), form);
          expect(sink.text()).not.toContain(SECRET);
          expect(sink.text()).toContain('***@h');
        }
      });
    }
  }

  it('leaves a line alone when nothing typed holds a password', () => {
    const sink = capture();
    const line = 'the host key of h:22 is not known; user@h';
    writeLine(redactingOutput(sink.output, ['ls', 'sftp://u@h/'], CWD), line);
    expect(sink.text()).toBe(`${line}\n`);
  });

  it('replaces only the text between a colon and an at sign', () => {
    const sink = capture();
    const args = ['ls', `sftp://u:${SECRET}@h/`];
    writeLine(redactingOutput(sink.output, args, CWD), `${SECRET} is a word`);
    expect(sink.text()).toBe(`${SECRET} is a word\n`);
  });
});
