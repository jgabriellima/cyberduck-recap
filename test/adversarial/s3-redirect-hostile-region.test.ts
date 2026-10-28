/**
 * Adversarial (FEATURE-3, ATK-80): a region redirect whose `x-amz-bucket-region` is hostile. On
 * AWS's endpoint the region becomes part of a host name (AC-52), so a value such as `evil.com#`
 * or `eu-west-1.attacker.net` would send the signed request, and its session token, to another
 * host. A region must match `^[a-z0-9-]+$` (the spec's rule for the option `region`): any other
 * value is a reply not valid for its request, `OPERATION_FAILED` with `path`, and the request is
 * not sent again, neither to a new host nor signed for that region on a custom endpoint.
 */
import { describe, expect, it } from 'vitest';
import { s3Error, type FaultRule } from '../support/s3-server.js';
import {
  hasRawEscapedCodePoint,
  interceptAwsConnections,
  rejection,
  useS3,
} from '../support/s3.js';

const HOSTILE_REGIONS = [
  'evil.com#',
  'eu-west-1.attacker.net',
  '127.0.0.1',
  'EU-WEST-1',
  'eu west 1',
  'eu-west-1/../x',
  '',
];

/** Answers every request for bucket `far` with a redirect to `region`. */
function redirectTo(region: string): FaultRule {
  return (request) =>
    request.bucket === 'far'
      ? s3Error('PermanentRedirect', 'The bucket is in another region.', {
          headers: { 'x-amz-bucket-region': region },
        })
      : undefined;
}

describe("ATK-80: a hostile redirect region on AWS's endpoint reaches no other host", () => {
  it.each(HOSTILE_REGIONS)(
    'x-amz-bucket-region %j gives OPERATION_FAILED and one request',
    async (region) => {
      const setup = await useS3({}, { buckets: ['b', 'far'] });
      const intercepted = interceptAwsConnections(setup.server);
      const fs = await setup.connected({ endpoint: undefined });
      setup.server.clearRequests();
      setup.server.fault(redirectTo(region));

      const error = await rejection(
        fs.list('/far'),
        'OPERATION_FAILED',
        '/far',
      );

      expect(hasRawEscapedCodePoint(error.message)).toBe(false);
      expect(
        setup.server.requests.filter((r) => r.bucket === 'far'),
      ).toHaveLength(1);
      // Every connection went to AWS's S3 host of the configured region, over TLS.
      for (const connection of intercepted.connections) {
        expect(connection.host).toMatch(
          /^(?:far\.|b\.)?s3\.us-east-1\.amazonaws\.com$/,
        );
      }
      expect(intercepted.plain).toEqual([]);
    },
    15_000,
  );
});

describe('ATK-80: a hostile redirect region on a custom endpoint is not signed for', () => {
  it.each(HOSTILE_REGIONS)(
    'x-amz-bucket-region %j gives OPERATION_FAILED and no second request',
    async (region) => {
      const setup = await useS3({}, { buckets: ['b', 'far'] });
      const fs = await setup.connected();
      setup.server.clearRequests();
      setup.server.fault(redirectTo(region));

      await rejection(fs.list('/far'), 'OPERATION_FAILED', '/far');

      const far = setup.server.requests.filter((r) => r.bucket === 'far');
      expect(far.map((r) => r.region)).toEqual(['us-east-1']);
    },
    15_000,
  );
});
