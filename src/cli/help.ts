import { PASSPHRASE_VARIABLE, PASSWORD_VARIABLE } from './credentials.js';
import { PROGRAM } from './errors.js';
import { EXIT_CODE_TABLE } from './exit-codes.js';
import { defaultKnownHostsText } from './known-hosts-path.js';

/** The text of `--help`: the command forms, the options, the schemes and the exit codes. */
export function helpText(schemes: readonly string[]): string {
  const exits = EXIT_CODE_TABLE.map(
    ([exit, code, meaning]) =>
      `  ${String(exit).padStart(3)}  ${code.padEnd(19)}${meaning}`,
  );
  const [xdgKnownHosts, homeKnownHosts] = defaultKnownHostsText();
  return [
    'Usage:',
    `  ${PROGRAM} ls  [options] <url>`,
    `  ${PROGRAM} get [options] <url> [<local-path>]`,
    `  ${PROGRAM} put [options] <local-path> <url>`,
    `  ${PROGRAM} --help | -h | --version`,
    '',
    'Options:',
    '  --identity <file>     the private key file; its passphrase comes from',
    `                        ${PASSPHRASE_VARIABLE}`,
    '  --known-hosts <file>  the known_hosts file (default:',
    `                        ${xdgKnownHosts} or`,
    `                        ${homeKnownHosts})`,
    '  --overwrite           replace an existing destination file (get, put only)',
    '',
    `The password comes from ${PASSWORD_VARIABLE}, or from a prompt on a terminal.`,
    '',
    `URL schemes: ${schemes.join(', ')}`,
    '',
    'Exit codes:',
    ...exits,
    '',
  ].join('\n');
}
