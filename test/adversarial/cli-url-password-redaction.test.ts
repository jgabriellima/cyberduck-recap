/**
 * Adversarial (FEATURE-2), topic "secrets on the command line": the `***` redaction of the USAGE
 * line `invalid URL '<x>'` finds the user information by the URL's authority, which ends at the
 * first `/`, `?` or `#`. A person whose password holds one of these characters types it unencoded;
 * the URL then fails to parse, the redaction finds no `@` in the cut authority, and the whole text
 * would be echoed with the password in it. The spec forbids a password in stderr in any case.
 */
import { describe, expect, it } from 'vitest';
import { sentinel, tempDir } from '../support/harness.js';
import {
  cli,
  memBackend,
  registry,
  stderrLines,
} from './support/cli-harness.js';

async function lsOf(url: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  connects: number;
}> {
  const cwd = await tempDir();
  const mem = memBackend({ files: {} });
  const run = await cli(['ls', url], {
    registry: registry({ mem: mem.factory }),
    cwd,
    home: cwd,
  });
  return { ...run, connects: mem.spy.connects };
}

describe('ATK-68: a URL password with a delimiter is not echoed by the USAGE line', () => {
  it.each([
    ['a # inside the password', (s: string) => `mem://u:a#${s}@h/`],
    ['a # after the password', (s: string) => `mem://u:${s}#x@h/`],
    ['a / inside the password', (s: string) => `mem://u:a/${s}@h:65536/`],
    ['a ? inside the password', (s: string) => `mem://u:a?${s}@h/`],
    // The rework round: the fix itself (redaction from the first ':' to the last '@').
    [
      'a percent-encoded password, port 65536',
      (s: string) => `mem://u:%41${s}@h:65536/`,
    ],
    ['an @ and a # inside the password', (s: string) => `mem://u:a@${s}#@h/`],
    ['a :// inside the password', (s: string) => `mem://u:a://${s}#@h/`],
    [
      'an @ in the path after the password',
      (s: string) => `mem://u:a#${s}@h/x@y`,
    ],
  ])('%s: exit 2, no connection, no secret', async (_label, urlOf) => {
    const secret = sentinel();
    const run = await lsOf(urlOf(secret));

    expect(run.code).toBe(2);
    expect(run.connects).toBe(0);
    expect(stderrLines(run.stderr)[0]).toMatch(/^cyberduck-recap: USAGE: /);
    expect(run.stdout).not.toContain(secret);
    expect(run.stderr).not.toContain(secret);
  });

  it('a URL with no @ but a : after :// is shown as typed, port error intact', async () => {
    const run = await lsOf('mem://h:65536/');

    expect(run.code).toBe(2);
    expect(run.connects).toBe(0);
    expect(stderrLines(run.stderr)[0]).toBe(
      "cyberduck-recap: USAGE: invalid URL 'mem://h:65536/'",
    );
  });
});

/**
 * The URL parser removes every ASCII TAB and newline from its input before it parses (WHATWG URL),
 * so a TAB or a newline inside `://` still gives a URL with user information. The redaction looks
 * for `://` in the raw text, finds none, and echoes the whole text, password included.
 */
describe('ATK-70: a TAB or newline the parser removes does not hide the user information', () => {
  it.each([
    ['a TAB inside ://', (s: string) => `mem:/\t/u:a#${s}@h/`],
    ['a newline inside ://', (s: string) => `mem:\n//u:a?${s}@h/`],
  ])('%s: exit 2, no connection, no secret', async (_label, urlOf) => {
    const secret = sentinel();
    const run = await lsOf(urlOf(secret));

    expect(run.code).toBe(2);
    expect(run.connects).toBe(0);
    expect(stderrLines(run.stderr)[0]).toMatch(/^cyberduck-recap: USAGE: /);
    expect(run.stdout).not.toContain(secret);
    expect(run.stderr).not.toContain(secret);
  });
});

/**
 * Deferred (ATK-71): an unencoded password whose text before its first `/`, `?` or `#` is all
 * digits makes a valid URL with another meaning: `mem://u:1/<s>@h/` is the host `u`, the port 1 and
 * the path `/<s>@h/`. The URL holds no password, so no rule of the spec applies; the CLI connects
 * and its error line names the path. Kept skipped: it records the finding and later runs replay it.
 */
describe('ATK-71: a digits-first password with a / is read as a port and a path', () => {
  it.skip('deferred ATK-71: exit 2, no connection, no secret', async () => {
    const secret = sentinel();
    const run = await lsOf(`mem://u:1/${secret}@h/`);

    expect(run.code).toBe(2);
    expect(run.connects).toBe(0);
    expect(run.stderr).not.toContain(secret);
  });
});
