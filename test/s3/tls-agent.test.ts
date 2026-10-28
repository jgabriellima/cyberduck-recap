/**
 * The HTTPS agent of an instance (design Options 5A and 10B): verification on, no socket queue,
 * and the trusted authorities from `ca`, else `AWS_CA_BUNDLE`, else Node's own store.
 */
import { rootCertificates } from 'node:tls';
import { describe, expect, it } from 'vitest';
import {
  createAgent,
  TrustProblem,
  trustedAuthorities,
} from '../../src/s3/tls.js';
import { useAwsEnv } from '../support/aws-env.js';
import { createTestCa } from '../support/test-ca.js';

describe('the HTTPS agent', () => {
  it('verifies, never queues a request for a socket, and keeps 16 idle sockets', () => {
    const agent = createAgent(undefined, undefined);
    expect(agent.options).toMatchObject({
      rejectUnauthorized: true,
      keepAlive: true,
      maxSockets: Infinity,
      maxFreeSockets: 16,
    });
    expect(agent.options).not.toHaveProperty('ca');
    agent.destroy();
  });

  it('trusts the option ca beside the bundled roots, and it replaces AWS_CA_BUNDLE', async () => {
    const ca = createTestCa().cert;
    const trusted = await trustedAuthorities(ca, {
      AWS_CA_BUNDLE: '/no/such/file',
    });
    expect(trusted).toEqual([...rootCertificates, ca]);
  });

  it('reads AWS_CA_BUNDLE and refuses a file that is missing or holds no certificate', async () => {
    const env = await useAwsEnv();
    const ca = createTestCa().cert;
    const good = await env.file('ca.pem', ca);
    expect(
      await trustedAuthorities(undefined, { AWS_CA_BUNDLE: good }),
    ).toHaveLength(rootCertificates.length + 1);
    const bad = await env.file('bad.pem', 'not a certificate');
    await expect(
      trustedAuthorities(undefined, { AWS_CA_BUNDLE: bad }),
    ).rejects.toThrow(TrustProblem);
    await expect(
      trustedAuthorities(undefined, {
        AWS_CA_BUNDLE: `${env.dir}/missing.pem`,
      }),
    ).rejects.toThrow(/does not exist/);
    expect(await trustedAuthorities(undefined, {})).toBeUndefined();
  });
});
