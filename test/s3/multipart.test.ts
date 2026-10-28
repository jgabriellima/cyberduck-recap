/**
 * Multipart uploads and the outcome of a failed upload (AC-14, AC-42, AC-43, AC-48).
 */
import { describe, expect, it } from 'vitest';
import type { RemoteFileSystem } from '../../src/fs/index.js';
import type { S3ServerFixture } from '../support/s3-server.js';
import { s3Error } from '../support/s3-server.js';
import {
  LARGEST_UPLOAD,
  MIB,
  PART,
  bytes,
  loadUploadModule,
  onlyError,
  useS3,
  writeAll,
  type S3Setup,
} from '../support/s3.js';

const BIG = 20 * MIB;

function failSecondPart(server: S3ServerFixture): void {
  server.fault((request) =>
    request.operation === 'UploadPart' && request.query.partNumber === '2'
      ? s3Error('InternalError', 'We encountered an internal error.')
      : undefined,
  );
}

/**
 * Starts a write of `data`, waits until the server holds the second UploadPart, calls
 * disconnect() while it is held, and returns the stream's outcome and the disconnect promise.
 */
async function disconnectDuringUpload(
  setup: S3Setup,
  fs: RemoteFileSystem,
  path: string,
  data: Buffer,
): Promise<{
  outcome: Awaited<ReturnType<typeof writeAll>>;
  disconnected: Promise<void>;
}> {
  setup.server.fault((request) =>
    request.operation === 'UploadPart' ? { kind: 'stall' } : undefined,
  );
  const writing = writeAll(fs.createWriteStream(path), data);
  await setup.server.waitForRequest((r) => r.operation === 'UploadPart');
  const disconnected = fs.disconnect();
  const outcome = await writing;
  return { outcome, disconnected };
}

describe('a failed part (AC-14)', () => {
  for (const existing of [false, true]) {
    it(`AC-14: HTTP 500 on part 2 gives one OPERATION_FAILED and one abort (${existing ? 'existing' : 'new'} key)`, async () => {
      const setup = await useS3();
      if (existing) setup.server.putObject('b', 'k', 'old bytes');
      const fs = await setup.connected();
      failSecondPart(setup.server);
      const outcome = await writeAll(fs.createWriteStream('/b/k'), bytes(BIG));
      onlyError(outcome, 'OPERATION_FAILED', '/b/k');
      expect(outcome.finished).toBe(false);
      const [created] = setup.server.requestsOf('CreateMultipartUpload', 'k');
      const aborts = setup.server.requestsOf('AbortMultipartUpload', 'k');
      expect(aborts).toHaveLength(1);
      expect(aborts[0]?.query.uploadId).toBe('upload-1');
      expect(created).toBeDefined();
      if (existing)
        expect(setup.server.getObject('b', 'k')?.toString()).toBe('old bytes');
      else expect(setup.server.hasObject('b', 'k')).toBe(false);
    }, 30_000);
  }
});

describe('an abort that fails (AC-42)', () => {
  const uploadId = 'u\u00071';
  const cases = [
    ['HTTP 500 on every abort', 'error'],
    ['a reset abort', 'reset'],
    ['disconnect() with the abort answered 500', 'disconnect'],
  ] as const;

  for (const [label, mode] of cases) {
    it(`AC-42: ${label}: one error with the first failure's code and the cleanup command`, async () => {
      const setup = await useS3(
        { uploadId: () => uploadId },
        { buckets: ['bkt-42'] },
      );
      const fs = await setup.connected();
      setup.server.fault((request) =>
        request.operation !== 'AbortMultipartUpload'
          ? undefined
          : mode === 'reset'
            ? { kind: 'reset' }
            : s3Error('InternalError'),
      );
      let outcome: Awaited<ReturnType<typeof writeAll>>;
      let code: 'OPERATION_FAILED' | 'NOT_CONNECTED' = 'OPERATION_FAILED';
      if (mode === 'disconnect') {
        const run = await disconnectDuringUpload(
          setup,
          fs,
          '/bkt-42/up/k42',
          bytes(BIG),
        );
        outcome = run.outcome;
        await expect(run.disconnected).resolves.toBeUndefined();
        code = 'NOT_CONNECTED';
      } else {
        failSecondPart(setup.server);
        outcome = await writeAll(
          fs.createWriteStream('/bkt-42/up/k42'),
          bytes(BIG),
        );
      }
      const error = onlyError(outcome, code, '/bkt-42/up/k42');
      expect(outcome.finished).toBe(false);
      expect(error.message).toContain('bkt-42');
      expect(error.message).toContain('up/k42');
      expect(error.message).toContain('u\\x071');
      expect(error.message).not.toContain('\u0007');
      expect(error.message).toContain('aws s3api abort-multipart-upload');
      expect(error.message).toContain('AbortIncompleteMultipartUpload');
      await expect(fs.disconnect()).resolves.toBeUndefined();
      expect(setup.server.hasObject('bkt-42', 'up/k42')).toBe(false);
    }, 30_000);
  }
});

describe('upload sizes and the part limit (AC-43)', () => {
  it('AC-43: the upload module exports the part size 16,777,216 and the part limit 10,000', async () => {
    const upload = await loadUploadModule();
    expect(upload.PART_SIZE).toBe(PART);
    expect(upload.MAX_PARTS).toBe(10_000);
    expect(PART * 10_000).toBe(LARGEST_UPLOAD);
  });

  it('AC-43: exactly 16 MiB is one PutObject; one byte more is 2 parts of 16 MiB and 1 byte', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    const one = await writeAll(fs.createWriteStream('/b/exact'), bytes(PART));
    expect(one.errors).toEqual([]);
    expect(setup.server.requestsOf('PutObject', 'exact')).toHaveLength(1);
    expect(setup.server.requestsOf('CreateMultipartUpload', 'exact')).toEqual(
      [],
    );
    const two = await writeAll(
      fs.createWriteStream('/b/over'),
      bytes(PART + 1),
    );
    expect(two.errors).toEqual([]);
    expect(setup.server.requestsOf('PutObject', 'over')).toEqual([]);
    const parts = setup.server
      .requestsOf('UploadPart', 'over')
      .map((r) => [Number(r.query.partNumber), r.bodyBytes])
      .sort(([a = 0], [b = 0]) => a - b);
    expect(parts).toEqual([
      [1, PART],
      [2, 1],
    ]);
    expect(setup.server.getObject('b', 'over')).toEqual(bytes(PART + 1));
  }, 60_000);

  it('AC-43: the server never holds more than 4 UploadPart requests at once', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    const outcome = await writeAll(
      fs.createWriteStream('/b/wide'),
      bytes(6 * PART + 1),
    );
    expect(outcome.errors).toEqual([]);
    expect(
      setup.server.requestsOf('UploadPart', 'wide').length,
    ).toBeGreaterThanOrEqual(7);
    expect(setup.server.maxUploadPartsInFlight).toBeGreaterThanOrEqual(1);
    expect(setup.server.maxUploadPartsInFlight).toBeLessThanOrEqual(4);
  }, 120_000);

  it('AC-43: with a part limit of 3, 3 parts plus 1 byte fail before part 4, with one abort', async () => {
    const setup = await useS3();
    const fs = await setup.connected({}, { partLimit: 3 });
    const outcome = await writeAll(
      fs.createWriteStream('/b/limit'),
      bytes(3 * PART + 1),
    );
    const error = onlyError(outcome, 'OPERATION_FAILED', '/b/limit');
    expect(outcome.finished).toBe(false);
    const parts = setup.server.requestsOf('UploadPart', 'limit');
    expect(parts.length).toBeLessThanOrEqual(3);
    expect(parts.filter((r) => r.query.partNumber === '4')).toEqual([]);
    expect(
      setup.server.requestsOf('AbortMultipartUpload', 'limit'),
    ).toHaveLength(1);
    expect(setup.server.hasObject('b', 'limit')).toBe(false);
    expect(error.message).toContain(String(3 * PART));
    // The default limit's message states 167772160000; reaching it needs 156.25 GiB of
    // upload, so the test checks the same message built for limit 3, from the same module.
  }, 60_000);
});

describe('what a failed upload says about the object (AC-48)', () => {
  type Scenario = (
    setup: S3Setup,
    fs: RemoteFileSystem,
    path: string,
  ) => Promise<{
    outcome: Awaited<ReturnType<typeof writeAll>>;
    code: string;
  }>;

  const noObject: [string, Scenario][] = [
    [
      'a failed part (AC-14)',
      async (setup, fs, path) => {
        failSecondPart(setup.server);
        return {
          outcome: await writeAll(fs.createWriteStream(path), bytes(BIG)),
          code: 'OPERATION_FAILED',
        };
      },
    ],
    [
      'a denied write (AC-40)',
      async (setup, fs, path) => {
        setup.server.fault((r) =>
          r.operation === 'PutObject'
            ? s3Error('AccessDenied', 'Access Denied')
            : undefined,
        );
        return {
          outcome: await writeAll(fs.createWriteStream(path), bytes(1024)),
          code: 'PERMISSION_DENIED',
        };
      },
    ],
    [
      'an exclusive write to an existing object (AC-13)',
      async (setup, fs, path) => {
        setup.server.putObject('b', 'k', 'old');
        return {
          outcome: await writeAll(
            fs.createWriteStream(path, { exclusive: true }),
            bytes(1024),
          ),
          code: 'ALREADY_EXISTS',
        };
      },
    ],
    [
      'a store that refuses If-None-Match (AC-45)',
      async (setup, fs, path) => {
        setup.server.fault((r) =>
          r.ifNoneMatch === undefined ? undefined : s3Error('NotImplemented'),
        );
        return {
          outcome: await writeAll(
            fs.createWriteStream(path, { exclusive: true }),
            bytes(1024),
          ),
          code: 'OPERATION_FAILED',
        };
      },
    ],
    [
      'disconnect() during a 20 MiB upload (AC-34)',
      async (setup, fs, path) => {
        const run = await disconnectDuringUpload(setup, fs, path, bytes(BIG));
        await run.disconnected;
        return { outcome: run.outcome, code: 'NOT_CONNECTED' };
      },
    ],
    [
      'a reset on every attempt of part 2',
      async (setup, fs, path) => {
        setup.server.fault((r) =>
          r.operation === 'UploadPart' && r.query.partNumber === '2'
            ? { kind: 'reset' }
            : undefined,
        );
        return {
          outcome: await writeAll(fs.createWriteStream(path), bytes(BIG)),
          code: 'CONNECTION_LOST',
        };
      },
    ],
  ];

  for (const scoped of [false, true]) {
    const mode = scoped ? 'bucket-scoped' : 'account-wide';
    const path = scoped ? '/k' : '/b/k';
    for (const [label, scenario] of noObject) {
      it(`AC-48: ${mode}, ${label}: no object was written to s3://b/k`, async () => {
        const setup = await useS3();
        const fs = await setup.connected(scoped ? { bucket: 'b' } : {});
        const { outcome, code } = await scenario(setup, fs, path);
        expect(outcome.errors).toHaveLength(1);
        const error = onlyError(outcome, code as never, path);
        expect(error.message).toContain('no object was written to s3://b/k');
      }, 30_000);
    }

    it(`AC-48: ${mode}, a 1 KiB PutObject stored and reset on every attempt: may have been written`, async () => {
      const setup = await useS3();
      const fs = await setup.connected(scoped ? { bucket: 'b' } : {});
      setup.server.fault((r) =>
        r.operation === 'PutObject' ? { kind: 'store-then-reset' } : undefined,
      );
      const outcome = await writeAll(fs.createWriteStream(path), bytes(1024));
      const error = onlyError(outcome, 'CONNECTION_LOST', path);
      expect(error.message).toContain('s3://b/k');
      expect(error.message).toContain('may have been written');
      expect(error.message).not.toContain('no object was written');
    });
  }
});
