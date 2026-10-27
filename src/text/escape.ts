// C0 controls, DEL and C1 controls: raw, they could rewrite a terminal or forge log lines (G-4).
// Bidi embeddings and overrides (U+202A-U+202E) and isolates (U+2066-U+2069): raw, they let a
// sender reorder what a reader sees, so a path or host looks different. Line and paragraph
// separators (U+2028, U+2029): raw, they split one log record into two and forge a log line.
// This is the only place in src/ that names these code points (cyberduck/standard.single-source).
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

/**
 * Escapes every code point of cyberduck/standard.sanitised-server-text and changes nothing else:
 * up to U+00FF as `\xhh`, above as `\uhhhh`, in lowercase hex. It works on UTF-16 code units, so a
 * lone surrogate stays where it was. No length cap: callers that need one add it.
 */
export function escapeUnsafeText(text: string): string {
  return text.replace(UNSAFE_CHARACTERS, escapeCharacter);
}
