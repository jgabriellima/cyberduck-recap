/**
 * Credentials (FEATURE-3 AC-23, AC-24, AC-25, AC-47, AC-49, AC-50): which source gives the keys,
 * how a missing or failing source fails, and how the store's refusal of the keys is reported.
 * The fake server accepts several key pairs and records which one signed each request, so the
 * chosen source is observed at the server, not inferred from the back-end.
 */
import { randomBytes } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  credentialsSection,
  keyVariables,
  type AwsEnv,
} from '../support/aws-env.js';
import { sentinel } from '../support/harness.js';
import { s3Error } from '../support/s3-server.js';
import type { SigningKeys } from '../support/sigv4.js';
import {
  everythingIn,
  rejection,
  spyOutput,
  useS3,
  type S3Setup,
} from '../support/s3.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** A random key pair: never a real credential. */
function keyPair(sessionToken?: string): SigningKeys {
  return {
    accessKeyId: `AKIA${randomBytes(8).toString('hex').toUpperCase()}`,
    secretAccessKey: randomBytes(24).toString('base64'),
    ...(sessionToken === undefined ? {} : { sessionToken }),
  };
}

/** A `credential_process` value that runs a Node script written for the test. */
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

/** Options with no `credentials`, so the back-end reads the standard AWS chain. */
const CHAIN = { credentials: undefined } as const;

describe('S3 credential sources (AC-23)', () => {
  it('AC-23: environment keys and session token sign every request', async () => {
    const env = keyPair(sentinel());
    const setup = await useS3({ credentials: [env] });
    setup.env.set(keyVariables(env));

    const fs = await setup.connected(CHAIN);
    await fs.list('/b');

    expect(setup.server.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of setup.server.requests) {
      expect(request.signatureValid).toBe(true);
      expect(request.accessKeyId).toBe(env.accessKeyId);
      expect(request.sessionToken).toBe(env.sessionToken);
      expect(request.headers['x-amz-security-token']).toBe(env.sessionToken);
    }
  });

  it('AC-23: with no profile selected, environment keys come before the default profile', async () => {
    const env = keyPair();
    const fileDefault = keyPair();
    const setup = await useS3({ credentials: [env, fileDefault] });
    setup.env.set(keyVariables(env));
    await setup.env.writeCredentials(
      credentialsSection('default', fileDefault),
    );

    await setup.connected(CHAIN);

    expect(setup.server.requests.map((r) => r.accessKeyId)).toEqual([
      env.accessKeyId,
    ]);
  });

  it('AC-23: the shared credentials file gives default, AWS_PROFILE, then the option profile', async () => {
    const fileDefault = keyPair();
    const other = keyPair();
    const setup = await useS3({ credentials: [fileDefault, other] });
    await setup.env.writeCredentials(
      credentialsSection('default', fileDefault) +
        credentialsSection('other', other),
    );

    await setup.connected(CHAIN);
    expect(setup.server.requests.at(-1)?.accessKeyId).toBe(
      fileDefault.accessKeyId,
    );

    setup.env.set({ AWS_PROFILE: 'other' });
    await setup.connected(CHAIN);
    expect(setup.server.requests.at(-1)?.accessKeyId).toBe(other.accessKeyId);

    setup.env.set({ AWS_PROFILE: 'default' });
    await setup.connected({ ...CHAIN, profile: 'other' });
    expect(setup.server.requests.at(-1)?.accessKeyId).toBe(other.accessKeyId);
    expect(setup.server.requests.every((r) => r.signatureValid)).toBe(true);
  });

  it.each([
    ['AWS_PROFILE=other', { AWS_PROFILE: 'other' }, {}],
    ['the option profile', {}, { profile: 'other' }],
  ] as const)(
    'AC-23: a selected profile (%s) ignores environment keys and writes nothing',
    async (_label, variables, overrides) => {
      const output = spyOutput();
      const env = keyPair();
      const other = keyPair();
      const setup = await useS3({ credentials: [env, other] });
      setup.env.set({ ...keyVariables(env), ...variables });
      await setup.env.writeCredentials(credentialsSection('other', other));

      const fs = await setup.connected({ ...CHAIN, ...overrides });
      await fs.list('/b');

      expect(setup.server.requests.length).toBeGreaterThanOrEqual(2);
      for (const request of setup.server.requests) {
        expect(request.accessKeyId).toBe(other.accessKeyId);
      }
      expect(output.text()).toBe('');
      expect(output.calls()).toBe(0);
    },
  );

  it('AC-23: AWS_PROFILE naming a missing profile fails, never falling back to the environment', async () => {
    const env = keyPair();
    const setup = await useS3({ credentials: [env] });
    setup.env.set({ ...keyVariables(env), AWS_PROFILE: 'nosuchprofile' });

    const fs = await setup.s3(CHAIN);
    const error = await rejection(fs.connect(), 'AUTH_FAILED');

    expect(error.message).toContain('nosuchprofile');
    expect(setup.server.requests).toEqual([]);
  });

  it('AC-23: a profile whose credential_process prints credentials gives those keys', async () => {
    const processKeys = keyPair();
    const setup = await useS3({ credentials: [processKeys] });
    const command = await processCommand(
      setup.env,
      'creds.mjs',
      `process.stdout.write(${JSON.stringify(
        JSON.stringify({
          Version: 1,
          AccessKeyId: processKeys.accessKeyId,
          SecretAccessKey: processKeys.secretAccessKey,
        }),
      )});\n`,
    );
    await setup.env.writeConfig(`[default]\ncredential_process = ${command}\n`);

    await setup.connected(CHAIN);

    expect(setup.server.requests.map((r) => r.accessKeyId)).toEqual([
      processKeys.accessKeyId,
    ]);
    expect(setup.server.requests[0]?.signatureValid).toBe(true);
  });

  it('AC-23: the option credentials come before every source', async () => {
    const option = keyPair();
    const env = keyPair();
    const file = keyPair();
    const setup = await useS3({ credentials: [option, env, file] });
    setup.env.set({ ...keyVariables(env), AWS_PROFILE: 'other' });
    await setup.env.writeCredentials(
      credentialsSection('default', file) + credentialsSection('other', file),
    );

    const fs = await setup.connected({ credentials: option, profile: 'other' });
    await fs.list('/b');

    expect(setup.server.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of setup.server.requests) {
      expect(request.accessKeyId).toBe(option.accessKeyId);
    }
  });
});

describe('S3 credentials that give no keys (AC-24)', () => {
  /** Rejects with AUTH_FAILED within 5 s and no request; returns the message. */
  async function authFails(setup: S3Setup): Promise<string> {
    const fs = await setup.s3(CHAIN);
    const started = performance.now();
    const error = await rejection(fs.connect(), 'AUTH_FAILED');
    expect(performance.now() - started).toBeLessThan(5000);
    expect(setup.server.requests).toEqual([]);
    expect(error.message).toContain(setup.env.credentialsFile);
    expect(error.message).toContain(setup.env.configFile);
    return error.message;
  }

  it('AC-24: no source at all says no AWS credentials were found', async () => {
    const setup = await useS3();
    const message = await authFails(setup);
    expect(message).toContain('no AWS credentials were found');
    expect(message).toContain('default');
  }, 10_000);

  it('AC-24: a missing profile is named as not found', async () => {
    const setup = await useS3();
    setup.env.set({ AWS_PROFILE: 'ghost' });
    const message = await authFails(setup);
    expect(message).toContain('profile ghost was not found');
  }, 10_000);

  it('AC-24: a credential_process that exits 1 is named with its exit code', async () => {
    const setup = await useS3();
    const command = await processCommand(
      setup.env,
      'fail.mjs',
      'process.exit(1);\n',
    );
    await setup.env.writeConfig(
      `[profile builder]\ncredential_process = ${command}\n`,
    );
    setup.env.set({ AWS_PROFILE: 'builder' });
    const message = await authFails(setup);
    expect(message).toContain('builder');
    expect(message).toContain('credential_process');
    expect(message).toContain('exited with code 1');
  }, 10_000);

  // Root reads a file of mode 000, so the case exists only for another user.
  it.skipIf(isRoot)(
    'AC-24: an unreadable shared credentials file is read as empty',
    async () => {
      const setup = await useS3({ credentials: [keyPair()] });
      await setup.env.writeCredentials(
        credentialsSection('default', keyPair()),
      );
      await chmod(setup.env.credentialsFile, 0o000);
      const message = await authFails(setup);
      expect(message).toContain('no AWS credentials were found');
      expect(message).toContain('default');
    },
    10_000,
  );
});

describe('S3 keys that the store refuses (AC-25)', () => {
  const CHECK = 'check the access key and secret access key';
  const REFRESH = 'refresh the session token';

  it.each([
    ['InvalidAccessKeyId', CHECK],
    ['SignatureDoesNotMatch', CHECK],
    ['ExpiredToken', REFRESH],
    ['InvalidToken', REFRESH],
    ['TokenRefreshRequired', REFRESH],
  ] as const)(
    'AC-25: a probe answered %s fails AUTH_FAILED with the source and remedy',
    async (code, remedy) => {
      const setup = await useS3();
      setup.server.fault(() => s3Error(code));
      const fs = await setup.s3();
      const error = await rejection(fs.connect(), 'AUTH_FAILED');
      expect(error.message).toContain(code);
      expect(error.message).toContain('option credentials');
      expect(error.message).toContain(remedy);
    },
  );

  it('AC-25: the message names environment keys as the source', async () => {
    const env = keyPair();
    const setup = await useS3({ credentials: [env] });
    setup.env.set(keyVariables(env));
    setup.server.fault(() => s3Error('InvalidAccessKeyId'));
    const fs = await setup.s3(CHAIN);
    const error = await rejection(fs.connect(), 'AUTH_FAILED');
    expect(error.message).toContain('InvalidAccessKeyId');
    expect(error.message).toContain('environment');
    expect(error.message).toContain(CHECK);
  });

  it('AC-25: the message names a profile as the source', async () => {
    const file = keyPair();
    const setup = await useS3({ credentials: [file] });
    await setup.env.writeCredentials(credentialsSection('work', file));
    setup.env.set({ AWS_PROFILE: 'work' });
    setup.server.fault(() => s3Error('ExpiredToken'));
    const fs = await setup.s3(CHAIN);
    const error = await rejection(fs.connect(), 'AUTH_FAILED');
    expect(error.message).toContain('ExpiredToken');
    expect(error.message).toContain('profile work');
    expect(error.message).toContain(REFRESH);
  });

  it('AC-25: a wrong secret access key fails against the signature check', async () => {
    const setup = await useS3();
    const fs = await setup.s3({
      credentials: {
        accessKeyId: setup.server.keys.accessKeyId,
        secretAccessKey: randomBytes(24).toString('base64'),
      },
    });
    const error = await rejection(fs.connect(), 'AUTH_FAILED');
    expect(error.message).toContain('SignatureDoesNotMatch');
    expect(setup.server.requests.length).toBeGreaterThanOrEqual(1);
    expect(setup.server.requests.every((r) => !r.signatureValid)).toBe(true);
  });
});

describe('S3 clock skew (AC-47)', () => {
  function expectClockMessage(message: string): void {
    expect(message).toContain('RequestTimeTooSkewed');
    expect(message).toContain(
      "the local clock differs from the server's clock",
    );
    expect(message).toContain('set the local clock');
  }

  it('AC-47: connect() fails AUTH_FAILED with at most 3 requests', async () => {
    const setup = await useS3();
    setup.server.fault(() => s3Error('RequestTimeTooSkewed'));
    const fs = await setup.s3();
    const error = await rejection(fs.connect(), 'AUTH_FAILED');
    expectClockMessage(error.message);
    expect(setup.server.requests.length).toBeGreaterThanOrEqual(1);
    expect(setup.server.requests.length).toBeLessThanOrEqual(3);
  });

  it('AC-47: list on a connected instance fails AUTH_FAILED with path', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    setup.server.clearRequests();
    setup.server.fault(() => s3Error('RequestTimeTooSkewed'));
    const error = await rejection(fs.list('/b'), 'AUTH_FAILED', '/b');
    expectClockMessage(error.message);
    expect(setup.server.requests.length).toBeGreaterThanOrEqual(1);
    expect(setup.server.requests.length).toBeLessThanOrEqual(3);
  });
});

describe('S3 shared files with bad syntax (AC-49)', () => {
  it.each(['credentials', 'config'] as const)(
    'AC-49: a %s file with bad syntax fails AUTH_FAILED and leaks nothing',
    async (which) => {
      const secret = sentinel();
      const setup = await useS3();
      const text = `[default\naws_secret_access_key ${secret}\n`;
      if (which === 'credentials') await setup.env.writeCredentials(text);
      else await setup.env.writeConfig(text);

      const fs = await setup.s3(CHAIN);
      const started = performance.now();
      const error = await rejection(fs.connect(), 'AUTH_FAILED');

      expect(performance.now() - started).toBeLessThan(5000);
      expect(setup.server.requests).toEqual([]);
      expect(error.message).toContain('default');
      expect(error.message).toContain(setup.env.credentialsFile);
      expect(error.message).toContain(setup.env.configFile);
      expect(everythingIn(error)).not.toContain(secret);
    },
    10_000,
  );
});

describe('S3 credential resolution bound (AC-50)', () => {
  it('AC-50: a credential_process that never exits fails AUTH_FAILED within 3 s', async () => {
    const setup = await useS3();
    // An open server keeps the child alive with no timer: it never exits on its own.
    const command = await processCommand(
      setup.env,
      'hang.mjs',
      "import { createServer } from 'node:net';\ncreateServer().listen(0, '127.0.0.1');\n",
    );
    await setup.env.writeConfig(
      `[profile stuck]\ncredential_process = ${command}\n`,
    );
    setup.env.set({ AWS_PROFILE: 'stuck' });

    const fs = await setup.s3({ ...CHAIN, timeoutMs: 300 });
    const started = performance.now();
    const error = await rejection(fs.connect(), 'AUTH_FAILED');

    expect(performance.now() - started).toBeLessThan(3000);
    expect(setup.server.requests).toEqual([]);
    expect(error.message).toContain('stuck');
    expect(error.message).toContain('credential_process');
    expect(error.message).toContain('did not finish within 300 ms');
  }, 10_000);
});
