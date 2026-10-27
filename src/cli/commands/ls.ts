import type { RemoteEntry, RemoteFileSystem } from '../../fs/types.js';
import { writeFields, type Output } from '../output.js';

const TYPE_MARKS: Readonly<Record<RemoteEntry['type'], string>> = {
  file: '-',
  directory: 'd',
  symlink: 'l',
  other: '?',
};

// A back-end reports what its server sent; a size or time out of range is shown as `?`, never
// turned into a defect of the CLI (toISOString throws on an invalid date).
function sizeField(size: number): string {
  return Number.isSafeInteger(size) && size >= 0 ? String(size) : '?';
}

function timeField(modifiedAt: Date): string {
  return modifiedAt instanceof Date && !Number.isNaN(modifiedAt.getTime())
    ? modifiedAt.toISOString()
    : '?';
}

function typeField(type: RemoteEntry['type']): string {
  return Object.hasOwn(TYPE_MARKS, type) ? TYPE_MARKS[type] : '?';
}

/** One line per entry, `<type>\t<size>\t<modifiedAt>\t<name>`, sorted by name (code units). */
export async function runLs(
  remote: RemoteFileSystem,
  path: string,
  stdout: Output,
): Promise<void> {
  const entries = await remote.list(path);
  const sorted = [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of sorted) {
    writeFields(stdout, [
      typeField(entry.type),
      sizeField(entry.size),
      timeField(entry.modifiedAt),
      entry.name,
    ]);
  }
}
