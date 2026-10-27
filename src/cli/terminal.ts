import { CliError, usageError } from './errors.js';
import { writePrompt, type Output } from './output.js';

export type Input = NodeJS.ReadableStream & {
  readonly isTTY?: boolean;
  readonly readableEnded?: boolean;
  readonly destroyed?: boolean;
  setRawMode?(mode: boolean): unknown;
};

const CR = 0x0d;
const LF = 0x0a;
const BS = 0x08;
const DEL = 0x7f;
const CTRL_C = 0x03;
const CTRL_D = 0x04;
const CTRL_U = 0x15;

/**
 * One byte reader over `stdin`, shared by the password prompt and the host-key prompt. It listens
 * only while a prompt waits, so a command that asks nothing reads nothing. Bytes after a line end
 * stay in its buffer for the next prompt, and an LF directly after a CR is dropped, also when the
 * two arrive in different chunks or for different prompts.
 */
export class TerminalReader {
  readonly #input: Input;
  #buffer: Buffer = Buffer.alloc(0);
  #ended = false;
  #afterCr = false;

  constructor(input: Input) {
    this.#input = input;
    // An error between two prompts would otherwise be an unhandled 'error' event; it only marks
    // the input as ended. This listener reads nothing.
    input.on('error', () => {
      this.#ended = true;
    });
  }

  /** The next byte, or `undefined` once the input ended, failed or closed. */
  async readByte(): Promise<number | undefined> {
    for (;;) {
      const byte = this.#buffer[0];
      if (byte !== undefined) {
        this.#buffer = this.#buffer.subarray(1);
        const dropped = byte === LF && this.#afterCr;
        this.#afterCr = byte === CR;
        if (!dropped) return byte;
        continue;
      }
      if (this.#ended || this.#input.readableEnded === true) return undefined;
      if (this.#input.destroyed === true) return undefined;
      await this.#fill();
    }
  }

  /** Waits for the next chunk, the end, an error or a close; then stops listening. */
  #fill(): Promise<void> {
    const input = this.#input;
    return new Promise((resolve) => {
      const finish = (): void => {
        input.removeListener('data', onData);
        input.removeListener('end', onEnd);
        input.removeListener('error', onEnd);
        input.removeListener('close', onEnd);
        input.pause();
        resolve();
      };
      const onData = (chunk: Buffer | string): void => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        this.#buffer = Buffer.concat([this.#buffer, bytes]);
        finish();
      };
      const onEnd = (): void => {
        this.#ended = true;
        finish();
      };
      input.on('data', onData);
      input.on('end', onEnd);
      // An input that fails or closes is an input that ended: the prompt cancels, it never hangs.
      input.on('error', onEnd);
      input.on('close', onEnd);
      input.resume();
    });
  }
}

export const CANCELLED_TEXT = 'the password prompt was cancelled';

/** Removes the last code point of a UTF-8 byte list: its continuation bytes and its lead byte. */
function removeLastCodePoint(bytes: number[]): void {
  while (bytes.length > 0 && ((bytes[bytes.length - 1] ?? 0) & 0xc0) === 0x80) {
    bytes.pop();
  }
  bytes.pop();
}

/**
 * Reads a password in raw mode, byte by byte, with no echo. Raw mode is switched off and one LF
 * written however the answer ends, so the terminal is never left raw and the next line starts on
 * its own line. Ctrl-C reaches the CLI as a byte in raw mode, not as a signal.
 */
export async function promptPassword(
  reader: TerminalReader,
  input: Input,
  stderr: Output,
  prompt: string,
): Promise<string> {
  writePrompt(stderr, [prompt]);
  input.setRawMode?.(true);
  const answer: number[] = [];
  let ended: 'line' | 'cancel';
  try {
    for (;;) {
      const byte = await reader.readByte();
      if (byte === undefined || byte === CTRL_C || byte === CTRL_D) {
        ended = 'cancel';
        break;
      }
      if (byte === CR || byte === LF) {
        ended = 'line';
        break;
      }
      if (byte === DEL || byte === BS) removeLastCodePoint(answer);
      else if (byte === CTRL_U) answer.length = 0;
      else if (byte >= 0x20) answer.push(byte);
      // Every other C0 byte (an arrow key's ESC among them) is discarded.
    }
  } finally {
    input.setRawMode?.(false);
    stderr.write('\n');
  }
  if (ended === 'cancel') throw new CliError('CANCELLED', CANCELLED_TEXT);
  if (answer.length === 0) throw usageError('the password is empty');
  return Buffer.from(answer).toString('utf8');
}

/**
 * Reads one line with raw mode untouched (the terminal echoes it), up to the first line end. The
 * answer counts only when a line end ended it; spaces and TABs around it are removed.
 */
export async function promptLine(
  reader: TerminalReader,
  stderr: Output,
  lines: readonly string[],
): Promise<string | undefined> {
  writePrompt(stderr, lines);
  const answer: number[] = [];
  let complete = false;
  for (;;) {
    const byte = await reader.readByte();
    if (byte === undefined) break;
    if (byte === CR || byte === LF) {
      complete = true;
      break;
    }
    answer.push(byte);
  }
  // A test or a pipe does not echo the line end: the next line must still start on its own.
  stderr.write('\n');
  if (!complete) return undefined;
  return Buffer.from(answer)
    .toString('utf8')
    .replace(/^[ \t]+|[ \t]+$/g, '');
}
