import type {
  BackendRegistry,
  Endpoint,
  ResolvedBackend,
} from '../fs/backend.js';
import { usageError } from './errors.js';

export interface RemoteLocation {
  readonly backend: ResolvedBackend;
  readonly endpoint: Endpoint;
  /** The percent-decoded URL path; `.` (the login directory) when the URL has none. */
  readonly path: string;
}

/**
 * The URL as the person typed it, for an error line, with the password replaced by `***`. A URL
 * that fails to parse may still hold a password, and an unencoded one may hold `/`, `?`, `#`, `:`
 * or `@`; so the user information runs from the `://` to the last `@` of the whole text, and the
 * text between its first `:` and that `@` is redacted. A path that holds `@` is over-redacted,
 * which costs only detail in an error line.
 */
function shownUrl(text: string): string {
  const separator = text.indexOf('://');
  if (separator < 0) return text;
  const start = separator + 3;
  const at = text.lastIndexOf('@');
  if (at < start) return text;
  const colon = text.indexOf(':', start);
  if (colon < 0 || colon > at) return text;
  return `${text.slice(0, colon)}:***${text.slice(at)}`;
}

function decode(text: string, part: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw usageError(`invalid percent-encoding in the URL ${part}`);
  }
}

/** Parses a URL into its back-end, its endpoint and its remote path; no I/O. */
export function parseRemoteUrl(
  text: string,
  registry: BackendRegistry,
): RemoteLocation {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw usageError(`invalid URL '${shownUrl(text)}'`);
  }
  if (url.password !== '') {
    throw usageError(
      'passwords are not accepted in the URL; use --identity, CYBERDUCK_RECAP_PASSWORD or the prompt',
    );
  }
  const scheme = url.protocol.replace(/:$/, '');
  const backend = registry.get(scheme);
  if (backend === undefined) {
    throw usageError(
      `no back-end for the scheme '${scheme}' (registered: ${registry.schemes().join(', ')})`,
    );
  }
  const port = url.port === '' ? undefined : Number(url.port);
  if (port !== undefined && (port < 1 || port > 65535)) {
    throw usageError(`the port must be 1-65535, got ${port}`);
  }
  const path = url.pathname === '' ? '.' : decode(url.pathname, 'path');
  if (path.includes('\0')) {
    throw usageError('the URL path must not contain U+0000');
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const username = decode(url.username, 'user name');
  const endpoint: Endpoint = { host, port, username };
  backend.checkEndpoint(endpoint);
  return { backend, endpoint, path };
}

/** The last `/`-separated segment: empty for `/a/`, `.` for `.`. */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
