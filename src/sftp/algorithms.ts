// ssh2's defaults minus `ssh-rsa` (SHA-1 signatures), which the OpenSSH client dropped in 8.8 (S-7).
// RSA host keys still work through the SHA-2 signature algorithms.
const HOST_KEY_ALGORITHMS: readonly string[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
];

function algorithmsForKeyType(keyType: string): string[] {
  if (keyType === 'ssh-rsa') return ['rsa-sha2-512', 'rsa-sha2-256'];
  return HOST_KEY_ALGORITHMS.includes(keyType) ? [keyType] : [];
}

/**
 * Puts the algorithms of the key types already recorded for the host first, as OpenSSH does, so a
 * server that adds a new key type keeps presenting the one we know instead of looking changed
 * (S-5b).
 */
export function serverHostKeyAlgorithms(
  knownKeyTypes: readonly string[],
): string[] {
  const preferred = knownKeyTypes.flatMap(algorithmsForKeyType);
  return [...new Set([...preferred, ...HOST_KEY_ALGORITHMS])];
}
