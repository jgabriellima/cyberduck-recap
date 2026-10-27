import { PROGRAM } from './errors.js';
import { EXIT_CODE_TABLE } from './exit-codes.js';

/** The text of `--help`: the command forms, the options, the schemes and the exit codes. */
export function helpText(schemes: readonly string[]): string {
  const exits = EXIT_CODE_TABLE.map(
    ([exit, code, meaning]) =>
      `  ${String(exit).padStart(3)}  ${code.padEnd(19)}${meaning}`,
  );
  return [
    'Usage:',
    `  ${PROGRAM} ls  [options] <url>`,
    `  ${PROGRAM} get [options] <url> [<local-path>]`,
    `  ${PROGRAM} put [options] <local-path> <url>`,
    `  ${PROGRAM} --help | -h | --version`,
    '',
    'Options:',
    '  --identity <file>     the private key file; its passphrase comes from',
    '                        CYBERDUCK_RECAP_PASSPHRASE',
    '  --known-hosts <file>  the known_hosts file (default:',
    '                        $XDG_CONFIG_HOME/cyberduck-recap/known_hosts or',
    '                        ~/.config/cyberduck-recap/known_hosts)',
    '  --overwrite           replace an existing destination file (get, put only)',
    '',
    'The password comes from CYBERDUCK_RECAP_PASSWORD, or from a prompt on a terminal.',
    '',
    `URL schemes: ${schemes.join(', ')}`,
    '',
    'Exit codes:',
    ...exits,
    '',
  ].join('\n');
}
