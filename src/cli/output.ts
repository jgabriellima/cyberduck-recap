import { escapeUnsafeText } from '../text/escape.js';
import { PROGRAM } from './errors.js';

export type Output = Pick<NodeJS.WritableStream, 'write'>;

/** Writes one line; every line the CLI writes passes through the one escape of src/text/. */
export function writeLine(stream: Output, text: string): void {
  stream.write(`${escapeUnsafeText(text)}\n`);
}

/** Writes one TAB-separated line; each field is escaped, so the separators are the only TABs. */
export function writeFields(stream: Output, fields: readonly string[]): void {
  stream.write(`${fields.map(escapeUnsafeText).join('\t')}\n`);
}

/** The spec's error line: `cyberduck-recap: <CODE>: <text>`, the path appended when not in it. */
export function writeError(
  stream: Output,
  code: string,
  text: string,
  path?: string,
): void {
  const suffix = path === undefined || text.includes(path) ? '' : ` (${path})`;
  writeLine(stream, `${PROGRAM}: ${code}: ${text}${suffix}`);
}

/** A hint line: `cyberduck-recap: <text>`, with no code. */
export function writeHint(stream: Output, text: string): void {
  writeLine(stream, `${PROGRAM}: ${text}`);
}

/**
 * Prompt text: each line escaped, joined by LF, the last one without a line end. No prompt line
 * begins with the program name, so it can never be read as an error line.
 */
export function writePrompt(stream: Output, lines: readonly string[]): void {
  stream.write(lines.map(escapeUnsafeText).join('\n'));
}
