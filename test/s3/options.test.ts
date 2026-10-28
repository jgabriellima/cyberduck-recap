import { describe, expect, it } from 'vitest';
import { RemoteFsError } from '../../src/fs/index.js';
import { sentinel } from '../support/harness.js';
import { loadS3FileSystem, useS3 } from '../support/s3.js';

describe('new S3FileSystem(options) validates its options (AC-4)', () => {
  it('AC-4: each bad option throws INVALID_ARGUMENT that names it, with no request and no secret', async () => {
    const setup = await useS3();
    const { server } = setup;
    const S3FileSystem = await loadS3FileSystem();
    const secret = sentinel();
    const token = sentinel();
    const urlPassword = sentinel();
    const keys = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: secret };
    const port = server.port;
    const cases: [string, Record<string, unknown>][] = [
      ['rejectUnauthorized', { rejectUnauthorized: false }],
      ['insecure', { insecure: true }],
      ['bucket', { bucket: '' }],
      ['bucket', { bucket: 42 }],
      ['bucket', { bucket: 'a/b' }],
      ['endpoint', { endpoint: 'not a url' }],
      ['endpoint', { endpoint: `http://127.0.0.1:${port}` }],
      ['endpoint', { endpoint: `https://u:${urlPassword}@host` }],
      ['endpoint', { endpoint: 'https://host/path' }],
      ['endpoint', { endpoint: 'https://host/?q' }],
      ['endpoint', { endpoint: 'https://host/#f' }],
      ['region', { region: '' }],
      ['region', { region: 'EU WEST' }],
      ['credentials', { credentials: { secretAccessKey: secret } }],
      ['credentials', { credentials: { accessKeyId: 'AKIAEXAMPLE' } }],
      ['credentials', { credentials: { ...keys, accessKeyId: '' } }],
      ['credentials', { credentials: { ...keys, secretAccessKey: '' } }],
      ['credentials', { credentials: { ...keys, accessKeyId: 7 } }],
      ['credentials', { credentials: { ...keys, secretAccessKey: 7 } }],
      ['sessionToken', { credentials: { ...keys, sessionToken: 7 } }],
      ['profile', { profile: '' }],
      ['ca', { ca: 5 }],
      ['timeoutMs', { timeoutMs: 0 }],
      ['timeoutMs', { timeoutMs: -1 }],
      ['timeoutMs', { timeoutMs: 1.5 }],
      ['timeoutMs', { timeoutMs: '30000' }],
    ];
    for (const [option, bad] of cases) {
      // A valid base with the secrets present, so a message that echoed options would show them.
      const options = {
        endpoint: server.endpoint,
        credentials: { ...keys, sessionToken: token },
        ...bad,
      };
      let thrown: unknown;
      try {
        new S3FileSystem(options);
      } catch (error) {
        thrown = error;
      }
      const label = `${option} ${JSON.stringify(bad).replaceAll(secret, '<s>')}`;
      expect(thrown, label).toBeInstanceOf(RemoteFsError);
      const error = thrown as RemoteFsError;
      expect(error.code, label).toBe('INVALID_ARGUMENT');
      expect(error.message, label).toContain(option);
      for (const value of [secret, token, urlPassword]) {
        expect(error.message, label).not.toContain(value);
      }
    }
    expect(server.requests).toEqual([]);
    expect(server.counts.tcp).toBe(0);
  });
});
