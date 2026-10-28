/**
 * disconnect() while work is in flight (AC-34, cyberduck/standard.session-ending-settles-once):
 * each pending operation settles once with NOT_CONNECTED, the upload is aborted before
 * disconnect() resolves, and a reply that arrives later is cleaned up.
 */
import { describe, expect, it } from 'vitest';
import {
  MIB,
  bytes,
  onlyError,
  readAll,
  rejection,
  useS3,
  writeAll,
} from '../support/s3.js';

const BIG = 20 * MIB;

describe('disconnect() during operations (AC-34)', () => {
  it('AC-34: a download, a multipart upload and a list each settle once with NOT_CONNECTED', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'big', bytes(BIG));
    const fs = await setup.connected();
    setup.server.fault((request) => {
      if (request.operation === 'GetObject')
        return { kind: 'stall-in-body', after: MIB };
      if (request.operation === 'UploadPart') return { kind: 'stall' };
      if (
        request.operation === 'ListObjectsV2' &&
        request.query.prefix === 'dir/'
      ) {
        return { kind: 'stall' };
      }
      return undefined;
    });
    const reading = readAll(fs.createReadStream('/b/big'));
    const upload = fs.createWriteStream('/b/up');
    let finished = false;
    upload.on('finish', () => {
      finished = true;
    });
    const writing = writeAll(upload, bytes(BIG));
    const listing = rejection(fs.list('/b/dir'), 'NOT_CONNECTED', '/b/dir');
    await setup.server.waitForRequest((r) => r.operation === 'GetObject');
    await setup.server.waitForRequest((r) => r.operation === 'UploadPart');
    await setup.server.waitForRequest(
      (r) => r.operation === 'ListObjectsV2' && r.query.prefix === 'dir/',
    );

    await fs.disconnect();
    // The abort reached the server before disconnect() resolved.
    expect(setup.server.requestsOf('AbortMultipartUpload', 'up')).toHaveLength(
      1,
    );

    const read = await reading;
    onlyError(read, 'NOT_CONNECTED', '/b/big');
    expect(read.ended).toBe(false);
    const write = await writing;
    onlyError(write, 'NOT_CONNECTED', '/b/up');
    expect(finished).toBe(false);
    const listed = await listing;
    expect(listed).not.toBeInstanceOf(AggregateError);
    expect(setup.server.hasObject('b', 'up')).toBe(false);
  }, 30_000);

  it('AC-34: a CreateMultipartUpload reply after disconnect() is aborted by its upload ID', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setup.server.fault((request) =>
      request.operation === 'CreateMultipartUpload'
        ? { kind: 'hold', until: gate }
        : undefined,
    );
    const writing = writeAll(fs.createWriteStream('/b/late'), bytes(BIG));
    await setup.server.waitForRequest(
      (r) => r.operation === 'CreateMultipartUpload',
    );
    const disconnected = fs.disconnect();
    release();
    const abort = await setup.server.waitForRequest(
      (r) => r.operation === 'AbortMultipartUpload',
    );
    expect(abort.query.uploadId).toBe('upload-1');
    expect(abort.key).toBe('late');
    await disconnected;
    const outcome = await writing;
    onlyError(outcome, 'NOT_CONNECTED', '/b/late');
    expect(setup.server.hasObject('b', 'late')).toBe(false);
  }, 30_000);

  it('AC-34: a GetObject reply after disconnect() has its connection closed before the whole body', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'big', bytes(BIG));
    const fs = await setup.connected();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setup.server.fault((request) =>
      request.operation === 'GetObject'
        ? { kind: 'hold', until: gate }
        : undefined,
    );
    const reading = readAll(fs.createReadStream('/b/big'));
    const get = await setup.server.waitForRequest(
      (r) => r.operation === 'GetObject',
    );
    const disconnected = fs.disconnect();
    release();
    await setup.server.responseSettled(get);
    expect(get.connectionClosedEarly).toBe(true);
    expect(get.responseBytesSent).toBeLessThan(BIG);
    await disconnected;
    onlyError(await reading, 'NOT_CONNECTED', '/b/big');
  }, 30_000);

  it('AC-34: disconnect() resolves when not connected, also twice', async () => {
    const setup = await useS3();
    const fs = await setup.s3();
    await expect(fs.disconnect()).resolves.toBeUndefined();
    await expect(fs.disconnect()).resolves.toBeUndefined();
    await fs.connect();
    await fs.disconnect();
    await expect(fs.disconnect()).resolves.toBeUndefined();
  });
});
