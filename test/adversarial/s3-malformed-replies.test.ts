/**
 * Adversarial (FEATURE-3, ATK-78): malformed reply parts that AC-30 does not list. A store that
 * answers an upload request with 200 and a body that lacks the part the next step needs (the
 * upload ID, the part's ETag), a CompleteMultipartUpload that is 200 with an `<Error>` body (S3
 * documents this form), and listings whose names would escape the requested directory. Each is
 * untrusted input (cyberduck/standard.untrusted-server-replies): a typed error with `path`, never
 * a crash, a hang, a request built from the missing part, or an object the caller did not finish.
 */
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { Fault } from '../support/s3-server.js';
import {
  MIB,
  PART,
  bytes,
  onlyError,
  rejection,
  useS3,
  writeAll,
} from '../support/s3.js';

const NS = 'http://s3.amazonaws.com/doc/2006-03-01/';
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n';
const DATE = '2026-01-02T03:04:05.000Z';

function xml(body: string): Fault {
  return {
    kind: 'raw',
    status: 200,
    headers: { 'content-type': 'application/xml' },
    body: XML + body,
  };
}

/** A ListBuckets page with these bucket names, each given as XML text. */
function buckets(...names: string[]): Fault {
  const list = names
    .map(
      (name) =>
        `<Bucket><Name>${name}</Name><CreationDate>${DATE}</CreationDate></Bucket>`,
    )
    .join('');
  return xml(
    `<ListAllMyBucketsResult xmlns="${NS}"><Owner><ID>o</ID></Owner>` +
      `<Buckets>${list}</Buckets></ListAllMyBucketsResult>`,
  );
}

/** One ListObjectsV2 page for prefix `d/` with the given entries. */
function page(body: string): Fault {
  return xml(
    `<ListBucketResult xmlns="${NS}"><Name>b</Name><Prefix>d/</Prefix>` +
      '<Delimiter>/</Delimiter><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>' +
      `${body}</ListBucketResult>`,
  );
}

function contents(key: string): string {
  return `<Contents><Key>${key}</Key><LastModified>${DATE}</LastModified><ETag>"e"</ETag><Size>1</Size></Contents>`;
}

function prefix(value: string): string {
  return `<CommonPrefixes><Prefix>${value}</Prefix></CommonPrefixes>`;
}

describe('ATK-78: upload replies without the part the next request needs', () => {
  it('a CreateMultipartUpload of 200 with no UploadId fails the stream; no part is sent', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    setup.server.fault((r) =>
      r.operation === 'CreateMultipartUpload'
        ? xml(
            `<InitiateMultipartUploadResult xmlns="${NS}"><Bucket>b</Bucket>` +
              '<Key>k</Key></InitiateMultipartUploadResult>',
          )
        : undefined,
    );
    const started = performance.now();
    const outcome = await writeAll(
      fs.createWriteStream('/b/k'),
      bytes(PART + MIB),
    );
    onlyError(outcome, 'OPERATION_FAILED', '/b/k');
    expect(outcome.finished).toBe(false);
    expect(performance.now() - started).toBeLessThan(5000);
    // An upload ID the server never gave cannot be used: no request names one.
    expect(setup.server.requestsOf('UploadPart')).toHaveLength(0);
    expect(setup.server.requestsOf('CompleteMultipartUpload')).toHaveLength(0);
    expect(setup.server.hasObject('b', 'k')).toBe(false);
  }, 15_000);

  it('an UploadPart of 200 with no ETag fails the stream and aborts the upload', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    setup.server.fault((r) =>
      r.operation === 'UploadPart' ? { kind: 'raw', status: 200 } : undefined,
    );
    const outcome = await writeAll(
      fs.createWriteStream('/b/k'),
      bytes(PART + MIB),
    );
    onlyError(outcome, 'OPERATION_FAILED', '/b/k');
    expect(outcome.finished).toBe(false);
    // A part list with an empty ETag would be refused by a real store or, worse, complete an
    // object from parts the client never confirmed.
    expect(setup.server.requestsOf('CompleteMultipartUpload')).toHaveLength(0);
    const aborts = setup.server.requestsOf('AbortMultipartUpload', 'k');
    expect(aborts).toHaveLength(1);
    expect(aborts[0]?.query.uploadId).toBe('upload-1');
    expect(setup.server.hasObject('b', 'k')).toBe(false);
  }, 30_000);

  it('a CompleteMultipartUpload of 200 with an <Error> body is a failure, not a finish', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'k', 'old bytes');
    const fs = await setup.connected();
    setup.server.fault((r) =>
      r.operation === 'CompleteMultipartUpload'
        ? xml(
            '<Error><Code>InternalError</Code>' +
              '<Message>We encountered an internal error.</Message></Error>',
          )
        : undefined,
    );
    const outcome = await writeAll(
      fs.createWriteStream('/b/k'),
      bytes(PART + MIB),
    );
    const error = onlyError(outcome, 'OPERATION_FAILED', '/b/k');
    expect(outcome.finished).toBe(false);
    expect(error.message).toContain('InternalError');
    expect(error.message).toContain('no object was written to s3://b/k');
    expect(setup.server.getObject('b', 'k')?.toString()).toBe('old bytes');
  }, 30_000);
});

describe('ATK-78: listing names that escape the requested directory', () => {
  it.each([
    ['a bucket name with /', buckets('good', 'a/b')],
    ['an empty bucket name', buckets('good', '')],
  ])(
    'account-wide list("/") with %s gives OPERATION_FAILED with path',
    async (_label, fault) => {
      const setup = await useS3();
      const fs = await setup.connected();
      // The probe is a ListBuckets too: the fault starts after connect().
      setup.server.fault((r) =>
        r.operation === 'ListBuckets' ? fault : undefined,
      );
      const started = performance.now();
      await rejection(fs.list('/'), 'OPERATION_FAILED', '/');
      expect(performance.now() - started).toBeLessThan(5000);
    },
    10_000,
  );

  it.each([
    ['a CommonPrefix outside the prefix', page(prefix('elsewhere/'))],
    ['a CommonPrefix without its trailing /', page(prefix('d/x'))],
    ['a key below the delimiter (delimiter ignored)', page(contents('d/x/y'))],
  ])(
    'list("/b/d") with %s gives OPERATION_FAILED with path',
    async (_label, fault) => {
      const setup = await useS3();
      const fs = await setup.connected();
      setup.server.fault((r) =>
        r.operation === 'ListObjectsV2' && r.query.prefix === 'd/'
          ? fault
          : undefined,
      );
      const started = performance.now();
      await rejection(fs.list('/b/d'), 'OPERATION_FAILED', '/b/d');
      expect(performance.now() - started).toBeLessThan(5000);
    },
    10_000,
  );
});
