import { resolve } from 'node:path';
import { escapeUnsafeText } from '../text/escape.js';
import type { Output } from './output.js';

/** A URL scheme and its `:`, as the URL parser reads one at the start of the text. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** What a redacted password shows in its place. */
const MASK = '***';

/** The user information of a typed text: what `shownUrl` shows and what it hides. */
interface UserInfo {
  /** The text before the `:`, as the parser reads it. */
  readonly before: string;
  /** The text from the last `@` on, as the parser reads it. */
  readonly after: string;
  /** The hidden text as the parser reads it and as it stands in the typed text. */
  readonly hidden: readonly [string, string];
}

/**
 * Reads the text as the URL parser does: it first removes every ASCII TAB, LF and CR, and the
 * leading and trailing C0 controls and spaces, so none of them can hide `://` or `@`. A URL that
 * fails to parse may still hold a password, and an unencoded one may hold `/`, `?`, `#`, `:` or
 * `@`; so the text from the first `:` after the scheme (from the start when there is no scheme) to
 * the last `@` is hidden. Without `@` there is no user information and nothing is hidden.
 */
function userInfoOf(text: string): UserInfo | undefined {
  // The index in `text` of each character the parser keeps.
  const kept: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (!/[\t\n\r]/.test(text.charAt(i))) kept.push(i);
  }
  const removed = kept.map((i) => text.charAt(i)).join('');
  let first = 0;
  let end = removed.length;
  while (first < end && removed.charCodeAt(first) <= 0x20) first += 1;
  while (end > first && removed.charCodeAt(end - 1) <= 0x20) end -= 1;
  const seen = removed.slice(first, end);
  const at = seen.lastIndexOf('@');
  if (at < 0) return undefined;
  const colon = seen.indexOf(':', SCHEME.exec(seen)?.[0].length ?? 0);
  if (colon < 0 || colon > at) return undefined;
  const rawColon = kept[first + colon] ?? 0;
  const rawAt = kept[first + at] ?? text.length;
  return {
    before: seen.slice(0, colon),
    after: seen.slice(at),
    hidden: [seen.slice(colon + 1, at), text.slice(rawColon + 1, rawAt)],
  };
}

/**
 * Typed text for an error line, with a URL password replaced by `***`. An error line or hint that
 * names a word, an option or a path the person typed shows it through this function, so the line
 * reads well; `redactingOutput` is the guarantee behind it for every line. A path that holds `@`,
 * or a non-hierarchical URL, is over-redacted, which costs only detail in an error line.
 */
export function shownUrl(text: string): string {
  const info = userInfoOf(text);
  return info === undefined ? text : `${info.before}:${MASK}${info.after}`;
}

/**
 * The hidden text of every value the person typed, in each form a line can show it: as typed and
 * as the parser reads it; resolved against the working directory, as a back-end names a path
 * (`//` becomes `/`, `..` goes away); an option's value after its `=`; and each of these escaped,
 * as every line is written. The longest come first, so no shorter one leaves part of one behind.
 */
export function typedSecrets(args: readonly string[], cwd: string): string[] {
  const values = args.flatMap((arg) => {
    const equals = arg.indexOf('=');
    return arg.startsWith('-') && equals >= 0
      ? [arg, arg.slice(equals + 1)]
      : [arg];
  });
  const forms = values
    .flatMap((value) => [value, resolve(cwd, value)])
    .flatMap((value) => userInfoOf(value)?.hidden ?? [])
    .flatMap((hidden) => [hidden, escapeUnsafeText(hidden)])
    .filter((hidden) => hidden.length > 0);
  return [...new Set(forms)].sort((a, b) => b.length - a.length);
}

/**
 * The one point every line of the CLI passes on its way out: the hints, the prompts and the error
 * text of a back-end, which names a path as it got it. Whatever wrote a line, a password the person
 * typed in a URL is replaced by `***` there. Only text between a `:` and an `@` is replaced, the
 * way `shownUrl` shows it, so the same characters elsewhere in a line stay as they are. Every
 * write of the CLI is a string (src/cli/output.ts); anything else passes unchanged.
 */
export function redactingOutput(
  output: Output,
  args: readonly string[],
  cwd: string,
): Output {
  const secrets = typedSecrets(args, cwd);
  if (secrets.length === 0) return output;
  const redact = (text: string): string =>
    secrets.reduce(
      (line, secret) => line.split(`:${secret}@`).join(`:${MASK}@`),
      text,
    );
  const write = output.write.bind(output) as (
    chunk: unknown,
    ...rest: unknown[]
  ) => boolean;
  return {
    write: (chunk: unknown, ...rest: unknown[]) =>
      write(typeof chunk === 'string' ? redact(chunk) : chunk, ...rest),
  };
}
