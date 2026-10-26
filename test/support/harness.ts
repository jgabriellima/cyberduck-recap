/** Per-test resources: every server, directory and connection is cleaned up when its test ends. */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import { SftpFileSystem } from '../../src/index.js';
import type { SftpFileSystemOptions } from '../../src/sftp/options.js';
import {
  startSftpServer,
  type SftpServerFixture,
  type SftpServerOptions,
} from './sftp-server.js';

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sftp-test-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A random value made at test time: never a real credential. */
export function sentinel(): string {
  return randomBytes(24).toString('hex');
}

export async function useServer(
  options: SftpServerOptions = {},
): Promise<SftpServerFixture> {
  const fixture = await startSftpServer(options);
  onTestFinished(() => fixture.close());
  return fixture;
}

/** A known_hosts file that trusts the fixture's host key. */
export async function trustingKnownHosts(
  fixture: SftpServerFixture,
): Promise<string> {
  const path = join(await tempDir(), 'known_hosts');
  await writeFile(path, `${fixture.knownHostsLine}\n`);
  return path;
}

export type OptionOverrides = Partial<
  Record<keyof SftpFileSystemOptions, unknown>
>;

export function newFs(
  fixture: { readonly host: string; readonly port: number },
  knownHostsPath: string,
  overrides: OptionOverrides = {},
): SftpFileSystem {
  const options: Record<string, unknown> = {
    host: fixture.host,
    port: fixture.port,
    username: 'tester',
    knownHostsPath,
    ...overrides,
  };
  for (const key of Object.keys(options)) {
    if (options[key] === undefined) delete options[key];
  }
  const fs = new SftpFileSystem(options as unknown as SftpFileSystemOptions);
  onTestFinished(() => fs.disconnect());
  return fs;
}

/** A server with a password user, and a connected instance that trusts it. */
export async function connectedPair(
  serverOptions: SftpServerOptions = {},
): Promise<{
  fixture: SftpServerFixture;
  fs: SftpFileSystem;
  knownHostsPath: string;
  password: string;
}> {
  const password = sentinel();
  const fixture = await useServer({ password, ...serverOptions });
  const knownHostsPath = await trustingKnownHosts(fixture);
  const fs = newFs(fixture, knownHostsPath, { password });
  await fs.connect();
  return { fixture, fs, knownHostsPath, password };
}
