import type {
  BackendRegistry,
  Endpoint,
  ResolvedBackend,
} from '../fs/backend.js';
import { PASSWORD_VARIABLE } from './credentials.js';
import { usageError } from './errors.js';
import { shownUrl } from './redact.js';

export interface RemoteLocation {
  readonly backend: ResolvedBackend;
  readonly endpoint: Endpoint;
  /** The percent-decoded URL path; `.` (the login directory) when the URL has none. */
  readonly path: string;
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
      `passwords are not accepted in the URL; use --identity, ${PASSWORD_VARIABLE} or the prompt`,
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
