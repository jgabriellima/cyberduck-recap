import { generateKeyPairSync } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FakeInput,
  cli,
  errorLine,
  hintFollowsError,
  isRoot,
  isWindows,
  useCliServer,
  type RunResult,
} from '../support/cli.js';
import {
  sentinel,
  tempDir,
  trustingKnownHosts,
  useServer,
} from '../support/harness.js';
import { generateKey } from '../support/sftp-server.js';

const PROMPT = 'Password for tester@127.0.0.1: ';

async function keyFile(content: string, name = 'id_key'): Promise<string> {
  const path = join(await tempDir(), name);
  await writeFile(path, content);
  return path;
}

/** stdin was never read: every byte the test wrote is still buffered and raw mode was never set. */
function expectStdinUnread(result: RunResult): void {
  expect(result.stdin.readableLength).toBe(result.stdin.bytesWritten);
  expect(result.stdin.rawModeCalls).toEqual([]);
}

/** A legacy PEM key encrypted with a passphrase (`Proc-Type: 4,ENCRYPTED`). */
function encryptedPemKey(passphrase: string): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: {
      type: 'pkcs1',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase,
    },
  });
  return privateKey;
}

describe('credentials (FEATURE-2 AC-19 to AC-21, AC-38)', () => {
  it('AC-19: refuses a password on the command line without echoing it', async () => {
    const server = await useCliServer();
    const secret = sentinel();
    const inUrl = `sftp://tester:${secret}@127.0.0.1:${server.fixture.port}/`;

    const fromUrl = await cli(
      ['ls', '--known-hosts', server.knownHostsPath, inUrl],
      { env: server.env },
    );
    const fromOption = await cli(
      [
        'ls',
        `--password=${secret}`,
        '--known-hosts',
        server.knownHostsPath,
        server.url('/'),
      ],
      { env: server.env },
    );

    expect(fromUrl.code).toBe(2);
    expect(errorLine(fromUrl)).toBe(
      'cyberduck-recap: USAGE: passwords are not accepted in the URL; use --identity, CYBERDUCK_RECAP_PASSWORD or the prompt',
    );
    expect(fromOption.code).toBe(2);
    expect(errorLine(fromOption)).toBe(
      "cyberduck-recap: USAGE: unknown option '--password'",
    );
    for (const result of [fromUrl, fromOption]) {
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
    expect(server.fixture.stats.connections).toBe(0);
  });

  it('AC-19: treats an empty URL password as no password', async () => {
    const server = await useCliServer();
    const url = `sftp://tester:@127.0.0.1:${server.fixture.port}/`;

    const result = await cli(
      ['ls', '--known-hosts', server.knownHostsPath, url],
      { env: server.env },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it.each(['--identity', 'CYBERDUCK_RECAP_PASSWORD', 'prompt'] as const)(
    'AC-20: takes the credential from the first source that applies (%s)',
    async (source) => {
      const passphrase = sentinel();
      const userKey = generateKey(passphrase);
      const password = sentinel();
      const fixture = await useServer({
        password,
        authorizedKeys: [userKey],
      });
      const knownHosts = await trustingKnownHosts(fixture);
      const url = `sftp://tester@127.0.0.1:${fixture.port}/`;
      const stdin = new FakeInput(source === 'prompt');
      let args = ['ls', '--known-hosts', knownHosts, url];
      let env: Record<string, string> = {};
      if (source === '--identity') {
        args = [
          'ls',
          '--identity',
          await keyFile(userKey.privateKey),
          '--known-hosts',
          knownHosts,
          url,
        ];
        env = { CYBERDUCK_RECAP_PASSPHRASE: passphrase };
      } else if (source === 'CYBERDUCK_RECAP_PASSWORD') {
        env = { CYBERDUCK_RECAP_PASSWORD: password };
      } else {
        stdin.type(`${password}\r`);
      }

      const result = await cli(args, { env, stdin });

      expect(result.code).toBe(0);
      expect(fixture.stats.sessions).toBe(1);
      expect(result.stderr.includes(PROMPT)).toBe(source === 'prompt');
    },
    30_000,
  );

  it('AC-20: uses only the first source', async () => {
    const userKey = generateKey();
    // This server accepts only the key: a password attempt would fail authentication.
    const fixture = await useServer({ authorizedKeys: [userKey] });
    const knownHosts = await trustingKnownHosts(fixture);
    const url = `sftp://tester@127.0.0.1:${fixture.port}/`;
    const identity = await keyFile(userKey.privateKey);

    const both = await cli(
      ['ls', '--identity', identity, '--known-hosts', knownHosts, url],
      { env: { CYBERDUCK_RECAP_PASSWORD: sentinel() } },
    );
    expect(both.code).toBe(0);

    const identityOnTty = await cli(
      ['ls', '--identity', identity, '--known-hosts', knownHosts, url],
      { stdin: new FakeInput(true) },
    );
    expect(identityOnTty.code).toBe(0);
    expect(identityOnTty.stderr).not.toContain('Password for');
    expect(identityOnTty.stdin.rawModeCalls).toEqual([]);

    const passwordServer = await useCliServer();
    const passwordOnTty = await cli(
      [
        'ls',
        '--known-hosts',
        passwordServer.knownHostsPath,
        passwordServer.url('/'),
      ],
      { env: passwordServer.env, stdin: new FakeInput(true) },
    );
    expect(passwordOnTty.code).toBe(0);
    expect(passwordOnTty.stderr).not.toContain('Password for');
    expect(passwordOnTty.stdin.rawModeCalls).toEqual([]);
  });

  it('AC-20: refuses to run without a credential', async () => {
    const server = await useCliServer();
    const stdin = new FakeInput(false);
    stdin.type(`${sentinel()}\n`);

    const result = await cli(
      ['ls', '--known-hosts', server.knownHostsPath, server.url('/')],
      { env: {}, stdin },
    );

    expect(result.code).toBe(2);
    expect(errorLine(result)).toBe(
      'cyberduck-recap: USAGE: no credential: give --identity <file>, set CYBERDUCK_RECAP_PASSWORD, or run from a terminal',
    );
    expectStdinUnread(result);
    expect(server.fixture.stats.authAttempts).toBe(0);
  });

  it.each([
    { isTTY: true, env: {} },
    { isTTY: false, env: { CYBERDUCK_RECAP_PASSWORD: 'any' } },
  ])(
    'AC-20: refuses an sftp URL without a user name before the prompt (isTTY $isTTY)',
    async ({ isTTY, env }) => {
      const server = await useCliServer();
      const stdin = new FakeInput(isTTY);
      stdin.type('secret\r');

      const result = await cli(
        [
          'ls',
          '--known-hosts',
          server.knownHostsPath,
          `sftp://127.0.0.1:${server.fixture.port}/`,
        ],
        { env, stdin },
      );

      expect(result.code).toBe(21);
      expect(errorLine(result)).toBe(
        'cyberduck-recap: INVALID_ARGUMENT: invalid option "username": must be a non-empty string',
      );
      expect(result.stderr).not.toContain('Password for');
      expectStdinUnread(result);
      expect(server.fixture.stats.authAttempts).toBe(0);
    },
  );

  const unreadableIdentityCases =
    isRoot || isWindows ? [] : (['mode 0000'] as const);

  it.each([...(['missing'] as const), ...unreadableIdentityCases])(
    'AC-21: reports an unreadable identity file (%s)',
    async (kind) => {
      const server = await useCliServer();
      const identity = join(await tempDir(), 'id_key');
      if (kind === 'mode 0000') {
        await writeFile(identity, generateKey().privateKey);
        await chmod(identity, 0o000);
      }

      const result = await cli(
        [
          'ls',
          '--identity',
          identity,
          '--known-hosts',
          server.knownHostsPath,
          server.url('/'),
        ],
        { env: {} },
      );

      expect(result.code).toBe(3);
      expect(errorLine(result)).toBe(
        `cyberduck-recap: LOCAL_FILE: cannot read the identity file ${identity}`,
      );
      expect(server.fixture.stats.connections).toBe(0);
    },
  );

  type IdentityCase = {
    readonly name: string;
    readonly key: () => string;
    readonly passphrase: string | undefined;
    readonly isTTY: boolean;
    readonly hint: (file: string) => string;
    readonly fileName?: string;
  };
  const encryptedHint = (file: string): string =>
    `cyberduck-recap: the private key in ${file} is encrypted; set CYBERDUCK_RECAP_PASSPHRASE to its passphrase`;
  const wrongPassphraseHint = (file: string): string =>
    `cyberduck-recap: the passphrase in CYBERDUCK_RECAP_PASSPHRASE does not decrypt the private key in ${file}`;
  const notAKeyHint = (file: string): string =>
    `cyberduck-recap: ${file} is not a private key; give the private key file, not the .pub file`;
  const openSsh = (): string => generateKey(sentinel()).privateKey;
  const pem = (): string => encryptedPemKey(sentinel());
  const identityCases: IdentityCase[] = [];
  for (const [format, key] of [
    ['OpenSSH', openSsh],
    ['PEM', pem],
  ] as const) {
    for (const passphrase of [undefined, '']) {
      for (const isTTY of [true, false]) {
        identityCases.push({
          name: `(a) encrypted ${format} key, passphrase ${passphrase === undefined ? 'unset' : 'empty'}`,
          key,
          passphrase,
          isTTY,
          hint: encryptedHint,
        });
      }
    }
    identityCases.push({
      name: `(b) encrypted ${format} key, wrong passphrase`,
      key,
      passphrase: sentinel(),
      isTTY: false,
      hint: wrongPassphraseHint,
    });
  }
  identityCases.push(
    {
      name: '(c) a .pub public key',
      key: () => `${generateKey().publicKey}\n`,
      fileName: 'id_ed25519.pub',
      passphrase: undefined,
      isTTY: false,
      hint: notAKeyHint,
    },
    {
      name: '(c) the text hello',
      key: () => 'hello',
      passphrase: undefined,
      isTTY: false,
      hint: notAKeyHint,
    },
  );

  it.each(identityCases)(
    'AC-38: explains an identity file that gives no key ($name, isTTY $isTTY)',
    async ({ key, passphrase, isTTY, hint, fileName }) => {
      const server = await useCliServer();
      const identity = await keyFile(key(), fileName);
      const env: Record<string, string> =
        passphrase === undefined
          ? {}
          : { CYBERDUCK_RECAP_PASSPHRASE: passphrase };

      const result = await cli(
        [
          'ls',
          '--identity',
          identity,
          '--known-hosts',
          server.knownHostsPath,
          server.url('/'),
        ],
        { env, stdin: new FakeInput(isTTY) },
      );

      expect(result.code).toBe(10);
      expect(errorLine(result)).toMatch(/^cyberduck-recap: AUTH_FAILED: /);
      expect(result.stderrLines).toContain(hint(identity));
      expect(hintFollowsError(result, hint(identity))).toBe(true);
      expect(server.fixture.stats.connections).toBe(0);
      expect(result.stderr).not.toContain('Password for');
      expect(result.stderr).not.toContain('Type yes');
      expect(result.stdin.rawModeCalls).toEqual([]);
    },
    30_000,
  );
});
