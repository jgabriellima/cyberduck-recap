/**
 * Protocol-neutral contract assertions (decision 6C). They import only `src/fs/`, so FEATURE-3 can
 * move them into a shared `describeRemoteFileSystem` suite for every back-end.
 */
import { createHash } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { expect } from 'vitest';
import {
  RemoteFsError,
  type RemoteEntry,
  type RemoteFsErrorCode,
} from '../../src/fs/index.js';

export interface ErrorFields {
  readonly path?: string;
  readonly targetPath?: string;
}

export function expectRemoteFsError(
  error: unknown,
  code: RemoteFsErrorCode,
  fields: ErrorFields = {},
): RemoteFsError {
  expect(error).toBeInstanceOf(RemoteFsError);
  const typed = error as RemoteFsError;
  expect(typed.code).toBe(code);
  if (fields.path !== undefined) expect(typed.path).toBe(fields.path);
  if (fields.targetPath !== undefined) {
    expect(typed.targetPath).toBe(fields.targetPath);
  }
  return typed;
}

/** Awaits a promise that must reject with a `RemoteFsError` of `code`. */
export async function expectRejects(
  promise: Promise<unknown>,
  code: RemoteFsErrorCode,
  fields: ErrorFields = {},
): Promise<RemoteFsError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected a ${code} rejection`).toBeDefined();
  return expectRemoteFsError(caught, code, fields);
}

export interface StreamOutcome {
  readonly error: unknown;
  readonly finished: boolean;
}

/**
 * Settles when the stream errors or completes, telling which: `finished` covers both a Writable's
 * `finish` and a Readable's `end`, so a stream that errors after finishing is caught too.
 */
export function streamOutcome(
  stream: Readable | Writable,
): Promise<StreamOutcome> {
  return new Promise((resolve) => {
    let finished = false;
    stream.on('finish', () => {
      finished = true;
    });
    stream.on('end', () => {
      finished = true;
    });
    stream.on('error', (error) => resolve({ error, finished }));
    stream.on('close', () => resolve({ error: undefined, finished }));
  });
}

/** A stream that must fail with `code` and never finish. */
export async function expectStreamError(
  stream: Readable | Writable,
  code: RemoteFsErrorCode,
  fields: ErrorFields = {},
): Promise<RemoteFsError> {
  if ('resume' in stream) stream.resume();
  const outcome = await streamOutcome(stream);
  expect(outcome.finished).toBe(false);
  return expectRemoteFsError(outcome.error, code, fields);
}

export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function writeAll(stream: Writable, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('finish', () => resolve());
    stream.end(data);
  });
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function expectEntry(
  entry: RemoteEntry | undefined,
  expected: Partial<RemoteEntry>,
): RemoteEntry {
  expect(entry).toBeDefined();
  const actual = entry as RemoteEntry;
  expect(actual).toMatchObject(expected);
  expect(actual.modifiedAt).toBeInstanceOf(Date);
  return actual;
}
