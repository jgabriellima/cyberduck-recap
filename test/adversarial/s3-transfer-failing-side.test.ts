/**
 * Adversarial (FEATURE-3, ATK-85): the CLI's failing-side rule (src/cli/commands/transfer.ts,
 * ATK-75) against the S3 streams. When the local side fails, the S3 stream is only torn down: the
 * result names the local side and its error; the upload is aborted and leaves no object (an
 * existing one keeps its bytes); the download's connection is closed before the whole body. When
 * the S3 side fails, the result names the remote side with its typed RemoteFsError.
 */
import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { download, upload } from '../../src/cli/commands/transfer.js';
import {
  MIB,
  PART,
  bytes,
  expectRemoteError,
  rejection,
  useS3,
} from '../support/s3.js';

const LOCAL = new Error('local disk failed');
const BIG = 20 * MIB;

/** A local file that gives `length` bytes and then waits, until the test fails it. */
function localSource(length: number): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (sent) return;
      sent = true;
      this.push(bytes(length));
    },
  });
}

describe('ATK-85: a local failure during an S3 transfer names the local side', () => {
  it('upload: the local file fails after a part was sent; aborted, no object, old bytes kept', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'up', 'old bytes');
    const fs = await setup.connected();
    const local = localSource(PART + MIB);

    const result = upload(local, () => fs.createWriteStream('/b/up'));
    await setup.server.waitForRequest((r) => r.operation === 'UploadPart');
    local.destroy(LOCAL);

    expect(await result).toEqual({ side: 'local', error: LOCAL });
    const abort = await setup.server.waitForRequest(
      (r) => r.operation === 'AbortMultipartUpload',
    );
    expect(abort.key).toBe('up');
    expect(setup.server.requestsOf('CompleteMultipartUpload')).toHaveLength(0);
    expect(setup.server.getObject('b', 'up')?.toString()).toBe('old bytes');
  }, 30_000);

  it('upload: the local file fails before its end; no PutObject of the partial bytes', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    const local = localSource(1024);
    const remote = fs.createWriteStream('/b/small');
    const closed = new Promise<void>((resolve) =>
      remote.once('close', resolve),
    );

    const result = upload(local, () => remote);
    local.destroy(LOCAL);

    expect(await result).toEqual({ side: 'local', error: LOCAL });
    await closed;
    // A round trip after the close: a PutObject of the partial buffer would be recorded by now.
    await rejection(fs.stat('/b/small'), 'NOT_FOUND', '/b/small');
    expect(setup.server.requestsOf('PutObject')).toHaveLength(0);
  });

  it('download: the local file fails; the GetObject connection closes before the whole body', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'big', bytes(BIG));
    const fs = await setup.connected();
    const local = new Writable({
      write(_chunk, _encoding, callback) {
        callback(LOCAL);
      },
    });

    const result = await download(() => fs.createReadStream('/b/big'), local);

    expect(result).toEqual({ side: 'local', error: LOCAL });
    const get = setup.server.requestsOf('GetObject', 'big')[0];
    expect(get).toBeDefined();
    if (get === undefined) return;
    await setup.server.responseSettled(get);
    expect(get.connectionClosedEarly).toBe(true);
    expect(get.responseBytesSent).toBeLessThan(BIG);
  }, 30_000);
});

describe('ATK-85: an S3 failure during a transfer names the remote side', () => {
  it('download: a reset in the body is the remote side, CONNECTION_LOST with path', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'big', bytes(BIG));
    const fs = await setup.connected();
    setup.server.fault((r) =>
      r.operation === 'GetObject'
        ? { kind: 'reset-in-body', after: MIB }
        : undefined,
    );
    const local = new PassThrough();
    local.resume();

    const result = await download(() => fs.createReadStream('/b/big'), local);

    expect(result?.side).toBe('remote');
    expectRemoteError(result?.error, 'CONNECTION_LOST', '/b/big');
  }, 30_000);

  it('upload: a denied PutObject is the remote side, PERMISSION_DENIED with path', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    setup.server.fault((r) =>
      r.operation === 'PutObject'
        ? {
            kind: 'error',
            status: 403,
            code: 'AccessDenied',
            message: 'Access Denied',
          }
        : undefined,
    );
    const local = Readable.from([bytes(1024)]);

    const result = await upload(local, () => fs.createWriteStream('/b/k'));

    expect(result?.side).toBe('remote');
    expectRemoteError(result?.error, 'PERMISSION_DENIED', '/b/k');
  });
});
