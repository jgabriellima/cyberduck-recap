import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RemoteFsError, type BackendTarget } from '../../src/fs/index.js';
import {
  checkSftpPrivateKey,
  sftpBackend,
  sftpOptionsFor,
} from '../../src/sftp/backend.js';
import { validateOptions } from '../../src/sftp/options.js';
import { sentinel } from '../support/harness.js';
import { generateKey } from '../support/sftp-server.js';

function messageOfThrow(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof RemoteFsError) return `${error.code} ${error.message}`;
    throw error;
  }
  return 'no error';
}

function reasonOfThrow(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof RemoteFsError) return error.reason;
    throw error;
  }
  return undefined;
}

const target: BackendTarget = {
  host: 'example.com',
  port: undefined,
  username: 'u',
  credential: { kind: 'password', password: 'p' },
  knownHostsPath: '/k',
  confirmHostKey: undefined,
};

function encryptedPemKey(passphrase: string): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: {
      type: 'pkcs1',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase,
    },
  }).privateKey;
}

describe('the SFTP back-end definition (FEATURE-2 design 1A)', () => {
  it('declares a required credential and known_hosts', () => {
    expect(sftpBackend.credential).toBe('required');
    expect(sftpBackend.usesKnownHosts).toBe(true);
  });

  it.each([
    { host: '', username: 'u', port: undefined },
    { host: 'bad host', username: 'u', port: undefined },
    { host: 'h', username: '', port: undefined },
    { host: 'h', username: 'u', port: 70000 },
  ])('checkEndpoint reports what validateOptions reports (%j)', (endpoint) => {
    const fromEndpoint = messageOfThrow(() =>
      sftpBackend.checkEndpoint?.(endpoint),
    );
    const fromOptions = messageOfThrow(() =>
      validateOptions({
        host: endpoint.host,
        username: endpoint.username,
        port: endpoint.port,
        password: 'p',
        knownHostsPath: '/k',
      }),
    );

    expect(fromEndpoint).toMatch(/^INVALID_ARGUMENT /);
    expect(fromEndpoint).toBe(fromOptions);
  });

  it('leaves a missing port out of the options, so the default 22 applies', () => {
    expect(sftpOptionsFor(target)).not.toHaveProperty('port');
    expect(sftpOptionsFor({ ...target, port: 2222 }).port).toBe(2222);
    expect(validateOptions(sftpOptionsFor(target)).port).toBe(22);
  });

  it('maps each credential kind to its options and nothing else', () => {
    expect(sftpOptionsFor(target)).toEqual({
      host: 'example.com',
      username: 'u',
      knownHostsPath: '/k',
      password: 'p',
    });
    const key = Buffer.from('key');
    expect(
      sftpOptionsFor({
        ...target,
        credential: { kind: 'privateKey', privateKey: key, passphrase: 'x' },
      }),
    ).toEqual({
      host: 'example.com',
      username: 'u',
      knownHostsPath: '/k',
      privateKey: key,
      passphrase: 'x',
    });
  });
});

describe('checkSftpPrivateKey (FEATURE-2 AC-38, design 2A)', () => {
  const endpoint = { host: 'h', port: undefined, username: 'u' };
  const check = (privateKey: string, passphrase?: string) => () =>
    checkSftpPrivateKey(
      { kind: 'privateKey', privateKey: Buffer.from(privateKey), passphrase },
      endpoint,
    );

  it.each([
    ['OpenSSH', (passphrase: string) => generateKey(passphrase).privateKey],
    ['PEM', encryptedPemKey],
  ])('gives the reason for an encrypted %s key', (_format, keyOf) => {
    const passphrase = sentinel();
    const key = keyOf(passphrase);

    expect(reasonOfThrow(check(key))).toBe('PRIVATE_KEY_ENCRYPTED');
    expect(reasonOfThrow(check(key, sentinel()))).toBe(
      'PRIVATE_KEY_PASSPHRASE_WRONG',
    );
    expect(check(key, passphrase)).not.toThrow();
  });

  it.each([
    ['a public key', `${generateKey().publicKey}\n`],
    ['other text', 'hello'],
  ])('gives PRIVATE_KEY_INVALID for %s', (_label, text) => {
    expect(reasonOfThrow(check(text))).toBe('PRIVATE_KEY_INVALID');
    expect(messageOfThrow(check(text))).toMatch(/^AUTH_FAILED /);
  });
});
