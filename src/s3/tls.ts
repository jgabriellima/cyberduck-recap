/**
 * TLS of the S3 back-end (design Option 5A): every socket that carries a request verifies the
 * certificate and the host name; `rejectUnauthorized: true` is set explicitly, so
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` has no effect. A private authority is trusted only through the
 * option `ca`, `AWS_CA_BUNDLE` or Node's `NODE_EXTRA_CA_CERTS`.
 */
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Agent } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import tls from 'node:tls';
import { errnoOf } from '../fs/errors.js';

const UNTRUSTED_CODES: ReadonlySet<string> = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
]);
const EXPIRED_CODE = 'CERT_HAS_EXPIRED';
const HOST_CODE = 'ERR_TLS_CERT_ALTNAME_INVALID';
const OTHER_TLS_CODES: ReadonlySet<string> = new Set([
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_REJECTED',
  'INVALID_CA',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO',
]);

export type TlsCause = 'untrusted' | 'expired' | 'host' | 'other';

/** The cause of a failure by its Node code; `undefined` when it is not a TLS failure. */
export function tlsCauseOf(errno: string | undefined): TlsCause | undefined {
  if (errno === undefined) return undefined;
  if (UNTRUSTED_CODES.has(errno)) return 'untrusted';
  if (errno === EXPIRED_CODE) return 'expired';
  if (errno === HOST_CODE) return 'host';
  if (OTHER_TLS_CODES.has(errno) || errno.startsWith('ERR_SSL_'))
    return 'other';
  return undefined;
}

export type CaInput = string | Buffer | readonly (string | Buffer)[];

/** Why `AWS_CA_BUNDLE` cannot be used; the caller makes it CONNECTION_FAILED. */
export class TrustProblem extends Error {
  override readonly name = 'TrustProblem';
  readonly why: string;

  constructor(why: string) {
    super(why);
    this.why = why;
  }
}

const PEM_BLOCK =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/**
 * The authorities to trust beside Node's own: the option `ca`, else the file named by
 * `AWS_CA_BUNDLE` (read before any request), else none (`undefined`: Node's default store, with
 * `NODE_EXTRA_CA_CERTS`). `ca` replaces `AWS_CA_BUNDLE`.
 */
export async function trustedAuthorities(
  ca: CaInput | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Promise<(string | Buffer)[] | undefined> {
  if (ca !== undefined) {
    const given: readonly (string | Buffer)[] =
      typeof ca === 'string' || Buffer.isBuffer(ca) ? [ca] : ca;
    return [...tls.rootCertificates, ...given];
  }
  const bundle = env.AWS_CA_BUNDLE;
  if (bundle === undefined || bundle === '') return undefined;
  let text: string;
  try {
    text = await readFile(bundle, 'utf8');
  } catch (error) {
    throw new TrustProblem(
      errnoOf(error) === 'ENOENT'
        ? `AWS_CA_BUNDLE names ${bundle}, which does not exist`
        : `AWS_CA_BUNDLE names ${bundle}, which cannot be read`,
    );
  }
  const certificates = (text.match(PEM_BLOCK) ?? []).filter((block) => {
    try {
      new X509Certificate(block);
      return true;
    } catch {
      return false;
    }
  });
  if (certificates.length === 0) {
    throw new TrustProblem(
      `AWS_CA_BUNDLE names ${bundle}, which holds no valid PEM certificate`,
    );
  }
  return [...tls.rootCertificates, ...certificates];
}

/**
 * The one HTTPS agent of an instance (design Option 10B): no socket queue, so no request ever
 * waits for a socket and `connectionTimeout` bounds each request from its start; at most 16 idle
 * sockets stay open.
 */
export function createAgent(
  ca: (string | Buffer)[] | undefined,
  lookup: LookupFunction | undefined,
): Agent {
  return new Agent({
    rejectUnauthorized: true,
    keepAlive: true,
    maxSockets: Infinity,
    maxFreeSockets: 16,
    ...(ca === undefined ? {} : { ca }),
    ...(lookup === undefined ? {} : { lookup }),
  });
}

/**
 * The expiry date of the certificate a server presents, `YYYY-MM-DDTHH:MM:SSZ`, read by a second
 * handshake that does not verify. It is closed at `secureConnect` and writes no application
 * byte, so no request, header or signature reaches the server on it.
 */
export function expiryOf(
  target: { readonly host: string; readonly port: number },
  ca: (string | Buffer)[] | undefined,
  lookup: LookupFunction | undefined,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      // An IP address is no server name (RFC 6066): Node warns on stderr when it is given one.
      ...(isIP(target.host) === 0 ? { servername: target.host } : {}),
      rejectUnauthorized: false,
      ...(ca === undefined ? {} : { ca }),
      ...(lookup === undefined ? {} : { lookup }),
    });
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    socket.once('secureConnect', () => {
      const validTo = socket.getPeerCertificate().valid_to;
      const date = typeof validTo === 'string' ? new Date(validTo) : undefined;
      finish(
        date === undefined || Number.isNaN(date.getTime())
          ? undefined
          : date.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      );
    });
    socket.once('error', () => finish(undefined));
  });
}
