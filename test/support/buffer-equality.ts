/**
 * Compares two Buffers by their bytes, at once. Vitest's default deep equality walks a Buffer one
 * element at a time and runs out of heap on the 16 MiB objects of the S3 tests; this tester gives
 * the same verdict (equal bytes, equal length) without that walk.
 */
import { expect } from 'vitest';

expect.addEqualityTesters([
  (a: unknown, b: unknown): boolean | undefined =>
    Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : undefined,
]);
