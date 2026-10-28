/**
 * The remedy of an upload that could not be aborted (design SE-15): a command line only for values
 * that are inert in a shell, each in single quotes; else the values apart, escaped and quoted.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { abortRemedy } from '../../src/s3/errors.js';

const COMMAND = 'aws s3api abort-multipart-upload --';

describe('abortRemedy', () => {
  it('gives one command, each value in single quotes, for values in the safe set', () => {
    expect(
      abortRemedy('my-bucket', 'dir/file name.txt', 'Up_load.ID-1=2+3@4,5~'),
    ).toBe(
      "aws s3api abort-multipart-upload --bucket 'my-bucket' --key 'dir/file name.txt' --upload-id 'Up_load.ID-1=2+3@4,5~'",
    );
  });

  const HOSTILE = [
    "'",
    '$(id)',
    '`id`',
    ';',
    '|',
    '&',
    '\n',
    '%PATH%',
    '^',
    '\u0007',
    'é',
  ];

  it.each(HOSTILE)('gives no command when a value holds %j', (bad) => {
    for (const place of ['bucket', 'key', 'id'] as const) {
      const remedy = abortRemedy(
        place === 'bucket' ? `b${bad}` : 'b',
        place === 'key' ? `k${bad}` : 'k',
        place === 'id' ? `u${bad}` : 'u',
      );
      expect(remedy).not.toContain(COMMAND);
      expect(remedy).toContain('aws s3api abort-multipart-upload');
      expect(remedy).not.toContain('\n');
      expect(remedy).not.toContain('\u0007');
      for (const line of remedy.split('\n')) {
        expect(line.startsWith('aws s3api')).toBe(false);
      }
    }
  });

  it("writes a ' of a value as '\\'' inside its quotes", () => {
    expect(abortRemedy('b', "k'1", 'u')).toContain("key 'k'\\''1'");
  });

  it.skipIf(process.platform === 'win32')(
    'the command form runs in sh with exactly the raw values as its arguments',
    () => {
      const bucket = 'bkt-42';
      const key = 'dir with space/k:1=2';
      const id = 'Up.Load_ID+1@2,3~';
      const remedy = abortRemedy(bucket, key, id);
      const out = execFileSync(
        '/bin/sh',
        ['-c', `aws() { printf '%s\\n' "$@"; }; ${remedy}`],
        { encoding: 'utf8' },
      );
      expect(out.split('\n').slice(0, -1)).toEqual([
        's3api',
        'abort-multipart-upload',
        '--bucket',
        bucket,
        '--key',
        key,
        '--upload-id',
        id,
      ]);
    },
  );
});
