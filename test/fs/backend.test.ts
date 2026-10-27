import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  RemoteFsError,
  createRegistry,
  type RemoteFileSystem,
} from '../../src/fs/index.js';

const nothing: RemoteFileSystem = {
  connect: () => Promise.resolve(),
  disconnect: () => Promise.resolve(),
  list: () => Promise.resolve([]),
  stat: () => Promise.reject(new RemoteFsError('NOT_FOUND', 'none')),
  createReadStream: () => Readable.from([]),
  createWriteStream: () => new Writable({ write: (_c, _e, done) => done() }),
  mkdir: () => Promise.resolve(),
  remove: () => Promise.resolve(),
  rename: () => Promise.resolve(),
};

const endpoint = { host: 'h', port: undefined, username: 'u' };

describe('the back-end registry (src/fs/backend.ts)', () => {
  it('gives a bare factory the defaults: optional credential, known_hosts, every endpoint', () => {
    const registry = createRegistry();
    const factory = (): RemoteFileSystem => nothing;
    registry.register('demo', factory);

    const backend = registry.get('demo');

    expect(backend?.scheme).toBe('demo');
    expect(backend?.create).toBe(factory);
    expect(backend?.credential).toBe('optional');
    expect(backend?.usesKnownHosts).toBe(true);
    expect(() =>
      backend?.checkEndpoint({ ...endpoint, host: '' }),
    ).not.toThrow();
  });

  it('keeps what a full definition declares', () => {
    const registry = createRegistry();
    const checkEndpoint = vi.fn(() => {
      throw new RemoteFsError('INVALID_ARGUMENT', 'no');
    });
    registry.register('demo', {
      create: () => nothing,
      credential: 'none',
      usesKnownHosts: false,
      checkEndpoint,
    });

    const backend = registry.get('demo');

    expect(backend?.credential).toBe('none');
    expect(backend?.usesKnownHosts).toBe(false);
    expect(() => backend?.checkEndpoint(endpoint)).toThrow(RemoteFsError);
    expect(checkEndpoint).toHaveBeenCalledWith(endpoint);
  });

  it.each(['', 'SFTP', 'Demo', '1x', 'a b', 'a:'])(
    'refuses the scheme %j',
    (scheme) => {
      expect(() => createRegistry().register(scheme, () => nothing)).toThrow(
        Error,
      );
    },
  );

  it('refuses a scheme registered twice, so a later entry cannot replace it', () => {
    const registry = createRegistry();
    const first = (): RemoteFileSystem => nothing;
    registry.register('demo', first);

    expect(() => registry.register('demo', () => nothing)).toThrow(
      /already registered/,
    );
    expect(registry.get('demo')?.create).toBe(first);
  });

  it('lists the schemes sorted, and two registries share nothing', () => {
    const one = createRegistry();
    const two = createRegistry();
    one.register('zeta', () => nothing);
    one.register('alpha', () => nothing);

    expect(one.schemes()).toEqual(['alpha', 'zeta']);
    expect(two.schemes()).toEqual([]);
    expect(two.get('alpha')).toBeUndefined();
  });

  it('runs the private-key check that was set, once set, and only one', () => {
    const registry = createRegistry();
    const credential = {
      kind: 'privateKey',
      privateKey: Buffer.from('key'),
      passphrase: undefined,
    } as const;
    expect(() => registry.checkPrivateKey(credential, endpoint)).not.toThrow();

    const check = vi.fn();
    registry.setPrivateKeyCheck(check);
    registry.checkPrivateKey(credential, endpoint);

    expect(check).toHaveBeenCalledWith(credential, endpoint);
    expect(() => registry.setPrivateKeyCheck(vi.fn())).toThrow(/already set/);
  });
});
