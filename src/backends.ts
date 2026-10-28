import type { BackendRegistry } from './fs/backend.js';
import { s3Backend } from './s3/backend.js';
import { checkSftpPrivateKey, sftpBackend } from './sftp/backend.js';

/**
 * The composition module: the one place that knows the production back-ends. A later back-end
 * adds one registration here and no change in src/cli/.
 */
export function registerBackends(registry: BackendRegistry): void {
  registry.setPrivateKeyCheck(checkSftpPrivateKey);
  registry.register('sftp', sftpBackend);
  registry.register('s3', s3Backend);
}
