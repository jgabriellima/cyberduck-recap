import type {
  BackendDefinition,
  BackendTarget,
  Endpoint,
  PrivateKeyCheck,
} from '../fs/backend.js';
import { authFailed, parsePrivateKeyOrFail } from './connection.js';
import {
  DEFAULT_PORT,
  validateEndpoint,
  type SftpFileSystemOptions,
} from './options.js';
import { SftpFileSystem } from './sftp-file-system.js';

/**
 * The options `SftpFileSystem` gets for a target. A missing port is left out, so the back-end's
 * default applies; a missing credential is left out, so `validateOptions` refuses it.
 */
export function sftpOptionsFor(target: BackendTarget): SftpFileSystemOptions {
  const { credential } = target;
  return {
    host: target.host,
    username: target.username,
    knownHostsPath: target.knownHostsPath ?? '',
    ...(target.port === undefined ? {} : { port: target.port }),
    ...(credential?.kind === 'password'
      ? { password: credential.password }
      : {}),
    ...(credential?.kind === 'privateKey'
      ? {
          privateKey: credential.privateKey,
          ...(credential.passphrase === undefined
            ? {}
            : { passphrase: credential.passphrase }),
        }
      : {}),
    ...(target.confirmHostKey === undefined
      ? {}
      : { confirmHostKey: target.confirmHostKey }),
  };
}

/** The SFTP back-end as the registry knows it: a credential always, host keys always checked. */
export const sftpBackend: BackendDefinition = {
  create: (target) => new SftpFileSystem(sftpOptionsFor(target)),
  credential: 'required',
  usesKnownHosts: true,
  checkEndpoint: (endpoint: Endpoint) => {
    validateEndpoint({
      host: endpoint.host,
      username: endpoint.username,
      ...(endpoint.port === undefined ? {} : { port: endpoint.port }),
    });
  },
};

/**
 * The private-key check of the registry: the key parse of `connect()`, run before any back-end gets
 * the credential, so an unusable key file fails with its reason and without a connection.
 */
export const checkSftpPrivateKey: PrivateKeyCheck = (credential, endpoint) => {
  const { username, host } = endpoint;
  const port = endpoint.port ?? DEFAULT_PORT;
  parsePrivateKeyOrFail(
    credential.privateKey,
    credential.passphrase,
    (why, reason) => authFailed(username, host, port, why, reason),
  );
};
