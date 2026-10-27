/**
 * Adversarial: garbage from the caller (paths and options of the wrong shape), secrets hunted in
 * every object the library hands back, and a flood of concurrent operations on one session.
 */
import { writeFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { RemoteFsError, SftpFileSystem } from '../../src/index.js';
import {
  connectedPair,
  newFs,
  sentinel,
  trustingKnownHosts,
  useServer,
} from '../support/harness.js';
import { readAll, streamOutcome } from '../support/remote-fs-assertions.js';
import { generateKey } from '../support/sftp-server.js';

/** A call's failure, whether it throws synchronously, rejects, or errors its stream. */
async function failureOf(call: () => unknown): Promise<unknown> {
  try {
    const result = call();
    if (result instanceof Promise) {
      await result;
      return undefined;
    }
    if (result !== null && typeof result === 'object' && 'on' in result) {
      const outcome = await streamOutcome(
        result as NodeJS.ReadableStream & import('node:stream').Readable,
      );
      return outcome.error;
    }
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('ATK-17: paths of the wrong shape', () => {
  const garbage: [string, unknown][] = [
    ['an empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object with a toString', { toString: () => '/' }],
    ['an array', ['/']],
  ];

  it.each(garbage)(
    '%s as a path is INVALID_ARGUMENT for every operation, before any request',
    async (_label, path) => {
      const { fixture, fs } = await connectedPair();
      const requests = fixture.stats.requests;
      const p = path as string;
      const operations: [string, () => unknown][] = [
        ['list', () => fs.list(p)],
        ['stat', () => fs.stat(p)],
        ['mkdir', () => fs.mkdir(p)],
        ['remove', () => fs.remove(p)],
        ['rename from', () => fs.rename(p, '/x')],
        ['rename to', () => fs.rename('/x', p)],
        ['createReadStream', () => fs.createReadStream(p)],
        ['createWriteStream', () => fs.createWriteStream(p)],
      ];

      for (const [name, call] of operations) {
        const error = await failureOf(call);
        expect(error, name).toBeInstanceOf(RemoteFsError);
        expect((error as RemoteFsError).code, name).toBe('INVALID_ARGUMENT');
      }
      expect(fixture.stats.requests).toBe(requests);
    },
  );

  it('a path with a NUL or a traversal is sent as given and fails typed, never crashes the session', async () => {
    const { fixture, fs } = await connectedPair();
    await writeFile(fixture.local('/ok'), 'ok');

    for (const path of [
      '/ok\u0000/../../etc/passwd',
      '/../../../../etc/passwd',
    ]) {
      const error = await fs.stat(path).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      if (error !== undefined) {
        expect(error, path).toBeInstanceOf(RemoteFsError);
        expect((error as RemoteFsError).path, path).toBe(path);
      }
    }
    expect((await fs.stat('/ok')).size).toBe(2);
  });

  it.each([
    [
      'a getter that throws',
      {
        get host(): string {
          throw new Error('boom');
        },
      },
    ],
    [
      'a prototype-polluting key',
      JSON.parse('{"__proto__": {"hostVerifier": 1}}') as unknown,
    ],
    ['an array', ['127.0.0.1']],
    ['a string', '127.0.0.1'],
    ['null', null],
  ])(
    'options of %s are refused with INVALID_ARGUMENT or a plain throw, never a connection',
    (_label, options) => {
      let caught: unknown;
      try {
        new SftpFileSystem(options as never);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
    },
  );
});

describe('ATK-18: secrets hunted in streams, entries and errors of a key-authenticated session', () => {
  it('no 16-character piece of the key or passphrase appears in anything the library returns', async () => {
    const passphrase = sentinel();
    const key = generateKey(passphrase);
    const fixture = await useServer({ authorizedKeys: [key] });
    const knownHostsPath = await trustingKnownHosts(fixture);
    const fs = newFs(fixture, knownHostsPath, {
      privateKey: Buffer.from(key.privateKey),
      passphrase,
    });
    await fs.connect();
    await writeFile(fixture.local('/f'), 'data');
    fixture.deny('/denied');

    const secrets = [
      passphrase,
      key.privateKey.replace(/-----[^-]+-----|\s/g, ''),
    ];
    const leaks = (text: string): string | undefined => {
      for (const secret of secrets) {
        for (let i = 0; i + 16 <= secret.length; i += 1) {
          if (text.includes(secret.slice(i, i + 16)))
            return secret.slice(i, i + 16);
        }
      }
      return undefined;
    };

    const read = fs.createReadStream('/f');
    const write = fs.createWriteStream('/w');
    const writeDone = streamOutcome(write);
    // Observed from creation, so its error is never emitted without a listener.
    const deniedError = streamOutcome(
      fs.createReadStream('/denied').resume(),
    ).then((outcome) => outcome.error);
    const things: [string, unknown][] = [
      ['read stream', read],
      ['write stream', write],
      ['entry', await fs.stat('/f')],
      ['listing', await fs.list('/')],
      ['denied stream error', await deniedError],
      ['stat error', await fs.stat('/missing').catch((e: unknown) => e)],
      ['instance', fs],
    ];
    for (const [label, thing] of things) {
      const text = inspect(thing, { depth: Infinity, showHidden: true });
      expect(leaks(text), `${label} inspect`).toBeUndefined();
      let json = '';
      try {
        json = JSON.stringify(thing) ?? '';
      } catch {
        // Circular stream internals cannot be serialised; inspect above covered them.
      }
      expect(leaks(json), `${label} JSON`).toBeUndefined();
    }
    await readAll(read);
    write.end('x');
    expect((await writeDone).error).toBeUndefined();
  });

  it('a wrong passphrase on a Buffer key is AUTH_FAILED with no cause and no key material', async () => {
    const passphrase = sentinel();
    const key = generateKey(passphrase);
    const fixture = await useServer({ authorizedKeys: [key] });
    const knownHostsPath = await trustingKnownHosts(fixture);
    const wrong = sentinel();
    const fs = newFs(fixture, knownHostsPath, {
      privateKey: Buffer.from(key.privateKey),
      passphrase: Buffer.from(wrong),
    });

    const error = await fs.connect().then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RemoteFsError);
    expect((error as RemoteFsError).code).toBe('AUTH_FAILED');
    expect((error as Error).cause).toBeUndefined();
    const text = inspect(error, { depth: Infinity, showHidden: true });
    for (const secret of [passphrase, wrong])
      expect(text).not.toContain(secret);
    expect(text).not.toContain(key.privateKey.split('\n')[1] ?? '');
    expect(fixture.stats.connections).toBe(0);
  });
});

describe('ATK-19: a flood of concurrent operations on one session', () => {
  // The operation count is the attack; the time limit only catches a hang. It stays far above the
  // honest cost, because a loaded host (load 50 on 8 CPUs) needed more than the 5 s default.
  it('500 concurrent stats, lists and small reads all complete correctly', async () => {
    const { fixture, fs } = await connectedPair();
    for (let i = 0; i < 20; i += 1) {
      await writeFile(fixture.local(`/f${i}`), `content-${i}`);
    }

    const results = await Promise.all(
      Array.from({ length: 500 }, async (_, i) => {
        const name = `/f${i % 20}`;
        switch (i % 3) {
          case 0:
            return (await fs.stat(name)).size === `content-${i % 20}`.length;
          case 1:
            return (await fs.list('/')).length === 20;
          default:
            return (
              (await readAll(fs.createReadStream(name))).toString() ===
              `content-${i % 20}`
            );
        }
      }),
    );

    expect(results.every(Boolean)).toBe(true);
    expect(fixture.stats.sessions).toBe(1);
  }, 60_000);
});
