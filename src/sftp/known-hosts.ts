import { createHmac, timingSafeEqual } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { errnoOf, RemoteFsError } from '../fs/errors.js';
import { fingerprint, keyType as blobKeyType } from './host-key.js';
import { sanitizedCause } from './error-map.js';

type HostPattern =
  | { readonly kind: 'plain'; readonly names: readonly string[] }
  | { readonly kind: 'hashed'; readonly salt: Buffer; readonly hash: Buffer };

export interface KnownHostEntry {
  readonly hosts: HostPattern;
  readonly keyType: string;
  readonly keyBlob: Buffer;
}

export type HostMatch =
  | { readonly kind: 'trusted' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'changed'; readonly expectedFingerprints: string[] };

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SHA1_LENGTH = 20;

/** OpenSSH writes the bare host for port 22 and `[host]:port` otherwise; names compare lower-cased. */
export function hostField(host: string, port: number): string {
  const name = host.toLowerCase();
  return port === 22 ? name : `[${name}]:${port}`;
}

function decodeBase64(text: string): Buffer | undefined {
  return BASE64.test(text) ? Buffer.from(text, 'base64') : undefined;
}

function parseHostPattern(field: string): HostPattern | undefined {
  if (field.startsWith('|1|')) {
    const [, , saltText, hashText, ...rest] = field.split('|');
    if (saltText === undefined || hashText === undefined || rest.length > 0) {
      return undefined;
    }
    const salt = decodeBase64(saltText);
    const hash = decodeBase64(hashText);
    if (salt === undefined || hash?.length !== SHA1_LENGTH) return undefined;
    return { kind: 'hashed', salt, hash };
  }
  const names = field
    .split(',')
    .filter((name) => name.length > 0)
    .map((name) => name.toLowerCase());
  return names.length > 0 ? { kind: 'plain', names } : undefined;
}

function parseLine(line: string): KnownHostEntry | undefined {
  const trimmed = line.trim();
  // Marker lines (@cert-authority, @revoked) are out of scope and must never make a key trusted.
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('@')) {
    return undefined;
  }
  const [hostsText, type, keyText] = trimmed.split(/\s+/);
  if (hostsText === undefined || type === undefined || keyText === undefined) {
    return undefined;
  }
  const hosts = parseHostPattern(hostsText);
  const keyBlob = decodeBase64(keyText);
  if (hosts === undefined || keyBlob === undefined) return undefined;
  if (blobKeyType(keyBlob) !== type) return undefined;
  return { hosts, keyType: type, keyBlob };
}

/** Blank, comment, marker and malformed lines are skipped, as OpenSSH does. */
export function parseKnownHosts(text: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = parseLine(line);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

function patternMatches(pattern: HostPattern, field: string): boolean {
  if (pattern.kind === 'hashed') {
    const digest = createHmac('sha1', pattern.salt).update(field).digest();
    return timingSafeEqual(digest, pattern.hash);
  }
  // Wildcard and negated patterns are out of scope: they never match, so they never grant trust.
  return pattern.names.some(
    (name) =>
      !name.startsWith('!') &&
      !name.includes('*') &&
      !name.includes('?') &&
      name === field,
  );
}

function entriesFor(
  entries: readonly KnownHostEntry[],
  host: string,
  port: number,
): KnownHostEntry[] {
  const field = hostField(host, port);
  return entries.filter((entry) => patternMatches(entry.hosts, field));
}

export function matchHost(
  entries: readonly KnownHostEntry[],
  host: string,
  port: number,
  keyBlob: Buffer,
): HostMatch {
  const candidates = entriesFor(entries, host, port);
  if (candidates.length === 0) return { kind: 'unknown' };
  if (candidates.some((entry) => entry.keyBlob.equals(keyBlob))) {
    return { kind: 'trusted' };
  }
  return {
    kind: 'changed',
    expectedFingerprints: [
      ...new Set(candidates.map((entry) => fingerprint(entry.keyBlob))),
    ],
  };
}

/** The key types already recorded for this host, so the handshake can prefer them (S-5b). */
export function knownKeyTypes(
  entries: readonly KnownHostEntry[],
  host: string,
  port: number,
): string[] {
  return [
    ...new Set(entriesFor(entries, host, port).map((entry) => entry.keyType)),
  ];
}

/** A missing file holds no entries; any other read failure fails the connection. */
export async function readKnownHosts(path: string): Promise<KnownHostEntry[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return [];
    throw new RemoteFsError(
      'CONNECTION_FAILED',
      `could not read the known_hosts file ${path}`,
      { cause: sanitizedCause(error) },
    );
  }
  return parseKnownHosts(text);
}

export function formatKnownHostLine(
  host: string,
  port: number,
  keyBlob: Buffer,
): string {
  return `${hostField(host, port)} ${blobKeyType(keyBlob) ?? ''} ${keyBlob.toString('base64')}`;
}

/**
 * G-2: the line is written only if our own parser reads it back as one plain entry for exactly
 * this host and port and this key, so a crafted value can never record trust for anything else.
 */
export function lineRoundTrips(
  line: string,
  host: string,
  port: number,
  keyBlob: Buffer,
): boolean {
  if (/[\r\n]/.test(line)) return false;
  const entries = parseKnownHosts(line);
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined) return false;
  if (entry.hosts.kind !== 'plain' || entry.hosts.names.length !== 1) {
    return false;
  }
  if (entry.hosts.names[0] !== hostField(host, port)) return false;
  return matchHost(entries, host, port, keyBlob).kind === 'trusted';
}

/**
 * Appends one complete line in a single write on an O_APPEND descriptor, so concurrent writers
 * (another instance, OpenSSH itself) cannot interleave inside it. A new file gets mode 0600.
 */
export async function appendKnownHost(
  path: string,
  host: string,
  port: number,
  keyBlob: Buffer,
): Promise<void> {
  const line = formatKnownHostLine(host, port, keyBlob);
  const failure = (cause?: unknown): RemoteFsError =>
    new RemoteFsError(
      'CONNECTION_FAILED',
      `could not record the host key in the known_hosts file ${path}`,
      cause === undefined ? {} : { cause: sanitizedCause(cause) },
    );
  if (!lineRoundTrips(line, host, port, keyBlob)) throw failure();
  try {
    const file = await open(path, 'a+', 0o600);
    try {
      const { size } = await file.stat();
      let prefix = '';
      if (size > 0) {
        const last = Buffer.alloc(1);
        await file.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = '\n';
      }
      await file.write(`${prefix}${line}\n`);
    } finally {
      await file.close();
    }
  } catch (error) {
    throw failure(error);
  }
}
