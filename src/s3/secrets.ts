import { escapeUnsafeText } from '../text/escape.js';

const MASK = '***';

/**
 * The secrets one instance knows: the secret access key and the session token from the options,
 * the environment and every key set the credential chain returns. `redact` is called by the one
 * output point (`errors.ts`) on whole messages, never at a call site.
 */
export class SecretSet {
  readonly #values = new Set<string>();

  add(value: unknown): void {
    if (typeof value !== 'string' || value === '') return;
    this.#values.add(value);
    // A secret can reach a message escaped (server text is escaped before it is joined), so its
    // escaped form is a secret too.
    const escaped = escapeUnsafeText(value);
    if (escaped !== value) this.#values.add(escaped);
  }

  /** Replaces every known secret in `line`, the longest first so no part of one is left. */
  redact(line: string): string {
    if (this.#values.size === 0) return line;
    const ordered = [...this.#values].sort((a, b) => b.length - a.length);
    let out = line;
    for (const secret of ordered) {
      if (out.includes(secret)) out = out.split(secret).join(MASK);
    }
    return out;
  }
}
