/**
 * Exclusive create (AC-13, AC-45, AC-55): decided by the store in one step, `If-None-Match: *`
 * on the creating request only, sent once, and never replaced by an existence check.
 */
import { describe, expect, it } from 'vitest';
import type { RecordedRequest, S3ServerFixture } from '../support/s3-server.js';
import { s3Error } from '../support/s3-server.js';
import {
  MIB,
  bytes,
  onlyError,
  rejection,
  sha256,
  useS3,
  writeAll,
} from '../support/s3.js';

const SIZES = [
  ['1 KiB', 1024],
  ['20 MiB', 20 * MIB],
] as const;

const CREATING = new Set([
  'PutObject',
  'CompleteMultipartUpload',
  'CopyObject',
]);
const UPLOADING = [
  'PutObject',
  'CreateMultipartUpload',
  'UploadPart',
  'CompleteMultipartUpload',
  'CopyObject',
] as const;

function creatingRequests(
  server: S3ServerFixture,
  key: string,
): RecordedRequest[] {
  return server.requests.filter(
    (r) => CREATING.has(r.operation) && r.key === key,
  );
}

/** The checks before the create that AC-45 allows: no Head/Get of the target, listings of `x/`. */
function expectOnlyShapeChecksBefore(
  server: S3ServerFixture,
  create: RecordedRequest,
  key: string,
): void {
  const before = server.requests.filter((r) => r.index < create.index);
  expect(
    before.filter(
      (r) =>
        (r.operation === 'HeadObject' || r.operation === 'GetObject') &&
        r.key === key,
    ),
  ).toEqual([]);
  for (const listing of before.filter((r) => r.operation === 'ListObjectsV2')) {
    expect(listing.query.prefix ?? '').toMatch(/\/$/);
  }
}

describe('exclusive write (AC-13)', () => {
  it('AC-13: an exclusive write to a new key stores it', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    const data = bytes(1024, 1);
    const outcome = await writeAll(
      fs.createWriteStream('/b/new', { exclusive: true }),
      data,
    );
    expect(outcome.errors).toEqual([]);
    expect(outcome.finished).toBe(true);
    expect(setup.server.getObject('b', 'new')).toEqual(data);
  });

  it('AC-13: an exclusive write to an existing object emits ALREADY_EXISTS, bytes unchanged', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'k', 'old');
    const fs = await setup.connected();
    const outcome = await writeAll(
      fs.createWriteStream('/b/k', { exclusive: true }),
      bytes(1024),
    );
    onlyError(outcome, 'ALREADY_EXISTS', '/b/k');
    expect(outcome.finished).toBe(false);
    expect(setup.server.getObject('b', 'k')?.toString()).toBe('old');
  });

  for (const [label, size] of SIZES) {
    it(`AC-13: another client creates the object during a ${label} write: ALREADY_EXISTS`, async () => {
      const setup = await useS3();
      const fs = await setup.connected();
      const theirs = Buffer.from('the other client');
      // The other client writes just before the creating request reaches the store.
      setup.server.fault((request) => {
        if (CREATING.has(request.operation) && request.key === 'race') {
          setup.server.putObject('b', 'race', theirs);
        }
        return undefined;
      });
      const outcome = await writeAll(
        fs.createWriteStream('/b/race', { exclusive: true }),
        bytes(size, 2),
      );
      onlyError(outcome, 'ALREADY_EXISTS', '/b/race');
      expect(outcome.finished).toBe(false);
      expect(setup.server.getObject('b', 'race')).toEqual(theirs);
    }, 30_000);
  }

  it('AC-13: If-None-Match: * is on PutObject and CompleteMultipartUpload only', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    for (const [label, size] of SIZES) {
      const outcome = await writeAll(
        fs.createWriteStream(`/b/${label}`, { exclusive: true }),
        bytes(size),
      );
      expect(outcome.errors).toEqual([]);
    }
    const small = setup.server.requestsOf('PutObject', '1 KiB');
    expect(small.map((r) => r.ifNoneMatch)).toEqual(['*']);
    const big = '20 MiB';
    expect(
      setup.server
        .requestsOf('CompleteMultipartUpload', big)
        .map((r) => r.ifNoneMatch),
    ).toEqual(['*']);
    for (const operation of ['CreateMultipartUpload', 'UploadPart'] as const) {
      const requests = setup.server.requestsOf(operation, big);
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests)
        expect(request.ifNoneMatch).toBeUndefined();
    }
  }, 30_000);
});

describe('exclusive create is decided only by the store (AC-45)', () => {
  for (const [label, size] of SIZES) {
    it(`AC-45 (a): a ${label} exclusive write to an existing k gets the store's 412, no Head/Get of k`, async () => {
      const setup = await useS3();
      setup.server.putObject('b', 'k', 'old');
      const fs = await setup.connected();
      setup.server.clearRequests();
      const outcome = await writeAll(
        fs.createWriteStream('/b/k', { exclusive: true }),
        bytes(size),
      );
      onlyError(outcome, 'ALREADY_EXISTS', '/b/k');
      const [create] = creatingRequests(setup.server, 'k');
      expect(create).toBeDefined();
      if (create === undefined) return;
      expect(create.ifNoneMatch).toBe('*');
      expect(create.responseStatus).toBe(412);
      expectOnlyShapeChecksBefore(setup.server, create, 'k');
      expect(setup.server.getObject('b', 'k')?.toString()).toBe('old');
    }, 30_000);
  }

  it("AC-45 (a): rename onto an existing k gets the store's 412 on CopyObject", async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'k', 'old');
    setup.server.putObject('b', 'a.txt', 'from');
    const fs = await setup.connected();
    setup.server.clearRequests();
    await rejection(
      fs.rename('/b/a.txt', '/b/k'),
      'ALREADY_EXISTS',
      '/b/a.txt',
    );
    const [copy] = setup.server.requestsOf('CopyObject', 'k');
    expect(copy?.ifNoneMatch).toBe('*');
    expect(copy?.responseStatus).toBe(412);
    if (copy !== undefined)
      expectOnlyShapeChecksBefore(setup.server, copy, 'k');
    expect(setup.server.getObject('b', 'k')?.toString()).toBe('old');
    expect(setup.server.getObject('b', 'a.txt')?.toString()).toBe('from');
  });

  const refusals = [
    [
      'NotImplemented (501)',
      s3Error(
        'NotImplemented',
        'A header you provided implies functionality that is not implemented',
      ),
    ],
    [
      'HTTP 400 naming If-None-Match',
      s3Error('InvalidArgument', 'If-None-Match: * is not supported here'),
    ],
  ] as const;

  for (const [refusal, fault] of refusals) {
    for (const [label, size] of SIZES) {
      it(`AC-45 (b): ${refusal} refuses a ${label} exclusive write: one OPERATION_FAILED, no resend`, async () => {
        const setup = await useS3();
        setup.server.putObject('b', 'existing', 'old');
        const fs = await setup.connected();
        setup.server.fault((request) =>
          request.ifNoneMatch === undefined ? undefined : fault,
        );
        for (const key of ['k', 'existing']) {
          setup.server.clearRequests();
          const outcome = await writeAll(
            fs.createWriteStream(`/b/${key}`, { exclusive: true }),
            bytes(size),
          );
          const error = onlyError(outcome, 'OPERATION_FAILED', `/b/${key}`);
          expect(outcome.finished).toBe(false);
          expect(error.message).toContain('not supported');
          expect(error.message).toContain('exclusive');
          expect(error.message).toContain('--overwrite');
          const refused = setup.server.requests.find(
            (r) => r.ifNoneMatch !== undefined,
          );
          expect(refused).toBeDefined();
          const after = setup.server.requests.filter(
            (r) => r.index > (refused?.index ?? 0) && r.key === key,
          );
          for (const operation of UPLOADING) {
            expect(after.filter((r) => r.operation === operation)).toEqual([]);
          }
          if (size > 16 * MIB) {
            const aborts = setup.server.requestsOf('AbortMultipartUpload', key);
            expect(aborts).toHaveLength(1);
            expect(aborts[0]?.ifNoneMatch).toBeUndefined();
          }
        }
        expect(setup.server.hasObject('b', 'k')).toBe(false);
        expect(setup.server.getObject('b', 'existing')?.toString()).toBe('old');
        // The same store takes a write that does not ask for exclusive create.
        const plain = await writeAll(
          fs.createWriteStream('/b/plain'),
          bytes(1024),
        );
        expect(plain.errors).toEqual([]);
        expect(plain.finished).toBe(true);
      }, 60_000);
    }

    it(`AC-45 (b): ${refusal} makes rename reject OPERATION_FAILED, no DeleteObject`, async () => {
      const setup = await useS3();
      setup.server.putObject('b', 'a.txt', 'from');
      const fs = await setup.connected();
      setup.server.fault((request) =>
        request.ifNoneMatch === undefined ? undefined : fault,
      );
      const error = await rejection(
        fs.rename('/b/a.txt', '/b/k'),
        'OPERATION_FAILED',
      );
      expect(error.message).toContain('not supported');
      expect(error.message).toContain('exclusive');
      expect(error.message).toContain('--overwrite');
      expect(setup.server.requestsOf('DeleteObject')).toEqual([]);
      expect(setup.server.requestsOf('CopyObject', 'k')).toHaveLength(1);
      expect(setup.server.getObject('b', 'a.txt')?.toString()).toBe('from');
      expect(setup.server.hasObject('b', 'k')).toBe(false);
    });
  }
});

describe('an exclusive create after a lost reply (AC-55)', () => {
  /** Attempt 1 of the creating request is stored and its reply lost; later attempts get 412. */
  function lostThen412(server: S3ServerFixture): void {
    let attempts = 0;
    server.fault((request) => {
      if (!CREATING.has(request.operation) || request.key !== 'k')
        return undefined;
      attempts += 1;
      return attempts === 1
        ? { kind: 'store-then-reset' }
        : s3Error('PreconditionFailed');
    });
  }

  for (const [label, size] of SIZES) {
    it(`AC-55: a ${label} exclusive write whose reply is lost: one create, CONNECTION_LOST`, async () => {
      const setup = await useS3();
      const fs = await setup.connected();
      lostThen412(setup.server);
      const data = bytes(size, 4);
      const outcome = await writeAll(
        fs.createWriteStream('/b/k', { exclusive: true }),
        data,
      );
      expect(creatingRequests(setup.server, 'k')).toHaveLength(1);
      const error = onlyError(outcome, 'CONNECTION_LOST', '/b/k');
      expect(outcome.finished).toBe(false);
      expect(error.message).toContain('s3://b/k');
      expect(error.message).toContain('may have been written');
      expect(error.message).not.toContain('no object was written');
      expect(error.message).not.toContain('aws s3api abort-multipart-upload');
      expect(sha256(setup.server.getObject('b', 'k') ?? Buffer.alloc(0))).toBe(
        sha256(data),
      );
    }, 30_000);
  }

  it('AC-55: without exclusive, a lost reply then HTTP 500 gives OPERATION_FAILED, may have been written', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    let attempts = 0;
    setup.server.fault((request) => {
      if (request.operation !== 'PutObject' || request.key !== 'k')
        return undefined;
      attempts += 1;
      return attempts === 1
        ? { kind: 'store-then-reset' }
        : s3Error('InternalError');
    });
    const outcome = await writeAll(fs.createWriteStream('/b/k'), bytes(1024));
    const error = onlyError(outcome, 'OPERATION_FAILED', '/b/k');
    expect(error.message).toContain('may have been written');
    expect(error.message).not.toContain('no object was written');
  });

  it('AC-55: without exclusive, a lost CompleteMultipartUpload reply then NoSuchUpload: CONNECTION_LOST', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    let attempts = 0;
    setup.server.fault((request) => {
      if (request.operation !== 'CompleteMultipartUpload') return undefined;
      attempts += 1;
      return attempts === 1
        ? { kind: 'store-then-reset' }
        : s3Error('NoSuchUpload');
    });
    const data = bytes(20 * MIB, 6);
    const outcome = await writeAll(fs.createWriteStream('/b/k'), data);
    const error = onlyError(outcome, 'CONNECTION_LOST', '/b/k');
    expect(error.message).toContain('s3://b/k');
    expect(error.message).toContain('may have been written');
    expect(error.message).not.toContain('no object was written');
    expect(sha256(setup.server.getObject('b', 'k') ?? Buffer.alloc(0))).toBe(
      sha256(data),
    );
  }, 30_000);

  it('AC-55: rename whose CopyObject reply is lost: one copy, no delete, CONNECTION_LOST', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'a.txt', 'from');
    const fs = await setup.connected();
    lostThen412(setup.server);
    const error = await rejection(
      fs.rename('/b/a.txt', '/b/k'),
      'CONNECTION_LOST',
    );
    expect(setup.server.requestsOf('CopyObject')).toHaveLength(1);
    expect(setup.server.requestsOf('DeleteObject')).toEqual([]);
    expect(error.message).toContain('s3://b/k');
    expect(error.message).toContain('may have been written');
    expect(setup.server.getObject('b', 'a.txt')?.toString()).toBe('from');
  });
});
