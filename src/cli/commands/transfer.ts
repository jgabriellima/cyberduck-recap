import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Which side of a transfer failed first, and its error. */
export interface TransferFailure {
  readonly side: 'local' | 'remote';
  readonly error: unknown;
}

/**
 * Runs one transfer between a local stream that is already open and a remote stream that
 * `openRemote` makes. The first stream to fail names the side: a failure of the other is only the
 * teardown that pipeline causes. A remote stream that cannot be made is a remote failure, and the
 * local stream is torn down.
 */
async function transfer<Remote extends Readable | Writable>(
  local: Readable | Writable,
  openRemote: () => Remote,
  pipe: (remote: Remote) => Promise<void>,
): Promise<TransferFailure | undefined> {
  let first: TransferFailure | undefined;
  local.on('error', (error: unknown) => {
    first ??= { side: 'local', error };
  });
  let remote: Remote;
  try {
    remote = openRemote();
  } catch (error) {
    local.destroy();
    return { side: 'remote', error };
  }
  remote.on('error', (error: unknown) => {
    first ??= { side: 'remote', error };
  });
  try {
    await pipe(remote);
    return undefined;
  } catch (error) {
    local.destroy();
    return first ?? { side: 'remote', error };
  }
}

/** `get`: the remote file into a local stream. */
export function download(
  openRemote: () => Readable,
  local: Writable,
): Promise<TransferFailure | undefined> {
  return transfer(local, openRemote, (remote) => pipeline(remote, local));
}

/** `put`: a local stream into the remote file. */
export function upload(
  local: Readable,
  openRemote: () => Writable,
): Promise<TransferFailure | undefined> {
  return transfer(local, openRemote, (remote) => pipeline(local, remote));
}
