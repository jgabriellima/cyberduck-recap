import { describe, expect, it } from 'vitest';
import { RemoteFsError, SftpFileSystem } from '../../src/index.js';
import { generateKey } from '../support/sftp-server.js';
import { sentinel, useServer } from '../support/harness.js';

const password = sentinel();
const passphrase = sentinel();
const privateKey = generateKey(passphrase).privateKey;

function constructionError(options: Record<string, unknown>): RemoteFsError {
  let thrown: unknown;
  try {
    new SftpFileSystem(options as never);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RemoteFsError);
  return thrown as RemoteFsError;
}

describe('option validation (AC-25)', () => {
  const cases: [string, string, Record<string, unknown>][] = [
    ['both password and privateKey', 'password', { password, privateKey }],
    ['neither password nor privateKey', 'password', {}],
    ['host missing', 'host', { password, host: undefined }],
    ['host empty', 'host', { password, host: '' }],
    ['host a number', 'host', { password, host: 127 }],
    ['username missing', 'username', { password, username: undefined }],
    ['username empty', 'username', { password, username: '' }],
    ['username a number', 'username', { password, username: 42 }],
    ['port 0', 'port', { password, port: 0 }],
    ['port 65536', 'port', { password, port: 65536 }],
    ['port the string "22"', 'port', { password, port: '22' }],
    ['port not an integer', 'port', { password, port: 22.5 }],
    ['passphrase without privateKey', 'passphrase', { password, passphrase }],
    [
      'confirmHostKey not a function',
      'confirmHostKey',
      { password, confirmHostKey: true },
    ],
    [
      'connectTimeoutMs 0',
      'connectTimeoutMs',
      { password, connectTimeoutMs: 0 },
    ],
    [
      'connectTimeoutMs negative',
      'connectTimeoutMs',
      { password, connectTimeoutMs: -5 },
    ],
    [
      'privateKey of the wrong type',
      'privateKey',
      { privateKey: 12, passphrase },
    ],
    ['password of the wrong type', 'password', { password: 12 }],
    [
      'an unknown key next to a key credential',
      'hostVerifier',
      { privateKey, passphrase, hostVerifier: () => true },
    ],
  ];

  it.each(cases)(
    '%s throws INVALID_ARGUMENT naming the option, without secrets, and opens no connection',
    async (_label, option, overrides) => {
      const fixture = await useServer({ password });
      const options: Record<string, unknown> = {
        host: fixture.host,
        port: fixture.port,
        username: 'tester',
        knownHostsPath: '/tmp/known_hosts-never-read',
        ...overrides,
      };
      for (const key of Object.keys(options)) {
        if (options[key] === undefined) delete options[key];
      }

      const error = constructionError(options);

      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.message).toContain(`"${option}"`);
      for (const secret of [password, passphrase, privateKey]) {
        expect(error.message).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
      }
      expect(fixture.stats.connections).toBe(0);
    },
  );

  it('options that are not an object are INVALID_ARGUMENT', () => {
    expect(constructionError(null as never).code).toBe('INVALID_ARGUMENT');
  });

  it('accepts a complete password configuration and the defaults', () => {
    expect(
      () =>
        new SftpFileSystem({
          host: 'example.org',
          username: 'tester',
          password,
          knownHostsPath: '/tmp/known_hosts',
        }),
    ).not.toThrow();
  });
});
