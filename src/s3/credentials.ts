/**
 * Where the keys come from (design Option 4C, spec "Credential precedence"): the option, else
 * the SDK's standard chain, with own code only where the SDK loses a fact the spec needs (a
 * missing selected profile, the exit code of a `credential_process`) or makes its text unsafe to
 * show. The whole resolution is bound by `timeoutMs`, and a failure gets a fixed message that
 * names the profile and the two shared files, never a line of a file or the output of a process.
 */
import type { Agent } from 'node:https';
import type { RemoteFsError } from '../fs/errors.js';
import { escapeUnsafeText } from '../text/escape.js';
import { ProcessFailure, runCredentialProcess } from './credential-process.js';
import type { S3Errors } from './errors.js';
import type { SecretSet } from './secrets.js';
import { profileSettings, type S3Settings } from './settings.js';
import {
  CredentialsUnavailable,
  type KeyProvider,
  type LoadedProfiles,
  type S3Keys,
  type SdkModule,
  type SharedFilePaths,
} from './transport.js';

/** The SDK asks for new keys this long before they expire; the own runner keeps the same rule. */
const REFRESH_WINDOW_MS = 300_000;

export interface ResolvedCredentials {
  readonly provider: KeyProvider;
  /** `option credentials`, `environment` or `profile <name>`. */
  readonly source: string;
}

export interface CredentialInput {
  readonly option:
    | {
        readonly accessKeyId: string;
        readonly secretAccessKey: string;
        readonly sessionToken?: string;
      }
    | undefined;
  readonly settings: S3Settings;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly profiles: LoadedProfiles;
  readonly paths: SharedFilePaths;
  readonly timeoutMs: number;
  /** The instance's agent, for the chain's STS and SSO requests. */
  readonly agent: Agent;
  readonly secrets: SecretSet;
  readonly errors: S3Errors;
  readonly sdk: SdkModule;
}

function label(name: string): string {
  return `profile ${escapeUnsafeText(name).slice(0, 128)}`;
}

/**
 * A profile whose keys only its `credential_process` gives, in the SDK's own order (assume role,
 * static keys, web identity, SSO, then process): only then does the back-end run the process.
 */
function processCommandOf(
  settings: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (settings === undefined) return undefined;
  const command = settings.credential_process;
  if (command === undefined || command === '') return undefined;
  const otherSource =
    settings.role_arn !== undefined ||
    (settings.aws_access_key_id !== undefined &&
      settings.aws_secret_access_key !== undefined) ||
    settings.web_identity_token_file !== undefined ||
    settings.sso_session !== undefined ||
    settings.sso_start_url !== undefined;
  return otherSource ? undefined : command;
}

/** Keys from `inner`, kept until 5 minutes before they expire; each secret joins the set. */
function remembered(inner: KeyProvider, secrets: SecretSet): KeyProvider {
  let current: S3Keys | undefined;
  let pending: Promise<S3Keys> | undefined;
  return () => {
    const fresh =
      current !== undefined &&
      (current.expiration === undefined ||
        current.expiration.getTime() - Date.now() > REFRESH_WINDOW_MS);
    if (fresh && current !== undefined) return Promise.resolve(current);
    pending ??= inner().then(
      (keys) => {
        secrets.add(keys.secretAccessKey);
        secrets.add(keys.sessionToken);
        current = keys;
        pending = undefined;
        return keys;
      },
      (error: unknown) => {
        pending = undefined;
        throw error instanceof CredentialsUnavailable
          ? error
          : new CredentialsUnavailable('the credential source failed');
      },
    );
    return pending;
  };
}

/** Rejects with `onTimeout()` when `promise` has not settled within `ms`. */
function bounded<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('failed'));
      },
    );
  });
}

function processText(problem: ProcessFailure['problem']): string {
  switch (problem.kind) {
    case 'exit':
      return `exited with code ${problem.code}`;
    case 'signal':
      return `was stopped by signal ${problem.signal}`;
    case 'timeout':
      return `did not finish within ${problem.timeoutMs} ms`;
    case 'invalid':
      return 'printed no valid credentials';
    case 'start':
      return 'could not be started';
  }
}

/**
 * Resolves the keys once, within `timeoutMs`, and returns the provider the clients use. Rejects
 * with AUTH_FAILED and no request sent when no source gives keys.
 */
export async function resolveCredentials(
  input: CredentialInput,
): Promise<ResolvedCredentials> {
  const { option, settings, env, profiles, paths, timeoutMs, secrets, errors } =
    input;
  const files = `shared credentials file ${paths.credentials}, config file ${paths.config}`;
  const authFailed = (text: string): RemoteFsError =>
    errors.fail('AUTH_FAILED', `${text} (${files})`);

  if (option !== undefined) {
    const keys: S3Keys = option;
    return {
      provider: () => Promise.resolve(keys),
      source: 'option credentials',
    };
  }

  const selected = settings.selectedProfile;
  if (
    selected !== undefined &&
    profileSettings(profiles, selected) === undefined
  ) {
    throw authFailed(
      `cannot read AWS credentials: ${label(selected)} was not found`,
    );
  }
  const envKeys =
    env.AWS_ACCESS_KEY_ID !== undefined &&
    env.AWS_ACCESS_KEY_ID !== '' &&
    env.AWS_SECRET_ACCESS_KEY !== undefined &&
    env.AWS_SECRET_ACCESS_KEY !== '';
  // With a profile selected the chain skips the environment keys; else it reads them first.
  const chainProfile = selected ?? (envKeys ? undefined : 'default');
  const chainSettings =
    chainProfile === undefined
      ? undefined
      : profileSettings(profiles, chainProfile);
  const command = processCommandOf(chainSettings);

  let provider: KeyProvider;
  let source: string;
  let explain: (error: unknown) => string;
  if (chainProfile !== undefined && command !== undefined) {
    const name = label(chainProfile);
    provider = remembered(
      () => runCredentialProcess(command, timeoutMs),
      secrets,
    );
    source = name;
    explain = (error) =>
      error instanceof ProcessFailure
        ? `cannot read AWS credentials: the credential_process of ${name} ${processText(error.problem)}`
        : `cannot read AWS credentials from ${name}`;
  } else {
    provider = remembered(
      input.sdk.chainCredentials({
        profile: selected,
        paths,
        agent: input.agent,
        timeoutMs,
      }),
      secrets,
    );
    if (selected !== undefined) source = label(selected);
    else if (envKeys) source = 'environment';
    else source = label('default');
    const nothing =
      selected === undefined && !envKeys && chainSettings === undefined;
    explain = () =>
      nothing
        ? `no AWS credentials were found: no profile is selected, the environment holds no keys and ${label('default')} was not found`
        : `cannot read AWS credentials from ${source}`;
  }

  try {
    await bounded(
      provider(),
      timeoutMs,
      () => new ProcessFailure({ kind: 'timeout', timeoutMs }),
    );
  } catch (error) {
    if (
      error instanceof ProcessFailure &&
      error.problem.kind === 'timeout' &&
      command === undefined
    ) {
      throw authFailed(
        `cannot read AWS credentials: the credential chain gave no keys within ${timeoutMs} ms`,
      );
    }
    throw authFailed(explain(error));
  }
  return { provider, source };
}
