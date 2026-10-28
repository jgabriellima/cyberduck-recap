/**
 * ATK-92 (credential chain tls): the chain's STS requests that a *profile* starts carry secrets
 * too. A `web_identity_token_file` in the config file sends its token to STS; a `role_arn` with a
 * `source_profile` sends the source profile's session token to STS. The spec's Problem section
 * and decision 3 say no credential travels on a connection whose certificate is not verified,
 * and NODE_TLS_REJECT_UNAUTHORIZED=0 has no effect. So a plain HTTP STS endpoint must receive no
 * connection, whichever source of the chain makes the request.
 *
 * ATK-95 (credential chain tls): the same property when the chain recurses through
 * `source_profile` (role chaining), where the SDK resolves the source profile with the options
 * it passes down, not with the ones the caller gave the outer profile.
 */
import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { onTestFinished, describe, expect, it } from 'vitest';
import { sentinel } from '../support/harness.js';
import { everythingIn, rejection, useS3, type S3Setup } from '../support/s3.js';

interface Plain {
  readonly url: string;
  readonly connections: () => number;
  readonly requests: string[];
}

/** A plain HTTP listener that records every connection and request, and answers 400. */
async function plainListener(): Promise<Plain> {
  const requests: string[] = [];
  let connections = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(
        `${req.method ?? ''} ${req.url ?? ''}\n${JSON.stringify(req.headers)}\n${Buffer.concat(chunks).toString('utf8')}`,
      );
      res.statusCode = 400;
      res.end();
    });
  });
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    connections += 1;
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
  return {
    url: `http://127.0.0.1:${port}`,
    connections: () => connections,
    requests,
  };
}

interface ProfileSource {
  /** Writes the profile files; returns the secrets the STS request would carry. */
  prepare(setup: S3Setup): Promise<string[]>;
}

const ROLE = 'arn:aws:iam::123456789012:role/cyberduck-recap-test';

const SOURCES: Record<string, ProfileSource> = {
  'web_identity_token_file in a profile': {
    async prepare(setup) {
      const token = sentinel();
      const file = await setup.env.file('profile-web-identity-token', token);
      await setup.env.writeConfig(
        [
          '[default]',
          'region = us-east-1',
          `web_identity_token_file = ${file}`,
          `role_arn = ${ROLE}`,
          '',
        ].join('\n'),
      );
      return [token];
    },
  },
  'role_arn with a source_profile': {
    async prepare(setup) {
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
        [
          '[default]',
          'region = us-east-1',
          `role_arn = ${ROLE}`,
          'source_profile = source',
          '',
        ].join('\n'),
      );
      return [sessionToken];
    },
  },
  // ATK-95: the chain recurses into the source profile; each level must keep the checked client.
  'role_arn whose source_profile names a web identity token (role chaining)': {
    async prepare(setup) {
      const token = sentinel();
      const file = await setup.env.file('chained-web-identity-token', token);
      await setup.env.writeConfig(
        [
          '[default]',
          'region = us-east-1',
          `role_arn = ${ROLE}`,
          'source_profile = identity',
          '[profile identity]',
          'region = us-east-1',
          `web_identity_token_file = ${file}`,
          `role_arn = ${ROLE}-source`,
          '',
        ].join('\n'),
      );
      return [token];
    },
  },
  'role_arn whose source_profile is itself a role with a source_profile (two hops)':
    {
      async prepare(setup) {
        const sessionToken = sentinel();
        await setup.env.writeCredentials(
          [
            '[base]',
            'aws_access_key_id = AKIDCYBERDUCKRECAPTEST',
            `aws_secret_access_key = ${sentinel()}`,
            `aws_session_token = ${sessionToken}`,
            '',
          ].join('\n'),
        );
        await setup.env.writeConfig(
          [
            '[default]',
            'region = us-east-1',
            `role_arn = ${ROLE}`,
            'source_profile = middle',
            '[profile middle]',
            'region = us-east-1',
            `role_arn = ${ROLE}-middle`,
            'source_profile = base',
            '',
          ].join('\n'),
        );
        return [sessionToken];
      },
    },
};

describe('A profile source of the credential chain sends no secret to a plain HTTP STS endpoint', () => {
  for (const [name, source] of Object.entries(SOURCES)) {
    for (const rejectOff of [false, true]) {
      const suffix = rejectOff
        ? ', also with NODE_TLS_REJECT_UNAUTHORIZED=0'
        : '';
      it(`${name}: AWS_ENDPOINT_URL_STS on plain http receives no connection${suffix}`, async () => {
        const setup = await useS3();
        const listener = await plainListener();
        const secrets = await source.prepare(setup);
        setup.env.set({ AWS_ENDPOINT_URL_STS: listener.url });
        if (rejectOff) setup.env.set({ NODE_TLS_REJECT_UNAUTHORIZED: '0' });
        const fs = await setup.s3({ credentials: undefined, timeoutMs: 5000 });
        const error = await rejection(fs.connect(), 'AUTH_FAILED');
        const seen = listener.requests.join('\n');
        for (const secret of secrets) expect(seen).not.toContain(secret);
        expect(listener.requests).toEqual([]);
        expect(listener.connections()).toBe(0);
        const carried = everythingIn(error);
        for (const secret of secrets) expect(carried).not.toContain(secret);
        expect(setup.server.requests).toEqual([]);
      }, 15_000);
    }
  }
});
