/**
 * Regions (FEATURE-3 AC-29, AC-52): the credential scope's region comes from the option, then
 * `AWS_REGION`, then the selected profile, then `us-east-1`; a region redirect is followed once,
 * to a host derived from the region, never to a host the reply names.
 */
import { describe, expect, it } from 'vitest';
import {
  s3Error,
  type Fault,
  type RecordedRequest,
} from '../support/s3-server.js';
import { interceptAwsConnections, rejection, useS3 } from '../support/s3.js';

const THIRD_HOST = 'third.s3.eu-central-1.amazonaws.com';

/** A 301 PermanentRedirect that also names a third host in `Endpoint` and `Location`. */
function redirect(region: string): Fault {
  return s3Error('PermanentRedirect', 'The bucket is in another region.', {
    headers: {
      'x-amz-bucket-region': region,
      location: `https://${THIRD_HOST}/far`,
    },
    extraXml: `<Endpoint>${THIRD_HOST}</Endpoint>`,
  });
}

/** Answers the first requests for bucket `far` with the given faults, in order. */
function redirectsFor(
  ...faults: Fault[]
): (r: RecordedRequest) => Fault | undefined {
  let seen = 0;
  return (request) => {
    if (request.bucket !== 'far') return undefined;
    const fault = faults[seen];
    seen += 1;
    return fault;
  };
}

describe('S3 region of the signature (AC-29)', () => {
  async function regionsWith(
    overrides: Readonly<Record<string, unknown>>,
    variables: Readonly<Record<string, string>>,
    config: string,
  ): Promise<(string | undefined)[]> {
    const setup = await useS3();
    setup.env.set(variables);
    await setup.env.writeConfig(config);
    const fs = await setup.connected({ region: undefined, ...overrides });
    await fs.list('/b');
    expect(setup.server.requests.length).toBeGreaterThanOrEqual(2);
    return setup.server.requests.map((request) => request.region);
  }

  const PROFILES =
    '[default]\nregion = eu-central-1\n[profile other]\nregion = ap-south-1\n';

  it('AC-29: AWS_REGION comes before the profile region', async () => {
    const regions = await regionsWith(
      {},
      { AWS_REGION: 'eu-west-1' },
      PROFILES,
    );
    expect(new Set(regions)).toEqual(new Set(['eu-west-1']));
  });

  it("AC-29: the default profile's region applies when no profile is selected", async () => {
    const regions = await regionsWith({}, {}, PROFILES);
    expect(new Set(regions)).toEqual(new Set(['eu-central-1']));
  });

  it("AC-29: the selected profile's region applies", async () => {
    const regions = await regionsWith({}, { AWS_PROFILE: 'other' }, PROFILES);
    expect(new Set(regions)).toEqual(new Set(['ap-south-1']));
  });

  it('AC-29: us-east-1 applies when no source gives a region', async () => {
    const regions = await regionsWith({}, {}, '');
    expect(new Set(regions)).toEqual(new Set(['us-east-1']));
  });

  it('AC-29: the option region comes before all sources', async () => {
    const regions = await regionsWith(
      { region: 'us-west-2' },
      { AWS_REGION: 'eu-west-1', AWS_PROFILE: 'other' },
      PROFILES,
    );
    expect(new Set(regions)).toEqual(new Set(['us-west-2']));
  });
});

describe('S3 region redirect on a custom endpoint (AC-29)', () => {
  it('AC-29: a redirect is followed once, signed for the new region, to the same host', async () => {
    const setup = await useS3({}, { buckets: ['b', 'far'] });
    const intercepted = interceptAwsConnections(setup.server);
    setup.server.putObject('far', 'x', 'data');
    const fs = await setup.connected();
    setup.server.clearRequests();
    setup.server.fault(redirectsFor(redirect('eu-west-1')));

    const entries = await fs.list('/far');

    expect(entries.map((entry) => entry.name)).toEqual(['x']);
    const far = setup.server.requests.filter((r) => r.bucket === 'far');
    expect(far).toHaveLength(2);
    expect(far[0]?.region).toBe('us-east-1');
    expect(far[1]?.region).toBe('eu-west-1');
    expect(far[1]?.signatureValid).toBe(true);
    for (const request of far) expect(request.host).toBe('127.0.0.1');
    expect(
      intercepted.connections.filter((c) => c.host === THIRD_HOST),
    ).toEqual([]);
  });

  it('AC-29: a second redirect fails OPERATION_FAILED with exactly 2 requests', async () => {
    const setup = await useS3({}, { buckets: ['b', 'far'] });
    const intercepted = interceptAwsConnections(setup.server);
    const fs = await setup.connected();
    setup.server.clearRequests();
    setup.server.fault(
      redirectsFor(redirect('eu-west-1'), redirect('ap-south-1')),
    );

    const error = await rejection(fs.list('/far'), 'OPERATION_FAILED', '/far');

    expect(error.message).toContain('PermanentRedirect');
    expect(error.message).toContain('ap-south-1');
    expect(
      setup.server.requests.filter((r) => r.bucket === 'far'),
    ).toHaveLength(2);
    expect(
      intercepted.connections.filter((c) => c.host === THIRD_HOST),
    ).toEqual([]);
  });

  it('AC-29: the redirect is not one of the 3 attempts of the standard retry', async () => {
    const setup = await useS3({}, { buckets: ['b', 'far'] });
    setup.server.putObject('far', 'x', 'data');
    const fs = await setup.connected();
    setup.server.clearRequests();
    // After the redirect, the request sent again keeps its own 3 attempts: 2 failures, 1 success.
    setup.server.fault(
      redirectsFor(
        redirect('eu-west-1'),
        s3Error('InternalError'),
        s3Error('InternalError'),
      ),
    );

    const entries = await fs.list('/far');

    expect(entries.map((entry) => entry.name)).toEqual(['x']);
    const far = setup.server.requests.filter((r) => r.bucket === 'far');
    expect(far).toHaveLength(4);
    expect(far.slice(1).map((r) => r.region)).toEqual([
      'eu-west-1',
      'eu-west-1',
      'eu-west-1',
    ]);
  });
});

describe("S3 region redirect on AWS's endpoint (AC-52)", () => {
  async function awsSetup(): Promise<{
    setup: Awaited<ReturnType<typeof useS3>>;
    intercepted: ReturnType<typeof interceptAwsConnections>;
  }> {
    const setup = await useS3({}, { buckets: ['b', 'far'] });
    // AWS_DEFAULT_REGION is an AWS CLI variable: the back-end must not read it.
    setup.env.set({ AWS_DEFAULT_REGION: 'eu-west-1' });
    const intercepted = interceptAwsConnections(setup.server);
    return { setup, intercepted };
  }

  it('AC-52: the request is sent again once to the S3 host of the new region', async () => {
    const { setup, intercepted } = await awsSetup();
    setup.server.putObject('far', 'x', 'data');
    const fs = await setup.connected({
      endpoint: undefined,
      region: undefined,
    });
    setup.server.clearRequests();
    setup.server.fault(redirectsFor(redirect('eu-west-1')));

    const entries = await fs.list('/far');

    expect(entries.map((entry) => entry.name)).toEqual(['x']);
    const far = setup.server.requests.filter((r) => r.bucket === 'far');
    expect(far.map((r) => [r.host, r.region])).toEqual([
      ['far.s3.us-east-1.amazonaws.com', 'us-east-1'],
      ['far.s3.eu-west-1.amazonaws.com', 'eu-west-1'],
    ]);
    expect(far[1]?.signatureValid).toBe(true);
    const hosts = intercepted.connections.map((c) => c.host);
    expect(hosts).toContain('far.s3.eu-west-1.amazonaws.com');
    expect(hosts).not.toContain(THIRD_HOST);
    for (const connection of intercepted.connections) {
      expect(connection.port).toBe(443);
    }
    expect(intercepted.plain).toEqual([]);
  });

  it('AC-52: a second redirect fails OPERATION_FAILED and never reaches its region', async () => {
    const { setup, intercepted } = await awsSetup();
    const fs = await setup.connected({
      endpoint: undefined,
      region: undefined,
    });
    setup.server.clearRequests();
    setup.server.fault(
      redirectsFor(redirect('eu-west-1'), redirect('ap-south-1')),
    );

    const error = await rejection(fs.list('/far'), 'OPERATION_FAILED', '/far');

    expect(error.message).toContain('PermanentRedirect');
    expect(error.message).toContain('ap-south-1');
    expect(
      setup.server.requests.filter((r) => r.bucket === 'far'),
    ).toHaveLength(2);
    const hosts = intercepted.connections.map((c) => c.host);
    expect(hosts).not.toContain('far.s3.ap-south-1.amazonaws.com');
    expect(hosts).not.toContain(THIRD_HOST);
  });
});
