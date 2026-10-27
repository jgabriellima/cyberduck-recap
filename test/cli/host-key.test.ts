import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FakeInput,
  cli,
  errorLine,
  hintFollowsError,
  isRoot,
  isWindows,
  testRegistry,
  useCliServer,
  type CliServer,
  type RunResult,
} from '../support/cli.js';
import { sentinel, tempDir } from '../support/harness.js';
import { memBackend } from '../support/mem-backend.js';
import { generateKey } from '../support/sftp-server.js';

const UNTRUSTED_HINT =
  'cyberduck-recap: the host key was not trusted; run the command again and type yes to trust it';

function promptText(server: CliServer, knownHostsPath: string): string {
  const { fixture } = server;
  return [
    `The host key of 127.0.0.1:${fixture.port} is not known.`,
    `${fixture.hostKey.type} key fingerprint: ${fixture.hostKey.fingerprint}`,
    `Type yes to trust it and record it in ${knownHostsPath}: `,
  ].join('\n');
}

function expectStdinUnread(result: RunResult): void {
  expect(result.stdin.readableLength).toBe(result.stdin.bytesWritten);
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

/** A known_hosts file whose only line trusts another host. */
async function otherHostKnownHosts(withFinalLf = true): Promise<{
  path: string;
  content: string;
}> {
  const path = join(await tempDir(), 'known_hosts');
  const content = `example.org ${generateKey().publicKey}${withFinalLf ? '\n' : ''}`;
  await writeFile(path, content);
  return { path, content };
}

const lsArgs = (server: CliServer, knownHosts: string): string[] => [
  'ls',
  '--known-hosts',
  knownHosts,
  server.url('/'),
];

describe('host keys and known_hosts (FEATURE-2 AC-24 to AC-27, AC-39, AC-40)', () => {
  const answers = [
    { answer: 'yes\n', accepted: true },
    { answer: 'yes\r', accepted: true },
    { answer: 'yes\r\n', accepted: true },
    { answer: ' yes\t\n', accepted: true },
    { answer: 'no\n', accepted: false },
    { answer: 'y\n', accepted: false },
    { answer: 'YES\n', accepted: false },
    { answer: 'yess\n', accepted: false },
    { answer: '\n', accepted: false },
    { answer: '', accepted: false, end: true },
    { answer: 'yes', accepted: false, end: true },
  ];

  it.each(answers)(
    'AC-24: asks the person to confirm an unknown host key (answer $answer)',
    async ({ answer, accepted, end }) => {
      const server = await useCliServer();
      const knownHosts = await otherHostKnownHosts();
      const stdin = new FakeInput(true);
      stdin.type(answer);
      if (end === true) stdin.end();

      const result = await cli(lsArgs(server, knownHosts.path), {
        env: server.env,
        stdin,
      });

      expect(result.stderr).toContain(promptText(server, knownHosts.path));
      // The host-key answer is read with raw mode off.
      expect(result.stdin.rawModeCalls).toEqual([]);
      const after = await readFile(knownHosts.path, 'utf8');
      if (accepted) {
        expect(result.code).toBe(0);
        expect(after).toBe(
          `${knownHosts.content}${server.fixture.knownHostsLine}\n`,
        );
      } else {
        expect(result.code).toBe(11);
        expect(errorLine(result)).toMatch(
          /^cyberduck-recap: HOST_KEY_UNKNOWN: /,
        );
        expect(hintFollowsError(result, UNTRUSTED_HINT)).toBe(true);
        expect(after).toBe(knownHosts.content);
      }
    },
  );

  it('AC-24: starts the new known_hosts line on its own line', async () => {
    const server = await useCliServer();
    const knownHosts = await otherHostKnownHosts(false);
    const stdin = new FakeInput(true);
    stdin.type('yes\n');

    const result = await cli(lsArgs(server, knownHosts.path), {
      env: server.env,
      stdin,
    });

    expect(result.code).toBe(0);
    expect(await readFile(knownHosts.path, 'utf8')).toBe(
      `${knownHosts.content}\n${server.fixture.knownHostsLine}\n`,
    );
  });

  it('AC-25: refuses an unknown host key without a terminal', async () => {
    const server = await useCliServer();
    const knownHosts = await otherHostKnownHosts();
    const stdin = new FakeInput(false);
    stdin.type('yes\n');

    const result = await cli(lsArgs(server, knownHosts.path), {
      env: server.env,
      stdin,
    });

    expect(result.code).toBe(11);
    const line = errorLine(result);
    expect(line).toMatch(/^cyberduck-recap: HOST_KEY_UNKNOWN: /);
    expect(line).toContain(server.fixture.hostKey.fingerprint);
    expect(
      hintFollowsError(
        result,
        `cyberduck-recap: the host key is not in ${knownHosts.path}; run from a terminal to confirm it, or add it to that file`,
      ),
    ).toBe(true);
    expect(result.stderr).not.toContain('Type yes');
    expectStdinUnread(result);
    expect(await readFile(knownHosts.path, 'utf8')).toBe(knownHosts.content);
  });

  it.each([true, false])(
    'AC-26: refuses a changed host key and never asks (isTTY %s)',
    async (isTTY) => {
      const server = await useCliServer();
      const other = generateKey();
      const knownHostsPath = join(await tempDir(), 'known_hosts');
      const content = `[127.0.0.1]:${server.fixture.port} ${other.publicKey}\n`;
      await writeFile(knownHostsPath, content);
      const stdin = new FakeInput(isTTY);
      stdin.type('yes\n');

      const result = await cli(lsArgs(server, knownHostsPath), {
        env: server.env,
        stdin,
      });

      expect(result.code).toBe(12);
      const line = errorLine(result);
      expect(line).toMatch(/^cyberduck-recap: HOST_KEY_CHANGED: /);
      expect(line).toContain(server.fixture.hostKey.fingerprint);
      expect(line).toContain(other.fingerprint);
      expect(
        hintFollowsError(
          result,
          `cyberduck-recap: the host key differs from the one in ${knownHostsPath}; if the server's key changed on purpose, remove its line from that file`,
        ),
      ).toBe(true);
      expect(result.stderr).not.toContain('Type yes');
      expectStdinUnread(result);
      expect(await readFile(knownHostsPath, 'utf8')).toBe(content);
    },
  );

  it.each([
    'XDG absolute',
    'XDG relative',
    'XDG empty',
    'XDG unset',
    '--known-hosts',
  ] as const)('AC-27: chooses the known_hosts file (%s)', async (variant) => {
    const home = await tempDir();
    const xdg = join(await tempDir(), 'xdg');
    const explicit = join(await tempDir(), 'my_known_hosts');
    const homeDefault = join(home, '.config', 'cyberduck-recap', 'known_hosts');
    const env: Record<string, string> = {
      CYBERDUCK_RECAP_PASSWORD: sentinel(),
    };
    let args = ['ls', 'mem://u@h/'];
    let expected = homeDefault;
    if (variant === 'XDG absolute') {
      env['XDG_CONFIG_HOME'] = xdg;
      expected = join(xdg, 'cyberduck-recap', 'known_hosts');
    } else if (variant === 'XDG relative') {
      env['XDG_CONFIG_HOME'] = 'relative/xdg';
    } else if (variant === 'XDG empty') {
      env['XDG_CONFIG_HOME'] = '';
    } else if (variant === '--known-hosts') {
      env['XDG_CONFIG_HOME'] = xdg;
      args = ['ls', '--known-hosts', explicit, 'mem://u@h/'];
      expected = explicit;
    }
    const mem = memBackend();
    const directory = join(expected, '..');
    let directoryAtConnect: boolean | undefined;
    mem.onConnect = () => {
      directoryAtConnect = existsSync(directory);
    };

    const result = await cli(args, {
      env,
      home,
      registry: testRegistry({ mem: mem.factory }),
    });

    expect(result.code).toBe(0);
    expect(mem.lastKnownHostsPath()).toBe(expected);
    expect(directoryAtConnect).toBe(true);
    if (variant === '--known-hosts') {
      expect(existsSync(join(home, '.config'))).toBe(false);
      expect(existsSync(xdg)).toBe(false);
    }
  });

  it.skipIf(isWindows)(
    'AC-27: creates missing directories with mode 0700',
    async () => {
      const env = { CYBERDUCK_RECAP_PASSWORD: sentinel() };

      // Nothing exists: both directories of the default path are created with mode 0700.
      const fresh = await tempDir();
      const mem = memBackend();
      let createdBeforeConnect = false;
      mem.onConnect = () => {
        createdBeforeConnect = existsSync(
          join(fresh, '.config', 'cyberduck-recap'),
        );
      };
      const first = await cli(['ls', 'mem://u@h/'], {
        env,
        home: fresh,
        registry: testRegistry({ mem: mem.factory }),
      });
      expect(first.code).toBe(0);
      expect(createdBeforeConnect).toBe(true);
      expect(await modeOf(join(fresh, '.config'))).toBe(0o700);
      expect(await modeOf(join(fresh, '.config', 'cyberduck-recap'))).toBe(
        0o700,
      );

      // An existing directory keeps its mode; only the missing one is created.
      const existing = await tempDir();
      await mkdir(join(existing, '.config'));
      await chmod(join(existing, '.config'), 0o755);
      const second = await cli(['ls', 'mem://u@h/'], {
        env,
        home: existing,
        registry: testRegistry({ mem: memBackend().factory }),
      });
      expect(second.code).toBe(0);
      expect(await modeOf(join(existing, '.config'))).toBe(0o755);
      expect(await modeOf(join(existing, '.config', 'cyberduck-recap'))).toBe(
        0o700,
      );

      // Under an absolute XDG_CONFIG_HOME, every missing directory is created with mode 0700.
      const base = await tempDir();
      const xdg = join(base, 'x', 'y');
      const third = await cli(['ls', 'mem://u@h/'], {
        env: { ...env, XDG_CONFIG_HOME: xdg },
        home: await tempDir(),
        registry: testRegistry({ mem: memBackend().factory }),
      });
      expect(third.code).toBe(0);
      for (const directory of [
        join(base, 'x'),
        xdg,
        join(xdg, 'cyberduck-recap'),
      ]) {
        expect(await modeOf(directory)).toBe(0o700);
      }
    },
  );

  it
    .skipIf(isWindows)
    .each(['the default path', '--known-hosts <file>'] as const)(
    'AC-39: records the first host key in a new known_hosts file (%s)',
    async (variant) => {
      const server = await useCliServer();
      const home = await tempDir();
      const explicit = join(await tempDir(), 'known_hosts');
      const knownHostsPath =
        variant === 'the default path'
          ? join(home, '.config', 'cyberduck-recap', 'known_hosts')
          : explicit;
      const options =
        variant === 'the default path' ? [] : ['--known-hosts', explicit];
      const stdin = new FakeInput(true);
      stdin.type('yes\n');

      const result = await cli(['ls', ...options, server.url('/')], {
        env: server.env,
        home,
        stdin,
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toContain(promptText(server, knownHostsPath));
      expect(await readFile(knownHostsPath, 'utf8')).toBe(
        `${server.fixture.knownHostsLine}\n`,
      );
      expect(await modeOf(knownHostsPath)).toBe(0o600);
      if (variant === 'the default path') {
        expect(await modeOf(join(home, '.config'))).toBe(0o700);
        expect(await modeOf(join(home, '.config', 'cyberduck-recap'))).toBe(
          0o700,
        );
      }

      const again = await cli(['ls', ...options, server.url('/')], {
        env: server.env,
        home,
        stdin: new FakeInput(true),
      });
      expect(again.code).toBe(0);
      expect(again.stderr).not.toContain('is not known');
      expect(again.stderr).not.toContain('Type yes');
    },
  );

  it.each(['no', 'no TTY'] as const)(
    'AC-39: creates no known_hosts file when the key is refused (%s)',
    async (variant) => {
      const server = await useCliServer();
      const home = await tempDir();
      const stdin = new FakeInput(variant === 'no');
      stdin.type('no\n');

      const result = await cli(['ls', server.url('/')], {
        env: server.env,
        home,
        stdin,
      });

      expect(result.code).toBe(11);
      expect(
        existsSync(join(home, '.config', 'cyberduck-recap', 'known_hosts')),
      ).toBe(false);
    },
  );

  const unwritableCases = isRoot || isWindows ? [] : (['b'] as const);

  it.each([...(['a'] as const), ...unwritableCases])(
    'AC-40: reports a known_hosts location it cannot write (%s)',
    async (variant) => {
      const server = await useCliServer();
      const home = await tempDir();
      const stdin = new FakeInput(true);
      stdin.type('yes\n');
      if (variant === 'a') {
        await writeFile(join(home, '.config'), 'a regular file');

        const result = await cli(['ls', server.url('/')], {
          env: server.env,
          home,
          stdin,
        });

        expect(result.code).toBe(3);
        // The criterion names "<directory path>": the directory of the default path that cannot
        // be created. `<home>/.config` exists as a file, so either it or its child is that path.
        expect([
          `cyberduck-recap: LOCAL_FILE: cannot create the directory ${join(home, '.config', 'cyberduck-recap')}`,
          `cyberduck-recap: LOCAL_FILE: cannot create the directory ${join(home, '.config')}`,
        ]).toContain(errorLine(result));
        expect(server.fixture.stats.connections).toBe(0);
        return;
      }
      const locked = join(await tempDir(), 'locked');
      await mkdir(locked);
      await chmod(locked, 0o500);
      const knownHostsPath = join(locked, 'known_hosts');
      try {
        const result = await cli(lsArgs(server, knownHostsPath), {
          env: server.env,
          home,
          stdin,
        });

        expect(result.code).toBe(13);
        expect(
          errorLine(result).startsWith(
            `cyberduck-recap: CONNECTION_FAILED: could not record the host key in the known_hosts file ${knownHostsPath}`,
          ),
        ).toBe(true);
        expect(server.fixture.stats.authAttempts).toBe(0);
        expect(existsSync(knownHostsPath)).toBe(false);
      } finally {
        await chmod(locked, 0o700);
      }
    },
  );

  it.skipIf(isRoot || isWindows)(
    'AC-40: reports a known_hosts file it cannot read',
    async () => {
      const server = await useCliServer();
      const knownHostsPath = join(await tempDir(), 'known_hosts');
      const content = `${server.fixture.knownHostsLine}\n`;
      await writeFile(knownHostsPath, content);
      await chmod(knownHostsPath, 0o000);
      const stdin = new FakeInput(true);
      stdin.type('yes\n');

      const result = await cli(lsArgs(server, knownHostsPath), {
        env: server.env,
        stdin,
      });

      expect(result.code).toBe(13);
      expect(
        errorLine(result).startsWith(
          `cyberduck-recap: CONNECTION_FAILED: could not read the known_hosts file ${knownHostsPath}`,
        ),
      ).toBe(true);
      expect(result.stderr).not.toContain('Type yes');
      expect(server.fixture.stats.authAttempts).toBe(0);
      expect(await modeOf(knownHostsPath)).toBe(0o000);
      await chmod(knownHostsPath, 0o600);
      expect(await readFile(knownHostsPath, 'utf8')).toBe(content);
    },
  );
});
