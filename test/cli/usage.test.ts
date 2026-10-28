import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT_CODES, USAGE_HINT, cli, testRegistry } from '../support/cli.js';
import { sentinel } from '../support/harness.js';
import { memBackend } from '../support/mem-backend.js';
import { REPOSITORY_ROOT } from '../support/imports.js';

const usage = (message: string): string => `cyberduck-recap: USAGE: ${message}`;
const passwordSentinel = sentinel();

// Every row of the spec's "USAGE error lines" table from "no argument" to "path that decodes to
// U+0000", with the command line that triggers it.
const rows: readonly (readonly [string, readonly string[], string])[] = [
  ['no argument', [], usage('no command given')],
  ['unknown command cp', ['cp'], usage("unknown command 'cp'")],
  ['help is an unknown command', ['help'], usage("unknown command 'help'")],
  ['ls with 0 arguments', ['ls'], usage('ls takes 1 argument, got 0')],
  [
    'ls with 2 arguments',
    ['ls', 'mem://u@h/a', 'mem://u@h/b'],
    usage('ls takes 1 argument, got 2'),
  ],
  ['get with 0 arguments', ['get'], usage('get takes 1 or 2 arguments, got 0')],
  [
    'get with 3 arguments',
    ['get', 'mem://u@h/a', 'b', 'c'],
    usage('get takes 1 or 2 arguments, got 3'),
  ],
  ['put with 1 argument', ['put', 'a'], usage('put takes 2 arguments, got 1')],
  [
    'put with 3 arguments',
    ['put', 'a', 'b', 'mem://u@h/c'],
    usage('put takes 2 arguments, got 3'),
  ],
  [
    'unknown option --force',
    ['ls', '--force', 'mem://u@h/'],
    usage("unknown option '--force'"),
  ],
  [
    'unknown option with a value',
    ['ls', `--password=${passwordSentinel}`, 'mem://u@h/'],
    usage("unknown option '--password'"),
  ],
  [
    '--overwrite with ls',
    ['ls', '--overwrite', 'mem://u@h/'],
    usage("option '--overwrite' is not allowed with ls"),
  ],
  [
    '--identity as the last argument',
    ['ls', 'mem://u@h/', '--identity'],
    usage("option '--identity' needs a value"),
  ],
  [
    'a URL that new URL() rejects (text)',
    ['ls', 'not a url'],
    usage("invalid URL 'not a url'"),
  ],
  [
    'a URL that new URL() rejects (port 65536)',
    ['ls', 'mem://u@h:65536/'],
    usage("invalid URL 'mem://u@h:65536/'"),
  ],
  [
    'scheme with no back-end',
    ['ls', 'ftp://u@h/'],
    usage("no back-end for the scheme 'ftp' (registered: mem, s3, sftp)"),
  ],
  ['port 0', ['ls', 'mem://u@h:0/'], usage('the port must be 1-65535, got 0')],
  [
    'invalid percent-encoding',
    ['ls', 'mem://u@h/%zz'],
    usage('invalid percent-encoding in the URL path'),
  ],
  [
    'path that decodes to U+0000',
    ['ls', 'mem://u@h/%00'],
    usage('the URL path must not contain U+0000'),
  ],
];

function memRun(args: readonly string[]) {
  const mem = memBackend();
  return {
    mem,
    run: cli(args, {
      env: { CYBERDUCK_RECAP_PASSWORD: sentinel() },
      registry: testRegistry({ mem: mem.factory }),
    }),
  };
}

async function packageVersion(): Promise<string> {
  const text = await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8');
  return (JSON.parse(text) as { version: string }).version;
}

describe('usage, help and version (FEATURE-2 AC-17, AC-18)', () => {
  it.each(rows)(
    'AC-17: refuses a wrong command line (%s)',
    async (_name, args, line) => {
      const { mem, run } = memRun(args);
      const result = await run;

      expect(result.code).toBe(2);
      expect(result.stderrLines).toEqual([line, USAGE_HINT]);
      expect(result.stderr).toBe(`${line}\n${USAGE_HINT}\n`);
      expect(mem.calls.connect).toBe(0);
      expect(mem.targets).toEqual([]);
      expect(result.stderr).not.toContain(passwordSentinel);
    },
  );

  it.each([['--help'], ['-h']])('AC-18: prints help (%s)', async (flag) => {
    const { mem, run } = memRun([flag]);
    const result = await run;

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const help = result.stdout;
    expect(help).toMatch(/cyberduck-recap ls\s+\[options\] <url>/);
    expect(help).toMatch(
      /cyberduck-recap get\s+\[options\] <url> \[<local-path>\]/,
    );
    expect(help).toMatch(
      /cyberduck-recap put\s+\[options\] <local-path> <url>/,
    );
    for (const option of [
      '--identity <file>',
      '--known-hosts <file>',
      '--overwrite',
    ]) {
      expect(help).toContain(option);
    }
    expect(help).toMatch(/\bmem\b/);
    expect(help).toMatch(/\bsftp\b/);
    const lines = help.split('\n');
    for (const [code, exit] of Object.entries(EXIT_CODES)) {
      const row = new RegExp(`(^|\\D)${exit}(\\D|$).*\\b${code}\\b`);
      expect(
        lines.some((line) => row.test(line)),
        `help has the exit-code row ${exit} ${code}`,
      ).toBe(true);
    }
    expect(mem.calls.connect).toBe(0);
  });

  it.each([
    [['ls', '--help']],
    [['get', '-h', 'mem://u@h/x']],
    [['--version', '--help']],
    [['cp', '--help']],
    [['ls', '--force', '--overwrite', '-h', 'not a url']],
  ])('AC-18: prints help wherever --help is (%j)', async (args) => {
    const reference = await memRun(['--help']).run;
    const { mem, run } = memRun(args);
    const result = await run;

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(reference.stdout);
    expect(result.stderr).toBe('');
    expect(mem.calls.connect).toBe(0);
  });

  it.each([
    [['--version']],
    [['ls', '--version', 'mem://u@h/']],
    [['cp', '--version']],
    [['--version', '--force']],
  ])('AC-18: prints the version (%j)', async (args) => {
    const { mem, run } = memRun(args);
    const result = await run;

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${await packageVersion()}\n`);
    expect(result.stderr).toBe('');
    expect(mem.calls.connect).toBe(0);
  });
});

// The redaction of `invalid URL '<x>'` reads the text as the URL parser does (ATK-70).
describe('the invalid URL line redacts the password as the parser reads it', () => {
  it.each([
    [
      'a CR inside :// and a leading space',
      ` mem:\r//u:${passwordSentinel}@h:65536/`,
      "invalid URL 'mem://u:***@h:65536/'",
    ],
    [
      'a TAB inside the scheme and a trailing control',
      `m\tem://u:${passwordSentinel}@h:65536/\u0001`,
      "invalid URL 'mem://u:***@h:65536/'",
    ],
    [
      'no scheme: from the first : to the last @',
      `1u:${passwordSentinel}@h`,
      "invalid URL '1u:***@h'",
    ],
  ])('%s', async (_name, url, message) => {
    const { mem, run } = memRun(['ls', url]);
    const result = await run;

    expect(result.code).toBe(2);
    expect(result.stderrLines).toEqual([usage(message), USAGE_HINT]);
    expect(mem.calls.connect).toBe(0);
    expect(result.stderr).not.toContain(passwordSentinel);
  });
});
