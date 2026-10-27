import { describe, expect, it } from 'vitest';
import { generateKey } from '../support/sftp-server.js';
import {
  newFs,
  sentinel,
  trustingKnownHosts,
  useServer,
} from '../support/harness.js';
import { expectRejects } from '../support/remote-fs-assertions.js';

describe('SftpFileSystem authentication (AC-4, AC-5, AC-26)', () => {
  it('AC-4: connects with an unencrypted private key', async () => {
    const userKey = generateKey();
    const fixture = await useServer({ authorizedKeys: [userKey] });
    const fs = newFs(fixture, await trustingKnownHosts(fixture), {
      privateKey: userKey.privateKey,
    });

    await fs.connect();

    expect(fixture.stats.sessions).toBe(1);
    await expect(fs.list('/')).resolves.toEqual([]);
  });

  it('AC-4: connects with an encrypted private key and its passphrase, given as a Buffer', async () => {
    const passphrase = sentinel();
    const userKey = generateKey(passphrase);
    const fixture = await useServer({ authorizedKeys: [userKey] });
    const fs = newFs(fixture, await trustingKnownHosts(fixture), {
      privateKey: Buffer.from(userKey.privateKey),
      passphrase,
    });

    await fs.connect();

    expect(fixture.stats.sessions).toBe(1);
  });

  it('AC-5: a wrong password is AUTH_FAILED and the instance stays disconnected', async () => {
    const fixture = await useServer({ password: sentinel() });
    const fs = newFs(fixture, await trustingKnownHosts(fixture), {
      password: sentinel(),
    });

    await expectRejects(fs.connect(), 'AUTH_FAILED');

    expect(fixture.stats.sessions).toBe(0);
    await expectRejects(fs.list('/'), 'NOT_CONNECTED');
  });

  it('AC-5: a private key the server does not accept is AUTH_FAILED', async () => {
    const fixture = await useServer({ authorizedKeys: [generateKey()] });
    const fs = newFs(fixture, await trustingKnownHosts(fixture), {
      privateKey: generateKey().privateKey,
    });

    await expectRejects(fs.connect(), 'AUTH_FAILED');

    expect(fixture.stats.authAttempts).toBeGreaterThan(0);
    await expectRejects(fs.list('/'), 'NOT_CONNECTED');
  });

  it('AC-5: an encrypted key with a wrong passphrase is AUTH_FAILED', async () => {
    const userKey = generateKey(sentinel());
    const fixture = await useServer({ authorizedKeys: [userKey] });
    const fs = newFs(fixture, await trustingKnownHosts(fixture), {
      privateKey: userKey.privateKey,
      passphrase: sentinel(),
    });

    const error = await expectRejects(fs.connect(), 'AUTH_FAILED');

    expect(error.message).toMatch(/could not be decrypted/);
    expect(error.reason).toBe('PRIVATE_KEY_PASSPHRASE_WRONG');
    await expectRejects(fs.list('/'), 'NOT_CONNECTED');
  });

  it('AC-5: an encrypted key without its passphrase is AUTH_FAILED', async () => {
    const userKey = generateKey(sentinel());
    const fixture = await useServer({ authorizedKeys: [userKey] });
    const fs = newFs(fixture, await trustingKnownHosts(fixture), {
      privateKey: userKey.privateKey,
    });

    const error = await expectRejects(fs.connect(), 'AUTH_FAILED');
    expect(error.message).toMatch(/encrypted and no passphrase was given/);
    expect(error.reason).toBe('PRIVATE_KEY_ENCRYPTED');
    expect(fixture.stats.authAttempts).toBe(0);
  });

  it.each([
    ['a file path instead of the key contents', '/var/keys/id_ed25519'],
    ['arbitrary text', 'this is not a key'],
    ['a public key', generateKey().publicKey],
  ])(
    'AC-26: a privateKey holding %s is AUTH_FAILED before any authentication attempt',
    async (_label, privateKey) => {
      const fixture = await useServer({ authorizedKeys: [generateKey()] });
      const fs = newFs(fixture, await trustingKnownHosts(fixture), {
        privateKey,
      });

      const error = await expectRejects(fs.connect(), 'AUTH_FAILED');

      expect(error.message).toMatch(/private key could not be parsed/);
      expect(error.reason).toBe('PRIVATE_KEY_INVALID');
      expect(fixture.stats.authAttempts).toBe(0);
      expect(fixture.stats.connections).toBe(0);
    },
  );
});
