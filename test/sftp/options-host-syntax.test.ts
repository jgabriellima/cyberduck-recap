import { describe, expect, it } from 'vitest';
import { RemoteFsError, SftpFileSystem } from '../../src/index.js';

function construct(host: string): unknown {
  try {
    new SftpFileSystem({
      host,
      username: 'tester',
      password: 'dummy-password',
      knownHostsPath: '/tmp/known_hosts',
    });
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('host syntax (G-1)', () => {
  it.each([
    'example.org',
    'sftp-01.internal.example',
    'under_score.example',
    'localhost',
    '127.0.0.1',
    '::1',
    '2001:db8::7',
    'A.EXAMPLE.ORG',
    `${'a'.repeat(63)}.example`,
  ])('accepts %s', (host) => {
    expect(construct(host)).toBeUndefined();
  });

  it.each([
    ['a host list', 'a.example,b.example'],
    ['a newline', 'a.example\nb.example ssh-ed25519 AAAA'],
    ['a space', 'a.example b'],
    ['a pipe (hashed-entry marker)', '|1|abc'],
    ['brackets', '[a.example]:22'],
    ['a wildcard', '*.example'],
    ['a question mark', 'host?.example'],
    ['a negation', '!a.example'],
    ['a trailing dot (empty label)', 'a.example.'],
    ['an empty label', 'a..example'],
    ['a label starting with a hyphen', '-a.example'],
    ['a label ending with a hyphen', 'a-.example'],
    ['a label of 64 characters', `${'a'.repeat(64)}.example`],
    ['a name of 254 characters', `${'a.'.repeat(126)}ab`],
    ['an IPv6 zone id', 'fe80::1%en0'],
    ['a port suffix', 'a.example:22'],
  ])(
    'refuses %s with INVALID_ARGUMENT naming host, never its value',
    (_label, host) => {
      const error = construct(host);

      expect(error).toBeInstanceOf(RemoteFsError);
      expect((error as RemoteFsError).code).toBe('INVALID_ARGUMENT');
      expect((error as RemoteFsError).message).toContain('"host"');
      expect((error as RemoteFsError).message).not.toContain(host);
    },
  );
});
