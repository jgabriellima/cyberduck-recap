/**
 * Attacks on the S3 back-end's secrets (FEATURE-3 AC-35, AC-44, AC-51): a server that echoes the
 * secret access key and the session token in its messages, headers and body; credential sources
 * that print, pass or hold a secret and then fail. No sentinel may reach a `RemoteFsError` (its
 * message, own properties or cause chain) or stdout, stderr or `console`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { ClientRequest, IncomingMessage } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { RemoteFileSystem } from '../../src/fs/index.js';
import { describe, expect, it } from 'vitest';
import {
  credentialsSection,
  keyVariables,
  type AwsEnv,
} from '../support/aws-env.js';
import { sentinel } from '../support/harness.js';
import { s3Error, type Fault } from '../support/s3-server.js';
import type { SigningKeys } from '../support/sigv4.js';
import {
  everythingIn,
  readAll,
  rejection,
  spyOutput,
  useS3,
  writeAll,
  type S3Setup,
} from '../support/s3.js';

/** Options with no `credentials`, so the back-end reads the standard AWS chain. */
const CHAIN = { credentials: undefined } as const;

/** Sentinel keys: the secret and the token are random values made at test time. */
function sentinelKeys(): SigningKeys & { sessionToken: string } {
  return {
    accessKeyId: `AKIA${randomBytes(8).toString('hex').toUpperCase()}`,
    secretAccessKey: sentinel(),
    sessionToken: sentinel(),
  };
}

/** An error reply that carries both sentinels in its message, its headers and its XML body. */
function echoing(
  code: string,
  keys: SigningKeys & { sessionToken: string },
): Fault {
  const both = `${keys.secretAccessKey} ${keys.sessionToken}`;
  return s3Error(code, `refused for ${both}`, {
    headers: { 'x-amz-echo': both, 'x-amz-token-echo': keys.sessionToken },
    extraXml: `<Echo>${keys.secretAccessKey}</Echo><Token>${keys.sessionToken}</Token>`,
  });
}

/** True when `value` holds an SDK error, an HTTP request or response, at any depth. */
function holdsProtocolObject(
  value: unknown,
  seen = new Set<unknown>(),
): boolean {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (value instanceof IncomingMessage || value instanceof ClientRequest) {
    return true;
  }
  const record = value as Record<string, unknown>;
  if ('$metadata' in record || '$response' in record || '$fault' in record) {
    return true;
  }
  return Object.getOwnPropertyNames(value).some((name) =>
    holdsProtocolObject(record[name], seen),
  );
}

function expectClean(error: unknown, secrets: readonly string[]): void {
  const text = everythingIn(error);
  for (const secret of secrets) expect(text).not.toContain(secret);
  expect(holdsProtocolObject(error)).toBe(false);
}

/** Every operation once against a server that echoes the secrets; returns the errors. */
async function failEveryOperation(fs: RemoteFileSystem): Promise<unknown[]> {
  const errors: unknown[] = [];
  const capture = async (promise: Promise<unknown>): Promise<void> => {
    await promise.then(
      () => errors.push(new Error('operation resolved')),
      (error: unknown) => errors.push(error),
    );
  };
  await capture(fs.list('/b'));
  await capture(fs.stat('/b/k'));
  await capture(fs.mkdir('/b/d'));
  await capture(fs.remove('/b/k'));
  await capture(fs.rename('/b/k', '/b/k2'));
  errors.push(...(await readAll(fs.createReadStream('/b/k'))).errors);
  errors.push(
    ...(await writeAll(fs.createWriteStream('/b/up'), Buffer.from('x'))).errors,
  );
  return errors;
}

/** The source of the sentinel keys, set up in a clean environment. */
type Source = (
  setup: S3Setup,
  keys: SigningKeys,
) => Promise<Readonly<Record<string, unknown>>>;

async function processCommand(
  env: AwsEnv,
  name: string,
  source: string,
  args: readonly string[] = [],
): Promise<string> {
  const script = await env.file(name, source);
  return [process.execPath, script, ...args]
    .map((part) => `"${part}"`)
    .join(' ');
}

const SOURCES: readonly (readonly [string, Source])[] = [
  ['the option credentials', () => Promise.resolve({})],
  [
    'the environment',
    (setup, keys) => {
      setup.env.set(keyVariables(keys));
      return Promise.resolve(CHAIN);
    },
  ],
  [
    'a shared credentials file',
    async (setup, keys) => {
      await setup.env.writeCredentials(credentialsSection('default', keys));
      return CHAIN;
    },
  ],
  [
    'a config file',
    async (setup, keys) => {
      await setup.env.writeConfig(credentialsSection('default', keys));
      return CHAIN;
    },
  ],
  [
    'the stdout of a credential_process',
    async (setup, keys) => {
      const json = JSON.stringify({
        Version: 1,
        AccessKeyId: keys.accessKeyId,
        SecretAccessKey: keys.secretAccessKey,
        SessionToken: keys.sessionToken,
      });
      const command = await processCommand(
        setup.env,
        'creds.mjs',
        `process.stdout.write(${JSON.stringify(json)});\n`,
      );
      await setup.env.writeConfig(
        `[default]\ncredential_process = ${command}\n`,
      );
      return CHAIN;
    },
  ],
];

describe('No secret leaves the S3 back-end (AC-35)', () => {
  it.each(SOURCES)(
    'AC-35: with the keys from %s, no error and no output holds a sentinel',
    async (_label, source) => {
      const output = spyOutput();
      const keys = sentinelKeys();
      const setup = await useS3({ credentials: [keys] });
      setup.server.putObject('b', 'k', 'data');
      const overrides = await source(setup, keys);
      const secrets = [keys.secretAccessKey, keys.sessionToken];

      const fs = await setup.connected(overrides);
      const removeDenied = setup.server.fault(() =>
        echoing('AccessDenied', keys),
      );
      const errors = await failEveryOperation(fs);
      expect(errors).toHaveLength(7);
      for (const error of errors) {
        expect(error).toHaveProperty('code', 'PERMISSION_DENIED');
        expectClean(error, secrets);
      }

      // A probe refused with an echo of the secrets: the AUTH_FAILED path leaks nothing either.
      // The denying rule goes first: fault rules run in the order added, and the probe of an
      // AccessDenied reply resolves (AC-22).
      removeDenied();
      const refused = await setup.s3(overrides);
      setup.server.fault(() => echoing('InvalidAccessKeyId', keys));
      const authError = await rejection(refused.connect(), 'AUTH_FAILED');
      expectClean(authError, secrets);

      const written = output.text();
      for (const secret of secrets) expect(written).not.toContain(secret);
      expect(output.calls()).toBe(0);
    },
  );
});

describe('No secret of a failing credential_process leaks (AC-44)', () => {
  const CASES: readonly (readonly [
    string,
    (secret: string) => { source: string; args: string[] },
  ])[] = [
    [
      'prints the secret on stdout (partial JSON) and stderr, then exits 1',
      (secret) => ({
        source: `process.stdout.write('{"Version":1,"AccessKeyId":"AKIA","SecretAccessKey":"${secret}');\nprocess.stderr.write('${secret}\\n');\nprocess.exitCode = 1;\n`,
        args: [],
      }),
    ],
    [
      'holds the secret in its command line and exits 1',
      (secret) => ({ source: 'process.exitCode = 1;\n', args: [secret] }),
    ],
    [
      'prints invalid JSON with the secret and exits 0',
      (secret) => ({
        source: `process.stdout.write('{not json ${secret}');\n`,
        args: [],
      }),
    ],
  ];

  it.each(CASES)(
    'AC-44: a credential_process that %s gives AUTH_FAILED with no sentinel',
    async (_label, script) => {
      const output = spyOutput();
      const secret = sentinel();
      const setup = await useS3();
      const { source, args } = script(secret);
      const command = await processCommand(setup.env, 'leak.mjs', source, args);
      await setup.env.writeConfig(
        `[profile leaky]\ncredential_process = ${command}\n`,
      );
      setup.env.set({ AWS_PROFILE: 'leaky' });

      const fs = await setup.s3(CHAIN);
      const error = await rejection(fs.connect(), 'AUTH_FAILED');

      expect(error.message).toContain('leaky');
      expect(setup.server.requests).toEqual([]);
      expectClean(error, [secret]);
      expect(output.text()).not.toContain(secret);
      expect(output.calls()).toBe(0);
    },
    10_000,
  );
});

/** A port on 127.0.0.1 with nothing listening: every connection to it is refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('No secret of the web identity and SSO sources leaks (AC-51)', () => {
  async function closedEndpoints(setup: S3Setup): Promise<void> {
    const url = `http://127.0.0.1:${await closedPort()}`;
    setup.env.set({
      AWS_ENDPOINT_URL_STS: url,
      AWS_ENDPOINT_URL_SSO: url,
      AWS_ENDPOINT_URL_SSO_OIDC: url,
    });
  }

  async function expectNoLeak(
    setup: S3Setup,
    secrets: readonly string[],
  ): Promise<void> {
    const output = spyOutput();
    const fs = await setup.s3(CHAIN);
    const started = performance.now();
    const error = await rejection(fs.connect(), 'AUTH_FAILED');
    expect(performance.now() - started).toBeLessThan(5000);
    expect(setup.server.requests).toEqual([]);
    expectClean(error, secrets);
    const written = output.text();
    for (const secret of secrets) expect(written).not.toContain(secret);
    expect(output.calls()).toBe(0);
  }

  it('AC-51: a web identity token file', async () => {
    const token = sentinel();
    const setup = await useS3();
    await closedEndpoints(setup);
    const file = await setup.env.file('web-identity-token', token);
    setup.env.set({
      AWS_WEB_IDENTITY_TOKEN_FILE: file,
      AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/cyberduck-recap-test',
      AWS_REGION: 'us-east-1',
    });
    await expectNoLeak(setup, [token]);
  }, 10_000);

  it('AC-51: an expired SSO cache file', async () => {
    const secrets = {
      accessToken: sentinel(),
      refreshToken: sentinel(),
      clientSecret: sentinel(),
    };
    const setup = await useS3();
    await closedEndpoints(setup);
    const startUrl = 'https://cyberduck-recap-test.awsapps.com/start';
    await setup.env.writeConfig(
      [
        '[default]',
        'sso_session = corp',
        'sso_account_id = 123456789012',
        'sso_role_name = Reader',
        'region = us-east-1',
        '[sso-session corp]',
        `sso_start_url = ${startUrl}`,
        'sso_region = us-east-1',
        'sso_registration_scopes = sso:account:access',
        '',
      ].join('\n'),
    );
    const cache = join(setup.env.home, '.aws', 'sso', 'cache');
    await mkdir(cache, { recursive: true });
    const entry = JSON.stringify({
      ...secrets,
      clientId: 'cyberduck-recap-test-client',
      expiresAt: '2020-01-01T00:00:00Z',
      registrationExpiresAt: '2999-01-01T00:00:00Z',
      region: 'us-east-1',
      startUrl,
    });
    // The SDK names the cache file after the SHA-1 of the session name (or the start URL).
    for (const name of ['corp', startUrl]) {
      const file = createHash('sha1').update(name).digest('hex');
      await writeFile(join(cache, `${file}.json`), entry);
    }
    await expectNoLeak(setup, Object.values(secrets));
  }, 10_000);
});
