/**
 * The CLI against the fake S3 server (FEATURE-3). The CLI reaches S3 only through the
 * registration in `src/backends.ts`; the back-end reads its settings from the process environment
 * and the AWS shared files, so each test stubs the environment (`useS3`) and gives the CLI context
 * the same values.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli, errorLine, EXIT_CODES, type RunResult } from '../support/cli.js';
import { sentinel, tempDir } from '../support/harness.js';
import { bytes, MIB, useS3, type S3Setup } from '../support/s3.js';
import {
  s3Error,
  type RecordedRequest,
  type S3ServerOptions,
} from '../support/s3-server.js';

const PROGRAM = 'cyberduck-recap';
const EPOCH = '1970-01-01T00:00:00.000Z';

interface CliS3 extends S3Setup {
  /** The variables that point the back-end at the fake server. */
  readonly variables: Readonly<Record<string, string>>;
  /** A directory for local files. */
  readonly local: string;
  run(
    args: readonly string[],
    extraEnv?: Readonly<Record<string, string>>,
  ): Promise<RunResult>;
}

async function useCliS3(
  serverOptions: S3ServerOptions = {},
  buckets: readonly string[] = ['b'],
): Promise<CliS3> {
  const setup = await useS3(serverOptions, { buckets });
  const caFile = await setup.env.file('ca.pem', setup.server.ca.cert);
  const variables: Record<string, string> = {
    AWS_ENDPOINT_URL_S3: setup.server.endpoint,
    AWS_CA_BUNDLE: caFile,
    AWS_ACCESS_KEY_ID: setup.server.keys.accessKeyId,
    AWS_SECRET_ACCESS_KEY: setup.server.keys.secretAccessKey,
    AWS_REGION: 'us-east-1',
  };
  setup.env.set(variables);
  const local = await tempDir();
  return {
    ...setup,
    variables,
    local,
    run(args, extraEnv = {}) {
      setup.env.set(extraEnv);
      return cli(args, {
        env: { ...process.env, ...variables, ...extraEnv },
        cwd: local,
        home: setup.env.home,
      });
    },
  };
}

async function localFile(
  setup: CliS3,
  name: string,
  data: Buffer,
): Promise<string> {
  const path = join(setup.local, name);
  await writeFile(path, data);
  return path;
}

function ofOperations(
  requests: readonly RecordedRequest[],
  ...operations: readonly string[]
): RecordedRequest[] {
  return requests.filter((request) => operations.includes(request.operation));
}

/** The stderr line right after the error line. */
function lineAfterError(result: RunResult): string | undefined {
  return result.stderrLines[result.stderrLines.indexOf(errorLine(result)) + 1];
}

/** AC-6's bucket `b`. */
function seedAc6(setup: CliS3): void {
  const { server } = setup;
  server.putObject('b', 'a.txt', 'hello', {
    lastModified: new Date('2026-01-02T03:04:05.678Z'),
  });
  server.putObject('b', 'dir/', '');
  server.putObject('b', 'dir/x', 'xx', {
    lastModified: new Date('2026-03-04T05:06:07.890Z'),
  });
  server.putObject('b', 'dir/sub/y', 'y');
  server.putObject('b', 'deep/z', 'z');
}

describe('cyberduck-recap with s3 URLs (FEATURE-3)', () => {
  it('AC-36: --help lists the s3 scheme', async () => {
    const setup = await useCliS3();
    const result = await setup.run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/\bs3\b/);
  });

  it("AC-36: ls s3://b/dir/ prints the ls lines of AC-6's dir entries", async () => {
    const setup = await useCliS3();
    seedAc6(setup);

    const result = await setup.run(['ls', 's3://b/dir/']);

    expect(result.stdout).toBe(
      [`d\t0\t${EPOCH}\tsub`, `-\t2\t2026-03-04T05:06:07.000Z\tx`, ''].join(
        '\n',
      ),
    );
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

  it.each(['s3://', 's3:///'])(
    'AC-36: ls %s prints the buckets',
    async (url) => {
      const setup = await useCliS3({}, ['b', 'b2']);

      const result = await setup.run(['ls', url]);

      expect(result.stdout).toBe(
        [`d\t0\t${EPOCH}\tb`, `d\t0\t${EPOCH}\tb2`, ''].join('\n'),
      );
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
    },
  );

  it('AC-36: put then get of s3://b/up.bin give the same bytes; put again without --overwrite exits 18', async () => {
    const setup = await useCliS3();
    const data = bytes(64 * 1024);
    const source = await localFile(setup, 'up.bin', data);

    const put = await setup.run(['put', source, 's3://b/up.bin']);
    expect(put.stderr).toBe('');
    expect(put.code).toBe(0);
    expect(setup.server.getObject('b', 'up.bin')?.equals(data)).toBe(true);

    const destination = join(setup.local, 'back.bin');
    const get = await setup.run(['get', 's3://b/up.bin', destination]);
    expect(get.stderr).toBe('');
    expect(get.code).toBe(0);
    expect((await readFile(destination)).equals(data)).toBe(true);

    const other = await localFile(setup, 'other.bin', bytes(1024, 99));
    const again = await setup.run(['put', other, 's3://b/up.bin']);
    expect(again.code).toBe(EXIT_CODES.ALREADY_EXISTS);
    expect(again.code).toBe(18);
    expect(setup.server.getObject('b', 'up.bin')?.equals(data)).toBe(true);
  });

  it('AC-36: ls s3://b/a.txt exits 19 and ls s3://b/nothing exits 16', async () => {
    const setup = await useCliS3();
    seedAc6(setup);

    const file = await setup.run(['ls', 's3://b/a.txt']);
    expect(file.code).toBe(19);
    expect(errorLine(file)).toMatch(/^cyberduck-recap: NOT_A_DIRECTORY: /);

    const missing = await setup.run(['ls', 's3://b/nothing']);
    expect(missing.code).toBe(16);
    expect(errorLine(missing)).toMatch(/^cyberduck-recap: NOT_FOUND: /);
  });

  it.each([
    ['a user name', 's3://someuser@b/k', 'someuser'],
    ['a port', 's3://b:9000/k', '9000'],
  ])(
    'AC-37: refuses an s3 URL with %s (exit 21) and sends no request',
    async (_what, url, named) => {
      const setup = await useCliS3();

      const result = await setup.run(['ls', url]);

      expect(result.code).toBe(21);
      const line = errorLine(result);
      expect(line.startsWith(`${PROGRAM}: INVALID_ARGUMENT: `)).toBe(true);
      expect(line).toContain(named);
      expect(line).toMatch(/not accepted/);
      expect(setup.server.requests).toHaveLength(0);
      expect(setup.server.counts.tcp).toBe(0);
    },
  );

  it('AC-37: CYBERDUCK_RECAP_PASSWORD, --identity and --known-hosts have no effect on an s3 command', async () => {
    const setup = await useCliS3();
    seedAc6(setup);
    const password = sentinel();
    const passphrase = sentinel();
    // Paths that do not exist: reading either file would fail the command.
    const identity = join(setup.local, 'no-such-identity');
    const knownHosts = join(setup.local, 'no-such-known-hosts');

    const plain = await setup.run(['ls', 's3://b/dir/']);
    const withSecrets = await setup.run(
      [
        'ls',
        '--identity',
        identity,
        '--known-hosts',
        knownHosts,
        's3://b/dir/',
      ],
      {
        CYBERDUCK_RECAP_PASSWORD: password,
        CYBERDUCK_RECAP_PASSPHRASE: passphrase,
      },
    );

    expect(plain.code).toBe(0);
    expect({
      code: withSecrets.code,
      stdout: withSecrets.stdout,
      stderr: withSecrets.stderr,
    }).toEqual({
      code: plain.code,
      stdout: plain.stdout,
      stderr: plain.stderr,
    });
    for (const request of setup.server.requests) {
      const sent = `${request.url}\n${JSON.stringify(request.headers)}\n${request.bodyText ?? ''}`;
      expect(sent).not.toContain(password);
      expect(sent).not.toContain(passphrase);
      expect(sent).not.toContain(identity);
      expect(sent).not.toContain(knownHosts);
    }
  });

  it('AC-39: ls s3://typo/ and put <file> s3://typo/ exit 16 and name the bucket', async () => {
    const setup = await useCliS3();
    const source = await localFile(setup, 'f.bin', bytes(1024));

    const ls = await setup.run(['ls', 's3://typo/']);
    expect(ls.code).toBe(16);
    expect(errorLine(ls)).toContain('typo');

    const put = await setup.run(['put', source, 's3://typo/']);
    expect(put.code).toBe(16);
    expect(errorLine(put)).toContain('typo');
    expect(
      ofOperations(setup.server.requests, 'PutObject', 'CreateMultipartUpload'),
    ).toEqual([]);
  });

  it('AC-40: a denied ls exits 17 and prints s3:ListBucket', async () => {
    const setup = await useCliS3();
    seedAc6(setup);
    setup.server.fault((request) =>
      request.operation === 'ListObjectsV2'
        ? s3Error('AccessDenied', 'Access Denied')
        : undefined,
    );

    const result = await setup.run(['ls', 's3://b/dir/']);

    expect(result.code).toBe(17);
    expect(errorLine(result)).toContain('s3:ListBucket');
  });

  it('AC-40: a denied get exits 17 and prints s3:GetObject', async () => {
    const setup = await useCliS3();
    seedAc6(setup);
    setup.server.fault((request) =>
      request.operation === 'GetObject' || request.operation === 'HeadObject'
        ? s3Error('AccessDenied', 'Access Denied')
        : undefined,
    );

    const result = await setup.run([
      'get',
      's3://b/a.txt',
      join(setup.local, 'a.txt'),
    ]);

    expect(result.code).toBe(17);
    expect(errorLine(result)).toContain('s3:GetObject');
  });

  it('AC-40: a denied put exits 17, prints s3:PutObject and leaves the object unchanged', async () => {
    const setup = await useCliS3();
    setup.server.putObject('b', 'k', 'old');
    setup.server.fault((request) =>
      request.operation === 'PutObject' ||
      request.operation === 'CreateMultipartUpload'
        ? s3Error('AccessDenied', 'Access Denied')
        : undefined,
    );
    const source = await localFile(setup, 'k', bytes(1024));

    const result = await setup.run(['put', '--overwrite', source, 's3://b/k']);

    expect(result.code).toBe(17);
    expect(errorLine(result)).toContain('s3:PutObject');
    expect(setup.server.getObject('b', 'k')?.toString()).toBe('old');
  });

  it('AC-31: a denied put to s3://b/a%07b shows the key escaped, with the raw path appended escaped', async () => {
    const setup = await useCliS3();
    setup.server.fault((request) =>
      request.operation === 'PutObject'
        ? s3Error('AccessDenied', 'Access Denied')
        : undefined,
    );
    const source = await localFile(setup, 'f.bin', bytes(1024));

    const result = await setup.run(['put', source, 's3://b/a%07b']);

    expect(result.code).toBe(17);
    const line = errorLine(result);
    expect(line).toContain('s3://b/a\\x07b');
    expect(line.endsWith(' (/a\\x07b)')).toBe(true);
    expect(result.stderr).not.toContain('\u0007');
    expect(result.stdout).not.toContain('\u0007');
  });

  it.each([
    ['s3://b/a%20b', 'a b'],
    ['s3://b/a%2Bb', 'a+b'],
    ['s3://b/100%25', '100%'],
    ['s3://b/q%3Fx', 'q?x'],
    ['s3://b/h%23x', 'h#x'],
  ])('AC-41: ls, get and put of %s reach the key %j', async (url, key) => {
    const setup = await useCliS3();
    const original = bytes(512, 3);
    // The key is a file and a directory at once: ls lists the prefix and get reads the object.
    setup.server.putObject('b', key, original);
    setup.server.putObject('b', `${key}/inner`, 'i');

    const ls = await setup.run(['ls', url]);
    expect(ls.stderr).toBe('');
    expect(ls.code).toBe(0);
    expect(ls.stdoutLines.map((line) => line.split('\t')[3])).toEqual([
      'inner',
    ]);

    const destination = join(setup.local, 'got.bin');
    const get = await setup.run(['get', url, destination]);
    expect(get.stderr).toBe('');
    expect(get.code).toBe(0);
    expect((await readFile(destination)).equals(original)).toBe(true);

    const replacement = bytes(700, 11);
    const source = await localFile(setup, 'up.bin', replacement);
    const put = await setup.run(['put', '--overwrite', source, url]);
    expect(put.stderr).toBe('');
    expect(put.code).toBe(0);
    expect(setup.server.getObject('b', key)?.equals(replacement)).toBe(true);
    // Every request named bucket b (or none, the account root): no key escaped into another.
    expect(
      setup.server.requests.every(
        (request) => request.bucket === 'b' || request.bucket === undefined,
      ),
    ).toBe(true);
    expect(setup.server.requests.every((r) => r.signatureValid)).toBe(true);
  });

  it('AC-54: a 1 KiB put whose reply is lost exits 14 and says the object may have been written', async () => {
    const setup = await useCliS3();
    setup.server.fault((request) =>
      request.operation === 'PutObject'
        ? { kind: 'store-then-reset' }
        : undefined,
    );
    const source = await localFile(setup, 'k', bytes(1024));

    const result = await setup.run(['put', source, 's3://b/k']);

    expect(result.code).toBe(14);
    const line = errorLine(result);
    expect(line.startsWith(`${PROGRAM}: CONNECTION_LOST: `)).toBe(true);
    expect(line).toContain('s3://b/k');
    expect(line).toContain('may have been written');
    expect(line.endsWith(' (/k)')).toBe(false);
    expect(lineAfterError(result)).toBe(
      `${PROGRAM}: the remote file /k may be incomplete`,
    );
  });

  it('AC-54: a 20 MiB put whose second part is reset on every attempt exits 14 and says no object was written', async () => {
    const setup = await useCliS3();
    setup.server.fault((request) =>
      request.operation === 'UploadPart' && request.query.partNumber === '2'
        ? { kind: 'reset' }
        : undefined,
    );
    const source = await localFile(setup, 'k', bytes(20 * MIB));

    const result = await setup.run(['put', source, 's3://b/k']);

    expect(result.code).toBe(14);
    const line = errorLine(result);
    expect(line.startsWith(`${PROGRAM}: CONNECTION_LOST: `)).toBe(true);
    expect(line).toContain('no object was written to s3://b/k');
    expect(line.endsWith(' (/k)')).toBe(false);
    expect(lineAfterError(result)).toBe(
      `${PROGRAM}: the remote file /k may be incomplete`,
    );
    expect(setup.server.hasObject('b', 'k')).toBe(false);
  }, 30_000);

  it('AC-55: put without --overwrite whose stored PutObject reply is lost exits 14, not 18', async () => {
    const setup = await useCliS3();
    let attempts = 0;
    setup.server.fault((request) => {
      if (request.operation !== 'PutObject') return undefined;
      attempts += 1;
      return attempts === 1
        ? { kind: 'store-then-reset' }
        : s3Error('PreconditionFailed');
    });
    const data = bytes(1024);
    const source = await localFile(setup, 'k', data);

    const result = await setup.run(['put', source, 's3://b/k']);

    expect(result.code).toBe(14);
    expect(result.code).not.toBe(18);
    expect(errorLine(result)).toMatch(/^cyberduck-recap: CONNECTION_LOST: /);
    expect(setup.server.requestsOf('PutObject', 'k')).toHaveLength(1);
    expect(setup.server.getObject('b', 'k')?.equals(data)).toBe(true);
  });
});
