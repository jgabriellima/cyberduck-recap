export const APP_NAME = 'cyberduck-recap';

export {
  REMOTE_FS_ERROR_CODES,
  REMOTE_FS_ERROR_REASONS,
  RemoteFsError,
  createRegistry,
  isRemoteFsError,
  type BackendDefinition,
  type BackendFactory,
  type BackendRegistry,
  type BackendTarget,
  type Credential,
  type CredentialPolicy,
  type Endpoint,
  type MkdirOptions,
  type PrivateKeyCheck,
  type PrivateKeyCredential,
  type RemoteEntry,
  type RemoteEntryType,
  type RemoteFileSystem,
  type RemoteFsErrorCode,
  type RemoteFsErrorDetails,
  type RemoteFsErrorReason,
  type ResolvedBackend,
  type WriteStreamOptions,
} from './fs/index.js';
export { S3FileSystem } from './s3/s3-file-system.js';
export type { S3FileSystemOptions } from './s3/options.js';
export { SftpFileSystem } from './sftp/sftp-file-system.js';
export type { HostKeyInfo, SftpFileSystemOptions } from './sftp/options.js';
