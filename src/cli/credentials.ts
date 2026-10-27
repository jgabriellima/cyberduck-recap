import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Credential, CredentialPolicy, Endpoint } from '../fs/backend.js';
import { localFileError, usageError } from './errors.js';
import { promptPassword, type Input, type TerminalReader } from './terminal.js';
import type { Output } from './output.js';
import { shownUrl } from './url.js';

export const PASSWORD_VARIABLE = 'CYBERDUCK_RECAP_PASSWORD';
export const PASSPHRASE_VARIABLE = 'CYBERDUCK_RECAP_PASSPHRASE';

export interface CredentialSources {
  readonly policy: CredentialPolicy;
  readonly identity: string | undefined;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: Input;
  readonly stderr: Output;
  readonly endpoint: Endpoint;
  /** Made on first use, so a command that never prompts never touches `stdin`. */
  readonly reader: () => TerminalReader;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The credential from the first source that applies, as the back-end's policy allows: the key
 * file of `--identity`, then CYBERDUCK_RECAP_PASSWORD, then (policy 'required' and a terminal
 * only) a prompt. No secret is ever put into an error.
 */
export async function takeCredential(
  sources: CredentialSources,
): Promise<Credential | undefined> {
  const { policy, identity, env, stdin, endpoint } = sources;
  if (policy === 'none') return undefined;
  if (identity !== undefined) {
    let privateKey: Buffer;
    try {
      privateKey = await readFile(resolve(sources.cwd, identity));
    } catch {
      throw localFileError(
        `cannot read the identity file ${shownUrl(identity)}`,
      );
    }
    return {
      kind: 'privateKey',
      privateKey,
      passphrase: nonEmpty(env[PASSPHRASE_VARIABLE]),
    };
  }
  const password = nonEmpty(env[PASSWORD_VARIABLE]);
  if (password !== undefined) return { kind: 'password', password };
  if (policy === 'optional') return undefined;
  if (stdin.isTTY !== true) {
    throw usageError(
      `no credential: give --identity <file>, set ${PASSWORD_VARIABLE}, or run from a terminal`,
    );
  }
  const typed = await promptPassword(
    sources.reader(),
    stdin,
    sources.stderr,
    `Password for ${endpoint.username}@${endpoint.host}: `,
  );
  return { kind: 'password', password: typed };
}
