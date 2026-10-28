/**
 * AWS Signature Version 4 for the fake S3 server: it rebuilds the canonical request from what it
 * received and checks the `Authorization` header against the keys the test gave it. The S3
 * rules apply: the path is signed as it was sent (no second encoding, no normalisation), the
 * payload hash is the `x-amz-content-sha256` header. `test/s3/sigv4.test.ts` checks this file
 * against AWS's four published S3 examples, so the server's verdict does not rest on the
 * back-end's own signer or the SDK's (design Option 9E).
 */
import { createHash, createHmac } from 'node:crypto';

export interface SigningKeys {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface ReceivedRequest {
  readonly method: string;
  /** The request target as received: raw path and raw query. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface ParsedAuthorization {
  readonly accessKeyId: string;
  readonly date: string;
  readonly region: string;
  readonly service: string;
  readonly signedHeaders: readonly string[];
  readonly signature: string;
}

export type Verdict =
  | {
      readonly ok: true;
      readonly authorization: ParsedAuthorization;
      readonly keys: SigningKeys;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'MissingSecurityHeader'
        | 'AuthorizationHeaderMalformed'
        | 'InvalidAccessKeyId'
        | 'InvalidToken'
        | 'SignatureDoesNotMatch';
      readonly authorization?: ParsedAuthorization;
    };

const AUTH_PATTERN =
  /^AWS4-HMAC-SHA256 Credential=([^/,\s]+)\/(\d{8})\/([^/,\s]+)\/([^/,\s]+)\/aws4_request,\s*SignedHeaders=([^,\s]+),\s*Signature=([0-9a-f]{64})$/;

export function parseAuthorization(
  header: string | undefined,
): ParsedAuthorization | undefined {
  if (header === undefined) return undefined;
  const match = AUTH_PATTERN.exec(header.trim());
  if (match === null) return undefined;
  const [, accessKeyId, date, region, service, signed, signature] = match;
  if (
    accessKeyId === undefined ||
    date === undefined ||
    region === undefined ||
    service === undefined ||
    signed === undefined ||
    signature === undefined
  ) {
    return undefined;
  }
  return {
    accessKeyId,
    date,
    region,
    service,
    signedHeaders: signed.split(';'),
    signature,
  };
}

/** Checks one received request against the keys the server accepts. */
export function verifyRequest(
  request: ReceivedRequest,
  accepted: readonly SigningKeys[],
): Verdict {
  const authorization = parseAuthorization(header(request, 'authorization'));
  if (authorization === undefined) {
    return header(request, 'authorization') === undefined
      ? { ok: false, code: 'MissingSecurityHeader' }
      : { ok: false, code: 'AuthorizationHeaderMalformed' };
  }
  const candidates = accepted.filter(
    (keys) => keys.accessKeyId === authorization.accessKeyId,
  );
  if (candidates.length === 0) {
    return { ok: false, code: 'InvalidAccessKeyId', authorization };
  }
  const token = header(request, 'x-amz-security-token');
  let tokenMismatch = false;
  for (const keys of candidates) {
    if ((keys.sessionToken ?? undefined) !== token) {
      tokenMismatch = true;
      continue;
    }
    const expected = signatureFor(request, authorization, keys.secretAccessKey);
    if (expected === authorization.signature) {
      return { ok: true, authorization, keys };
    }
  }
  return tokenMismatch
    ? { ok: false, code: 'InvalidToken', authorization }
    : { ok: false, code: 'SignatureDoesNotMatch', authorization };
}

/** The signature a request with these signed headers must carry. */
export function signatureFor(
  request: ReceivedRequest,
  authorization: Pick<
    ParsedAuthorization,
    'date' | 'region' | 'service' | 'signedHeaders'
  >,
  secretAccessKey: string,
): string {
  const amzDate = header(request, 'x-amz-date') ?? '';
  const scope = `${authorization.date}/${authorization.region}/${authorization.service}/aws4_request`;
  const canonical = canonicalRequest(request, authorization.signedHeaders);
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonical),
  ].join('\n');
  let key: Buffer = hmac(`AWS4${secretAccessKey}`, authorization.date);
  key = hmac(key, authorization.region);
  key = hmac(key, authorization.service);
  key = hmac(key, 'aws4_request');
  return createHmac('sha256', key).update(stringToSign).digest('hex');
}

export function canonicalRequest(
  request: ReceivedRequest,
  signedHeaders: readonly string[],
): string {
  const queryAt = request.url.indexOf('?');
  const rawPath = queryAt === -1 ? request.url : request.url.slice(0, queryAt);
  const rawQuery = queryAt === -1 ? '' : request.url.slice(queryAt + 1);
  const headers = signedHeaders
    .map((name) => `${name}:${canonicalValue(request.headers[name])}\n`)
    .join('');
  return [
    request.method.toUpperCase(),
    rawPath === '' ? '/' : rawPath,
    canonicalQuery(rawQuery),
    headers,
    signedHeaders.join(';'),
    header(request, 'x-amz-content-sha256') ?? sha256Hex(''),
  ].join('\n');
}

function canonicalQuery(raw: string): string {
  if (raw === '') return '';
  const pairs = raw
    .split('&')
    .filter((part) => part !== '')
    .map((part) => {
      const at = part.indexOf('=');
      const name = at === -1 ? part : part.slice(0, at);
      const value = at === -1 ? '' : part.slice(at + 1);
      return [escape(decode(name)), escape(decode(value))] as const;
    })
    .filter(([name]) => name !== 'X-Amz-Signature');
  pairs.sort(([a, x], [b, y]) =>
    a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0,
  );
  return pairs.map(([name, value]) => `${name}=${value}`).join('&');
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** RFC 3986 unreserved characters stay; every other byte is %XX in upper case. */
export function escape(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

function canonicalValue(value: string | string[] | undefined): string {
  const joined = Array.isArray(value) ? value.join(',') : (value ?? '');
  return joined.trim().replace(/\s+/g, ' ');
}

function header(request: ReceivedRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * Signs a request the way an S3 client does, for tests that send a request of their own (a
 * request with a wrong key, AC-25) and for the self-check of this file.
 */
export function signRequest(
  request: {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
  },
  keys: SigningKeys,
  region: string,
  service = 's3',
  now = new Date(),
): Record<string, string> {
  const amzDate = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...lowerCase(request.headers),
    'x-amz-date': amzDate,
  };
  headers['x-amz-content-sha256'] ??= sha256Hex('');
  if (keys.sessionToken !== undefined) {
    headers['x-amz-security-token'] = keys.sessionToken;
  }
  const signedHeaders = Object.keys(headers).sort();
  const signature = signatureFor(
    { method: request.method, url: request.url, headers },
    { date, region, service, signedHeaders },
    keys.secretAccessKey,
  );
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${keys.accessKeyId}/${date}/${region}/${service}/aws4_request, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;
  return headers;
}

function lowerCase(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = value;
  }
  return out;
}
