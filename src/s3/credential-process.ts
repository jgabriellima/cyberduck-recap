/**
 * The back-end's own `credential_process` runner (design Option 4C). The SDK's runner loses the
 * exit code and puts the command line and stderr in its error; this one knows the exit code and
 * the signal, never keeps stderr, never shows stdout or the command, and stops a process that
 * does not finish within the bound.
 */
import { spawn } from 'node:child_process';
import { CredentialsUnavailable, type S3Keys } from './transport.js';

/** Larger output is not a credential document; the process is stopped. */
const MAX_OUTPUT_BYTES = 1_048_576;

/** Why a process gave no keys, in words that hold none of its output. */
export type ProcessProblem =
  | { readonly kind: 'exit'; readonly code: number }
  | { readonly kind: 'signal'; readonly signal: string }
  | { readonly kind: 'timeout'; readonly timeoutMs: number }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'start' };

export class ProcessFailure extends CredentialsUnavailable {
  override readonly name: string = 'ProcessFailure';
  readonly problem: ProcessProblem;

  constructor(problem: ProcessProblem) {
    super(`credential_process failed (${problem.kind})`);
    this.problem = problem;
  }
}

function stop(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    // The command runs in a shell; the group holds the shell and what it started.
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

/** The keys of the process's stdout (AWS's credential_process document, `Version` 1). */
export function parseProcessOutput(text: string, now: Date): S3Keys {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new ProcessFailure({ kind: 'invalid' });
  }
  if (typeof document !== 'object' || document === null) {
    throw new ProcessFailure({ kind: 'invalid' });
  }
  const { Version, AccessKeyId, SecretAccessKey, SessionToken, Expiration } =
    document as Record<string, unknown>;
  const text1 = (value: unknown): value is string =>
    typeof value === 'string' && value !== '';
  if (Version !== 1 || !text1(AccessKeyId) || !text1(SecretAccessKey)) {
    throw new ProcessFailure({ kind: 'invalid' });
  }
  if (SessionToken !== undefined && !text1(SessionToken)) {
    throw new ProcessFailure({ kind: 'invalid' });
  }
  let expiration: Date | undefined;
  if (Expiration !== undefined) {
    expiration =
      typeof Expiration === 'string' ? new Date(Expiration) : undefined;
    if (
      expiration === undefined ||
      Number.isNaN(expiration.getTime()) ||
      expiration.getTime() <= now.getTime()
    ) {
      throw new ProcessFailure({ kind: 'invalid' });
    }
  }
  return {
    accessKeyId: AccessKeyId,
    secretAccessKey: SecretAccessKey,
    ...(SessionToken === undefined ? {} : { sessionToken: SessionToken }),
    ...(expiration === undefined ? {} : { expiration }),
  };
}

/**
 * Runs `command` with the shell, as the SDK does, and resolves with its keys. Rejects with
 * ProcessFailure: a non-zero exit, a signal, no end within `timeoutMs` (the process is then
 * stopped), or output that is not a valid document.
 */
export function runCredentialProcess(
  command: string,
  timeoutMs: number,
): Promise<S3Keys> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const child = spawn(command, {
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    });
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };
    const abandon = (problem: ProcessProblem): void => {
      finish(() => {
        stop(child.pid);
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        reject(new ProcessFailure(problem));
      });
    };
    const timer = setTimeout(
      () => abandon({ kind: 'timeout', timeoutMs }),
      timeoutMs,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        abandon({ kind: 'invalid' });
        return;
      }
      chunks.push(chunk);
    });
    // stderr can hold a token: it is read so the process never blocks on it, and dropped.
    child.stderr.resume();
    child.once('error', () => abandon({ kind: 'start' }));
    child.once('close', (code, signal) => {
      finish(() => {
        if (signal !== null) {
          reject(new ProcessFailure({ kind: 'signal', signal }));
        } else if (code !== 0) {
          reject(new ProcessFailure({ kind: 'exit', code: code ?? -1 }));
        } else {
          try {
            resolve(
              parseProcessOutput(
                Buffer.concat(chunks).toString('utf8'),
                new Date(),
              ),
            );
          } catch (error) {
            reject(
              error instanceof ProcessFailure
                ? error
                : new ProcessFailure({ kind: 'invalid' }),
            );
          }
        }
      });
    });
  });
}
