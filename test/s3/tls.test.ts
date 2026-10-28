/**
 * TLS verification (FEATURE-3 AC-26, decision 3): every certificate fault fails before any HTTP
 * request, nothing turns the check off, and a private authority is trusted only through `ca`,
 * `AWS_CA_BUNDLE` or `NODE_EXTRA_CA_CERTS`.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_HOSTS } from '../support/s3-server.js';
import { createTestCa } from '../support/test-ca.js';
import {
  rejection,
  runChildConnect,
  useS3,
  type S3Setup,
} from '../support/s3.js';

const EXPIRY = new Date('2025-01-01T00:00:00Z');
// Words that would tell the person to switch verification off: no message may hold them.
const TURN_OFF =
  /NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized|insecure|--no-verify|verify\s*=\s*false/i;

type Case = 'untrusted' | 'expired' | 'other-host';

async function serverFor(kind: Case): Promise<S3Setup> {
  const ca = createTestCa();
  switch (kind) {
    case 'untrusted':
      // Issued by an authority the client is never given.
      return useS3({ ca: createTestCa('untrusted test CA') });
    case 'expired':
      return useS3({
        ca,
        certificate: ca.issue({
          hosts: DEFAULT_HOSTS,
          notBefore: new Date('2024-01-01T00:00:00Z'),
          notAfter: EXPIRY,
        }),
      });
    case 'other-host':
      return useS3({ ca, certificate: ca.issue({ hosts: ['other.example'] }) });
  }
}

function clientOptions(kind: Case): Record<string, unknown> {
  // For the untrusted case the client trusts another authority, never the server's.
  return kind === 'untrusted' ? { ca: createTestCa().cert } : {};
}

function expectCause(kind: Case, message: string): void {
  switch (kind) {
    case 'untrusted':
      expect(message).toMatch(/not trusted/);
      expect(message).toContain('AWS_CA_BUNDLE');
      expect(message).toMatch(/\bca\b/);
      break;
    case 'expired':
      expect(message).toMatch(/expired/);
      expect(message).toContain('2025-01-01T00:00:00Z');
      break;
    case 'other-host':
      expect(message).toContain('127.0.0.1');
      break;
  }
  expect(message).not.toMatch(TURN_OFF);
}

describe('S3 TLS verification (AC-26)', () => {
  for (const kind of ['untrusted', 'expired', 'other-host'] as const) {
    for (const rejectOff of [false, true]) {
      it(`AC-26: a ${kind} certificate fails CONNECTION_FAILED before any request${rejectOff ? ', also with NODE_TLS_REJECT_UNAUTHORIZED=0' : ''}`, async () => {
        const setup = await serverFor(kind);
        if (rejectOff) setup.env.set({ NODE_TLS_REJECT_UNAUTHORIZED: '0' });
        const fs = await setup.s3(clientOptions(kind));

        const error = await rejection(fs.connect(), 'CONNECTION_FAILED');

        expectCause(kind, error.message);
        expect(setup.server.requests).toEqual([]);
      });
    }
  }

  it('AC-26: the test authority given in ca is trusted', async () => {
    const setup = await useS3();
    const fs = await setup.s3({ ca: setup.server.ca.cert });
    await fs.connect();
    expect(setup.server.requests).toHaveLength(1);
  });

  it('AC-26: the test authority in a file named by AWS_CA_BUNDLE is trusted', async () => {
    const setup = await useS3();
    const bundle = await setup.env.file('ca.pem', setup.server.ca.cert);
    setup.env.set({ AWS_CA_BUNDLE: bundle });
    const fs = await setup.s3({ ca: undefined });
    await fs.connect();
    expect(setup.server.requests).toHaveLength(1);
  });

  it('AC-26: the test authority in NODE_EXTRA_CA_CERTS is trusted (child process)', async () => {
    const setup = await useS3();
    const bundle = await setup.env.file('extra.pem', setup.server.ca.cert);
    const result = await runChildConnect({
      NODE_EXTRA_CA_CERTS: bundle,
      HOME: setup.env.home,
      AWS_SHARED_CREDENTIALS_FILE: setup.env.credentialsFile,
      AWS_CONFIG_FILE: setup.env.configFile,
      AWS_EC2_METADATA_DISABLED: 'true',
      S3_CHILD_OPTIONS: JSON.stringify({
        endpoint: setup.server.endpoint,
        region: 'us-east-1',
        credentials: setup.server.keys,
      }),
    });
    expect(result.stdout.trim()).toBe('connected');
    expect(result.code).toBe(0);
    expect(setup.server.requests).toHaveLength(1);
  }, 30_000);

  it('AC-26: ca replaces AWS_CA_BUNDLE', async () => {
    const setup = await useS3();
    const bundle = await setup.env.file('ca.pem', setup.server.ca.cert);
    setup.env.set({ AWS_CA_BUNDLE: bundle });
    const fs = await setup.s3({ ca: createTestCa('another CA').cert });
    await rejection(fs.connect(), 'CONNECTION_FAILED');
    expect(setup.server.requests).toEqual([]);
  });

  it('AC-26: an AWS_CA_BUNDLE file that does not exist fails and sends no request', async () => {
    const setup = await useS3();
    const missing = `${setup.env.dir}/no-such-bundle.pem`;
    setup.env.set({ AWS_CA_BUNDLE: missing });
    const fs = await setup.s3({ ca: undefined });
    const error = await rejection(fs.connect(), 'CONNECTION_FAILED');
    expect(error.message).toContain('AWS_CA_BUNDLE');
    expect(setup.server.requests).toEqual([]);
  });

  it('AC-26: an AWS_CA_BUNDLE file with no valid PEM certificate fails and sends no request', async () => {
    const setup = await useS3();
    const bundle = await setup.env.file('bad.pem', 'not a certificate');
    setup.env.set({ AWS_CA_BUNDLE: bundle });
    const fs = await setup.s3({ ca: undefined });
    const error = await rejection(fs.connect(), 'CONNECTION_FAILED');
    expect(error.message).toContain('AWS_CA_BUNDLE');
    expect(error.message).toContain(bundle);
    expect(error.message).toContain('no valid PEM certificate');
    expect(setup.server.requests).toEqual([]);
  });
});
