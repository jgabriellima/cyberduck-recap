/**
 * Keys that need encoding (FEATURE-3 AC-41, library part; the CLI part is in
 * test/cli/s3.test.ts). The SDK encodes a key once; the back-end never encodes it again and
 * never normalises it, so each odd key reaches the same object path-style and virtual-hosted,
 * and the signature-checking server accepts every request.
 */
import { describe, expect, it } from 'vitest';
import type { RemoteFileSystem } from '../../src/fs/index.js';
import type { S3ServerFixture } from '../support/s3-server.js';
import {
  bytes,
  interceptAwsConnections,
  readAll,
  sha256,
  useS3,
  writeAll,
} from '../support/s3.js';

const NFC = 'caf\u00e9';
const NFD = 'cafe\u0301';

/** The key set of AC-41. */
const KEYS: readonly string[] = [
  'a b',
  'a+b',
  '100%',
  '50%20off',
  'q?x',
  'h#x',
  "t~*'()!$&=,;@",
  'dir with space/f',
  NFC,
  NFD,
  '日本/語',
  '/lead',
];

/** The directory path and entry name of a key in bucket `b`, account-wide. */
function placeOf(key: string): { dir: string; name: string } {
  const slash = key.lastIndexOf('/');
  return slash === -1
    ? { dir: '/b', name: key }
    : { dir: `/b/${key.slice(0, slash)}`, name: key.slice(slash + 1) };
}

async function roundTrip(
  server: S3ServerFixture,
  fs: RemoteFileSystem,
): Promise<void> {
  KEYS.forEach((key, index) => server.putObject('b', key, bytes(100, index)));
  expect(NFC).not.toBe(NFD);

  for (const [index, key] of KEYS.entries()) {
    const path = `/b/${key}`;
    const original = bytes(100, index);

    // `/lead` has an empty segment: `list` does not show it (spec "Out of scope"); it stays
    // reachable by its full path, which the other steps prove.
    if (key !== '/lead') {
      const { dir, name } = placeOf(key);
      const entries = await fs.list(dir);
      expect(entries.filter((entry) => entry.name === name)).toEqual([
        expect.objectContaining({ name, type: 'file', path }),
      ]);
    }

    const stat = await fs.stat(path);
    expect(stat).toMatchObject({ type: 'file', size: original.length });

    const read = await readAll(fs.createReadStream(path));
    expect(read.errors).toEqual([]);
    expect(sha256(read.data)).toBe(sha256(original));

    const replacement = bytes(200, index + 50);
    const written = await writeAll(fs.createWriteStream(path), replacement);
    expect(written.errors).toEqual([]);
    expect(written.finished).toBe(true);
    expect(sha256(server.getObject('b', key) ?? Buffer.alloc(0))).toBe(
      sha256(replacement),
    );

    await fs.rename(path, `${path}-moved`);
    expect(server.hasObject('b', key)).toBe(false);
    expect(
      sha256(server.getObject('b', `${key}-moved`) ?? Buffer.alloc(0)),
    ).toBe(sha256(replacement));

    await fs.remove(`${path}-moved`);
    expect(server.hasObject('b', `${key}-moved`)).toBe(false);
  }

  expect(server.requests.length).toBeGreaterThan(0);
  expect(server.requests.filter((request) => !request.signatureValid)).toEqual(
    [],
  );
}

describe('keys that need encoding round-trip (AC-41)', () => {
  it(
    'AC-41: path-style, on a custom endpoint',
    { timeout: 30_000 },
    async () => {
      const setup = await useS3();

      const { server } = setup;
      const fs = await setup.connected();

      await roundTrip(server, fs);

      expect(server.requests.every((r) => r.style === 'path')).toBe(true);
    },
  );

  it(
    "AC-41: virtual-hosted style, on AWS's host routed to the fake server",
    { timeout: 30_000 },
    async () => {
      const setup = await useS3();

      const { server } = setup;
      const routed = interceptAwsConnections(server);
      const fs = await setup.connected({
        endpoint: undefined,
        region: 'us-east-1',
      });

      await roundTrip(server, fs);

      const objectRequests = server.requests.filter(
        (request) => request.key !== undefined,
      );
      expect(objectRequests.length).toBeGreaterThan(0);
      for (const request of objectRequests) {
        expect(request.style).toBe('virtual-hosted');
        expect(request.host).toBe('b.s3.us-east-1.amazonaws.com');
      }
      expect(routed.connections.length).toBeGreaterThan(0);
      expect(routed.plain).toEqual([]);
    },
  );

  it('AC-41: a bucket-scoped write to ../other/x stays in the bucket, sent as /b/../other/x', async () => {
    const setup = await useS3({}, { buckets: ['b', 'other'] });

    const { server } = setup;
    const fs = await setup.connected({ bucket: 'b' });
    const data = bytes(64);

    const outcome = await writeAll(fs.createWriteStream('/../other/x'), data);

    expect(outcome.errors).toEqual([]);
    const puts = server.requestsOf('PutObject');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.rawPath).toBe('/b/../other/x');
    expect(sha256(server.getObject('b', '../other/x') ?? Buffer.alloc(0))).toBe(
      sha256(data),
    );
    expect(server.keysOf('other')).toEqual([]);
  });
});
