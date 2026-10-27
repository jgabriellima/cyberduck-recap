import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeInput, cli, type RunResult } from '../support/cli.js';
import {
  sentinel,
  tempDir,
  trustingKnownHosts,
  useServer,
} from '../support/harness.js';
import {
  generateKey,
  unusedPort,
  type SftpServerFixture,
} from '../support/sftp-server.js';

const secrets = [
  'the password from CYBERDUCK_RECAP_PASSWORD',
  'the password from the prompt',
  'the passphrase from CYBERDUCK_RECAP_PASSPHRASE',
  "the private key's text from --identity",
] as const;
const outcomes = [
  { outcome: 'success', exit: 0 },
  { outcome: 'AUTH_FAILED', exit: 10 },
  { outcome: 'CONNECTION_FAILED', exit: 13 },
  { outcome: 'NOT_FOUND', exit: 16 },
] as const;

type Secret = (typeof secrets)[number];
type Outcome = (typeof outcomes)[number]['outcome'];

/** The texts that must never appear: the secret and, for a key, every line of its body. */
function forbiddenTexts(secret: string): string[] {
  const lines = secret
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 16 && !line.startsWith('-----'));
  return [secret, ...lines];
}

async function runWith(
  secretKind: Secret,
  outcome: Outcome,
): Promise<{ result: RunResult; forbidden: string[] }> {
  const wrong = outcome === 'AUTH_FAILED';
  const path = outcome === 'NOT_FOUND' ? '/missing' : '/';
  const stdin = new FakeInput(secretKind === 'the password from the prompt');
  let env: Record<string, string> = {};
  let identity: string[] = [];
  let secret: string;
  let fixture: SftpServerFixture;

  if (
    secretKind === 'the password from CYBERDUCK_RECAP_PASSWORD' ||
    secretKind === 'the password from the prompt'
  ) {
    secret = sentinel();
    fixture = await useServer({ password: wrong ? sentinel() : secret });
    if (secretKind === 'the password from the prompt') {
      stdin.type(`${secret}\r`);
    } else {
      env = { CYBERDUCK_RECAP_PASSWORD: secret };
    }
  } else if (secretKind === 'the passphrase from CYBERDUCK_RECAP_PASSPHRASE') {
    secret = sentinel();
    // A wrong secret: the key is encrypted with another passphrase than the one given.
    const userKey = generateKey(wrong ? sentinel() : secret);
    fixture = await useServer({ authorizedKeys: [userKey] });
    const file = join(await tempDir(), 'id_key');
    await writeFile(file, userKey.privateKey);
    identity = ['--identity', file];
    env = { CYBERDUCK_RECAP_PASSPHRASE: secret };
  } else {
    const userKey = generateKey();
    secret = userKey.privateKey;
    // A wrong secret: the server authorises another key.
    fixture = await useServer({
      authorizedKeys: [wrong ? generateKey() : userKey],
    });
    const file = join(await tempDir(), 'id_key');
    await writeFile(file, userKey.privateKey);
    identity = ['--identity', file];
  }

  const knownHosts = await trustingKnownHosts(fixture);
  const port =
    outcome === 'CONNECTION_FAILED' ? await unusedPort() : fixture.port;
  const result = await cli(
    [
      'ls',
      ...identity,
      '--known-hosts',
      knownHosts,
      `sftp://tester@127.0.0.1:${port}${path}`,
    ],
    { env, stdin },
  );
  return { result, forbidden: forbiddenTexts(secret) };
}

describe('secrets never reach the output (FEATURE-2 AC-23)', () => {
  it.each(
    secrets.flatMap((secret) =>
      outcomes.map(({ outcome, exit }) => ({ secret, outcome, exit })),
    ),
  )(
    'AC-23: never writes a secret to stdout or stderr ($secret, $outcome)',
    async ({ secret, outcome, exit }) => {
      const { result, forbidden } = await runWith(secret, outcome);

      expect(result.code).toBe(exit);
      for (const text of forbidden) {
        expect(result.stdout).not.toContain(text);
        expect(result.stderr).not.toContain(text);
      }
    },
    30_000,
  );
});
