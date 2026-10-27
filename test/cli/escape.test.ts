import { describe, expect, it } from 'vitest';
import { RemoteFsError } from '../../src/fs/index.js';
import {
  ESCAPED_CODE_POINTS,
  cli,
  errorLine,
  escapeOf,
  hasRawEscapedCodePoint,
  testRegistry,
  type RunResult,
} from '../support/cli.js';
import { sentinel } from '../support/harness.js';
import { memBackend } from '../support/mem-backend.js';

const env = { CYBERDUCK_RECAP_PASSWORD: sentinel() };
const hex = (codePoint: number): string =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

async function lsOf(names: readonly string[]): Promise<RunResult> {
  const mem = memBackend();
  for (const name of names) mem.file(`/d/${name}`, 'x');
  return cli(['ls', 'mem://u@h/d'], {
    env,
    registry: testRegistry({ mem: mem.factory }),
  });
}

function nameField(line: string | undefined): string | undefined {
  return line?.split('\t')[3];
}

function expectNoRawCodePoint(result: RunResult): void {
  // The three TABs that separate the fields of an ls line are the format of AC-28, not text:
  // each field is checked on its own.
  const texts = [
    ...result.stdoutLines.flatMap((line) => line.split('\t')),
    ...result.stderrLines,
  ];
  for (const text of texts) {
    expect(hasRawEscapedCodePoint(text), JSON.stringify(text)).toBe(false);
  }
}

describe('escaping (FEATURE-2 AC-28, AC-29)', () => {
  const escapedCases = ESCAPED_CODE_POINTS.map((codePoint) => [
    hex(codePoint),
    String.fromCodePoint(codePoint),
    escapeOf(codePoint),
  ]);
  const unchangedCases = [0x20, 0xa0, 0x2027, 0x202f, 0x2065, 0x206a].map(
    (codePoint) => [
      hex(codePoint),
      String.fromCodePoint(codePoint),
      String.fromCodePoint(codePoint),
    ],
  );

  it('AC-28: the escaped set has the 76 code points the spec lists', () => {
    expect(escapedCases).toHaveLength(76);
  });

  it.each([...escapedCases, ...unchangedCases])(
    'AC-28: escapes entry names in ls output (%s)',
    async (_name, character, shown) => {
      const result = await lsOf([`a${character}b`]);

      expect(result.code).toBe(0);
      expect(result.stdoutLines).toHaveLength(1);
      const [line] = result.stdoutLines;
      expect(line?.split('\t')).toHaveLength(4);
      expect(nameField(line)).toBe(`a${shown}b`);
      expectNoRawCodePoint(result);
    },
  );

  it('AC-28: prints a name outside the set unchanged', async () => {
    const name = 'é文\u{1f4c1}';
    const result = await lsOf([name]);

    expect(result.code).toBe(0);
    expect(nameField(result.stdoutLines[0])).toBe(name);
  });

  it('AC-28: does not truncate a long name', async () => {
    const result = await lsOf(['\u001b'.repeat(255)]);

    expect(result.code).toBe(0);
    const shown = nameField(result.stdoutLines[0]);
    expect(shown).toBe('\\x1b'.repeat(255));
    expect(shown).toHaveLength(1020);
  });

  it('AC-29: escapes server and URL text in stderr', async () => {
    const mem = memBackend();
    mem.faults.list = new RemoteFsError(
      'OPERATION_FAILED',
      'bad\u001bmessage\u0085with every‮kind',
      { path: '/p\u0009q' },
    );

    const fromServer = await cli(['ls', 'mem://u@h/p'], {
      env,
      registry: testRegistry({ mem: mem.factory }),
    });

    expect(fromServer.code).toBe(22);
    expect(errorLine(fromServer)).toBe(
      'cyberduck-recap: OPERATION_FAILED: bad\\x1bmessage\\x85with\\u2028every\\u202ekind (/p\\x09q)',
    );
    expectNoRawCodePoint(fromServer);

    // The URL path decodes to U+001B: the back-end's error and the CLI's own lines show it escaped.
    const missing = memBackend();
    const fromUrl = await cli(['ls', 'mem://u@h/%1B'], {
      env,
      registry: testRegistry({ mem: missing.factory }),
    });
    expect(missing.calls.list).toEqual(['/\u001b']);
    expect(fromUrl.code).toBe(16);
    expect(fromUrl.stderr).toContain('/\\x1b');
    expectNoRawCodePoint(fromUrl);

    const usage = await cli(['get', 'mem://u@h/%1B/'], {
      env,
      registry: testRegistry({ mem: memBackend().factory }),
    });
    expect(usage.code).toBe(2);
    expect(errorLine(usage)).toBe(
      "cyberduck-recap: USAGE: the remote path '/\\x1b/' has no file name; give a local file path",
    );
    expectNoRawCodePoint(usage);
  });
});
