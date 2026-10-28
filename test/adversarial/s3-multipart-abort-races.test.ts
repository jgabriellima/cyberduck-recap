/**
 * Adversarial (FEATURE-3, ATK-82): the multipart abort against parts still in flight, and a caller
 * who gives up halfway. With up to 4 parts in flight, a part that fails while others are being
 * sent must lead to one AbortMultipartUpload and then nothing more for that upload: no part sent
 * after the abort, no completion. A caller that destroys the write stream before `end()` has not
 * finished the upload, so no object may appear at the key, a started multipart upload is aborted
 * (spec "Uploads": every failure after CreateMultipartUpload), and `finish` never comes.
 */
import { describe, expect, it } from 'vitest';
import { s3Error } from '../support/s3-server.js';
import {
  MIB,
  PART,
  bytes,
  onlyError,
  rejection,
  useS3,
  writeAll,
} from '../support/s3.js';

describe('ATK-82: a part that fails while other parts are in flight', () => {
  it('one abort, then no UploadPart or CompleteMultipartUpload for that upload', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'k', 'old bytes');
    const fs = await setup.connected();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstPartAttempts = 0;
    setup.server.fault((r) => {
      if (r.operation !== 'UploadPart') return undefined;
      if (r.query.partNumber === '1') {
        firstPartAttempts += 1;
        // The other parts are released once the last attempt of part 1 has its reply, so an
        // uploader that waits for its parts in flight before it aborts does not wait forever.
        if (firstPartAttempts === 3) {
          void setup.server.responseSettled(r).then(() => release());
        }
        return s3Error('InternalError');
      }
      return { kind: 'hold', until: held };
    });

    const outcome = await writeAll(
      fs.createWriteStream('/b/k'),
      bytes(3 * PART + 1),
    );

    onlyError(outcome, 'OPERATION_FAILED', '/b/k');
    expect(outcome.finished).toBe(false);
    const aborts = setup.server.requestsOf('AbortMultipartUpload', 'k');
    expect(aborts).toHaveLength(1);
    const abortIndex = aborts[0]?.index ?? -1;
    const later = setup.server.requests.filter(
      (r) =>
        r.index > abortIndex &&
        (r.operation === 'UploadPart' ||
          r.operation === 'CompleteMultipartUpload'),
    );
    expect(later).toEqual([]);
    expect(setup.server.requestsOf('CompleteMultipartUpload')).toHaveLength(0);
    expect(setup.server.getObject('b', 'k')?.toString()).toBe('old bytes');
  }, 60_000);
});

describe('ATK-82: the caller destroys the write stream before end()', () => {
  it.each([
    ['destroy()', undefined],
    ['destroy(error)', new Error('the caller gave up')],
  ])(
    'a multipart upload ended by %s is aborted and creates no object',
    async (_label, reason) => {
      const setup = await useS3();
      const fs = await setup.connected();
      const stream = fs.createWriteStream('/b/k');
      let finished = false;
      stream.on('finish', () => {
        finished = true;
      });
      // Errors are expected here (the caller's own, or the back-end's): only their count matters.
      const errors: unknown[] = [];
      stream.on('error', (error) => errors.push(error));
      const closed = new Promise<void>((resolve) =>
        stream.once('close', resolve),
      );
      stream.write(bytes(PART + MIB));
      const part = await setup.server.waitForRequest(
        (r) => r.operation === 'UploadPart',
      );
      stream.destroy(reason);
      const abort = await setup.server.waitForRequest(
        (r) => r.operation === 'AbortMultipartUpload',
      );
      await closed;
      expect(abort.query.uploadId).toBe(part.query.uploadId);
      expect(finished).toBe(false);
      expect(errors.length).toBeLessThanOrEqual(1);
      expect(setup.server.requestsOf('CompleteMultipartUpload')).toHaveLength(
        0,
      );
      expect(setup.server.hasObject('b', 'k')).toBe(false);
    },
    30_000,
  );

  it('a small write destroyed before end() sends no PutObject', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    const stream = fs.createWriteStream('/b/small');
    stream.on('error', () => undefined);
    const closed = new Promise<void>((resolve) =>
      stream.once('close', resolve),
    );
    stream.write(bytes(1024));
    stream.destroy();
    await closed;
    // A round trip after the close: a PutObject of the partial buffer would have reached the
    // server by the time this stat is answered.
    await rejection(fs.stat('/b/small'), 'NOT_FOUND', '/b/small');
    expect(setup.server.requestsOf('PutObject')).toHaveLength(0);
    expect(setup.server.hasObject('b', 'small')).toBe(false);
  });
});
