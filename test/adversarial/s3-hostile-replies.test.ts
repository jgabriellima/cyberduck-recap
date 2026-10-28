/**
 * Hostile and odd server replies (AC-30, AC-31; cyberduck/standard.untrusted-server-replies and
 * sanitised-server-text): each maps to a typed error, never a crash or a hang, and server text
 * reaches a message escaped and bounded.
 */
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { Fault } from '../support/s3-server.js';
import { s3Error } from '../support/s3-server.js';
import {
  ESCAPED_CODE_POINTS,
  escaped,
  hasRawEscapedCodePoint,
  onlyError,
  rejection,
  useS3,
  writeAll,
} from '../support/s3.js';

function listing(body: string, truncated = false, token?: string): Fault {
  return {
    kind: 'raw',
    status: 200,
    headers: { 'content-type': 'application/xml' },
    body:
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      `<Name>b</Name><Prefix>d/</Prefix><Delimiter>/</Delimiter><MaxKeys>1000</MaxKeys><IsTruncated>${truncated}</IsTruncated>` +
      (token === undefined
        ? ''
        : `<NextContinuationToken>${token}</NextContinuationToken>`) +
      body +
      '</ListBucketResult>',
  };
}

function entry(fields: {
  key?: string;
  size?: string;
  modified?: string;
}): string {
  return (
    '<Contents>' +
    (fields.key === undefined ? '' : `<Key>${fields.key}</Key>`) +
    (fields.modified === undefined
      ? ''
      : `<LastModified>${fields.modified}</LastModified>`) +
    '<ETag>"e"</ETag>' +
    (fields.size === undefined ? '' : `<Size>${fields.size}</Size>`) +
    '</Contents>'
  );
}

const GOOD_DATE = '2026-01-02T03:04:05.000Z';

describe('hostile listings and replies (AC-30)', () => {
  const listings: [string, Fault][] = [
    [
      'a listing that is not XML',
      { kind: 'raw', status: 200, body: 'this is not XML at all' },
    ],
    [
      'IsTruncated with no continuation token',
      listing(entry({ key: 'd/a', size: '1', modified: GOOD_DATE }), true),
    ],
    ['a missing Size', listing(entry({ key: 'd/a', modified: GOOD_DATE }))],
    [
      'a non-numeric Size',
      listing(entry({ key: 'd/a', size: 'many', modified: GOOD_DATE })),
    ],
    [
      'a negative Size',
      listing(entry({ key: 'd/a', size: '-5', modified: GOOD_DATE })),
    ],
    ['a missing LastModified', listing(entry({ key: 'd/a', size: '1' }))],
    [
      'an invalid LastModified',
      listing(entry({ key: 'd/a', size: '1', modified: 'yesterday' })),
    ],
    [
      'a key outside the prefix',
      listing(entry({ key: 'elsewhere/a', size: '1', modified: GOOD_DATE })),
    ],
    [
      'an HTTP 500 with an HTML body',
      {
        kind: 'raw',
        status: 500,
        headers: { 'content-type': 'text/html' },
        body: '<html><body><h1>500</h1></body></html>',
      },
    ],
  ];
  for (const [label, fault] of listings) {
    it(`AC-30: ${label} gives OPERATION_FAILED with path, within 5 s`, async () => {
      const setup = await useS3();
      const fs = await setup.connected();
      setup.server.fault((r) =>
        r.operation === 'ListObjectsV2' ? fault : undefined,
      );
      const started = performance.now();
      await rejection(fs.list('/b/d'), 'OPERATION_FAILED', '/b/d');
      expect(performance.now() - started).toBeLessThan(5000);
    }, 10_000);
  }

  it('AC-30: a continuation token returned twice stops the listing, with no third page', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    setup.server.clearRequests();
    setup.server.fault((r) =>
      r.operation === 'ListObjectsV2'
        ? listing(
            entry({ key: `d/${r.index}`, size: '1', modified: GOOD_DATE }),
            true,
            'SAME',
          )
        : undefined,
    );
    const started = performance.now();
    await rejection(fs.list('/b/d'), 'OPERATION_FAILED', '/b/d');
    expect(performance.now() - started).toBeLessThan(5000);
    expect(setup.server.requestsOf('ListObjectsV2')).toHaveLength(2);
  }, 10_000);

  it('AC-30: a HeadObject without Content-Length gives OPERATION_FAILED with path', async () => {
    const setup = await useS3();
    setup.server.putObject('b', 'k', 'data');
    const fs = await setup.connected();
    setup.server.fault((r) =>
      r.operation === 'HeadObject'
        ? {
            kind: 'raw',
            status: 200,
            omitContentLength: true,
            headers: { 'last-modified': new Date().toUTCString(), etag: '"e"' },
          }
        : undefined,
    );
    const started = performance.now();
    await rejection(fs.stat('/b/k'), 'OPERATION_FAILED', '/b/k');
    expect(performance.now() - started).toBeLessThan(5000);
  }, 10_000);
});

describe('server text in messages (AC-31)', () => {
  async function deniedMessage(message: string): Promise<string> {
    const setup = await useS3();
    const fs = await setup.connected();
    setup.server.fault((r) =>
      r.operation === 'ListObjectsV2'
        ? s3Error('AccessDenied', message)
        : undefined,
    );
    return (await rejection(fs.list('/b/d'), 'PERMISSION_DENIED', '/b/d'))
      .message;
  }

  it('AC-31: every code point of the escape set appears escaped, none raw', async () => {
    const text = `x${String.fromCodePoint(...ESCAPED_CODE_POINTS)}y`;
    const message = await deniedMessage(text);
    expect(message).toContain(escaped(text));
    expect(hasRawEscapedCodePoint(message)).toBe(false);
  });

  it('AC-31: 10,000 x are cut to 500 x and one …; exactly 500 x get no …', async () => {
    const long = await deniedMessage('x'.repeat(10_000));
    expect(long).toContain(`${'x'.repeat(500)}…`);
    expect(long).not.toContain('x'.repeat(501));
    const exact = await deniedMessage('x'.repeat(500));
    expect(exact).toContain('x'.repeat(500));
    expect(exact).not.toContain('x'.repeat(501));
    expect(exact).not.toContain('…');
  });

  it('AC-31: 600 U+1F600 are cut to 500 whole code points and …, no lone surrogate', async () => {
    const face = '\u{1F600}';
    const message = await deniedMessage(face.repeat(600));
    expect(message).toContain(`${face.repeat(500)}…`);
    expect(message).not.toContain(face.repeat(501));
    expect(message).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it('AC-31: 400 U+2028 are escaped first, then cut to 500 code points and …', async () => {
    const message = await deniedMessage(' '.repeat(400));
    expect(message).toContain(`${'\\u2028'.repeat(400).slice(0, 500)}…`);
    expect(message).not.toContain(' ');
  });

  it('AC-31: the object URL holds the key as text and escaped', async () => {
    const setup = await useS3();
    const fs = await setup.connected();
    setup.server.fault((r) =>
      r.operation === 'PutObject'
        ? s3Error('AccessDenied', 'Access Denied')
        : undefined,
    );
    const space = onlyError(
      await writeAll(fs.createWriteStream('/b/a b'), Buffer.from('x')),
      'PERMISSION_DENIED',
      '/b/a b',
    );
    expect(space.message).toContain('s3://b/a b');
    expect(space.message).not.toContain('a%20b');
    const bell = onlyError(
      await writeAll(fs.createWriteStream('/b/a\u0007b'), Buffer.from('x')),
      'PERMISSION_DENIED',
      '/b/a\u0007b',
    );
    expect(bell.message).toContain('s3://b/a\\x07b');
    expect(bell.message).not.toContain('\u0007');
  });
});
