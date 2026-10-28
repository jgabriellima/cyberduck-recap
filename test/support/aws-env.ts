/**
 * A clean AWS environment for one test: a temporary `HOME` with empty shared files, no AWS
 * variable of the developer's shell, and the instance metadata service off. Every variable is
 * set with `vi.stubEnv` and restored when the test ends, so no test sees another's settings and
 * the developer's own `~/.aws` never takes part.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { onTestFinished, vi } from 'vitest';
import { tempDir } from './harness.js';

/** Variables that select or give AWS credentials, regions, endpoints or TLS trust. */
const CLEARED = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CREDENTIAL_EXPIRATION',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_S3',
  'AWS_ENDPOINT_URL_STS',
  'AWS_ENDPOINT_URL_SSO',
  'AWS_ENDPOINT_URL_SSO_OIDC',
  'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
  'AWS_CA_BUNDLE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
  'AWS_SDK_LOAD_CONFIG',
  'AWS_USE_FIPS_ENDPOINT',
  'AWS_USE_DUALSTACK_ENDPOINT',
  'AWS_S3_US_EAST_1_REGIONAL_ENDPOINT',
  'AWS_S3_DISABLE_MULTIREGION_ACCESS_POINTS',
  'AWS_MAX_ATTEMPTS',
  'AWS_RETRY_MODE',
  'AWS_REQUEST_CHECKSUM_CALCULATION',
  'AWS_RESPONSE_CHECKSUM_VALIDATION',
  'AWS_NODEJS_CONNECTION_REUSE_ENABLED',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'CYBERDUCK_RECAP_PASSWORD',
  'CYBERDUCK_RECAP_PASSPHRASE',
] as const;

export interface AwsEnv {
  /** The temporary home directory (`HOME`). */
  readonly home: string;
  /** `AWS_SHARED_CREDENTIALS_FILE`: an empty file until a test writes it. */
  readonly credentialsFile: string;
  /** `AWS_CONFIG_FILE`: an empty file until a test writes it. */
  readonly configFile: string;
  /** A scratch directory for the test's own files (CA bundles, scripts). */
  readonly dir: string;
  writeCredentials(text: string): Promise<void>;
  writeConfig(text: string): Promise<void>;
  /** Sets (string) or removes (undefined) variables until the test ends. */
  set(variables: Readonly<Record<string, string | undefined>>): void;
  /** Writes `text` to a file in `dir` and returns its path. */
  file(name: string, text: string | Buffer, mode?: number): Promise<string>;
}

export async function useAwsEnv(): Promise<AwsEnv> {
  const home = await tempDir();
  const dir = await tempDir();
  const aws = join(home, '.aws');
  await mkdir(aws, { recursive: true });
  const credentialsFile = join(aws, 'credentials');
  const configFile = join(aws, 'config');
  await writeFile(credentialsFile, '');
  await writeFile(configFile, '');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  for (const name of CLEARED) vi.stubEnv(name, undefined);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('AWS_')) vi.stubEnv(name, undefined);
  }
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', credentialsFile);
  vi.stubEnv('AWS_CONFIG_FILE', configFile);
  vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true');

  return {
    home,
    credentialsFile,
    configFile,
    dir,
    async writeCredentials(text) {
      await writeFile(credentialsFile, text);
    },
    async writeConfig(text) {
      await writeFile(configFile, text);
    },
    set(variables) {
      for (const [name, value] of Object.entries(variables)) {
        vi.stubEnv(name, value);
      }
    },
    async file(name, text, mode) {
      const path = join(dir, name);
      await writeFile(path, text, mode === undefined ? {} : { mode });
      return path;
    },
  };
}

/** The environment variables that give one key pair (source 1 of the standard AWS chain). */
export function keyVariables(keys: {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: keys.accessKeyId,
    AWS_SECRET_ACCESS_KEY: keys.secretAccessKey,
    ...(keys.sessionToken === undefined
      ? {}
      : { AWS_SESSION_TOKEN: keys.sessionToken }),
  };
}

/** One profile section of a shared credentials file. */
export function credentialsSection(
  profile: string,
  keys: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  },
): string {
  return [
    `[${profile}]`,
    `aws_access_key_id = ${keys.accessKeyId}`,
    `aws_secret_access_key = ${keys.secretAccessKey}`,
    ...(keys.sessionToken === undefined
      ? []
      : [`aws_session_token = ${keys.sessionToken}`]),
    '',
  ].join('\n');
}
