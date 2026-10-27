import { dirname, resolve } from 'node:path';
import type { BackendRegistry, HostKeyInfo } from '../fs/backend.js';
import { RemoteFsError } from '../fs/errors.js';
import type { RemoteFileSystem } from '../fs/types.js';
import { parseCommandLine } from './args.js';
import { planGet, runGet } from './commands/get.js';
import { runLs } from './commands/ls.js';
import { openPutSource, PartialUploadError, runPut } from './commands/put.js';
import type { PutSource } from './commands/put.js';
import { PASSPHRASE_VARIABLE, takeCredential } from './credentials.js';
import { CliError } from './errors.js';
import { CLI_EXIT_CODES, REMOTE_EXIT_CODES } from './exit-codes.js';
import { helpText } from './help.js';
import {
  defaultKnownHostsPath,
  ensurePrivateDirectory,
} from './known-hosts-path.js';
import { writeError, writeHint, type Output } from './output.js';
import { promptLine, TerminalReader, type Input } from './terminal.js';
import { redactingOutput, shownUrl } from './redact.js';
import { parseRemoteUrl } from './url.js';
import { packageVersion } from './version.js';

export interface CliContext {
  readonly stdout: Output;
  readonly stderr: Output;
  readonly stdin: Input;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly home: string;
  readonly registry: BackendRegistry;
  /** Default: the process's umask, read once per call. */
  readonly umask?: number;
  /** Default: the `version` of package.json. */
  readonly version?: string;
}

/** What the hints of a failure need to know about the command that failed. */
interface Situation {
  identity: string | undefined;
  knownHostsPath: string | undefined;
}

const DEFECT_HINT =
  'this is a defect; report it with the command line, without secrets, and the exit code 1';

const REASON_HINTS = {
  PRIVATE_KEY_ENCRYPTED: (file: string) =>
    `the private key in ${file} is encrypted; set ${PASSPHRASE_VARIABLE} to its passphrase`,
  PRIVATE_KEY_PASSPHRASE_WRONG: (file: string) =>
    `the passphrase in ${PASSPHRASE_VARIABLE} does not decrypt the private key in ${file}`,
  PRIVATE_KEY_INVALID: (file: string) =>
    `${file} is not a private key; give the private key file, not the .pub file`,
} as const;

// The read-only form: setting a mask to read it back would race other code and throws in a worker.
function currentUmask(): number {
  return process.umask();
}

function hintsFor(
  error: RemoteFsError,
  situation: Situation,
  isTTY: boolean,
): string[] {
  const { identity } = situation;
  const knownHostsPath =
    situation.knownHostsPath === undefined
      ? undefined
      : shownUrl(situation.knownHostsPath);
  if (
    error.code === 'AUTH_FAILED' &&
    error.reason !== undefined &&
    identity !== undefined
  ) {
    return [REASON_HINTS[error.reason](shownUrl(identity))];
  }
  if (error.code === 'HOST_KEY_UNKNOWN') {
    if (isTTY) {
      return [
        'the host key was not trusted; run the command again and type yes to trust it',
      ];
    }
    return knownHostsPath === undefined
      ? []
      : [
          `the host key is not in ${knownHostsPath}; run from a terminal to confirm it, or add it to that file`,
        ];
  }
  if (error.code === 'HOST_KEY_CHANGED' && knownHostsPath !== undefined) {
    return [
      `the host key differs from the one in ${knownHostsPath}; if the server's key changed on purpose, remove its line from that file`,
    ];
  }
  return [];
}

/** Writes the lines of a failure and gives its exit code. Never writes an unexpected value. */
function report(
  error: unknown,
  context: CliContext,
  situation: Situation,
): number {
  const { stderr } = context;
  if (error instanceof CliError) {
    const { code, hints } = error;
    writeError(stderr, code, textOf(error));
    for (const hint of hints) writeHint(stderr, hint);
    return CLI_EXIT_CODES[code];
  }
  const partial = error instanceof PartialUploadError ? error : undefined;
  const remote = partial?.remoteError ?? error;
  if (remote instanceof RemoteFsError) {
    const { code, path } = remote;
    writeError(stderr, code, textOf(remote), path);
    for (const hint of hintsFor(
      remote,
      situation,
      context.stdin.isTTY === true,
    )) {
      writeHint(stderr, hint);
    }
    if (partial !== undefined) {
      writeHint(
        stderr,
        `the remote file ${partial.remotePath} may be incomplete`,
      );
    }
    return REMOTE_EXIT_CODES[code];
  }
  writeError(stderr, 'INTERNAL', 'unexpected error');
  writeHint(stderr, DEFECT_HINT);
  return CLI_EXIT_CODES.INTERNAL;
}

// Only errors the CLI or a back-end built are shown; their text is never a foreign error's.
function textOf(error: CliError | RemoteFsError): string {
  const { message } = error;
  return message;
}

/** Runs one command: no connection before every local check has passed. */
async function runCommand(
  args: readonly string[],
  context: CliContext,
  situation: Situation,
): Promise<number> {
  const { stdout, stderr, stdin, env, cwd, registry } = context;
  const parsed = parseCommandLine(args);
  if (parsed.kind === 'help') {
    stdout.write(helpText(registry.schemes()));
    return 0;
  }
  if (parsed.kind === 'version') {
    stdout.write(`${context.version ?? packageVersion()}\n`);
    return 0;
  }
  const { command, operands, overwrite } = parsed;
  situation.identity = parsed.identity;
  const urlText = (command === 'put' ? operands[1] : operands[0]) ?? '';
  const location = parseRemoteUrl(urlText, registry);
  const { backend, endpoint } = location;

  let getPlan;
  let putSource: PutSource | undefined;
  if (command === 'get') {
    getPlan = await planGet(location.path, operands[1], cwd, overwrite);
  } else if (command === 'put') {
    putSource = await openPutSource(operands[0] ?? '', cwd);
  }

  try {
    let knownHostsPath: string | undefined;
    if (backend.usesKnownHosts) {
      if (parsed.knownHosts === undefined) {
        knownHostsPath = defaultKnownHostsPath(env, context.home);
        await ensurePrivateDirectory(dirname(knownHostsPath));
      } else {
        knownHostsPath = resolve(cwd, parsed.knownHosts);
      }
    }
    situation.knownHostsPath = knownHostsPath;

    let reader: TerminalReader | undefined;
    const sharedReader = (): TerminalReader =>
      (reader ??= new TerminalReader(stdin));
    const credential = await takeCredential({
      policy: backend.credential,
      identity: parsed.identity,
      cwd,
      env,
      stdin,
      stderr,
      endpoint,
      reader: sharedReader,
    });
    if (credential?.kind === 'privateKey') {
      registry.checkPrivateKey(credential, endpoint);
    }

    const confirmHostKey =
      stdin.isTTY === true && knownHostsPath !== undefined
        ? async (key: HostKeyInfo): Promise<boolean> => {
            const answer = await promptLine(sharedReader(), stderr, [
              `The host key of ${key.host}:${key.port} is not known.`,
              `${key.keyType} key fingerprint: ${key.fingerprint}`,
              `Type yes to trust it and record it in ${knownHostsPath}: `,
            ]);
            return answer === 'yes';
          }
        : undefined;

    const remote: RemoteFileSystem = backend.create({
      ...endpoint,
      credential,
      knownHostsPath,
      confirmHostKey,
    });
    await remote.connect();
    try {
      if (command === 'ls') {
        await runLs(remote, location.path, stdout);
      } else if (getPlan !== undefined) {
        await runGet(remote, getPlan, context.umask ?? currentUmask());
      } else if (putSource !== undefined) {
        await runPut(remote, putSource, location.path, overwrite);
      }
    } finally {
      // Once per connect(); a failure to close changes neither a success nor the first error.
      await remote.disconnect().catch(() => undefined);
    }
    return 0;
  } finally {
    if (putSource?.streamed === false) {
      await putSource.handle.close().catch(() => undefined);
    }
  }
}

/**
 * Resolves to the exit code. Never rejects, never throws. Both outputs are wrapped once, here, so
 * no line any part of the CLI or a back-end writes can show a password typed in a URL (AC-19).
 */
export async function runCli(
  args: readonly string[],
  given: CliContext,
): Promise<number> {
  const context: CliContext = {
    ...given,
    stdout: redactingOutput(given.stdout, args, given.cwd),
    stderr: redactingOutput(given.stderr, args, given.cwd),
  };
  const situation: Situation = {
    identity: undefined,
    knownHostsPath: undefined,
  };
  try {
    return await runCommand(args, context, situation);
  } catch (error) {
    try {
      return report(error, context, situation);
    } catch {
      return CLI_EXIT_CODES.INTERNAL;
    }
  }
}
