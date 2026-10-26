import type { RemoteEntry, RemoteEntryType } from '../fs/types.js';
import type { SftpAttributes } from './session.js';

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

export function entryType(mode: number | undefined): RemoteEntryType {
  if (mode === undefined) return 'other';
  switch (mode & S_IFMT) {
    case S_IFREG:
      return 'file';
    case S_IFDIR:
      return 'directory';
    case S_IFLNK:
      return 'symlink';
    default:
      return 'other';
  }
}

export function isDirectory(mode: number | undefined): boolean {
  return entryType(mode) === 'directory';
}

/** The last segment of a POSIX path; the path itself when it has none (e.g. `/`). */
export function baseName(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}

export function joinPath(directory: string, name: string): string {
  if (directory === '') return name;
  return directory.endsWith('/')
    ? `${directory}${name}`
    : `${directory}/${name}`;
}

/** Out-of-range values are kept as they come (S-14): an invalid time becomes an invalid Date. */
export function toEntry(
  name: string,
  path: string,
  attrs: SftpAttributes,
): RemoteEntry {
  return {
    name,
    path,
    type: entryType(attrs.mode),
    size: attrs.size ?? 0,
    modifiedAt: new Date(
      typeof attrs.mtime === 'number' ? attrs.mtime * 1000 : Number.NaN,
    ),
    permissions: attrs.mode === undefined ? undefined : attrs.mode & 0o7777,
  };
}
