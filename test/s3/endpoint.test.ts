/**
 * Endpoints (FEATURE-3 AC-27, AC-28): an `http:` endpoint is refused from every source, the
 * configured endpoints apply in their order with path-style requests, and without a custom
 * endpoint every request goes over HTTPS to AWS's S3 host for the region, virtual-hosted style.
 */
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { startS3Server, type S3ServerFixture } from '../support/s3-server.js';
import {
  interceptAwsConnections,
  rejection,
  useS3,
  type S3Setup,
} from '../support/s3.js';

/** A plain TCP server that only counts the connections it receives. */
async function recordingPlainServer(): Promise<{
  readonly url: string;
  connections(): number;
}> {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, connections: () => connections };
}

/** Another fake server with the same authority and keys as the setup's. */
async function sibling(setup: S3Setup): Promise<S3ServerFixture> {
  const server = await startS3Server({
    ca: setup.server.ca,
    credentials: [setup.server.keys],
  });
  onTestFinished(() => server.close());
  server.addBucket('b');
  return server;
}

/** Options that leave the endpoint to the configured sources. */
const NO_ENDPOINT = { endpoint: undefined } as const;

describe('S3 http: endpoints are refused (AC-27)', () => {
  it.each([
    ['AWS_ENDPOINT_URL_S3', /AWS_ENDPOINT_URL_S3/],
    ['AWS_ENDPOINT_URL', /AWS_ENDPOINT_URL(?!_S3)/],
  ] as const)(
    'AC-27: %s set to http: fails INVALID_ARGUMENT naming it, with no connection',
    async (variable, named) => {
      const setup = await useS3();
      const plain = await recordingPlainServer();
      setup.env.set({ [variable]: plain.url });
      const fs = await setup.s3(NO_ENDPOINT);

      const error = await rejection(fs.connect(), 'INVALID_ARGUMENT');

      expect(error.message).toMatch(named);
      expect(plain.connections()).toBe(0);
      expect(setup.server.requests).toEqual([]);
    },
  );

  it("AC-27: the selected profile's endpoint_url set to http: fails naming the profile setting", async () => {
    const setup = await useS3();
    const plain = await recordingPlainServer();
    await setup.env.writeConfig(`[default]\nendpoint_url = ${plain.url}\n`);
    const fs = await setup.s3(NO_ENDPOINT);

    const error = await rejection(fs.connect(), 'INVALID_ARGUMENT');

    expect(error.message).toContain('endpoint_url');
    expect(error.message).toContain('default');
    expect(plain.connections()).toBe(0);
    expect(setup.server.requests).toEqual([]);
  });
});

describe('S3 configured endpoints (AC-27)', () => {
  /** Servers for the S3 variable, the generic variable, the profile and the option. */
  async function fourEndpoints(): Promise<{
    setup: S3Setup;
    s3Var: S3ServerFixture;
    generic: S3ServerFixture;
    profile: S3ServerFixture;
    option: S3ServerFixture;
  }> {
    const setup = await useS3();
    return {
      setup,
      s3Var: setup.server,
      generic: await sibling(setup),
      profile: await sibling(setup),
      option: await sibling(setup),
    };
  }

  /** Runs connect() and stat of an object; returns nothing, the servers record. */
  async function use(
    setup: S3Setup,
    overrides: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const fs = await setup.connected(overrides);
    await rejection(fs.stat('/b/nothing'), 'NOT_FOUND', '/b/nothing');
  }

  function only(used: S3ServerFixture, all: readonly S3ServerFixture[]): void {
    for (const server of all) {
      if (server === used) {
        expect(server.requests.length).toBeGreaterThanOrEqual(2);
      } else {
        expect(server.requests).toEqual([]);
      }
    }
    // Path-style on a custom endpoint: the host is the endpoint's, the bucket is in the path.
    for (const request of used.requests) {
      expect(request.style).toBe('path');
      expect(request.host).toBe('127.0.0.1');
    }
    const object = used.requests.filter((r) => r.key === 'nothing');
    expect(object.length).toBeGreaterThanOrEqual(1);
    for (const request of object) expect(request.rawPath).toBe('/b/nothing');
  }

  it('AC-27: AWS_ENDPOINT_URL_S3 comes before AWS_ENDPOINT_URL and the profile', async () => {
    const { setup, s3Var, generic, profile, option } = await fourEndpoints();
    setup.env.set({
      AWS_ENDPOINT_URL_S3: s3Var.endpoint,
      AWS_ENDPOINT_URL: generic.endpoint,
    });
    await setup.env.writeConfig(
      `[default]\nendpoint_url = ${profile.endpoint}\n`,
    );
    await use(setup, NO_ENDPOINT);
    only(s3Var, [s3Var, generic, profile, option]);
  });

  it('AC-27: AWS_ENDPOINT_URL comes before the profile', async () => {
    const { setup, s3Var, generic, profile, option } = await fourEndpoints();
    setup.env.set({ AWS_ENDPOINT_URL: generic.endpoint });
    await setup.env.writeConfig(
      `[default]\nendpoint_url = ${profile.endpoint}\n`,
    );
    await use(setup, NO_ENDPOINT);
    only(generic, [s3Var, generic, profile, option]);
  });

  it("AC-27: the selected profile's https: endpoint_url is used", async () => {
    const { setup, s3Var, generic, profile, option } = await fourEndpoints();
    await setup.env.writeConfig(
      `[profile p]\nendpoint_url = ${profile.endpoint}\n`,
    );
    setup.env.set({ AWS_PROFILE: 'p' });
    await use(setup, NO_ENDPOINT);
    only(profile, [s3Var, generic, profile, option]);
  });

  it('AC-27: the option endpoint comes before all three', async () => {
    const { setup, s3Var, generic, profile, option } = await fourEndpoints();
    setup.env.set({
      AWS_ENDPOINT_URL_S3: s3Var.endpoint,
      AWS_ENDPOINT_URL: generic.endpoint,
    });
    await setup.env.writeConfig(
      `[default]\nendpoint_url = ${profile.endpoint}\n`,
    );
    await use(setup, { endpoint: option.endpoint });
    only(option, [s3Var, generic, profile, option]);
  });
});

describe("S3 on AWS's own endpoint (AC-28)", () => {
  it("AC-28: every request goes over HTTPS to AWS's S3 host for the region, virtual-hosted", async () => {
    const setup = await useS3();
    const intercepted = interceptAwsConnections(setup.server);
    setup.server.putObject('b', 'a.txt', 'hello');
    const fs = await setup.connected({
      ...NO_ENDPOINT,
      region: 'eu-west-1',
    });

    await fs.list('/b');
    await fs.stat('/b/a.txt');
    await rejection(fs.stat('/b/nothing'), 'NOT_FOUND', '/b/nothing');

    // Every connection is TLS (the interceptor sees only tls.connect) to an S3 host of the region.
    expect(intercepted.connections.length).toBeGreaterThanOrEqual(1);
    for (const connection of intercepted.connections) {
      expect(connection.host).toMatch(
        /^(?:[a-z0-9.-]+\.)?s3\.eu-west-1\.amazonaws\.com$/,
      );
      expect(connection.port).toBe(443);
    }
    expect(intercepted.plain).toEqual([]);

    const requests = setup.server.requests;
    expect(requests.length).toBeGreaterThanOrEqual(4);
    for (const request of requests) {
      if (request.operation === 'ListBuckets') {
        expect(request.host).toBe('s3.eu-west-1.amazonaws.com');
      } else {
        expect(request.bucket).toBe('b');
        expect(request.style).toBe('virtual-hosted');
        expect(request.host).toBe('b.s3.eu-west-1.amazonaws.com');
        expect(request.rawPath.startsWith('/b/')).toBe(false);
      }
      expect(request.region).toBe('eu-west-1');
      expect(request.signatureValid).toBe(true);
    }
  });
});
