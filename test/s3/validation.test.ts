/**
 * One table of good and bad values runs through each rule of src/s3/validation.ts and through
 * every caller of it (design Decision 12, MA-10): each caller accepts and refuses the same values.
 */
import { describe, expect, it } from 'vitest';
import { RemoteFsError } from '../../src/fs/index.js';
import { s3Backend } from '../../src/s3/backend.js';
import { validateS3Options } from '../../src/s3/options.js';
import { PathProblem, readPath } from '../../src/s3/paths.js';
import { redirectRegion } from '../../src/s3/request-policy.js';
import { resolveSettings } from '../../src/s3/settings.js';
import type { LoadedProfiles } from '../../src/s3/transport.js';
import {
  bucketProblem,
  endpointProblem,
  isRegion,
  isUploadId,
  isVirtualHostable,
} from '../../src/s3/validation.js';

const NO_PROFILES: LoadedProfiles = { credentials: {}, config: {} };
const BASE = validateS3Options({});

function accepts(run: () => unknown): boolean {
  try {
    run();
    return true;
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteFsError);
    expect((error as RemoteFsError).code).toBe('INVALID_ARGUMENT');
    return false;
  }
}

const REGIONS: readonly (readonly [string, boolean])[] = [
  ['us-east-1', true],
  ['eu-west-1', true],
  ['a', true],
  ['x'.repeat(63), true],
  ['', false],
  ['EU-WEST-1', false],
  ['eu west 1', false],
  ['evil.com#', false],
  ['eu-west-1.attacker.net', false],
  ['x'.repeat(64), false],
];

describe('the region rule has one source', () => {
  it.each(REGIONS)('%j: %s through every caller', (region, good) => {
    expect(isRegion(region)).toBe(good);
    // `''` is no value for a source: an empty variable or setting is unset, not refused.
    if (region !== '') {
      expect(accepts(() => validateS3Options({ region }))).toBe(good);
      expect(
        accepts(() =>
          resolveSettings(BASE, { AWS_REGION: region }, NO_PROFILES),
        ),
      ).toBe(good);
      expect(
        accepts(() =>
          resolveSettings(
            BASE,
            {},
            { credentials: {}, config: { default: { region } } },
          ),
        ),
      ).toBe(good);
    }
    const redirect = redirectRegion({
      kind: 'reply',
      status: 301,
      code: 'PermanentRedirect',
      serverMessage: undefined,
      bucketRegion: region,
    });
    expect(redirect).toBe(good ? region : undefined);
  });
});

const ENDPOINTS: readonly (readonly [string, boolean])[] = [
  ['https://s3.example.com', true],
  ['https://127.0.0.1:9000', true],
  ['https://s3.example.com/', true],
  ['http://s3.example.com', false],
  ['https://user:secret@s3.example.com', false],
  ['https://s3.example.com/path', false],
  ['https://s3.example.com/?q', false],
  ['https://s3.example.com/#f', false],
  ['not a url', false],
];

describe('the endpoint rule has one source', () => {
  it.each(ENDPOINTS)('%j: %s through every caller', (endpoint, good) => {
    expect(endpointProblem(endpoint) === undefined).toBe(good);
    expect(accepts(() => validateS3Options({ endpoint }))).toBe(good);
    for (const variable of ['AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL']) {
      expect(
        accepts(() =>
          resolveSettings(BASE, { [variable]: endpoint }, NO_PROFILES),
        ),
      ).toBe(good);
    }
    expect(
      accepts(() =>
        resolveSettings(
          BASE,
          {},
          { credentials: {}, config: { default: { endpoint_url: endpoint } } },
        ),
      ),
    ).toBe(good);
  });

  it('a refused endpoint is named by its source and its value is never echoed', () => {
    const secret = 'S3CR3T-in-the-url';
    let message = '';
    try {
      resolveSettings(
        BASE,
        { AWS_ENDPOINT_URL: `https://key:${secret}@host` },
        NO_PROFILES,
      );
    } catch (error) {
      message = (error as RemoteFsError).message;
    }
    expect(message).toContain('AWS_ENDPOINT_URL');
    expect(message).not.toContain(secret);
  });
});

const BUCKETS: readonly (readonly [string, boolean])[] = [
  ['b', true],
  ['my-bucket', true],
  ['Legacy_Bucket.name', true],
  ['', false],
  ['a/b', false],
  ['arn:aws:s3:us-east-1:123456789012:accesspoint/ap', false],
  ['ARN:aws:s3:::x', false],
];

describe('the bucket rule has one source', () => {
  it.each(BUCKETS)('%j: %s through every caller', (bucket, good) => {
    expect(bucketProblem(bucket) === undefined).toBe(good);
    expect(accepts(() => validateS3Options({ bucket }))).toBe(good);
    if (!bucket.includes('/') && bucket !== '') {
      let read = true;
      try {
        readPath(`/${bucket}/k`, undefined);
      } catch (error) {
        expect(error).toBeInstanceOf(PathProblem);
        read = false;
      }
      expect(read).toBe(good);
      expect(
        accepts(() =>
          s3Backend.checkEndpoint?.({
            host: bucket,
            port: undefined,
            username: '',
          }),
        ),
      ).toBe(good);
    }
  });
});

describe('the other value rules', () => {
  it('an upload ID is a string of 1 to 1,024 code units, of any characters', () => {
    expect(isUploadId('u\u00071')).toBe(true);
    expect(isUploadId('x'.repeat(1024))).toBe(true);
    expect(isUploadId('')).toBe(false);
    expect(isUploadId('x'.repeat(1025))).toBe(false);
    expect(isUploadId(42)).toBe(false);
    expect(isUploadId(undefined)).toBe(false);
  });

  it('a bucket of one DNS label is virtual-hosted on AWS; a name with . or _ is not', () => {
    expect(isVirtualHostable('b')).toBe(true);
    expect(isVirtualHostable('my-bucket-2')).toBe(true);
    expect(isVirtualHostable('a.b')).toBe(false);
    expect(isVirtualHostable('Upper')).toBe(false);
    expect(isVirtualHostable('under_score')).toBe(false);
    expect(isVirtualHostable('-dash')).toBe(false);
  });
});
