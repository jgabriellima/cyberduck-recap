const MAX_SERVER_TEXT = 256;

// C0 controls, DEL and C1 controls: raw, they could rewrite a terminal or forge log lines (G-4).
// eslint-disable-next-line no-control-regex -- matching control characters is the point of this pattern
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Server-chosen text made safe to embed in an error message. */
export function sanitizeServerText(text: string): string {
  const escaped = text.replace(
    CONTROL_CHARACTERS,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
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
