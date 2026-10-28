/**
 * Adversarial (FEATURE-3 design SE-16): a CreateMultipartUpload reply whose UploadId is empty or
 * longer than 1,024 characters. No request may carry an ID that failed the check: one
 * OPERATION_FAILED with `path` and "no object was written", and no part, completion or abort.
 */
import { describe, expect, it } from 'vitest';
import { MIB, PART, bytes, onlyError, useS3, writeAll } from '../support/s3.js';

describe('SE-16: an upload ID of a bad shape is used by no request', () => {
  it.each([
    ['empty', ''],
    ['of 1,025 characters', 'u'.repeat(1025)],
  ])(
    'an UploadId %s fails the stream before any part',
    async (_label, uploadId) => {
      const setup = await useS3({ uploadId: () => uploadId });
      const fs = await setup.connected();
      const outcome = await writeAll(
        fs.createWriteStream('/b/k'),
        bytes(PART + MIB),
      );
      const error = onlyError(outcome, 'OPERATION_FAILED', '/b/k');
      expect(outcome.finished).toBe(false);
      expect(error.message).toContain('no object was written to s3://b/k');
      for (const operation of [
        'UploadPart',
        'CompleteMultipartUpload',
        'AbortMultipartUpload',
      ] as const) {
        expect(setup.server.requestsOf(operation)).toEqual([]);
      }
      expect(setup.server.hasObject('b', 'k')).toBe(false);
    },
    30_000,
  );
});
