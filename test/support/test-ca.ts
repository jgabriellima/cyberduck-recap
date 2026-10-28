/**
 * Certificate authorities and leaf certificates made at run time for the S3 tests, so that no
 * private key is committed (FEATURE-3 decision 4). ECDSA P-256 keys come from `node:crypto`; the
 * X.509 structure is DER that this file encodes itself, because the project has no X.509 library
 * and a system `openssl` differs between machines.
 */
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { isIP } from 'node:net';

export interface IssuedCertificate {
  /** PEM of the leaf certificate. */
  readonly cert: string;
  /** PKCS#8 PEM of the leaf key. */
  readonly key: string;
  readonly notAfter: Date;
}

export interface IssueOptions {
  /** DNS names (wildcards allowed) and IP addresses for the subject alternative name. */
  readonly hosts: readonly string[];
  readonly notBefore?: Date;
  readonly notAfter?: Date;
}

export interface TestCa {
  /** PEM of the authority's self-signed certificate: what a client trusts. */
  readonly cert: string;
  readonly name: string;
  issue(options: IssueOptions): IssuedCertificate;
}

const DAY_MS = 86_400_000;

// Object identifiers used below, as dotted strings.
const OID = {
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  authorityKeyIdentifier: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
} as const;

/** A new authority with its own key. Each test that needs trust makes its own. */
export function createTestCa(name = 'cyberduck-recap test CA'): TestCa {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const now = Date.now();
  const caCert = buildCertificate({
    subject: name,
    issuer: name,
    subjectPublicKey: keys.publicKey,
    issuerPublicKey: keys.publicKey,
    signingKey: keys.privateKey,
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + 30 * DAY_MS),
    isCa: true,
    hosts: [],
  });
  return {
    cert: caCert,
    name,
    issue(options: IssueOptions): IssuedCertificate {
      const leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const notBefore = options.notBefore ?? new Date(Date.now() - DAY_MS);
      const notAfter = options.notAfter ?? new Date(Date.now() + 7 * DAY_MS);
      const cert = buildCertificate({
        subject: options.hosts[0] ?? 'leaf',
        issuer: name,
        subjectPublicKey: leaf.publicKey,
        issuerPublicKey: keys.publicKey,
        signingKey: keys.privateKey,
        notBefore,
        notAfter,
        isCa: false,
        hosts: options.hosts,
      });
      return {
        cert,
        key: leaf.privateKey
          .export({ type: 'pkcs8', format: 'pem' })
          .toString(),
        notAfter,
      };
    },
  };
}

interface CertificateInput {
  readonly subject: string;
  readonly issuer: string;
  readonly subjectPublicKey: KeyObject;
  readonly issuerPublicKey: KeyObject;
  readonly signingKey: KeyObject;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly isCa: boolean;
  readonly hosts: readonly string[];
}

function buildCertificate(input: CertificateInput): string {
  const spki = input.subjectPublicKey.export({ type: 'spki', format: 'der' });
  const issuerSpki = input.issuerPublicKey.export({
    type: 'spki',
    format: 'der',
  });
  const algorithm = sequence(oid(OID.ecdsaWithSha256));
  const serial = randomBytes(16);
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01;

  const extensions: Buffer[] = [
    extension(
      OID.basicConstraints,
      true,
      input.isCa ? sequence(tlv(0x01, Buffer.from([0xff]))) : sequence(),
    ),
    // keyCertSign + cRLSign for the authority; digitalSignature for a leaf.
    extension(
      OID.keyUsage,
      true,
      input.isCa
        ? tlv(0x03, Buffer.from([0x01, 0x06]))
        : tlv(0x03, Buffer.from([0x07, 0x80])),
    ),
    extension(OID.subjectKeyIdentifier, false, tlv(0x04, keyId(spki))),
    extension(
      OID.authorityKeyIdentifier,
      false,
      sequence(tlv(0x80, keyId(issuerSpki))),
    ),
  ];
  if (!input.isCa) {
    extensions.push(
      extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
      extension(
        OID.subjectAltName,
        false,
        sequence(...input.hosts.map(generalName)),
      ),
    );
  }

  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    distinguishedName(input.issuer),
    sequence(time(input.notBefore), time(input.notAfter)),
    distinguishedName(input.subject),
    spki,
    tlv(0xa3, sequence(...extensions)),
  );
  // ECDSA signatures from node:crypto are DER (r, s) by default: what X.509 expects.
  const signature = sign('sha256', tbs, input.signingKey);
  const der = sequence(
    tbs,
    algorithm,
    tlv(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  const pem = toPem(der);
  // Parse once, so an encoding mistake fails here rather than inside a TLS handshake.
  new X509Certificate(pem);
  return pem;
}

function keyId(spki: Buffer): Buffer {
  return createHash('sha1').update(spki).digest();
}

function generalName(host: string): Buffer {
  const version = isIP(host);
  if (version === 4) {
    return tlv(0x87, Buffer.from(host.split('.').map(Number)));
  }
  if (version === 6) {
    throw new Error('test-ca: IPv6 names are not supported');
  }
  return tlv(0x82, Buffer.from(host, 'ascii'));
}

function distinguishedName(commonName: string): Buffer {
  return sequence(
    set(sequence(oid(OID.organization), utf8('cyberduck-recap tests'))),
    set(sequence(oid(OID.commonName), utf8(commonName))),
  );
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(
    oid(id),
    ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []),
    tlv(0x04, value),
  );
}

function time(date: Date): Buffer {
  const iso = date.toISOString();
  const digits =
    iso.slice(0, 4) +
    iso.slice(5, 7) +
    iso.slice(8, 10) +
    iso.slice(11, 13) +
    iso.slice(14, 16) +
    iso.slice(17, 19);
  const year = date.getUTCFullYear();
  // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
  return year >= 1950 && year < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, 'ascii'))
    : tlv(0x18, Buffer.from(`${digits}Z`, 'ascii'));
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const first = parts[0] ?? 0;
  const second = parts[1] ?? 0;
  const bytes: number[] = [first * 40 + second];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    let rest = Math.floor(part / 128);
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function integer(value: Buffer): Buffer {
  return tlv(0x02, value);
}

function utf8(text: string): Buffer {
  return tlv(0x0c, Buffer.from(text, 'utf8'));
}

function sequence(...items: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(items));
}

function set(...items: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(items));
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

function length(value: number): Buffer {
  if (value < 0x80) return Buffer.from([value]);
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function toPem(der: Buffer): string {
  const base64 = der.toString('base64');
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** The date form AC-26 requires in the expiry message: `YYYY-MM-DDTHH:MM:SSZ`. */
export function expiryText(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}
