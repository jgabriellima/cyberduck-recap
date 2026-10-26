import { describe, expect, it, onTestFinished } from 'vitest';
import { openSession } from '../../src/sftp/connection.js';
import * as operations from '../../src/sftp/operations.js';
import { validateOptions } from '../../src/sftp/options.js';
import { sentinel, trustingKnownHosts, useServer } from '../support/harness.js';
import { expectRejects } from '../support/remote-fs-assertions.js';

describe('stall watchdog against a live but stuck server (G-6)', () => {
  it('fails in-flight calls with CONNECTION_LOST, then NOT_CONNECTED', async () => {
    const password = sentinel();
    const fixture = await useServer({ password });
    const options = validateOptions({
      host: fixture.host,
      port: fixture.port,
      username: 'tester',
      password,
      knownHostsPath: await trustingKnownHosts(fixture),
    });
    // The threshold is shortened through the internal session hook, never through an option.
    const session = await openSession(options, { stallTimeoutMs: 300 }).session;
    onTestFinished(() => session.disconnect());
    fixture.stall();

    await expectRejects(operations.list(session, '/'), 'CONNECTION_LOST', {
      path: '/',
    });

    expect(session.isOpen).toBe(false);
    await expectRejects(operations.stat(session, '/'), 'NOT_CONNECTED');
  });
});
