import { createHash } from 'node:crypto';

/** OpenSSH's fingerprint form, so a person can compare it with what `ssh-keygen -lf` prints. */
export function fingerprint(keyBlob: Buffer): string {
  const digest = createHash('sha256').update(keyBlob).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/** The key type is the first SSH string of the public key blob; `undefined` when malformed. */
export function keyType(keyBlob: Buffer): string | undefined {
  if (keyBlob.length < 4) return undefined;
  const length = keyBlob.readUInt32BE(0);
  if (length === 0 || 4 + length > keyBlob.length) return undefined;
  return keyBlob.toString('latin1', 4, 4 + length);
}
