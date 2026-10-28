/**
 * Adversarial (FEATURE-3, ATK-84): secrets on the command line and in a configured endpoint. A
 * person who pastes `s3://ACCESSKEY:SECRET@bucket/key` puts the secret access key in the URL's
 * password; AC-37 refuses a user name, but its tests carry no password. A configured endpoint
 * (`AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL`, a profile's `endpoint_url`) with user information is
 * checked like the option `endpoint` (AC-4): INVALID_ARGUMENT that names the source. In every case
 * the secret reaches no message, no stdout or stderr line and no server.
 */
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { cli } from '../support/cli.js';
import { sentinel, tempDir } from '../support/harness.js';
import {
  everythingIn,
  rejection,
  spyOutput,
  useS3,
  type S3Setup,
} from '../support/s3.js';

/** The variables that point the CLI's S3 back-end at the fake server. */
async function cliVariables(setup: S3Setup): Promise<Record<string, string>> {
  const caFile = await setup.env.file('ca.pem', setup.server.ca.cert);
  const variables = {
    AWS_ENDPOINT_URL_S3: setup.server.endpoint,
    AWS_CA_BUNDLE: caFile,
    AWS_ACCESS_KEY_ID: setup.server.keys.accessKeyId,
    AWS_SECRET_ACCESS_KEY: setup.server.keys.secretAccessKey,
    AWS_REGION: 'us-east-1',
  };
  setup.env.set(variables);
  return variables;
}

describe('ATK-84: an s3 URL with a password on the command line', () => {
  it.each([
    ['ls', (url: string) => ['ls', url]],
    ['get', (url: string) => ['get', url, 'out.bin']],
    ['put', (url: string) => ['put', 'in.bin', url]],
  ] as const)(
    '%s: exit 21, the password is on no line, no request',
    async (_command, args) => {
      const setup = await useS3();
      const variables = await cliVariables(setup);
      const local = await tempDir();
      await writeFile(join(local, 'in.bin'), 'payload');
      const secret = sentinel();
      const url = `s3://AKIAEXAMPLE:${secret}@b/k`;

      const result = await cli(args(url), {
        env: { ...process.env, ...variables },
        cwd: local,
        home: setup.env.home,
      });

      expect(result.code).toBe(21);
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      expect(setup.server.requests).toHaveLength(0);
      expect(setup.server.counts.tcp).toBe(0);
    },
  );
});

describe('ATK-84: a configured endpoint with user information', () => {
  const sources = [
    ['AWS_ENDPOINT_URL_S3', 'https'],
    ['AWS_ENDPOINT_URL', 'https'],
    ['AWS_ENDPOINT_URL_S3', 'http'],
    ['endpoint_url', 'https'],
  ] as const;

  it.each(sources)(
    '%s with an %s URL that holds a password: INVALID_ARGUMENT, the password nowhere',
    async (source, scheme) => {
      const setup = await useS3();
      const output = spyOutput();
      const secret = sentinel();
      const endpoint = `${scheme}://AKIAEXAMPLE:${secret}@127.0.0.1:${setup.server.port}`;
      if (source === 'endpoint_url') {
        await setup.env.writeConfig(`[default]\nendpoint_url = ${endpoint}\n`);
      } else {
        setup.env.set({ [source]: endpoint });
      }
      const fs = await setup.s3({ endpoint: undefined });

      const error = await rejection(fs.connect(), 'INVALID_ARGUMENT');

      expect(error.message).toContain(
        source === 'endpoint_url' ? 'endpoint_url' : source,
      );
      expect(everythingIn(error)).not.toContain(secret);
      expect(output.text()).not.toContain(secret);
      expect(setup.server.counts.tcp).toBe(0);
    },
  );
});
