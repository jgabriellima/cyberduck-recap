import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RemoteFsError } from '../../src/fs/index.js';
import { cli, testRegistry } from '../support/cli.js';
import { sentinel, tempDir } from '../support/harness.js';
import { memBackend, type MemBackend } from '../support/mem-backend.js';

const env = { CYBERDUCK_RECAP_PASSWORD: sentinel() };
const INTERNAL = 'cyberduck-recap: INTERNAL: unexpected error';
const DEFECT_HINT =
  'cyberduck-recap: this is a defect; report it with the command line, without secrets, and the exit code 1';

function run(mem: MemBackend, args: readonly string[]) {
  return cli(args, { env, registry: testRegistry({ mem: mem.factory }) });
}

describe('session lifecycle and unexpected errors (FEATURE-2 AC-33, AC-34)', () => {
  it.each(['success', 'a rejected list()', 'a stream error'] as const)(
    'AC-33: disconnects once after every command (%s)',
    async (variant) => {
      const mem = memBackend();
      mem.directory('/d');
      mem.file('/f.bin', 'remote bytes');
      let args = ['ls', 'mem://u@h/d'];
      if (variant === 'a rejected list()') {
        mem.faults.list = new RemoteFsError('PERMISSION_DENIED', 'denied', {
          path: '/d',
        });
      } else if (variant === 'a stream error') {
        mem.faults.read = new RemoteFsError('CONNECTION_LOST', 'lost', {
          path: '/f.bin',
        });
        args = ['get', 'mem://u@h/f.bin', join(await tempDir(), 'f.bin')];
      }

      const result = await run(mem, args);

      expect(mem.calls.connect).toBe(1);
      expect(mem.calls.disconnect).toBe(1);
      expect(result.code).toBe(
        { success: 0, 'a rejected list()': 17, 'a stream error': 14 }[variant],
      );
    },
  );

  it('AC-33: ignores a disconnect failure after success', async () => {
    const mem = memBackend();
    mem.directory('/d');
    mem.faults.disconnect = new RemoteFsError('CONNECTION_LOST', 'gone');

    const result = await run(mem, ['ls', 'mem://u@h/d']);

    expect(result.code).toBe(0);
    expect(mem.calls.disconnect).toBe(1);
  });

  it('AC-33: does not disconnect when connect rejects', async () => {
    const mem = memBackend();
    mem.faults.connect = new RemoteFsError('CONNECTION_FAILED', 'refused');

    const result = await run(mem, ['ls', 'mem://u@h/']);

    expect(result.code).toBe(13);
    expect(mem.calls.connect).toBe(1);
    expect(mem.calls.disconnect).toBe(0);
  });

  const secret = sentinel();

  it.each([
    ['a TypeError', new TypeError(secret)],
    ['a string', secret],
    ['undefined', undefined],
  ])(
    'AC-34: reports an unexpected error without a stack trace (%s)',
    async (_name, thrown) => {
      const mem = memBackend();
      mem.faults.list = thrown;

      // `runCli` never rejects: an awaited rejection would fail this test here.
      const result = await run(mem, ['ls', 'mem://u@h/']);

      expect(result.code).toBe(1);
      expect(result.stderrLines).toEqual([INTERNAL, DEFECT_HINT]);
      for (const line of result.stderrLines) {
        expect(line).not.toMatch(/^\s+at /);
        expect(line).not.toContain(secret);
      }
      expect(result.stdout).not.toContain(secret);
    },
  );
});
