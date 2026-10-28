/**
 * Attacks on the transport of the credential chain (FEATURE-3 spec "Problem", decision 3, design
 * SE-3): the STS, SSO, SSO-OIDC and sign-in requests of the AWS chain carry a web identity token
 * (from the environment or a profile), a source's session token for `role_arn`, an SSO access
 * token, an SSO refresh token and client secret, or a sign-in refresh token. Every source of the
 * chain that makes a request is a row of the matrix below. An endpoint that is plain HTTP, or
 * TLS with a certificate no trusted authority issued, must never receive one of them, also with
 * `NODE_TLS_REJECT_UNAUTHORIZED=0`, whichever source names the endpoint. A listener that the
 * test authority given in `ca` signs does receive the request: the endpoint source is honoured
 * and the chain trusts the same authorities as the S3 requests.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { onTestFinished, describe, expect, it } from 'vitest';
import { sentinel } from '../support/harness.js';
import { createTestCa, type TestCa } from '../support/test-ca.js';
import { everythingIn, rejection, useS3, type S3Setup } from '../support/s3.js';

/** Options with no `credentials`, so the back-end reads the standard AWS chain. */
const CHAIN = { credentials: undefined } as const;

type Service = 'sts' | 'sso' | 'sso_oidc' | 'signin';
type Listener = 'plain http' | 'untrusted https' | 'trusted https';

interface Recording {
  readonly url: string;
  /** Plain HTTP: the TCP connections; HTTPS: the completed TLS handshakes. */
  readonly connections: () => number;
  /** Each request the listener read, its head and body as text. */
  readonly requests: string[];
}

/** A listener that records what reaches it and answers every request 400 with no body. */
async function listen(kind: Listener, trusted: TestCa): Promise<Recording> {
  const requests: string[] = [];
  let connections = 0;
  const answer = (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(
        `${req.method ?? ''} ${req.url ?? ''}\n${JSON.stringify(req.headers)}\n${Buffer.concat(chunks).toString('utf8')}`,
      );
      res.statusCode = 400;
      res.end();
    });
  };
  let server: Server;
  if (kind === 'plain http') {
    server = createHttpServer(answer);
    server.on('connection', () => {
      connections += 1;
    });
  } else {
    const ca = kind === 'trusted https' ? trusted : createTestCa('untrusted');
    const leaf = ca.issue({ hosts: ['127.0.0.1'] });
    server = createHttpsServer({ cert: leaf.cert, key: leaf.key }, answer);
    server.on('secureConnection', () => {
      connections += 1;
    });
  }
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  const scheme = kind === 'plain http' ? 'http' : 'https';
  return {
    url: `${scheme}://127.0.0.1:${port}`,
    connections: () => connections,
    requests,
  };
}

/** The ways an endpoint for `service` can be named, beside the S3 endpoint the option gives. */
type EndpointSource =
  'service variable' | 'AWS_ENDPOINT_URL' | 'profile services';

const SERVICE_VARIABLE: Record<Service, string> = {
  sts: 'AWS_ENDPOINT_URL_STS',
  sso: 'AWS_ENDPOINT_URL_SSO',
  sso_oidc: 'AWS_ENDPOINT_URL_SSO_OIDC',
  signin: 'AWS_ENDPOINT_URL_SIGNIN',
};

/** Config lines that point the default profile's `service` at `url` (a `services` section). */
function servicesLines(service: Service, url: string): string[] {
  return [
    '[services cyberduck-recap-test]',
    `${service} =`,
    `  endpoint_url = ${url}`,
  ];
}

interface Source {
  /** The service whose request carries the secrets. */
  readonly service: Service;
  /** Writes the files and variables of the source; returns the secrets it holds. */
  prepare(setup: S3Setup, configExtra: string[]): Promise<string[]>;
}

const ROLE_ARN = 'arn:aws:iam::123456789012:role/cyberduck-recap-test';

/** The config file: a default profile of `lines`, pointed at the `services` section if any. */
function defaultProfile(lines: string[], configExtra: string[]): string {
  return [
    '[default]',
    'region = us-east-1',
    ...lines,
    ...(configExtra.length > 0 ? ['services = cyberduck-recap-test'] : []),
    ...configExtra,
    '',
  ].join('\n');
}

const SSO_START_URL = 'https://cyberduck-recap-test.awsapps.com/start';

/**
 * A new SSO session name for each test: the SDK tries a refresh of one session at most once in
 * 30 s per process, so a shared name would let a later test pass without any refresh request.
 */
function ssoSession(): string {
  return `corp-${sentinel().slice(0, 12)}`;
}

async function writeSsoCache(
  setup: S3Setup,
  session: string,
  entry: Record<string, string>,
): Promise<void> {
  const cache = join(setup.env.home, '.aws', 'sso', 'cache');
  await mkdir(cache, { recursive: true });
  // The SDK names the cache file after the SHA-1 of the session name (or the start URL).
  for (const name of [session, SSO_START_URL]) {
    const file = createHash('sha1').update(name).digest('hex');
    await writeFile(join(cache, `${file}.json`), JSON.stringify(entry));
  }
}

function ssoConfig(session: string, configExtra: string[]): string {
  return [
    '[default]',
    `sso_session = ${session}`,
    'sso_account_id = 123456789012',
    'sso_role_name = Reader',
    'region = us-east-1',
    ...(configExtra.length > 0 ? ['services = cyberduck-recap-test'] : []),
    `[sso-session ${session}]`,
    `sso_start_url = ${SSO_START_URL}`,
    'sso_region = us-east-1',
    'sso_registration_scopes = sso:account:access',
    ...configExtra,
    '',
  ].join('\n');
}

const SOURCES: Record<string, Source> = {
  'a web identity token named in a profile (STS)': {
    service: 'sts',
    async prepare(setup, configExtra) {
      const token = sentinel();
      const file = await setup.env.file('profile-web-identity-token', token);
      await setup.env.writeConfig(
        defaultProfile(
          [`web_identity_token_file = ${file}`, `role_arn = ${ROLE_ARN}`],
          configExtra,
        ),
      );
      return [token];
    },
  },
  "a source profile's session token for role_arn (STS)": {
    service: 'sts',
    async prepare(setup, configExtra) {
      const sessionToken = sentinel();
      await setup.env.writeCredentials(
        [
          '[source]',
          'aws_access_key_id = AKIDCYBERDUCKRECAPTEST',
          `aws_secret_access_key = ${sentinel()}`,
          `aws_session_token = ${sessionToken}`,
          '',
        ].join('\n'),
      );
      await setup.env.writeConfig(
        defaultProfile(
          [`role_arn = ${ROLE_ARN}`, 'source_profile = source'],
          configExtra,
        ),
      );
      return [sessionToken];
    },
  },
  "the environment's session token for role_arn with credential_source (STS)": {
    service: 'sts',
    async prepare(setup, configExtra) {
      const sessionToken = sentinel();
      // AWS_PROFILE makes the chain skip its environment source and read the profile.
      setup.env.set({
        AWS_PROFILE: 'default',
        AWS_ACCESS_KEY_ID: 'AKIDCYBERDUCKRECAPTEST',
        AWS_SECRET_ACCESS_KEY: sentinel(),
        AWS_SESSION_TOKEN: sessionToken,
      });
      await setup.env.writeConfig(
        defaultProfile(
          [`role_arn = ${ROLE_ARN}`, 'credential_source = Environment'],
          configExtra,
        ),
      );
      return [sessionToken];
    },
  },
  "an expired sign-in session's refresh token (sign-in)": {
    service: 'signin',
    async prepare(setup, configExtra) {
      const refreshToken = sentinel();
      const session = `arn:aws:iam::123456789012:user/${sentinel().slice(0, 12)}`;
      const cache = join(setup.env.dir, 'login-cache');
      await mkdir(cache, { recursive: true });
      setup.env.set({ AWS_LOGIN_CACHE_DIRECTORY: cache });
      const dpopKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        .privateKey.export({ type: 'sec1', format: 'pem' })
        .toString();
      // The SDK names the cache file after the SHA-256 of the session name.
      const file = createHash('sha256').update(session).digest('hex');
      await writeFile(
        join(cache, `${file}.json`),
        JSON.stringify({
          accessToken: {
            accessKeyId: 'AKIDCYBERDUCKRECAPTEST',
            secretAccessKey: sentinel(),
            sessionToken: sentinel(),
            accountId: '123456789012',
            expiresAt: '2020-01-01T00:00:00Z',
          },
          clientId: 'arn:aws:signin:::devtools/same-device',
          refreshToken,
          dpopKey,
        }),
      );
      await setup.env.writeConfig(
        defaultProfile([`login_session = ${session}`], configExtra),
      );
      // The access token has expired: only the refresh request carries a secret.
      return [refreshToken];
    },
  },
  'a web identity token (STS)': {
    service: 'sts',
    async prepare(setup, configExtra) {
      const token = sentinel();
      const file = await setup.env.file('web-identity-token', token);
      setup.env.set({
        AWS_WEB_IDENTITY_TOKEN_FILE: file,
        AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/cyberduck-recap-test',
        AWS_REGION: 'us-east-1',
      });
      if (configExtra.length > 0) {
        await setup.env.writeConfig(
          [
            '[default]',
            'region = us-east-1',
            'services = cyberduck-recap-test',
            ...configExtra,
            '',
          ].join('\n'),
        );
      }
      return [token];
    },
  },
  'a valid SSO access token (SSO)': {
    service: 'sso',
    async prepare(setup, configExtra) {
      const accessToken = sentinel();
      const session = ssoSession();
      await setup.env.writeConfig(ssoConfig(session, configExtra));
      await writeSsoCache(setup, session, {
        accessToken,
        expiresAt: '2999-01-01T00:00:00Z',
        region: 'us-east-1',
        startUrl: SSO_START_URL,
      });
      return [accessToken];
    },
  },
  'an SSO refresh token and client secret (SSO-OIDC)': {
    service: 'sso_oidc',
    async prepare(setup, configExtra) {
      const secrets = {
        accessToken: sentinel(),
        refreshToken: sentinel(),
        clientSecret: sentinel(),
      };
      const session = ssoSession();
      await setup.env.writeConfig(ssoConfig(session, configExtra));
      await writeSsoCache(setup, session, {
        ...secrets,
        clientId: 'cyberduck-recap-test-client',
        expiresAt: '2020-01-01T00:00:00Z',
        registrationExpiresAt: '2999-01-01T00:00:00Z',
        region: 'us-east-1',
        startUrl: SSO_START_URL,
      });
      // The access token has expired: only the refresh request carries secrets.
      return [secrets.refreshToken, secrets.clientSecret];
    },
  },
};

async function attempt(
  sourceName: string,
  endpointSource: EndpointSource,
  listenerKind: Listener,
  rejectOff: boolean,
): Promise<{ listener: Recording; secrets: string[]; error: unknown }> {
  const source = SOURCES[sourceName];
  if (source === undefined) throw new Error(`no source ${sourceName}`);
  const setup = await useS3();
  const listener = await listen(listenerKind, setup.server.ca);
  const configExtra =
    endpointSource === 'profile services'
      ? servicesLines(source.service, listener.url)
      : [];
  const secrets = await source.prepare(setup, configExtra);
  if (endpointSource === 'service variable') {
    setup.env.set({ [SERVICE_VARIABLE[source.service]]: listener.url });
  } else if (endpointSource === 'AWS_ENDPOINT_URL') {
    setup.env.set({ AWS_ENDPOINT_URL: listener.url });
  }
  if (rejectOff) setup.env.set({ NODE_TLS_REJECT_UNAUTHORIZED: '0' });
  // `ca` trusts the test authority that signs the trusted listener, never the untrusted one.
  const fs = await setup.s3({ ...CHAIN, timeoutMs: 5000 });
  const error = await rejection(fs.connect(), 'AUTH_FAILED');
  expect(setup.server.requests).toEqual([]);
  return { listener, secrets, error };
}

const ENDPOINT_SOURCES: readonly EndpointSource[] = [
  'service variable',
  'AWS_ENDPOINT_URL',
  'profile services',
];

describe('The credential chain sends no secret on an unverified connection', () => {
  for (const sourceName of Object.keys(SOURCES)) {
    for (const endpointSource of ENDPOINT_SOURCES) {
      it(`a trusted https endpoint from ${endpointSource} receives ${sourceName}: the path under test is live`, async () => {
        const { listener, secrets } = await attempt(
          sourceName,
          endpointSource,
          'trusted https',
          false,
        );
        expect(listener.requests.length).toBeGreaterThan(0);
        const seen = listener.requests.join('\n');
        expect(secrets.some((secret) => seen.includes(secret))).toBe(true);
      }, 15_000);

      for (const rejectOff of [false, true]) {
        const suffix = rejectOff
          ? ', also with NODE_TLS_REJECT_UNAUTHORIZED=0'
          : '';

        it(`a plain http endpoint from ${endpointSource} receives no connection for ${sourceName}${suffix}`, async () => {
          const { listener, secrets, error } = await attempt(
            sourceName,
            endpointSource,
            'plain http',
            rejectOff,
          );
          expect(listener.connections()).toBe(0);
          expect(listener.requests).toEqual([]);
          const carried = everythingIn(error);
          for (const secret of secrets) expect(carried).not.toContain(secret);
        }, 15_000);

        it(`an untrusted https endpoint from ${endpointSource} receives no request for ${sourceName}${suffix}`, async () => {
          const { listener, secrets, error } = await attempt(
            sourceName,
            endpointSource,
            'untrusted https',
            rejectOff,
          );
          expect(listener.connections()).toBe(0);
          expect(listener.requests).toEqual([]);
          const carried = everythingIn(error);
          for (const secret of secrets) expect(carried).not.toContain(secret);
        }, 15_000);
      }
    }
  }
});
