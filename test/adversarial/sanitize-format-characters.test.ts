/**
 * Adversarial, BUG-1: `sanitizeServerText` now escapes the bidi format characters and the line and
 * paragraph separators as well as C0, DEL and C1. A hostile server chooses the text, so it attacks
 * where the change is fragile: surrogates beside the new ranges, the 256-character cap cutting
 * through escapes and pairs, huge inputs, odd values at the call sites, double escaping, and every
 * path where server text reaches an error. This file holds no raw character of those ranges: every
 * one is written as a `\u` escape.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { RemoteFsError } from '../../src/index.js';
import { mapStatus, sanitizedCause } from '../../src/sftp/error-map.js';
import { sanitizeServerText } from '../../src/sftp/sanitize.js';
import { newFs, sentinel, tempDir } from '../support/harness.js';
import {
  STATUS,
  startHostileServer,
  type HostileSftp,
} from '../support/hostile-sftp-server.js';
import { streamOutcome } from '../support/remote-fs-assertions.js';

const CAP = 256;

/* eslint-disable no-control-regex -- the set under test is control and format characters */
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
/* eslint-enable no-control-regex */

/** The 76 code points cyberduck/standard.sanitised-server-text names. */
const UNSAFE_CODE_POINTS = [
  ...range(0x00, 0x1f),
  ...range(0x7f, 0x9f),
  0x2028,
  0x2029,
  ...range(0x202a, 0x202e),
  ...range(0x2066, 0x2069),
];

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/** What the spec says each unsafe character becomes; everything else stays as it is. */
function expectedEscape(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (!UNSAFE_CODE_POINTS.includes(code)) out += text[i];
    else if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return out;
}

const context = { operation: 'stat', path: '/p' };

describe('ATK-28: surrogates and astral characters next to the new ranges', () => {
  it.each([
    ['a lone high surrogate before U+202E', '\ud800\u202e', '\ud800\\u202e'],
    ['a lone low surrogate after U+202E', '\u202e\udc00', '\\u202e\udc00'],
    [
      'U+202E between the halves of a pair',
      '\ud83d\u202e\ude00',
      '\ud83d\\u202e\ude00',
    ],
    [
      'an emoji on each side of U+2066',
      '\u{1F600}\u2066\u{1F600}',
      '\u{1F600}\\u2066\u{1F600}',
    ],
    [
      'U+1202E, whose low half ends in 202e',
      '\u{1202E}\u2028',
      '\u{1202E}\\u2028',
    ],
    [
      'U+12066 and U+E0069, astral look-alikes of the ranges',
      '\u{12066}\u{E0069}\u2069',
      '\u{12066}\u{E0069}\\u2069',
    ],
    ['only lone surrogates', '\udfff\ud800\udbff', '\udfff\ud800\udbff'],
  ])(
    '%s: the format character is escaped, the rest unchanged',
    (_l, input, out) => {
      expect(sanitizeServerText(input)).toBe(out);
    },
  );

  it('every unsafe code point beside every surrogate kind is escaped and never throws', () => {
    for (const code of UNSAFE_CODE_POINTS) {
      const c = String.fromCharCode(code);
      for (const input of [
        `\ud800${c}`,
        `${c}\udc00`,
        `\ud83d${c}\ude00`,
        `\u{10FFFF}${c}\u{10000}`,
      ]) {
        const out = sanitizeServerText(input);
        expect(out).toBe(expectedEscape(input));
        expect(out).not.toMatch(UNSAFE);
      }
    }
  });
});

describe('ATK-29: the 256-character cap against escapes and surrogate pairs', () => {
  it('for every prefix length 0-300 before an unsafe character or an emoji, the cap never lets a raw character through or throws', () => {
    const tails = [
      '\u202e',
      '\u2028',
      '\u2069',
      '\u001b',
      '\u009b',
      '\u{1F600}',
    ];
    for (let n = 0; n <= 300; n += 1) {
      for (const tail of tails) {
        const input = `${'a'.repeat(n)}${tail}${tail}`;
        const out = sanitizeServerText(input);
        expect(out.length).toBeLessThanOrEqual(CAP);
        expect(out).not.toMatch(UNSAFE);
        // The cap applies to the escaped text: the output is its prefix, never a raw slice.
        expect(out).toBe(expectedEscape(input).slice(0, CAP));
      }
    }
  });

  it('an unsafe character placed exactly at the cut is escaped, not kept raw', () => {
    for (const code of UNSAFE_CODE_POINTS) {
      const c = String.fromCharCode(code);
      for (const n of [CAP - 1, CAP, CAP + 1]) {
        const out = sanitizeServerText(`${'a'.repeat(n)}${c}`);
        expect(out).not.toMatch(UNSAFE);
        expect(out.length).toBeLessThanOrEqual(CAP);
      }
    }
  });

  it('a cut inside an escape leaves only ASCII of that escape, never part of the raw character', () => {
    // 254 ASCII then U+202E: the cut keeps "\u" of "\u202e" (out of scope: a partial escape).
    const out = sanitizeServerText(`${'a'.repeat(254)}\u202e`);
    expect(out).toBe(`${'a'.repeat(254)}\\u`);
  });
});

describe('ATK-30: huge hostile inputs stay linear', () => {
  it('4 MiB of format characters, controls and backslashes is sanitised in under 3 s and capped', () => {
    const unit = '\u202e\u2028\\u202e\u001b\u2066x';
    const input = unit.repeat(Math.ceil((4 * 1024 * 1024) / unit.length));
    const started = performance.now();
    const out = sanitizeServerText(input);
    const elapsed = performance.now() - started;

    expect(out.length).toBe(CAP);
    expect(out).not.toMatch(UNSAFE);
    expect(elapsed).toBeLessThan(3000);
  });

  it('time grows linearly: 8x the input costs well under 64x the time (no backtracking)', () => {
    const unit = '\\\u202e\\u20\u2028';
    const time = (units: number): number => {
      const input = unit.repeat(units);
      const started = performance.now();
      sanitizeServerText(input);
      return performance.now() - started;
    };
    time(10_000); // warm-up
    const small = Math.max(time(50_000), 1);
    const large = time(400_000);

    expect(large).toBeLessThan(small * 64);
  });
});

describe('ATK-31: double escaping and look-alike escapes', () => {
  it('sanitising twice gives the same text: the output holds nothing left to escape', () => {
    const inputs = [
      'a\u202eb\u2028c\u001bd',
      UNSAFE_CODE_POINTS.map((code) => String.fromCharCode(code)).join(''),
      `${'\u2069'.repeat(40)}`,
    ];
    for (const input of inputs) {
      const once = sanitizeServerText(input);
      expect(sanitizeServerText(once)).toBe(once);
    }
  });

  it('text that already holds the ASCII escape is kept as is, and a raw U+202E beside it is escaped', () => {
    expect(sanitizeServerText('\\u202e\u202e\\x1b')).toBe(
      '\\u202e\\u202e\\x1b',
    );
  });

  it('a format character never takes the x form, so no escape reads as U+0020 and two more characters', () => {
    for (const code of [
      0x2028,
      0x2029,
      ...range(0x202a, 0x202e),
      ...range(0x2066, 0x2069),
    ]) {
      const out = sanitizeServerText(String.fromCharCode(code));
      expect(out).toMatch(/^\\u[0-9a-f]{4}$/);
      expect(out).not.toContain('\\x');
    }
  });
});

describe('ATK-32: odd values reaching the call sites in error-map.ts', () => {
  it.each([
    ['undefined', undefined],
    ['a number', 42],
    ['null', null],
    ['an object', { toString: () => 'x\u202ey' }],
  ])(
    'sanitizedCause of an Error whose message is %s returns an Error with no raw unsafe character',
    (_label, message) => {
      const error = new Error('placeholder');
      Object.defineProperty(error, 'message', { value: message });

      let cause: Error | undefined;
      expect(() => {
        cause = sanitizedCause(error);
      }).not.toThrow();
      expect(cause).toBeInstanceOf(Error);
      expect(typeof cause?.message).toBe('string');
      expect(cause?.message).not.toMatch(UNSAFE);
    },
  );

  it.each([
    ['a non-Error with a hostile message', { message: '\u202e', code: 7 }],
    ['a string', 'evil\u202e'],
    ['undefined', undefined],
    ['null', null],
  ])(
    'sanitizedCause of %s returns a cause without the raw text',
    (_l, error) => {
      const cause = sanitizedCause(error);
      expect(cause).toBeInstanceOf(Error);
      expect(cause.message).not.toMatch(UNSAFE);
    },
  );

  it('an Error subclass with a hostile message and code keeps only the escaped message and the code', () => {
    class Weird extends Error {
      code = 'E\u202e';
      secret = 'keep me out';
    }
    const cause = sanitizedCause(new Weird('a\u2029b'));
    expect(cause.message).toBe('a\\u2029b');
    expect(Object.keys(cause)).toEqual(['code']);
    expect(JSON.stringify(cause)).not.toContain('keep me out');
  });

  it.each([0, 4, 5, 8, 99, -1, 2 ** 32 - 1])(
    'mapStatus with status %i and a hostile text never holds a raw unsafe character',
    (status) => {
      const text = UNSAFE_CODE_POINTS.map((code) =>
        String.fromCharCode(code),
      ).join('');
      const error = mapStatus(status, text, context);
      expect(error).toBeInstanceOf(RemoteFsError);
      expect(error.message).not.toMatch(UNSAFE);
    },
  );
});

/** Starts a trusted hostile server scripted by `serve`, and an instance connected to it. */
async function hostilePair(serve: (sftp: HostileSftp) => void) {
  const password = sentinel();
  const server = await startHostileServer({ password, serve });
  onTestFinished(() => server.close());
  const knownHostsPath = join(await tempDir(), 'known_hosts');
  await writeFile(knownHostsPath, `${server.knownHostsLine}\n`);
  const fs = newFs(server, knownHostsPath, { password });
  await fs.connect();
  return { server, fs };
}

/** Every text an error carries, its cause chain included. */
function errorTexts(error: unknown): string[] {
  const texts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    texts.push(current.message, String(current));
    current = current.cause;
  }
  return texts;
}

const HOSTILE_TEXT = [
  'evil\u202etxt.exe',
  '\u2066host\u2069',
  '\u2028FAKE LOG LINE\u2029',
  '\ud800\u202e\udfff',
  UNSAFE_CODE_POINTS.map((code) => String.fromCharCode(code)).join(''),
  '\u202e'.repeat(5000),
].join(' ');

const REQUESTS = [
  'OPEN',
  'CLOSE',
  'READ',
  'WRITE',
  'LSTAT',
  'FSTAT',
  'SETSTAT',
  'FSETSTAT',
  'OPENDIR',
  'READDIR',
  'REMOVE',
  'MKDIR',
  'RMDIR',
  'REALPATH',
  'STAT',
  'RENAME',
] as const;

describe('ATK-33: a hostile server answers every request with format characters', () => {
  it.each([
    ['FAILURE', STATUS.FAILURE],
    ['BAD_MESSAGE', STATUS.BAD_MESSAGE],
    ['OP_UNSUPPORTED', STATUS.OP_UNSUPPORTED],
    ['an unknown status 99', 99],
    ['PERMISSION_DENIED', STATUS.PERMISSION_DENIED],
  ])(
    'status %s: every operation fails typed with no raw unsafe character in any error text',
    async (_label, status) => {
      const { fs } = await hostilePair((sftp) => {
        for (const request of REQUESTS) {
          sftp.on(request, (id: number) =>
            sftp.status(id, status, HOSTILE_TEXT),
          );
        }
      });

      const failures: unknown[] = [];
      for (const attempt of [
        () => fs.stat('/a'),
        () => fs.list('/d'),
        () => fs.mkdir('/d'),
        () => fs.remove('/a'),
        () => fs.rename('/a', '/b'),
      ]) {
        failures.push(
          await attempt().then(
            () => 'resolved',
            (e: unknown) => e,
          ),
        );
      }
      failures.push((await streamOutcome(fs.createReadStream('/a'))).error);
      const upload = fs.createWriteStream('/a');
      const uploaded = streamOutcome(upload);
      upload.end(Buffer.from('x'));
      failures.push((await uploaded).error);

      for (const failure of failures) {
        expect(failure).toBeInstanceOf(RemoteFsError);
        for (const text of errorTexts(failure)) {
          expect(text).not.toMatch(UNSAFE);
          expect(text.length).toBeLessThan(CAP + 100);
        }
      }
    },
  );

  it('a status with only format characters still names that the server spoke, escaped', async () => {
    const { fs } = await hostilePair((sftp) => {
      sftp.on('STAT', (id) =>
        sftp.status(id, STATUS.FAILURE, '\u202e\u2066\u2028'),
      );
    });

    const error = await fs.stat('/a').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RemoteFsError);
    expect((error as RemoteFsError).message).toContain('\\u202e\\u2066\\u2028');
  });
});

describe('ATK-34: server text in transport errors and entry names', () => {
  it('a session channel refused with a hostile description fails CONNECTION_FAILED with an escaped cause', async () => {
    const password = sentinel();
    const server = await startHostileServer({
      password,
      refuseSessionWith: `no\u202e\u2028FAKE LOG LINE\u2069\u001b[2K${'\u2066'.repeat(500)}`,
    });
    onTestFinished(() => server.close());
    const knownHostsPath = join(await tempDir(), 'known_hosts');
    await writeFile(knownHostsPath, `${server.knownHostsLine}\n`);
    const fs = newFs(server, knownHostsPath, { password });

    const error = await fs.connect().then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RemoteFsError);
    expect((error as RemoteFsError).code).toBe('CONNECTION_FAILED');
    const cause = (error as RemoteFsError).cause as Error;
    expect(cause).toBeInstanceOf(Error);
    expect(cause.message).toContain(
      'no\\u202e\\u2028FAKE LOG LINE\\u2069\\x1b',
    );
    for (const text of errorTexts(error)) {
      expect(text).not.toMatch(UNSAFE);
      expect(text.length).toBeLessThanOrEqual(CAP + 100);
    }
  });

  it('a listing with a hostile invalid entry name fails without echoing the name', async () => {
    const name = 'a\u202e/../\u2028FAKE';
    const { fs } = await hostilePair((sftp) => {
      let served = false;
      sftp.on('OPENDIR', (id) => sftp.handle(id, Buffer.from([0, 0, 0, 2])));
      sftp.on('READDIR', (id) => {
        if (served) {
          sftp.status(id, STATUS.EOF, 'EOF');
          return;
        }
        served = true;
        sftp.name(id, [
          {
            filename: name,
            longname: name,
            attrs: {
              mode: 0o100644,
              size: 0,
              uid: 0,
              gid: 0,
              atime: 0,
              mtime: 0,
            },
          },
        ]);
      });
      sftp.on('CLOSE', (id) => sftp.status(id, STATUS.OK, 'OK'));
    });

    const error = await fs.list('/d').then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RemoteFsError);
    for (const text of errorTexts(error)) {
      expect(text).not.toMatch(UNSAFE);
      expect(text).not.toContain('FAKE');
    }
  });
});
