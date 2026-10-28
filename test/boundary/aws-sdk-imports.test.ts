import { describe, expect, it } from 'vitest';
import {
  importsOf,
  resolveSpecifier,
  typeScriptFiles,
} from '../support/imports.js';

// The SDK stays a rewrite of these two places only (FEATURE-3 decision 2).
const ALLOWED = ['src/s3/', 'test/support/'];

function isAwsSdk(specifier: string): boolean {
  return specifier.startsWith('@aws-sdk/') || specifier.startsWith('@smithy/');
}

describe('the AWS SDK is confined to the S3 back-end and the test fixture (AC-2)', () => {
  it('AC-2: no file outside src/s3 and test/support imports @aws-sdk/ or @smithy/', async () => {
    const files = [
      ...(await typeScriptFiles('src')),
      ...(await typeScriptFiles('test')),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      if (ALLOWED.some((prefix) => file.startsWith(prefix))) continue;
      if ((await importsOf(file)).some(isAwsSdk)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('AC-2: no file under src/fs or src/cli imports src/s3', async () => {
    const files = [
      ...(await typeScriptFiles('src/fs')),
      ...(await typeScriptFiles('src/cli')),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const targets = (await importsOf(file)).map((specifier) =>
        resolveSpecifier(file, specifier),
      );
      if (targets.some((target) => target.startsWith('src/s3/'))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('AC-2: the check recognises sub-path, type-only, re-exported and dynamic imports', () => {
    expect(isAwsSdk('@aws-sdk/client-s3')).toBe(true);
    expect(isAwsSdk('@aws-sdk/client-s3/dist-cjs')).toBe(true);
    expect(isAwsSdk('@smithy/node-http-handler')).toBe(true);
    expect(isAwsSdk('aws-sdk-like')).toBe(false);
    const source = [
      "import type { S3Client } from '@aws-sdk/client-s3';",
      "export { NodeHttpHandler } from '@smithy/node-http-handler';",
      "const sdk = await import('@aws-sdk/credential-providers');",
    ].join('\n');
    return importsOfSource(source).then((specifiers) => {
      expect(specifiers.filter(isAwsSdk)).toHaveLength(3);
    });
  });

  it('AC-2: the S3 back-end is where the SDK is actually used', async () => {
    const users: string[] = [];
    for (const file of await typeScriptFiles('src/s3')) {
      if ((await importsOf(file)).some(isAwsSdk)) users.push(file);
    }
    expect(users.length).toBeGreaterThan(0);
  });
});

async function importsOfSource(source: string): Promise<string[]> {
  const { importSpecifiers } = await import('../support/imports.js');
  return importSpecifiers(source);
}
