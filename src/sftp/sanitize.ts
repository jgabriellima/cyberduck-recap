import { escapeUnsafeText } from '../text/escape.js';

const MAX_SERVER_TEXT = 256;

// The type says string, but ssh2 handlers pass whatever an error carries; a non-string must turn
// into text, never into an exception escaping an event handler.
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    return '';
  }
}

/**
 * Server-chosen text made safe to embed in an error message: escaped by `escapeUnsafeText` of
 * src/text/escape.ts (the one source of the escaped set, which the CLI also uses), then capped at
 * 256 characters (cyberduck/standard.sanitised-server-text). A non-string at runtime is coerced,
 * never thrown on.
 */
export function sanitizeServerText(text: string): string {
  const escaped = escapeUnsafeText(textOf(text));
  return escaped.length > MAX_SERVER_TEXT
    ? escaped.slice(0, MAX_SERVER_TEXT)
    : escaped;
}

/**
 * A directory entry name must be exactly one POSIX path segment (G-3); anything else comes from a
 * broken or hostile server and would turn the joined path into a traversal.
 */
export function isValidEntryName(name: string): boolean {
  return name.length > 0 && !name.includes('/') && !name.includes('\0');
}
