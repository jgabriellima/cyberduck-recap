/**
 * Adversarial: a server that is authenticated and trusted but answers SFTP requests in hostile or
 * broken ways. Whatever it sends, the client must either deliver correct data or fail with a typed
 * `RemoteFsError` — never crash, hang, accept a traversal, or report a truncated transfer as done.
 */
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { RemoteFsError } from '../../src/index.js';
import { newFs, sentinel, tempDir } from '../support/harness.js';
import {
  STATUS,
  startHostileServer,
  type HostileSftp,
} from '../support/hostile-sftp-server.js';
import {
  expectRejects,
  expectStreamError,
  readAll,
  sha256,
  streamOutcome,
} from '../support/remote-fs-assertions.js';
import { waitUntil } from '../support/sftp-server.js';

const FILE_HANDLE = Buffer.from([0, 0, 0, 1]);
const DIR_HANDLE = Buffer.from([0, 0, 0, 2]);
// Request ids the client can never have issued before the test ends: replies to them are spurious.
const SPURIOUS_IDS = [0xfffffff0, 0xfffffff1, 0xfffffff2];

/** Starts a trusted hostile server scripted by `serve`, and an instance connected to it. */
async function hostilePair(serve: (sftp: HostileSftp) => void) {
  const password = sentinel();
  const server = await startHostileServer({ password, serve });
  onTestFinished(() => server.close());
  const knownHostsPath = join(await tempDir(), 'known_hosts');
  await writeFile(knownHostsPath, `${server.knownHostsLine}\n`);
  const fs = newFs(server, knownHostsPath, { password });
  await fs.connect();
  return { server, fs };
}

const FILE_ATTRS = {
  mode: 0o100644,
  size: 0,
  uid: 0,
  gid: 0,
  atime: 0,
  mtime: 0,
};

describe('ATK-9: out-of-order, short and spurious READ replies', () => {
  it('a 1 MiB file read through reversed, short replies interleaved with replies to unknown ids is byte-exact', async () => {
    const content = randomBytes(1024 * 1024 + 123);
    let reads = 0;
    const { fs } = await hostilePair((sftp) => {
      let pending: { id: number; offset: number; length: number }[] = [];
      const flush = (): void => {
        const batch = pending.reverse();
        pending = [];
        for (const { id, offset, length } of batch) {
          for (const spurious of SPURIOUS_IDS) {
            sftp.data(spurious, randomBytes(16));
            sftp.status(spurious, STATUS.OK, 'OK');
          }
          if (offset >= content.length) {
            sftp.status(id, STATUS.EOF, 'EOF');
            continue;
          }
          // Never more than 7000 bytes: every 32 KiB request comes back short.
          const end = Math.min(offset + Math.min(length, 7000), content.length);
          sftp.data(id, content.subarray(offset, end));
        }
      };
      sftp.on('OPEN', (id) => sftp.handle(id, FILE_HANDLE));
      sftp.on('READ', (id, _handle, offset, length) => {
        reads += 1;
        if (pending.length === 0) setImmediate(flush);
        pending.push({ id, offset, length });
      });
      sftp.on('CLOSE', (id) => sftp.status(id, STATUS.OK, 'OK'));
      sftp.on('STAT', (id) =>
        sftp.attrs(id, { ...FILE_ATTRS, size: content.length }),
      );
    });

    const data = await readAll(fs.createReadStream('/f'));

    expect(data.length).toBe(content.length);
    expect(sha256(data)).toBe(sha256(content));
    expect(reads).toBeGreaterThan(content.length / 7000);
    // The session survived the spurious traffic.
    expect((await fs.stat('/f')).size).toBe(content.length);
  });
});

describe('ATK-10: absurd attributes and hostile names', () => {
  it('a size past 2^53, a far-future mtime and no mode come back as a typed entry', async () => {
    const { fs } = await hostilePair((sftp) => {
      sftp.on('STAT', (id) =>
        sftp.attrs(id, { size: 2 ** 63, mtime: 0xffffffff, atime: 0 } as never),
      );
    });

    const entry = await fs.stat('/huge');

    expect(typeof entry.size).toBe('number');
    expect(entry.size).toBe(2 ** 63);
    expect(entry.modifiedAt).toBeInstanceOf(Date);
    expect(entry.modifiedAt.getTime()).toBe(0xffffffff * 1000);
    expect(entry.type).toBe('other');
    expect(entry.permissions).toBeUndefined();
    expect(entry.name).toBe('huge');
  });

  it.each([
    ['a ".." mixed into real names', ['ok', '..', '.', 'b']],
    ['dot names repeated', ['.', '.', '..', '..', 'ok', 'b']],
  ])(
    '%s never yields an entry that leaves the directory',
    async (_label, names) => {
      const { fs } = await hostilePair((sftp) => {
        let served = false;
        sftp.on('OPENDIR', (id) => sftp.handle(id, DIR_HANDLE));
        sftp.on('READDIR', (id) => {
          if (served) {
            sftp.status(id, STATUS.EOF, 'EOF');
            return;
          }
          served = true;
          sftp.name(
            id,
            names.map((filename) => ({
              filename,
              longname: filename,
              attrs: FILE_ATTRS as never,
            })),
          );
        });
        sftp.on('CLOSE', (id) => sftp.status(id, STATUS.OK, 'OK'));
      });

      const entries = await fs.list('/dir');

      expect(entries.map((entry) => entry.name).sort()).toEqual(['b', 'ok']);
      for (const entry of entries) {
        expect(entry.path).toBe(`/dir/${entry.name}`);
      }
    },
  );

  it('a name split across batches with a slash in a later batch still fails the whole list', async () => {
    const { fs } = await hostilePair((sftp) => {
      let batch = 0;
      sftp.on('OPENDIR', (id) => sftp.handle(id, DIR_HANDLE));
      sftp.on('READDIR', (id) => {
        batch += 1;
        if (batch > 3) {
          sftp.status(id, STATUS.EOF, 'EOF');
          return;
        }
        const filename = batch === 3 ? '../../../etc/passwd' : `f${batch}`;
        sftp.name(id, [{ filename, longname: filename, attrs: FILE_ATTRS }]);
      });
      sftp.on('CLOSE', (id) => sftp.status(id, STATUS.OK, 'OK'));
    });

    await expectRejects(fs.list('/dir'), 'OPERATION_FAILED', { path: '/dir' });
  });

  it('status text with escapes, bidi controls and 10k characters is sanitised and capped', async () => {
    const { fs } = await hostilePair((sftp) => {
      sftp.on('STAT', (id) =>
        sftp.status(
          id,
          STATUS.FAILURE,
          `\u001b]0;pwned\u0007\u001b[2K\r\nERROR fake\u0000${'x'.repeat(10_000)}`,
        ),
      );
    });

    const error = await expectRejects(fs.stat('/p'), 'OPERATION_FAILED', {
      path: '/p',
    });

    const controls = [...error.message].filter((c) => {
      const code = c.charCodeAt(0);
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    });
    expect(controls).toEqual([]);
    expect(error.message.length).toBeLessThan(400);
  });

  it.each([
    ['EOF', STATUS.EOF],
    ['BAD_MESSAGE', STATUS.BAD_MESSAGE],
    ['OP_UNSUPPORTED', STATUS.OP_UNSUPPORTED],
  ])(
    'a STAT answered with the out-of-place status %s is OPERATION_FAILED and the session survives',
    async (_label, code) => {
      let stats = 0;
      const { fs } = await hostilePair((sftp) => {
        sftp.on('STAT', (id) => {
          stats += 1;
          if (stats === 1) sftp.status(id, code, 'weird');
          else sftp.attrs(id, FILE_ATTRS);
        });
      });

      await expectRejects(fs.stat('/p'), 'OPERATION_FAILED', { path: '/p' });
      expect((await fs.stat('/p')).type).toBe('file');
    },
  );
});

describe('ATK-11: replies that answer the wrong kind of request', () => {
  it('STAT answered with a bare OK status (no attributes) rejects with a RemoteFsError', async () => {
    const { fs } = await hostilePair((sftp) => {
      sftp.on('STAT', (id) => sftp.status(id, STATUS.OK, 'OK'));
    });

    let caught: unknown;
    await fs.stat('/p').catch((error: unknown) => {
      caught = error;
    });

    expect(caught).toBeInstanceOf(RemoteFsError);
  });

  it('READDIR answered with a bare OK status (no names) rejects with a RemoteFsError', async () => {
    const { fs } = await hostilePair((sftp) => {
      sftp.on('OPENDIR', (id) => sftp.handle(id, DIR_HANDLE));
      sftp.on('READDIR', (id) => sftp.status(id, STATUS.OK, 'OK'));
      sftp.on('CLOSE', (id) => sftp.status(id, STATUS.OK, 'OK'));
    });

    let caught: unknown;
    await fs.list('/dir').catch((error: unknown) => {
      caught = error;
    });

    expect(caught).toBeInstanceOf(RemoteFsError);
  });

  it('OPEN answered with a bare OK status (no handle) makes the read stream error, not hang', async () => {
    const { fs } = await hostilePair((sftp) => {
      sftp.on('OPEN', (id) => sftp.status(id, STATUS.OK, 'OK'));
      sftp.on('READ', (id) => sftp.status(id, STATUS.EOF, 'EOF'));
      sftp.on('STAT', (id) => sftp.attrs(id, FILE_ATTRS));
      sftp.on('CLOSE', (id) => sftp.status(id, STATUS.OK, 'OK'));
    });

    const stream = fs.createReadStream('/f');
    stream.resume();
    const outcome = await streamOutcome(stream);

    expect(outcome.finished).toBe(false);
    expect(outcome.error).toBeInstanceOf(RemoteFsError);
  }, 5000);

  it('OPEN answered with a bare OK status (no handle) never lets an upload finish', async () => {
    const { fs } = await hostilePair((sftp) => {
      sftp.on('OPEN', (id) => sftp.status(id, STATUS.OK, 'OK'));
      sftp.on('WRITE', (id) => sftp.status(id, STATUS.OK, 'OK'));
      sftp.on('STAT', (id) => sftp.attrs(id, FILE_ATTRS));
      sftp.on('CLOSE', (id) => sftp.status(id, STATUS.OK, 'OK'));
    });

    const stream = fs.createWriteStream('/f');
    stream.end(randomBytes(100_000));
    const outcome = await streamOutcome(stream);

    expect(outcome.finished).toBe(false);
    expect(outcome.error).toBeInstanceOf(RemoteFsError);
  });
});

describe('ATK-12: the server closes the SFTP channel mid-download', () => {
  it('the stream fails with CONNECTION_LOST instead of ending, later calls are NOT_CONNECTED, connect() recovers', async () => {
    const content = randomBytes(2 * 1024 * 1024);
    let sessions = 0;
    const { fs } = await hostilePair((sftp) => {
      sessions += 1;
      const first = sessions === 1;
      let served = 0;
      sftp.on('OPEN', (id) => sftp.handle(id, FILE_HANDLE));
      sftp.on('READ', (id, _handle, offset, length) => {
        served += 1;
        if (first && served === 20) {
          // The channel goes away, the SSH connection stays up.
          sftp.end();
          return;
        }
        if (offset >= content.length) {
          sftp.status(id, STATUS.EOF, 'EOF');
          return;
        }
        sftp.data(id, content.subarray(offset, offset + length));
      });
      sftp.on('CLOSE', (id) => sftp.status(id, STATUS.OK, 'OK'));
      sftp.on('STAT', (id) =>
        sftp.attrs(id, { ...FILE_ATTRS, size: content.length }),
      );
    });

    await expectStreamError(fs.createReadStream('/f'), 'CONNECTION_LOST', {
      path: '/f',
    });
    await expectRejects(fs.stat('/f'), 'NOT_CONNECTED');

    await fs.connect();
    expect(sha256(await readAll(fs.createReadStream('/f')))).toBe(
      sha256(content),
    );
  });
});

describe('ATK-13: a directory that never ends', () => {
  it('disconnect() ends an endless listing with NOT_CONNECTED and resolves', async () => {
    let readdirs = 0;
    const { fs } = await hostilePair((sftp) => {
      sftp.on('OPENDIR', (id) => sftp.handle(id, DIR_HANDLE));
      sftp.on('READDIR', (id) => {
        readdirs += 1;
        sftp.name(id, [
          {
            filename: `f${readdirs}`,
            longname: `f${readdirs}`,
            attrs: FILE_ATTRS,
          },
        ]);
      });
      sftp.on('CLOSE', (id) => sftp.status(id, STATUS.OK, 'OK'));
    });

    const listing = fs.list('/endless');
    // Observed before disconnect() rejects it, so the rejection is never unhandled.
    const outcome = expectRejects(listing, 'NOT_CONNECTED', {
      path: '/endless',
    });
    await waitUntil(() => readdirs > 200);
    await fs.disconnect();

    await outcome;
  });
});
