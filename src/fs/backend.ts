import type { RemoteFileSystem } from './types.js';

/** What a confirmation callback is shown for an unknown host key. */
export interface HostKeyInfo {
  readonly host: string;
  readonly port: number;
  readonly keyType: string;
  /** `SHA256:` followed by the unpadded base64 SHA-256 of the key blob, as OpenSSH prints it. */
  readonly fingerprint: string;
}

export interface PrivateKeyCredential {
  readonly kind: 'privateKey';
  readonly privateKey: Buffer;
  /** `undefined` when no passphrase was given (an unset or empty variable). */
  readonly passphrase: string | undefined;
}

export type Credential =
  | { readonly kind: 'password'; readonly password: string }
  | PrivateKeyCredential;

/** The parts of a URL that a back-end needs before a credential exists. */
export interface Endpoint {
  /** The brackets of an IPv6 literal are removed. */
  readonly host: string;
  /** `undefined`: the back-end's default port. */
  readonly port: number | undefined;
  /** Percent-decoded; '' when the URL has none. */
  readonly username: string;
}

/** The one argument a factory gets. */
export interface BackendTarget extends Endpoint {
  /** `undefined` when the back-end's credential policy let no source apply. */
  readonly credential: Credential | undefined;
  /** `undefined` only for a back-end that does not use known_hosts. */
  readonly knownHostsPath: string | undefined;
  /** Present only when a person can answer (a terminal). */
  readonly confirmHostKey: ((key: HostKeyInfo) => Promise<boolean>) | undefined;
}

export type BackendFactory = (target: BackendTarget) => RemoteFileSystem;

/**
 * How a caller takes a credential for a back-end:
 * - 'required': a key file, a password variable or a prompt; none applies -> the caller refuses.
 * - 'optional': a key file or a password variable only; none applies -> `credential` undefined.
 * - 'none': no source is read; `credential` is undefined.
 */
export type CredentialPolicy = 'required' | 'optional' | 'none';

export interface BackendDefinition {
  readonly create: BackendFactory;
  /** Default 'optional'. */
  readonly credential?: CredentialPolicy;
  /** Default true. */
  readonly usesKnownHosts?: boolean;
  /** Throws a RemoteFsError (INVALID_ARGUMENT) for an endpoint it cannot use. No I/O. */
  readonly checkEndpoint?: (endpoint: Endpoint) => void;
}

/** A definition with the defaults applied. */
export interface ResolvedBackend {
  readonly scheme: string;
  readonly create: BackendFactory;
  readonly credential: CredentialPolicy;
  readonly usesKnownHosts: boolean;
  checkEndpoint(endpoint: Endpoint): void;
}

/**
 * Parses a private-key credential before any back-end receives it, and throws a RemoteFsError
 * (AUTH_FAILED, with its `reason`) when the key is not usable. No I/O.
 */
export type PrivateKeyCheck = (
  credential: PrivateKeyCredential,
  endpoint: Endpoint,
) => void;

export interface BackendRegistry {
  /** Throws an Error (a defect of composition) for an invalid, upper-case or duplicate scheme. */
  register(scheme: string, backend: BackendFactory | BackendDefinition): void;
  get(scheme: string): ResolvedBackend | undefined;
  /** Sorted. */
  schemes(): readonly string[];
  /**
   * Sets the check that every private-key credential passes before any back-end gets it, so a
   * caller can refuse an unusable key file without a connection whatever back-end it goes to.
   * Throws an Error when a check is already set.
   */
  setPrivateKeyCheck(check: PrivateKeyCheck): void;
  /** Runs the check that was set; does nothing when none was. */
  checkPrivateKey(credential: PrivateKeyCredential, endpoint: Endpoint): void;
}

// RFC 3986 scheme syntax, lower case only: URL parsing lower-cases the scheme, so an upper-case
// registration could never be found.
const SCHEME = /^[a-z][a-z0-9+.-]*$/;

const acceptEveryEndpoint = (): void => undefined;

function resolve(
  scheme: string,
  backend: BackendFactory | BackendDefinition,
): ResolvedBackend {
  const definition: BackendDefinition =
    typeof backend === 'function' ? { create: backend } : backend;
  return {
    scheme,
    create: definition.create,
    credential: definition.credential ?? 'optional',
    usesKnownHosts: definition.usesKnownHosts ?? true,
    checkEndpoint: definition.checkEndpoint ?? acceptEveryEndpoint,
  };
}

/** A new, empty registry. No module-level state: each call is independent. */
export function createRegistry(): BackendRegistry {
  const backends = new Map<string, ResolvedBackend>();
  let privateKeyCheck: PrivateKeyCheck | undefined;
  return {
    register(scheme, backend) {
      if (!SCHEME.test(scheme)) {
        throw new Error(`invalid scheme "${scheme}": use lower-case letters`);
      }
      if (backends.has(scheme)) {
        throw new Error(`the scheme "${scheme}" is already registered`);
      }
      backends.set(scheme, resolve(scheme, backend));
    },
    get: (scheme) => backends.get(scheme),
    schemes: () => [...backends.keys()].sort(),
    setPrivateKeyCheck(check) {
      if (privateKeyCheck !== undefined) {
        throw new Error('a private-key check is already set');
      }
      privateKeyCheck = check;
    },
    checkPrivateKey(credential, endpoint) {
      privateKeyCheck?.(credential, endpoint);
    },
  };
}
