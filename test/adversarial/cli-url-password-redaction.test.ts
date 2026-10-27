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

describe('ATK-68: a URL password with a delimiter is not echoed by the USAGE line', () => {
  it.each([
    ['a # inside the password', (s: string) => `mem://u:a#${s}@h/`],
    ['a # after the password', (s: string) => `mem://u:${s}#x@h/`],
    ['a / inside the password', (s: string) => `mem://u:a/${s}@h:65536/`],
    ['a ? inside the password', (s: string) => `mem://u:a?${s}@h/`],
  ])('%s: exit 2, no connection, no secret', async (_label, urlOf) => {
    const cwd = await tempDir();
    const mem = memBackend({ files: {} });
    const secret = sentinel();
    const run = await cli(['ls', urlOf(secret)], {
      registry: registry({ mem: mem.factory }),
      cwd,
      home: cwd,
    });

    expect(run.code).toBe(2);
    expect(mem.spy.connects).toBe(0);
    expect(stderrLines(run.stderr)[0]).toMatch(/^cyberduck-recap: USAGE: /);
    expect(run.stdout).not.toContain(secret);
    expect(run.stderr).not.toContain(secret);
  });
});
