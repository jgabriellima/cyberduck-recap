/** A URL scheme and its `:`, as the URL parser reads one at the start of the text. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Typed text for an error line, with a URL password replaced by `***`. Every error line and hint
 * that shows a word, an option name or a path the person typed passes it through this one
 * function: a URL typed in the wrong place (as the command, an option or a local path) must not
 * leak its password there either. The redaction reads the text as the URL parser does: it first
 * removes every ASCII TAB, LF and CR, and the leading and trailing C0 controls and spaces, so none
 * of them can hide `://` or `@` from it. A URL that fails to parse may still hold a password, and
 * an unencoded one may hold `/`, `?`, `#`, `:` or `@`; so the text from the first `:` after the
 * scheme (from the start when there is no scheme) to the last `@` is redacted. Without `@` there is
 * no user information and the text is shown as typed. A path that holds `@`, or a
 * non-hierarchical URL, is over-redacted, which costs only detail in an error line.
 */
export function shownUrl(text: string): string {
  const removed = text.replace(/[\t\n\r]/g, '');
  let first = 0;
  let end = removed.length;
  while (first < end && removed.charCodeAt(first) <= 0x20) first += 1;
  while (end > first && removed.charCodeAt(end - 1) <= 0x20) end -= 1;
  const seen = removed.slice(first, end);
  const at = seen.lastIndexOf('@');
  if (at < 0) return text;
  const colon = seen.indexOf(':', SCHEME.exec(seen)?.[0].length ?? 0);
  if (colon < 0 || colon > at) return text;
  return `${seen.slice(0, colon)}:***${seen.slice(at)}`;
}
