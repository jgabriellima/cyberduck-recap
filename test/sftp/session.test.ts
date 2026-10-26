import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteFsError } from '../../src/index.js';
import { SftpStatusError } from '../../src/sftp/error-map.js';
import {
  PROBE_AFTER_MS,
  Session,
  STALL_TIMEOUT_MS,
} from '../../src/sftp/session.js';
import { FakeTransport, statusError } from '../support/fake-channel.js';
import { expectRejects } from '../support/remote-fs-assertions.js';

function stat(session: Session, path = '/x'): Promise<unknown> {
  return session.request((sftp, done) => sftp.stat(path, done));
}

describe('Session', () => {
  let transport: FakeTransport;
  let session: Session;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new FakeTransport();
    session = new Session(transport);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves a reply once and ignores a second settlement', async () => {
    const result = stat(session);
    const [request] = transport.sftp.take('stat');
    request?.reply(undefined, { size: 1 });
    request?.reply(statusError(2));

    await expect(result).resolves.toEqual({ size: 1 });
  });

  it('turns a server status into an SftpStatusError', async () => {
    const result = stat(session);
    transport.sftp.take('stat')[0]?.reply(statusError(2, 'No such file'));

    const error = await result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SftpStatusError);
    expect(error).toMatchObject({ status: 2, serverText: 'No such file' });
  });

  it('a failure without a status is a loss: CONNECTION_LOST for everything in flight, then NOT_CONNECTED', async () => {
    const lost = vi.fn();
    session.onLost(lost);
    const first = stat(session, '/a');
    const second = stat(session, '/b');
    transport.sftp.take('stat')[0]?.reply(new Error('No response from server'));

    await expectRejects(first, 'CONNECTION_LOST');
    await expectRejects(second, 'CONNECTION_LOST');
    expect(transport.destroyed).toBe(1);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(session.isOpen).toBe(false);
    await expectRejects(stat(session), 'NOT_CONNECTED');
  });

  it('the transport closing without disconnect() is a loss and aborts tracked streams', async () => {
    const abort = vi.fn();
    session.track({ abort });
    const pending = stat(session);

    transport.emitClose();

    await expectRejects(pending, 'CONNECTION_LOST');
    expect(abort).toHaveBeenCalledWith('CONNECTION_LOST');
  });

  it('disconnect() fails in-flight calls and streams with NOT_CONNECTED and closes the transport', async () => {
    const abort = vi.fn();
    const lost = vi.fn();
    session.onLost(lost);
    session.track({ abort });
    const pending = stat(session);

    await session.disconnect();

    await expectRejects(pending, 'NOT_CONNECTED');
    expect(abort).toHaveBeenCalledWith('NOT_CONNECTED');
    expect(transport.ended).toBe(1);
    expect(lost).not.toHaveBeenCalled();
    await expectRejects(stat(session), 'NOT_CONNECTED');
    await expect(session.disconnect()).resolves.toBeUndefined();
  });

  it('an untracked stream is not aborted', async () => {
    const abort = vi.fn();
    const untrack = session.track({ abort });
    untrack();

    await session.disconnect();

    expect(abort).not.toHaveBeenCalled();
  });

  it('disconnect() destroys a transport that does not close in time', async () => {
    transport.closeOnEnd = false;
    const closing = session.disconnect();

    await vi.advanceTimersByTimeAsync(20_000);

    await expect(closing).resolves.toBeUndefined();
    expect(transport.destroyed).toBe(1);
  });

  it('a late reply after the session ended is ignored', async () => {
    const pending = stat(session);
    const [request] = transport.sftp.take('stat');
    transport.emitClose();
    request?.reply(undefined, { size: 1 });

    await expectRejects(pending, 'CONNECTION_LOST');
  });

  it('a synchronous throw while sending is OPERATION_FAILED material, not a crash', async () => {
    const result = session.request(() => {
      throw new Error('boom');
    });

    const error = await result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SftpStatusError);
  });
});

describe('Session stall watchdog (G-6)', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new FakeTransport();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tears the session down when a request gets no reply for STALL_TIMEOUT_MS', async () => {
    const session = new Session(transport);
    const pending = stat(session);
    const outcome = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS - 1);
    expect(session.isOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    const error = await outcome;
    expect(error).toBeInstanceOf(RemoteFsError);
    expect((error as RemoteFsError).code).toBe('CONNECTION_LOST');
    expect(session.isOpen).toBe(false);
    await expectRejects(stat(session), 'NOT_CONNECTED');
  });

  it('never cuts a slow link that keeps answering', async () => {
    const session = new Session(transport);
    const slow = stat(session, '/slow');
    for (let i = 0; i < 5; i += 1) {
      const quick = stat(session, `/quick-${i}`);
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS / 2);
      transport.sftp
        .takeOne('stat', (args) => args[0] === `/quick-${i}`)
        ?.reply(undefined, {});
      await quick;
    }

    expect(session.isOpen).toBe(true);
    transport.sftp.take('stat')[0]?.reply(undefined, { size: 2 });
    await expect(slow).resolves.toEqual({ size: 2 });
  });

  it('an idle session with nothing outstanding is never cut', async () => {
    const session = new Session(transport);
    const done = stat(session);
    transport.sftp.take('stat')[0]?.reply(undefined, {});
    await done;

    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS * 3);

    expect(session.isOpen).toBe(true);
  });

  it('uses an injected threshold', async () => {
    const session = new Session(transport, { stallTimeoutMs: 1000 });
    const outcome = stat(session).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1000);

    expect(await outcome).toMatchObject({ code: 'CONNECTION_LOST' });
  });
});

describe('Session liveness probe (AC-20)', () => {
  /** A peer that vanished without the reading socket being told: only a write reveals it. */
  class SilentlyDeadTransport extends FakeTransport {
    probes = 0;
    probe(): void {
      this.probes += 1;
      this.emitClose();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('probes a silent connection with requests outstanding, so a vanished peer becomes CONNECTION_LOST in a second', async () => {
    const transport = new SilentlyDeadTransport();
    const session = new Session(transport);
    const abort = vi.fn();
    session.track({ abort });
    const outcome = stat(session).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(PROBE_AFTER_MS - 1);
    expect(transport.probes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(transport.probes).toBe(1);
    expect(await outcome).toMatchObject({ code: 'CONNECTION_LOST' });
    expect(abort).toHaveBeenCalledWith('CONNECTION_LOST');
  });

  it('a live but slow server is probed once per quiet second and never cut before the stall threshold', async () => {
    const transport = new FakeTransport();
    let probes = 0;
    Object.assign(transport, { probe: () => (probes += 1) });
    const session = new Session(transport);
    const pending = stat(session);

    await vi.advanceTimersByTimeAsync(PROBE_AFTER_MS * 5);

    expect(probes).toBe(5);
    expect(session.isOpen).toBe(true);
    transport.sftp.take('stat')[0]?.reply(undefined, { size: 1 });
    await expect(pending).resolves.toEqual({ size: 1 });
  });

  it('an idle session or one whose replies keep coming is not probed', async () => {
    const transport = new FakeTransport();
    let probes = 0;
    Object.assign(transport, { probe: () => (probes += 1) });
    const session = new Session(transport);

    await vi.advanceTimersByTimeAsync(PROBE_AFTER_MS * 3);
    for (let i = 0; i < 5; i += 1) {
      const call = stat(session, `/q${i}`);
      await vi.advanceTimersByTimeAsync(PROBE_AFTER_MS / 2);
      transport.sftp.takeOne('stat')?.reply(undefined, {});
      await call;
    }

    expect(probes).toBe(0);
  });
});
