/**
 * Adversarial, BUG-1 third round: attacks the escaping where earlier rounds did not look. A census
 * of every call site that carries server text (AC-14), an exhaustive scan of the Basic
 * Multilingual Plane against the exact set the standard names, and the state a global regular
 * expression keeps between calls, including a call made from inside another one; and a download
 * that a hostile server fails halfway with format characters in its status text. This file holds
 * no raw character of the escaped ranges: every one is written as a `\u` escape.
 */
import { randomBytes } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { describe, expect, it, onTestFinished } from 'vitest';
import { RemoteFsError } from '../../src/index.js';
import { sanitizedCause } from '../../src/sftp/error-map.js';
import { sanitizeServerText } from '../../src/sftp/sanitize.js';
import { newFs, sentinel, tempDir } from '../support/harness.js';
import {
  STATUS,
  startHostileServer,
  type HostileSftp,
} from '../support/hostile-sftp-server.js';

const SRC = join(import.meta.dirname, '..', '..', 'src');

/** The code points cyberduck/standard.sanitised-server-text requires to be escaped. */
function isUnsafe(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function escapeOf(code: number): string {
  return code <= 0xff
    ? `\\x${code.toString(16).padStart(2, '0')}`
    : `\\u${code.toString(16).padStart(4, '0')}`;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('ATK-47: no new path carries server text past sanitizeServerText (AC-14)', () => {
  it('the source holds exactly the 5 call sites the spec lists', async () => {
    const pattern = /sanitizeServerText\(|\.serverText/;
    const hits: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      for (const line of lines) {
        if (pattern.test(line))
          hits.push(`${file.slice(SRC.length)}: ${line.trim()}`);
      }
    }
    expect(hits).toHaveLength(5);
    const expected = [
      'export function sanitizeServerText(text: string): string {',
      'this.serverText = serverText;',
      'const text = sanitizeServerText(serverText);',
      'return mapStatus(error.status, error.serverText, context);',
      "error instanceof Error ? sanitizeServerText(error.message) : 'unknown';",
    ];
    for (const text of expected) {
      expect(hits.some((hit) => hit.endsWith(text))).toBe(true);
    }
  });
});

describe('ATK-48: every BMP code point is escaped exactly when the standard names it', () => {
  it('scans U+0000 to U+FFFF one by one', () => {
    const wrong: string[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      const input = String.fromCharCode(code);
      const want = isUnsafe(code) ? escapeOf(code) : input;
      if (sanitizeServerText(input) !== want) wrong.push(code.toString(16));
    }
    expect(wrong).toEqual([]);
  });

  it('a lone surrogate next to an escaped character stays where it was', () => {
    expect(sanitizeServerText('\ud800‮\udc00')).toBe('\ud800\\u202e\udc00');
  });
});

describe('ATK-49: the global pattern keeps no state between calls', () => {
  it('the same input gives the same output on every call, in any order', () => {
    const inputs = ['‮', 'a b', 'plain', '⁦⁩', '\u001b'];
    const first = inputs.map(sanitizeServerText);
    for (let round = 0; round < 50; round += 1) {
      for (let i = inputs.length - 1; i >= 0; i -= 1) {
        expect(sanitizeServerText(inputs[i] as string)).toBe(first[i]);
      }
    }
  });

  it('a call made from inside a coercion of another call escapes both texts', () => {
    // A hostile value whose conversion re-enters the sanitizer before the outer replace runs.
    let inner = '';
    const hostile = {
      toString(): string {
        inner = sanitizeServerText('in‮side');
        return 'out side';
      },
    };
    const outer = sanitizeServerText(hostile as unknown as string);
    expect(outer).toBe('out\\u2029side');
    expect(inner).toBe('in\\u202eside');
  });

  it('sanitizedCause escapes a message whose conversion re-enters the sanitizer', () => {
    const error = new Error('x');
    Object.defineProperty(error, 'message', {
      get(): unknown {
        return {
          toString: () => `${sanitizeServerText('‭')}⁧`,
        };
      },
    });
    expect(sanitizedCause(error).message).toBe('\\u202d\\u2067');
  });
});

const FILE_HANDLE = Buffer.from([0, 0, 0, 1]);

/* eslint-disable no-control-regex -- the set under test is control and format characters */
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
/* eslint-enable no-control-regex */

async function hostilePair(serve: (sftp: HostileSftp) => void) {
  const password = sentinel();
  const server = await startHostileServer({ password, serve });
  onTestFinished(() => server.close());
  const knownHostsPath = join(await tempDir(), 'known_hosts');
  await writeFile(knownHostsPath, `${server.knownHostsLine}\n`);
  const fs = newFs(server, knownHostsPath, { password });
  await fs.connect();
  return { fs };
}

/** Collects what a read stream delivers until it errors or ends. */
function drain(
  stream: Readable,
): Promise<{ data: Buffer; error: unknown; ended: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let ended = false;
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      ended = true;
    });
    stream.on('error', (error) =>
      resolve({ data: Buffer.concat(chunks), error, ended }),
    );
    stream.on('close', () =>
      resolve({ data: Buffer.concat(chunks), error: undefined, ended }),
    );
  });
}

describe('ATK-50: a download failed halfway with hostile status text', () => {
  it('errors typed and escaped, never ends, delivers only a true prefix, and the session lives on', async () => {
    const content = randomBytes(512 * 1024);
    const failAt = 200 * 1024;
    const hostile = 'disk\u202eexe.txt\u2028FAKE LOG LINE\u2066\u2069\u001b[2K';
    const { fs } = await hostilePair((sftp) => {
      sftp.on('OPEN', (id) => sftp.handle(id, FILE_HANDLE));
      sftp.on('READ', (id, _handle, offset, length) => {
        if (offset >= failAt) {
          sftp.status(id, STATUS.FAILURE, hostile);
          return;
        }
        sftp.data(
          id,
          content.subarray(offset, Math.min(offset + length, failAt)),
        );
      });
      sftp.on('CLOSE', (id) => sftp.status(id, STATUS.OK, 'OK'));
      sftp.on('STAT', (id) =>
        sftp.attrs(id, {
          mode: 0o100644,
          size: content.length,
          uid: 0,
          gid: 0,
          atime: 0,
          mtime: 0,
        }),
      );
    });

    const outcome = await drain(fs.createReadStream('/f'));

    expect(outcome.ended).toBe(false);
    expect(outcome.error).toBeInstanceOf(RemoteFsError);
    let current: unknown = outcome.error;
    while (current instanceof Error) {
      expect(current.message).not.toMatch(UNSAFE);
      current = current.cause;
    }
    expect(outcome.data.length).toBeLessThanOrEqual(failAt);
    expect(outcome.data.equals(content.subarray(0, outcome.data.length))).toBe(
      true,
    );
    expect((await fs.stat('/f')).size).toBe(content.length);
  });
});
