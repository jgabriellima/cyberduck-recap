import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeInput, cli, errorLine, startCli } from '../support/cli.js';
import {
  sentinel,
  tempDir,
  trustingKnownHosts,
  useServer,
} from '../support/harness.js';

const PROMPT = 'Password for tester@127.0.0.1: ';
const DEL = '\x7f';
const BS = '\x08';
const CTRL_C = '\x03';
const CTRL_D = '\x04';
const CTRL_U = '\x15';
const ESC = '\x1b';
const CANCELLED =
  'cyberduck-recap: CANCELLED: the password prompt was cancelled';
const EMPTY = 'cyberduck-recap: USAGE: the password is empty';

type Ending =
  'line end' | 'Ctrl-C' | 'Ctrl-D' | 'end of input' | 'empty answer';

async function promptServer(password: string) {
  const fixture = await useServer({ password });
  const knownHosts = await trustingKnownHosts(fixture);
  return {
    fixture,
    args: [
      'ls',
      '--known-hosts',
      knownHosts,
      `sftp://tester@127.0.0.1:${fixture.port}/`,
    ],
  };
}

describe('the password prompt (FEATURE-2 AC-22, AC-36, AC-37)', () => {
  it.each<Ending>([
    'line end',
    'Ctrl-C',
    'Ctrl-D',
    'end of input',
    'empty answer',
  ])('AC-22: prompts for the password without echo (%s)', async (ending) => {
    const typed = sentinel();
    const { args } = await promptServer(typed);
    const stdin = new FakeInput(true);
    const input = {
      'line end': `${typed}\r`,
      'Ctrl-C': `${typed}${CTRL_C}`,
      'Ctrl-D': `${typed}${CTRL_D}`,
      'end of input': typed,
      'empty answer': '\r',
    }[ending];
    stdin.type(input);
    if (ending === 'end of input') stdin.end();

    const result = await cli(args, { env: {}, stdin });

    expect(result.stdin.rawModeCalls).toEqual([true, false]);
    expect(result.stderr).toContain(`${PROMPT}\n`);
    expect(result.stderr).not.toContain(`${PROMPT}\n\n`);
    expect(result.stdout).not.toContain(typed);
    expect(result.stderr).not.toContain(typed);
    expect(result.code).toBe(
      {
        'line end': 0,
        'Ctrl-C': 130,
        'Ctrl-D': 130,
        'end of input': 130,
        'empty answer': 2,
      }[ending],
    );
  });

  // Each case: what the person types, the password the server accepts, and the outcome.
  const cases: readonly {
    readonly name: string;
    readonly input: Buffer;
    readonly end?: boolean;
    readonly accepts: string;
    readonly exit: number;
    readonly line?: string;
  }[] = [
    {
      name: '(a) secret CR',
      input: Buffer.from('secret\r'),
      accepts: 'secret',
      exit: 0,
    },
    {
      name: '(a) secret LF',
      input: Buffer.from('secret\n'),
      accepts: 'secret',
      exit: 0,
    },
    {
      name: '(b) secrex DEL t',
      input: Buffer.from(`secrex${DEL}t\r`),
      accepts: 'secret',
      exit: 0,
    },
    {
      name: '(b) secrex BS t',
      input: Buffer.from(`secrex${BS}t\r`),
      accepts: 'secret',
      exit: 0,
    },
    {
      name: '(b) e-acute DEL ok: DEL removes a whole code point',
      input: Buffer.concat([
        Buffer.from('é', 'utf8'),
        Buffer.from(`${DEL}ok\r`),
      ]),
      accepts: 'ok',
      exit: 0,
    },
    {
      name: '(b) DEL on an empty answer does nothing',
      input: Buffer.from(`${DEL}${BS}secret\r`),
      accepts: 'secret',
      exit: 0,
    },
    {
      name: '(c) bad Ctrl-U secret',
      input: Buffer.from(`bad${CTRL_U}secret\r`),
      accepts: 'secret',
      exit: 0,
    },
    {
      name: '(d) Ctrl-C',
      input: Buffer.from(`sec${CTRL_C}`),
      accepts: 'secret',
      exit: 130,
      line: CANCELLED,
    },
    {
      name: '(e) Ctrl-D',
      input: Buffer.from(`sec${CTRL_D}`),
      accepts: 'secret',
      exit: 130,
      line: CANCELLED,
    },
    {
      name: '(e) end of input before a line end',
      input: Buffer.from('sec'),
      end: true,
      accepts: 'secret',
      exit: 130,
      line: CANCELLED,
    },
    {
      name: '(f) a line end with an empty answer',
      input: Buffer.from('\r'),
      accepts: 'secret',
      exit: 2,
      line: EMPTY,
    },
    {
      name: '(g) sec ESC ret',
      input: Buffer.from(`sec${ESC}ret\r`),
      accepts: 'secret',
      exit: 0,
    },
    {
      name: '(g) other C0 bytes are discarded',
      input: Buffer.from('s\x00e\x01c\x07r\x1fet\r'),
      accepts: 'secret',
      exit: 0,
    },
  ];

  it.each(cases)(
    'AC-36: reads the password in raw mode ($name)',
    async ({ input, end, accepts, exit, line }) => {
      const { fixture, args } = await promptServer(accepts);
      const stdin = new FakeInput(true);
      stdin.type(input);
      if (end === true) stdin.end();

      const result = await cli(args, { env: {}, stdin });

      expect(result.code).toBe(exit);
      if (line === undefined) {
        // The server accepts only `accepts`: a session proves that this is the password it got.
        expect(fixture.stats.sessions).toBe(1);
        expect(fixture.stats.connections).toBe(1);
      } else {
        expect(errorLine(result)).toBe(line);
        expect(fixture.stats.connections).toBe(0);
        expect(fixture.stats.authAttempts).toBe(0);
      }
      expect(result.stdin.rawModeCalls).toEqual([true, false]);
    },
  );

  it('AC-37: asks for the password before the host key', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const knownHosts = join(await tempDir(), 'known_hosts');
    await writeFile(knownHosts, '');
    const stdin = new FakeInput(true);

    const started = await startCli(
      [
        'ls',
        '--known-hosts',
        knownHosts,
        `sftp://tester@127.0.0.1:${fixture.port}/`,
      ],
      { env: {}, stdin },
    );
    await started.stderr.waitFor(PROMPT);
    expect(fixture.stats.connections).toBe(0);
    stdin.type(`${password}\r\nyes\n`);
    const result = await started.done;

    expect(result.code).toBe(0);
    const passwordAt = result.stderr.indexOf(PROMPT);
    const hostKeyAt = result.stderr.indexOf('The host key of');
    expect(passwordAt).toBeGreaterThanOrEqual(0);
    expect(hostKeyAt).toBeGreaterThan(passwordAt);
    expect(fixture.stats.sessions).toBe(1);
  });
});
