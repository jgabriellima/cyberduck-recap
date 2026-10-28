/**
 * No path, variable or profile setting sends a signed request to an access point or a host
 * outside S3's (design SE-6). A bucket that starts with `arn:` never reaches the client
 * (validation.test.ts); below it, the client itself keeps `useArnRegion: false` and
 * `disableMultiregionAccessPoints: true` whatever the environment and the profile say, so an
 * ARN that reached it would still not leave the process. The access point case fails when
 * `useArnRegion` turns true. The multi-region case has a second barrier: the project installs no
 * SigV4a signer, so the SDK refuses it also with the setting off; the test pins the outcome.
 */
import { describe, expect, it } from 'vitest';
import { createTransport } from '../../src/s3/sdk.js';
import { createAgent } from '../../src/s3/tls.js';
import { S3TransportError } from '../../src/s3/transport.js';
import { useAwsEnv } from '../support/aws-env.js';
import { recordingLookup } from '../support/s3.js';

const KEYS = {
  accessKeyId: 'AKIATESTSETTINGS',
  secretAccessKey: 'settings-test-secret',
};

const ARNS = {
  'an access point in another region':
    'arn:aws:s3:us-west-2:123456789012:accesspoint/cyberduck-recap-test',
  'a multi-region access point':
    'arn:aws:s3::123456789012:accesspoint/mfzwi23gnjvgw.mrap',
} as const;

describe('the S3 client never follows an ARN (SE-6)', () => {
  for (const [name, arn] of Object.entries(ARNS)) {
    it(`${name} is refused before any host is looked up, whatever the environment and profile ask`, async () => {
      const env = await useAwsEnv();
      env.set({
        AWS_S3_USE_ARN_REGION: 'true',
        AWS_S3_DISABLE_MULTIREGION_ACCESS_POINTS: 'false',
      });
      await env.writeConfig(
        [
          '[default]',
          's3_use_arn_region = true',
          's3_disable_multiregion_access_points = false',
          '',
        ].join('\n'),
      );
      const { lookup, names } = recordingLookup();
      const transport = createTransport({
        region: 'us-east-1',
        endpoint: undefined,
        agent: createAgent(undefined, lookup),
        timeoutMs: 2000,
        credentials: () => Promise.resolve(KEYS),
      });
      try {
        const error = await transport
          .headObject(arn, 'k', new AbortController().signal)
          .then(
            () => undefined,
            (caught: unknown) => caught,
          );
        expect(error).toBeInstanceOf(S3TransportError);
        expect(names).toEqual([]);
      } finally {
        transport.destroy();
      }
    });
  }
});
