/** The rule every back-end's options use for a required text value: a string with a character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}
