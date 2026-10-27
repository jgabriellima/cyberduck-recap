/**
 * Adversarial (FEATURE-2): a hostile server's names, status text and entry attributes, end to end
 * through the real SFTP back-end and the CLI. A name may not break the one-entry-per-line,
 * three-TAB format of `ls`, forge a line, or reach the terminal as a raw control or bidi
 * character; a status text may not forge a stderr line; and an entry whose time or size is out
 * of range is a server fault, never an INTERNAL defect (exit 1).
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sentinel, tempDir, useServer } from '../support/harness.js';
import {
  RAW_ESCAPED_SET,
  cli,
  memBackend,
  namesIn,
  registry,
  stderrLines,
} from './support/cli-harness.js';

/** The spec's escape: `\xHH` up to U+00FF, `\uHHHH` above, for the set only. */
function escapeLikeSpec(text: string): string {
  let out = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (RAW_ESCAPED_SET.test(character)) {
      out +=
        codePoint <= 0xff
          ? `\\x${codePoint.toString(16).padStart(2, '0')}`
          : `\\u${codePoint.toString(16).padStart(4, '0')}`;
    } else {
      out += character;
    }
  }
  return out;
}

async function sftpSetup(): Promise<{
  fixture: Awaited<ReturnType<typeof useServer>>;
  password: string;
  cwd: string;
  knownHosts: string;
}> {
  const password = sentinel();
  const fixture = await useServer({ password });
  const cwd = await tempDir();
  const knownHosts = join(cwd, 'known_hosts');
  await writeFile(knownHosts, `${fixture.knownHostsLine}\n`);
  return { fixture, password, cwd, knownHosts };
}

const HOSTILE_NAMES = [
  'plain',
  'line\nbreak',
  'tab\there',
  'carriage\rreturn',
  '\u001b[31mred',
  '\u001b]0;title\u0007',
  'invoice\u202efdp.exe',
  'next\u0085line',
  'separator\u2028line',
  'isolate\u2066x\u2069',
  'delete\u007f',
  'cyberduck-recap: INTERNAL: forged',
  '-\t0\t1970-01-01T00:00:00.000Z\tforged-entry',
  'x'.repeat(1000),
];

describe('ATK-6: hostile entry names from a real SFTP server', () => {
  it('each name is one escaped line with exactly three TABs', async () => {
    const { fixture, password, cwd, knownHosts } = await sftpSetup();
    fixture.hostileNames(HOSTILE_NAMES);
    const run = await cli(
      [
        'ls',
        '--known-hosts',
        knownHosts,
        `sftp://tester@127.0.0.1:${fixture.port}/`,
      ],
      {
        registry: registry(),
        cwd,
        home: cwd,
        env: { CYBERDUCK_RECAP_PASSWORD: password },
      },
    );

    expect(run.code).toBe(0);
    expect(run.stdout.endsWith('\n')).toBe(true);
    const lines = run.stdout.slice(0, -1).split('\n');
    expect(lines).toHaveLength(HOSTILE_NAMES.length);
    for (const line of lines) {
      expect(line.split('\t')).toHaveLength(4);
      expect(RAW_ESCAPED_SET.test(line.replaceAll('\t', ' '))).toBe(false);
    }
    const printed = lines.map((line) => line.split('\t')[3]).sort();
    expect(printed).toEqual(HOSTILE_NAMES.map(escapeLikeSpec).sort());
  });
});

describe('ATK-6: a hostile status text cannot forge a stderr line', () => {
  const STATUS_TEXT =
    '\u001b]0;pwned\u0007 \u202egnp.exe\ncyberduck-recap: INTERNAL: forged\r\u2028\u0085done';

  it.each([
    ['ls of a missing directory', 'ls', '/missing/'],
    ['get of a missing file', 'get', '/missing.txt'],
  ])('%s', async (_label, command, path) => {
    const { fixture, password, cwd, knownHosts } = await sftpSetup();
    fixture.hostileStatusText(STATUS_TEXT);
    const before = namesIn(cwd);
    const run = await cli(
      [
        command,
        '--known-hosts',
        knownHosts,
        `sftp://tester@127.0.0.1:${fixture.port}${path}`,
      ],
      {
        registry: registry(),
        cwd,
        home: cwd,
        env: { CYBERDUCK_RECAP_PASSWORD: password },
      },
    );

    expect(run.code).toBe(16);
    const lines = stderrLines(run.stderr);
    expect(lines[0]).toMatch(/^cyberduck-recap: NOT_FOUND: /);
    for (const line of lines) {
      expect(line.startsWith('cyberduck-recap: ')).toBe(true);
      expect(RAW_ESCAPED_SET.test(line)).toBe(false);
    }
    expect(
      lines.filter((line) => line.startsWith('cyberduck-recap: INTERNAL')),
    ).toEqual([]);
    expect(namesIn(cwd)).toEqual(before);
  });
});

describe('ATK-6: entry attributes out of range are not a defect', () => {
  it.each([
    ['an invalid time', { modifiedAt: new Date(Number.NaN), size: 1 }],
    ['a negative size', { modifiedAt: new Date(0), size: -1 }],
    [
      'a size that is not a number',
      { modifiedAt: new Date(0), size: Number.NaN },
    ],
    ['a size above 2^53', { modifiedAt: new Date(0), size: 2 ** 64 }],
  ])(
    '%s: no INTERNAL error, every line keeps three TABs',
    async (_label, attrs) => {
      const cwd = await tempDir();
      const mem = memBackend({
        list: () =>
          Promise.resolve([
            {
              name: 'odd',
              path: '/odd',
              type: 'file',
              permissions: 0o644,
              ...attrs,
            },
            {
              name: 'fine',
              path: '/fine',
              type: 'file',
              size: 3,
              modifiedAt: new Date(0),
              permissions: 0o644,
            },
          ]),
      });
      const run = await cli(['ls', 'mem://u@h/'], {
        registry: registry({ mem: mem.factory }),
        cwd,
        home: cwd,
      });

      expect(run.code).not.toBe(1);
      expect(run.stderr).not.toContain('INTERNAL');
      if (run.code === 0) {
        const lines = run.stdout.split('\n').filter((line) => line !== '');
        expect(lines).toHaveLength(2);
        for (const line of lines) expect(line.split('\t')).toHaveLength(4);
      } else {
        expect(stderrLines(run.stderr)[0]).toMatch(
          /^cyberduck-recap: [A-Z_]+: /,
        );
      }
      expect(mem.spy.disconnects).toBe(1);
    },
  );
});
