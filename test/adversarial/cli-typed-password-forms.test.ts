/**
 * Adversarial (FEATURE-2, ATK-76), topic "secrets on the command line": the one output point
 * (`redactingOutput`, wrapped in runCli) must hold for every form a typed value takes on a real
 * line, not only for the forms the unit tests compose by hand. Here the back-end itself names the
 * typed --known-hosts path in its CONNECTION_FAILED line, after the CLI resolved it against the
 * working directory and the line was escaped: the `--opt=` form, a relative path with `.` and `..`
 * segments, `//` runs, and passwords that hold a control or a bidi character, which the line shows
 * escaped. AC-19 excludes a password in stderr or in an error line, whatever form it takes.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli, FakeInput, useCliServer } from '../support/cli.js';
import { sentinel, tempDir } from '../support/harness.js';

/** Each shape of a typed known_hosts value below the regular file `plain` (so reading fails). */
const shapes: readonly (readonly [
  string,
  (secret: string) => readonly string[],
])[] = [
  [
    'the --known-hosts=<value> form',
    (s) => [`--known-hosts=plain/sftp://u:${s}@h/kh`],
  ],
  [
    'a relative path with . and .. segments',
    (s) => ['--known-hosts', `./q/../plain/./sftp://u:${s}@h/kh`],
  ],
  [
    'a password with // and /./ runs the path resolution collapses',
    (s) => ['--known-hosts', `plain/sftp://u:${s}//x/./y@h/kh`],
  ],
  [
    'a password with an ESC, shown escaped',
    (s) => ['--known-hosts', `plain/sftp://u:${s}\u001b[31m${s}@h/kh`],
  ],
  [
    'a password with a bidi override, shown escaped',
    (s) => ['--known-hosts', `plain/sftp://u:${s}‮${s}@h/kh`],
  ],
  [
    'a password with a TAB the URL parser would drop',
    (s) => ['--known-hosts', `plain/sftp://u:${s}\t${s}@h/kh`],
  ],
];

describe('ATK-76: a typed password does not reach a back-end error line in any form', () => {
  it.each(shapes)('%s', async (_label, optionsOf) => {
    const server = await useCliServer();
    const secret = sentinel();
    const cwd = await tempDir();
    await writeFile(join(cwd, 'plain'), 'x');

    const result = await cli(['ls', ...optionsOf(secret), server.url('/')], {
      env: server.env,
      cwd,
      stdin: new FakeInput(false),
    });

    expect(result.code).toBe(13);
    expect(result.stderr).toMatch(
      /^cyberduck-recap: CONNECTION_FAILED: could not read the known_hosts file /,
    );
    expect(result.stderr).toContain(':***@h/kh');
    expect(result.stderr).not.toContain(secret);
    expect(result.stdout).not.toContain(secret);
  });
});
