export const APP_NAME = 'cyberduck-recap';

export {
  REMOTE_FS_ERROR_CODES,
  RemoteFsError,
  isRemoteFsError,
  type MkdirOptions,
  type RemoteEntry,
  type RemoteEntryType,
  type RemoteFileSystem,
  type RemoteFsErrorCode,
  type RemoteFsErrorDetails,
} from './fs/index.js';
export { SftpFileSystem } from './sftp/sftp-file-system.js';
export type { HostKeyInfo, SftpFileSystemOptions } from './sftp/options.js';
