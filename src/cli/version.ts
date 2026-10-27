import { createRequire } from 'node:module';

/**
 * The `version` of package.json. The relative path holds from src/cli/ (tests) and from dist/cli/
 * (the built program), so both print the same text.
 */
export function packageVersion(): string {
  const manifest = createRequire(import.meta.url)('../../package.json') as {
    readonly version?: unknown;
  };
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
}
