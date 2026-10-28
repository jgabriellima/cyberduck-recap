/** The request policy table and the redirect rule, with no SDK (design Decision 13, MA-12). */
import { describe, expect, it } from 'vitest';
import {
  REQUEST_POLICY,
  redirectRegion,
  sendsOnce,
  serverWorkIdleMs,
} from '../../src/s3/request-policy.js';
import type { S3Failure } from '../../src/s3/transport.js';

const COMMANDS = [
  'listBuckets',
  'listObjects',
  'headObject',
  'getObject',
  'putObject',
  'createMultipartUpload',
  'uploadPart',
  'completeMultipartUpload',
  'abortMultipartUpload',
  'copyObject',
  'deleteObject',
  'createBucket',
  'deleteBucket',
] as const;

function reply(
  status: number,
  code: string | undefined,
  bucketRegion?: string,
): S3Failure {
  return {
    kind: 'reply',
    status,
    code,
    serverMessage: undefined,
    bucketRegion,
  };
}

describe('the request policy (design "Request policy")', () => {
  it('has one row for every command of S3Transport', () => {
    expect(Object.keys(REQUEST_POLICY).sort()).toEqual([...COMMANDS].sort());
  });

  it('sends a creating request once only when it is exclusive; CopyObject always once', () => {
    for (const command of COMMANDS) {
      const once = command === 'copyObject';
      const onceWhenExclusive =
        command === 'putObject' || command === 'completeMultipartUpload';
      expect(sendsOnce(command, false), command).toBe(once);
      expect(sendsOnce(command, true), command).toBe(once || onceWhenExclusive);
    }
  });

  it('gives the long idle bound to the completion and the copy only', () => {
    const serverWork = COMMANDS.filter(
      (command) => REQUEST_POLICY[command].idle === 'server-work',
    );
    expect(serverWork.sort()).toEqual([
      'completeMultipartUpload',
      'copyObject',
    ]);
    expect(serverWorkIdleMs(300)).toBe(600_000);
    expect(serverWorkIdleMs(900_000)).toBe(900_000);
  });

  it('records the attempts of the creating requests, and cuts no abort or completion', () => {
    const recorded = COMMANDS.filter(
      (command) => REQUEST_POLICY[command].recordAttempts,
    );
    expect(recorded.sort()).toEqual([
      'completeMultipartUpload',
      'copyObject',
      'putObject',
    ]);
    const unsignalled = COMMANDS.filter(
      (command) => !REQUEST_POLICY[command].signal,
    );
    expect(unsignalled.sort()).toEqual([
      'abortMultipartUpload',
      'completeMultipartUpload',
      'createMultipartUpload',
    ]);
  });
});

describe('redirectRegion (design Option 3B)', () => {
  it('follows a 301 or a 400 IllegalLocationConstraintException with a valid region', () => {
    expect(redirectRegion(reply(301, 'PermanentRedirect', 'eu-west-1'))).toBe(
      'eu-west-1',
    );
    expect(redirectRegion(reply(301, undefined, 'ap-south-1'))).toBe(
      'ap-south-1',
    );
    expect(
      redirectRegion(
        reply(400, 'IllegalLocationConstraintException', 'eu-central-1'),
      ),
    ).toBe('eu-central-1');
  });

  it.each(['', 'EU-WEST-1', 'x'.repeat(64), 'evil.com#'])(
    'refuses the region %j',
    (region) => {
      expect(
        redirectRegion(reply(301, 'PermanentRedirect', region)),
      ).toBeUndefined();
    },
  );

  it('follows nothing without the header, for another status, or for no reply', () => {
    expect(redirectRegion(reply(301, 'PermanentRedirect'))).toBeUndefined();
    expect(
      redirectRegion(reply(400, 'InvalidRequest', 'eu-west-1')),
    ).toBeUndefined();
    expect(
      redirectRegion(reply(307, 'TemporaryRedirect', 'eu-west-1')),
    ).toBeUndefined();
    expect(
      redirectRegion({ kind: 'no-reply', errno: 'ECONNRESET', timeout: false }),
    ).toBeUndefined();
  });
});
