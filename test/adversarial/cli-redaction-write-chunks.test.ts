/**
 * Adversarial (FEATURE-2, ATK-77), topic "secrets on the command line": `redactingOutput` redacts
 * each `write()` call on its own, and only a string chunk. A password split across two calls, or
 * written as a Buffer, passes it unchanged. The first test is the property AC-19 needs: every write
 * of a real run (hints, the host-key prompt, back-end error lines) is one whole string, so the
 * wrapper sees the whole `:<password>@` on one chunk.
 *
 * Deferred (ATK-77): the second test pins the wrapper's per-chunk behaviour. No writer of the CLI
 * splits a line or writes a Buffer today (the first test), so no criterion fails; a writer that
 * streams a line in parts would bypass the one output point. It is not the wanted behaviour: a
 * fix that buffers to the line end changes the second test, and later runs replay the finding.
 */
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { redactingOutput } from '../../src/cli/redact.js';
import { FakeInput, testRegistry, useCliServer } from '../support/cli.js';
import { sentinel, tempDir } from '../support/harness.js';

/** An output that keeps every `write()` call as it was made. */
function recorder(): { calls: unknown[][]; write: (...a: unknown[]) => true } {
  const calls: unknown[][] = [];
  return {
    calls,
    write: (...args: unknown[]) => {
      calls.push(args);
      return true;
    },
  };
}

describe('ATK-77: the one output point sees each line whole', () => {
  it.each([
    ['no terminal: the HOST_KEY_UNKNOWN hints', false, ''],
    ['a terminal, answer no: the prompt and the hints', true, 'no\n'],
    ['a terminal, answer yes: the prompt and the record error', true, 'yes\n'],
  ])('%s', async (_label, isTTY, answer) => {
    const server = await useCliServer();
    const secret = sentinel();
    const cwd = await tempDir();
    const stdin = new FakeInput(isTTY);
    if (answer !== '') stdin.type(answer);
    const stdout = recorder();
    const stderr = recorder();

    const code = await runCli(
      ['ls', '--known-hosts', `sftp://u:${secret}@h/kh`, server.url('/')],
      {
        stdout,
        stderr,
        stdin,
        env: server.env,
        cwd,
        home: cwd,
        registry: testRegistry(),
      } as never,
    );

    expect([11, 13]).toContain(code);
    const chunks = [...stdout.calls, ...stderr.calls].map((call) => call[0]);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(typeof chunk).toBe('string');
      // A whole line, or the prompt's last line, which waits for the answer on the same line.
      expect(chunk as string).toMatch(/(\n|: )$/);
      expect(chunk as string).not.toContain(secret);
    }
    expect(chunks.join('')).toContain(':***@h/kh');
  });

  it('deferred ATK-77: today a split write or a Buffer passes unredacted', () => {
    const secret = sentinel();
    const sink = recorder();
    const out = redactingOutput(sink, ['ls', `sftp://u:${secret}@h/`], '/w');

    out.write(`x sftp://u:${secret}@h/ y\n`);
    out.write(`a :${secret.slice(0, 4)}`);
    out.write(`${secret.slice(4)}@h b\n`);
    out.write(Buffer.from(`c :${secret}@h d\n`));

    expect(sink.calls[0]?.[0]).toBe('x sftp://u:***@h/ y\n');
    expect(sink.calls[1]?.[0]).toBe(`a :${secret.slice(0, 4)}`);
    expect(sink.calls[2]?.[0]).toBe(`${secret.slice(4)}@h b\n`);
    expect(String(sink.calls[3]?.[0])).toBe(`c :${secret}@h d\n`);
  });
});
