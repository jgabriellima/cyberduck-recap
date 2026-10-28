/**
 * The listing `remove()` reads to tell an empty folder from a full one is untrusted input
 * (cyberduck/standard.untrusted-server-replies), checked by the same rule as every other listing
 * (`keysUnder` in listing.ts): a key outside the folder or a page that is not a list is
 * OPERATION_FAILED, and nothing is deleted.
 */
import { describe, expect, it } from 'vitest';
import type { Fault } from '../support/s3-server.js';
import { rejection, useS3 } from '../support/s3.js';

const NS = 'http://s3.amazonaws.com/doc/2006-03-01/';
const DATE = '2026-01-02T03:04:05.000Z';

function page(body: string): Fault {
  return {
    kind: 'raw',
    status: 200,
    headers: { 'content-type': 'application/xml' },
    body:
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<ListBucketResult xmlns="${NS}"><Name>b</Name><Prefix>d/</Prefix>` +
      `<MaxKeys>2</MaxKeys><IsTruncated>false</IsTruncated>${body}</ListBucketResult>`,
  };
}

function contents(key: string): string {
  return `<Contents><Key>${key}</Key><LastModified>${DATE}</LastModified><ETag>"e"</ETag><Size>0</Size></Contents>`;
}

describe('remove() checks the listing of a folder', () => {
  const cases: [string, Fault][] = [
    ['a key outside the folder', page(contents('other/x'))],
    [
      'more keys than it asked for',
      page(contents('d/') + contents('d/a') + contents('d/b')),
    ],
  ];
  for (const [name, fault] of cases) {
    it(`${name} is OPERATION_FAILED and deletes nothing`, async () => {
      const setup = await useS3();
      const fs = await setup.connected();
      setup.server.fault((r) =>
        r.operation === 'ListObjectsV2' && r.query.prefix === 'd/'
          ? fault
          : undefined,
      );
      const error = await rejection(
        fs.remove('/b/d'),
        'OPERATION_FAILED',
        '/b/d',
      );
      // A malformed listing is not a folder with content.
      expect(error.message).toContain('not valid for the request');
      expect(error.message).not.toContain('not empty');
      expect(
        setup.server.requests.filter((r) => r.operation === 'DeleteObject'),
      ).toEqual([]);
    });
  }

  it('the marker alone is an empty folder and is deleted', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    setup.server.fault((r) =>
      r.operation === 'ListObjectsV2' && r.query.prefix === 'd/'
        ? page(contents('d/'))
        : undefined,
    );
    await fs.remove('/b/d');
    expect(
      setup.server.requests
        .filter((r) => r.operation === 'DeleteObject')
        .map((r) => r.key),
    ).toEqual(['d/']);
  });
});
