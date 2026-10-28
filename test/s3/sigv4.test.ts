/**
 * The fake server's SigV4 verifier (test/support/sigv4.ts) against the four examples AWS
 * publishes for S3 ("Signature Calculations for the Authorization Header: Transferring Payload
 * in a Single Chunk", Amazon S3 API Reference). The server's verdict on every request of AC-23,
 * AC-25, AC-29 and AC-41 rests on this file; these values come from AWS, not from a signer of
 * this project or of the SDK.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalRequest,
  sha256Hex,
  signatureFor,
  verifyRequest,
  type ReceivedRequest,
} from '../support/sigv4.js';

const KEYS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const HOST = 'examplebucket.s3.amazonaws.com';
const AMZ_DATE = '20130524T000000Z';

interface Example {
  readonly name: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly signedHeaders: string[];
  readonly signature: string;
}

const EXAMPLES: readonly Example[] = [
  {
    name: 'GET Object',
    method: 'GET',
    url: '/test.txt',
    headers: {
      host: HOST,
      range: 'bytes=0-9',
      'x-amz-content-sha256': EMPTY_SHA256,
      'x-amz-date': AMZ_DATE,
    },
    signedHeaders: ['host', 'range', 'x-amz-content-sha256', 'x-amz-date'],
    signature:
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  },
  {
    name: 'PUT Object',
    method: 'PUT',
    url: '/test%24file.text',
    headers: {
      date: 'Fri, 24 May 2013 00:00:00 GMT',
      host: HOST,
      'x-amz-content-sha256': sha256Hex('Welcome to Amazon S3.'),
      'x-amz-date': AMZ_DATE,
      'x-amz-storage-class': 'REDUCED_REDUNDANCY',
    },
    signedHeaders: [
      'date',
      'host',
      'x-amz-content-sha256',
      'x-amz-date',
      'x-amz-storage-class',
    ],
    signature:
      '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
  },
  {
    name: 'GET Bucket Lifecycle',
    method: 'GET',
    url: '/?lifecycle',
    headers: {
      host: HOST,
      'x-amz-content-sha256': EMPTY_SHA256,
      'x-amz-date': AMZ_DATE,
    },
    signedHeaders: ['host', 'x-amz-content-sha256', 'x-amz-date'],
    signature:
      'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
  },
  {
    name: 'GET Bucket (List Objects)',
    method: 'GET',
    url: '/?max-keys=2&prefix=J',
    headers: {
      host: HOST,
      'x-amz-content-sha256': EMPTY_SHA256,
      'x-amz-date': AMZ_DATE,
    },
    signedHeaders: ['host', 'x-amz-content-sha256', 'x-amz-date'],
    signature:
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
  },
];

function received(example: Example, signature: string): ReceivedRequest {
  return {
    method: example.method,
    url: example.url,
    headers: {
      ...example.headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${KEYS.accessKeyId}/20130524/us-east-1/s3/aws4_request, ` +
        `SignedHeaders=${example.signedHeaders.join(';')}, Signature=${signature}`,
    },
  };
}

describe("the fake server's SigV4 verifier matches AWS's published S3 examples", () => {
  it("builds the GET Object example's canonical request byte for byte", () => {
    const [example] = EXAMPLES;
    if (example === undefined) throw new Error('no example');
    const canonical = canonicalRequest(
      received(example, '0'.repeat(64)),
      example.signedHeaders,
    );
    expect(canonical).toBe(
      [
        'GET',
        '/test.txt',
        '',
        `host:${HOST}`,
        'range:bytes=0-9',
        `x-amz-content-sha256:${EMPTY_SHA256}`,
        `x-amz-date:${AMZ_DATE}`,
        '',
        'host;range;x-amz-content-sha256;x-amz-date',
        EMPTY_SHA256,
      ].join('\n'),
    );
    expect(sha256Hex(canonical)).toBe(
      '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972',
    );
  });

  for (const example of EXAMPLES) {
    it(`${example.name}: the published signature verifies`, () => {
      const request = received(example, example.signature);
      expect(
        signatureFor(
          request,
          {
            date: '20130524',
            region: 'us-east-1',
            service: 's3',
            signedHeaders: example.signedHeaders,
          },
          KEYS.secretAccessKey,
        ),
      ).toBe(example.signature);
      expect(verifyRequest(request, [KEYS])).toMatchObject({ ok: true });
    });

    it(`${example.name}: one changed signature digit or another secret key is refused`, () => {
      const last = example.signature.endsWith('0') ? '1' : '0';
      const tampered = `${example.signature.slice(0, -1)}${last}`;
      expect(verifyRequest(received(example, tampered), [KEYS])).toMatchObject({
        ok: false,
        code: 'SignatureDoesNotMatch',
      });
      expect(
        verifyRequest(received(example, example.signature), [
          { ...KEYS, secretAccessKey: `${KEYS.secretAccessKey}x` },
        ]),
      ).toMatchObject({ ok: false, code: 'SignatureDoesNotMatch' });
    });
  }
});
