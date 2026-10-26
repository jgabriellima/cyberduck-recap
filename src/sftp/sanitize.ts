const MAX_SERVER_TEXT = 256;

// C0 controls, DEL and C1 controls: raw, they could rewrite a terminal or forge log lines (G-4).
// Bidi embeddings and overrides (U+202A-U+202E) and isolates (U+2066-U+2069): raw, they let the
// server reorder what a reader sees, so a path or host looks different. Line and paragraph
// separators (U+2028, U+2029): raw, they split one log record into two and forge a log line.
/* eslint-disable no-control-regex -- matching control characters is the point of this pattern */
const UNSAFE_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
/* eslint-enable no-control-regex */

// Controls keep the 2-digit \x form; format characters take the 4-digit \u form, because \x202e
// would read as the escape of U+0020 followed by "2e".
function escapeCharacter(c: string): string {
  const code = c.charCodeAt(0);
  return code <= 0xff
    ? `\\x${code.toString(16).padStart(2, '0')}`
    : `\\u${code.toString(16).padStart(4, '0')}`;
}

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
 * Server-chosen text made safe to embed in an error message: C0/C1 controls, DEL, bidi format
 * characters and the line/paragraph separators are escaped, then the result is capped at 256
 * characters (cyberduck/standard.sanitised-server-text). A non-string at runtime is coerced, never
 * thrown on.
 */
export function sanitizeServerText(text: string): string {
  const escaped = textOf(text).replace(UNSAFE_CHARACTERS, escapeCharacter);
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
