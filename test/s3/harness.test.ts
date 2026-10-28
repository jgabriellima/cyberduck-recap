/**
 * The fake S3 server's own checks: its signature verdict agrees with AWS's published example, its
 * certificates verify against its authority, and its listing pages as S3 does. The acceptance
 * tests rest on these, so they are proved apart from the back-end.
 */
import { request } from 'node:https';
import { describe, expect, it } from 'vitest';
import {
  canonicalRequest,
  sha256Hex,
  signRequest,
  signatureFor,
  verifyRequest,
} from '../support/sigv4.js';
import { startS3Server, type S3ServerFixture } from '../support/s3-server.js';
import { createTestCa } from '../support/test-ca.js';
import { onTestFinished } from 'vitest';

// AWS's Signature Version 4 test suite, case "get-vanilla" (public example keys, not a secret).
const EXAMPLE = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

async function send(
  server: S3ServerFixture,
  method: string,
  url: string,
  body?: Buffer,
): Promise<Reply> {
  const headers = signRequest(
    {
      method,
      url,
      headers: {
        host: `127.0.0.1:${server.port}`,
        'x-amz-content-sha256': sha256Hex(body ?? ''),
      },
    },
    server.keys,
    'us-east-1',
  );
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        method,
        path: url,
        headers,
        ca: server.ca.cert,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function useServer(
  options: Parameters<typeof startS3Server>[0] = {},
): Promise<S3ServerFixture> {
  const server = await startS3Server(options);
  onTestFinished(() => server.close());
  return server;
}

describe('the fake S3 server (FEATURE-3 decision 4)', () => {
  it("verifies signatures as AWS's get-vanilla example does", () => {
    const received = {
      method: 'GET',
      url: '/',
      headers: {
        host: 'example.amazonaws.com',
        'x-amz-date': '20150830T123600Z',
      },
    };
    const scope = {
      date: '20150830',
      region: 'us-east-1',
      service: 'service',
      signedHeaders: ['host', 'x-amz-date'],
    };
    expect(canonicalRequest(received, scope.signedHeaders)).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-date',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n'),
    );
    const signature = signatureFor(received, scope, EXAMPLE.secretAccessKey);
    expect(signature).toBe(
      '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    const authorization = `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=${signature}`;
    expect(
      verifyRequest(
        { ...received, headers: { ...received.headers, authorization } },
        [EXAMPLE],
      ).ok,
    ).toBe(true);
    expect(
      verifyRequest(
        { ...received, headers: { ...received.headers, authorization } },
        [{ ...EXAMPLE, secretAccessKey: 'wrong' }],
      ),
    ).toMatchObject({ ok: false, code: 'SignatureDoesNotMatch' });
  });

  it('serves TLS with a certificate that its authority verifies, and records requests', async () => {
    const server = await useServer();
    server.addBucket('b');
    const put = await send(server, 'PUT', '/b/a%20b', Buffer.from('hello'));
    expect(put.status).toBe(200);
    const get = await send(server, 'GET', '/b/a%20b');
    expect(get).toMatchObject({ status: 200, body: 'hello' });
    expect(server.requests.map((r) => [r.operation, r.key])).toEqual([
      ['PutObject', 'a b'],
      ['GetObject', 'a b'],
    ]);
    expect(server.requests.every((r) => r.signatureValid)).toBe(true);
  });

  it('refuses a request signed with another key', async () => {
    const server = await useServer();
    const other = await useServer();
    const headers = signRequest(
      {
        method: 'GET',
        url: '/',
        headers: { host: `127.0.0.1:${server.port}` },
      },
      other.keys,
      'us-east-1',
    );
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/',
          headers,
          ca: server.ca.cert,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('pages ListObjectsV2 with a delimiter as S3 does', async () => {
    const server = await useServer({ listPageSize: 2 });
    for (const key of ['a', 'd/1', 'd/2', 'e', 'f/x', 'g']) {
      server.putObject('b', key, '');
    }
    const seen: string[] = [];
    let token: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const query = `list-type=2&delimiter=%2F${token === undefined ? '' : `&continuation-token=${encodeURIComponent(token)}`}`;
      const reply = await send(server, 'GET', `/b?${query}`);
      expect(reply.status).toBe(200);
      seen.push(
        ...[...reply.body.matchAll(/<(?:Key|Prefix)>([^<]+)<\//g)].map(
          (match) => match[1] ?? '',
        ),
      );
      token = /<NextContinuationToken>([^<]+)</.exec(reply.body)?.[1];
      if (token === undefined) break;
    }
    expect(seen.filter((entry) => entry !== '')).toEqual([
      'a',
      'd/',
      'e',
      'f/',
      'g',
    ]);
  });

  it('issues expired and other-host certificates that parse', () => {
    const ca = createTestCa();
    const expired = ca.issue({
      hosts: ['127.0.0.1'],
      notBefore: new Date('2024-01-01T00:00:00Z'),
      notAfter: new Date('2025-01-01T00:00:00Z'),
    });
    expect(expired.notAfter.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(ca.issue({ hosts: ['other.example'] }).cert).toContain(
      'BEGIN CERTIFICATE',
    );
  });
});
