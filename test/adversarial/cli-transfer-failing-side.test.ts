/**
 * Adversarial (FEATURE-2, ATK-75): the one failing-side rule of `get` and `put`
 * (src/cli/commands/transfer.ts) and the one errno reading (errnoOf in src/fs/errors.ts) that the
 * rework made shared. The side decides the error line: a local failure is LOCAL_FILE (exit 3), a
 * remote one is the back-end's code. The attacks: both sides fail in the same tick, the local side
 * fails after the remote one ended, the remote stream cannot be made, an error after the end, and
 * values that are not Node.js errors where an errno is read.
 */
import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { download, upload } from '../../src/cli/commands/transfer.js';
import { errnoOf } from '../../src/fs/errors.js';

const LOCAL = new Error('local');
const REMOTE = new Error('remote');

/** A writable that holds every chunk until the test fails or ends it. */
function heldWriter(): Writable {
  return new Writable({ write: () => undefined });
}

/** A readable that gives nothing until the test fails or ends it. */
function heldReader(): Readable {
  return new Readable({ read: () => undefined });
}

describe('ATK-75: the first side to fail names the failure', () => {
  it.each([
    ['remote', REMOTE],
    ['local', LOCAL],
  ] as const)(
    'download: both fail in one tick, %s first',
    async (firstSide, firstError) => {
      const remote = heldReader();
      const local = heldWriter();
      const result = download(() => remote, local);
      if (firstSide === 'remote') {
        remote.destroy(REMOTE);
        local.destroy(LOCAL);
      } else {
        local.destroy(LOCAL);
        remote.destroy(REMOTE);
      }
      expect(await result).toEqual({ side: firstSide, error: firstError });
    },
  );

  it.each([
    ['remote', REMOTE],
    ['local', LOCAL],
  ] as const)(
    'upload: both fail in one tick, %s first',
    async (firstSide, firstError) => {
      const local = heldReader();
      const remote = heldWriter();
      const result = upload(local, () => remote);
      if (firstSide === 'remote') {
        remote.destroy(REMOTE);
        local.destroy(LOCAL);
      } else {
        local.destroy(LOCAL);
        remote.destroy(REMOTE);
      }
      expect(await result).toEqual({ side: firstSide, error: firstError });
    },
  );

  it('download: the local file fails at its last flush, after the remote end', async () => {
    const remote = Readable.from([Buffer.from('all of it')]);
    const local = new Writable({
      write: (_chunk, _encoding, callback) => callback(),
      final: (callback) => callback(LOCAL),
    });
    let remoteEnded = false;
    remote.on('end', () => {
      remoteEnded = true;
    });
    const failure = await download(() => remote, local);
    expect(remoteEnded).toBe(true);
    expect(failure).toEqual({ side: 'local', error: LOCAL });
  });

  it('upload: the remote file fails at its last flush, after the local file ended', async () => {
    const local = Readable.from([Buffer.from('all of it')]);
    const remote = new Writable({
      write: (_chunk, _encoding, callback) => callback(),
      final: (callback) => callback(REMOTE),
    });
    const failure = await upload(local, () => remote);
    expect(failure).toEqual({ side: 'remote', error: REMOTE });
  });

  it.each([
    ['an Error', REMOTE],
    ['a string', 'remote text'],
    ['undefined', undefined],
  ])(
    'a remote stream not made (%s thrown): remote failure, local torn down',
    async (_label, thrown) => {
      const local = new PassThrough();
      const failure = await upload(local, () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error on purpose
        throw thrown;
      });
      expect(failure).toEqual({ side: 'remote', error: thrown });
      expect(local.destroyed).toBe(true);

      const writer = heldWriter();
      const failed = await download(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error on purpose
        throw thrown;
      }, writer);
      expect(failed).toEqual({ side: 'remote', error: thrown });
      expect(writer.destroyed).toBe(true);
    },
  );

  it('a remote error after a finished transfer changes nothing, is handled', async () => {
    // autoDestroy off: the ended stream is not destroyed yet, so a later destroy emits its error.
    const remote = new Readable({
      autoDestroy: false,
      read() {
        this.push('x');
        this.push(null);
      },
    });
    const local = new Writable({
      write: (_chunk, _encoding, callback) => callback(),
    });
    expect(await download(() => remote, local)).toBeUndefined();
    const late = new Promise<unknown>((resolve) =>
      remote.once('error', resolve),
    );
    remote.destroy(REMOTE);
    // The listener of the transfer is still there: the late error is caught, not thrown.
    expect(await late).toBe(REMOTE);
  });

  it('deferred: a remote stream closed with no error reads as a local failure', async () => {
    // The finding of ATK-75: pipeline tears the local side down with ERR_STREAM_PREMATURE_CLOSE,
    // and that is the first 'error' event, so `get` would show LOCAL_FILE (exit 3) for a remote
    // stream that ended early. The back-end contract makes a remote failure an 'error' event, so
    // no criterion is broken; this pins today's behaviour (no skipped tests in the tree).
    const remote = heldReader();
    const local = heldWriter();
    const result = download(() => remote, local);
    remote.destroy();
    const failure = await result;
    expect(failure?.side).toBe('local');
    expect(failure?.error).toMatchObject({
      code: 'ERR_STREAM_PREMATURE_CLOSE',
    });
  });
});

describe('ATK-75: errnoOf reads only a string code, whatever is thrown', () => {
  it.each([
    ['null', null, undefined],
    ['undefined', undefined, undefined],
    ['a string', 'ENOENT', undefined],
    ['a number', 2, undefined],
    ['a numeric code', { code: 2 }, undefined],
    ['a code object', { code: { toString: () => 'ENOENT' } }, undefined],
    ['a prototype-less object', Object.create(null) as object, undefined],
    [
      'a system error',
      Object.assign(new Error('x'), { code: 'EEXIST' }),
      'EEXIST',
    ],
    ['a plain object with a code', { code: 'ENOTDIR' }, 'ENOTDIR'],
  ])('%s', (_label, value, expected) => {
    expect(errnoOf(value)).toBe(expected);
  });
});
