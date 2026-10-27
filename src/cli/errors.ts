import type { CliErrorCode } from './exit-codes.js';

/** A failure the CLI itself reports, with its own code and the hint lines that follow it. */
export class CliError extends Error {
  override readonly name = 'CliError';
  readonly code: Exclude<CliErrorCode, 'INTERNAL'>;
  readonly hints: readonly string[];

  constructor(
    code: Exclude<CliErrorCode, 'INTERNAL'>,
    text: string,
    hints: readonly string[] = [],
  ) {
    super(text);
    this.code = code;
    this.hints = hints;
  }
}

export const PROGRAM = 'cyberduck-recap';

export const USAGE_HINT = `run '${PROGRAM} --help' for usage`;

export function usageError(text: string): CliError {
  return new CliError('USAGE', text, [USAGE_HINT]);
}

export function localFileError(text: string): CliError {
  return new CliError('LOCAL_FILE', text);
}

/**
 * The one wording of the refusal of AC-8 (`get`) and AC-12 (`put`): a destination exists and only
 * `--overwrite` replaces it.
 */
export function existsText(shownPath: string): string {
  return `${shownPath} exists; give --overwrite to replace it`;
}
