/**
 * Attacks on the CLI's output with S3 secrets (FEATURE-3 AC-38, AC-44). The CLI's own redaction
 * point knows only the CLI's secrets; the AWS secrets come from the environment and the shared
 * files, so these tests prove that no S3 failure path brings one to stdout or stderr.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli, type RunResult } from '../support/cli.js';
import { sentinel, tempDir } from '../support/harness.js';
import { bytes, useS3, type S3Setup } from '../support/s3.js';
import { s3Error, type Fault } from '../support/s3-server.js';
import { writeFile } from 'node:fs/promises';

interface Secrets {
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

/** A server that accepts the sentinel keys and can echo them in a reply. */
async function useSecretServer(): Promise<{
  setup: S3Setup;
  secrets: Secrets;
  env: Record<string, string>;
  local: string;
}> {
  const secrets: Secrets = {
    secretAccessKey: sentinel(),
    sessionToken: sentinel(),
  };
  const accessKeyId = `AKIA${sentinel().slice(0, 16).toUpperCase()}`;
  const setup = await useS3({
    credentials: [{ accessKeyId, ...secrets }],
  });
  const caFile = await setup.env.file('ca.pem', setup.server.ca.cert);
  const env = {
    AWS_ENDPOINT_URL_S3: setup.server.endpoint,
    AWS_CA_BUNDLE: caFile,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secrets.secretAccessKey,
    AWS_SESSION_TOKEN: secrets.sessionToken,
  };
  setup.env.set(env);
  return { setup, secrets, env, local: await tempDir() };
}

/** An error reply that carries both sentinels in its message, a header and its XML body. */
function echo(code: string, secrets: Secrets): Fault {
  const both = `${secrets.secretAccessKey} ${secrets.sessionToken}`;
  return s3Error(code, `echo ${both}`, {
    headers: { 'x-amz-echo': both },
    extraXml: `<Echo>${both}</Echo><Token>${secrets.sessionToken}</Token>`,
  });
}

function expectNoSentinel(result: RunResult, secrets: readonly string[]): void {
  for (const secret of secrets) {
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  }
}

describe('no S3 secret reaches the CLI output (FEATURE-3)', () => {
  it('AC-38: a failing ls, get and put against a server that echoes the secrets print none', async () => {
    const { setup, secrets, env, local } = await useSecretServer();
    setup.server.putObject('b', 'k', 'old');
    setup.server.fault((request) => {
      switch (request.operation) {
        case 'ListObjectsV2':
          // The probe (max-keys=1) passes, so ls fails at the listing itself.
          return request.query['max-keys'] === '1'
            ? undefined
            : echo('AccessDenied', secrets);
        case 'GetObject':
        case 'HeadObject':
          return echo('AccessDenied', secrets);
        case 'PutObject':
        case 'CreateMultipartUpload':
          return echo('AccessDenied', secrets);
        default:
          return undefined;
      }
    });
    const source = join(local, 'up.bin');
    await writeFile(source, bytes(1024));
    const all = [secrets.secretAccessKey, secrets.sessionToken];

    const ls = await cli(['ls', 's3://b/'], { env, cwd: local });
    const get = await cli(['get', 's3://b/k', join(local, 'k')], {
      env,
      cwd: local,
    });
    const put = await cli(['put', '--overwrite', source, 's3://b/k'], {
      env,
      cwd: local,
    });

    for (const result of [ls, get, put]) {
      expect(result.code).toBe(17);
      expectNoSentinel(result, all);
    }
  });

  it('AC-38: an AUTH_FAILED and a CONNECTION_FAILED that echo the secrets print none', async () => {
    const { setup, secrets, env, local } = await useSecretServer();
    const all = [secrets.secretAccessKey, secrets.sessionToken];

    const removeAuth = setup.server.fault(() =>
      echo('InvalidAccessKeyId', secrets),
    );
    const auth = await cli(['ls', 's3://b/'], { env, cwd: local });
    removeAuth();
    expect(auth.code).toBe(10);
    expectNoSentinel(auth, all);

    // A probe reply that is neither 200, AccessDenied, NoSuchBucket nor an auth code.
    setup.server.fault(() => echo('NotImplemented', secrets));
    const failed = await cli(['ls', 's3://b/'], { env, cwd: local });
    expect(failed.code).toBe(13);
    expectNoSentinel(failed, all);
  });

  describe('AC-44: a failing credential_process leaks nothing through runCli', () => {
    const cases: readonly {
      readonly name: string;
      readonly script: (secret: string) => string;
      readonly argument: boolean;
    }[] = [
      {
        name: 'prints the secret on stdout (partial JSON) and stderr, exits 1',
        script: (secret) =>
          `process.stdout.write('{"Version": 1, "AccessKeyId": "AKIAX", "SecretAccessKey": "${secret}"');\nprocess.stderr.write('${secret}');\nprocess.exit(1);\n`,
        argument: false,
      },
      {
        name: 'holds the secret as a command-line argument, exits 1',
        script: () => 'process.exit(1);\n',
        argument: true,
      },
      {
        name: 'prints invalid JSON with the secret, exits 0',
        script: (secret) =>
          `process.stdout.write('{not json ${secret}');\nprocess.exit(0);\n`,
        argument: false,
      },
    ];

    it.each(cases)('$name: exit 10, no sentinel, no request', async (entry) => {
      const setup = await useS3();
      const secret = sentinel();
      const script = await setup.env.file('process.mjs', entry.script(secret));
      const command = `"${process.execPath}" "${script}"${entry.argument ? ` ${secret}` : ''}`;
      await setup.env.writeConfig(
        `[profile proc]\ncredential_process = ${command}\n`,
      );
      const caFile = await setup.env.file('ca.pem', setup.server.ca.cert);
      const env = {
        AWS_ENDPOINT_URL_S3: setup.server.endpoint,
        AWS_CA_BUNDLE: caFile,
        AWS_REGION: 'us-east-1',
        AWS_PROFILE: 'proc',
      };
      setup.env.set(env);

      const result = await cli(['ls', 's3://b/'], {
        env,
        cwd: await tempDir(),
      });

      expect(result.code).toBe(10);
      expectNoSentinel(result, [secret]);
      expect(setup.server.requests).toHaveLength(0);
    });
  });
});
