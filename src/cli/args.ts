import { parseArgs } from 'node:util';
import { usageError } from './errors.js';
import { shownUrl } from './redact.js';

export type Command = 'ls' | 'get' | 'put';

export type Parsed =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | {
      readonly kind: 'command';
      readonly command: Command;
      readonly operands: readonly string[];
      readonly identity: string | undefined;
      readonly knownHosts: string | undefined;
      readonly overwrite: boolean;
    };

const OPTIONS = {
  identity: { type: 'string' },
  'known-hosts': { type: 'string' },
  overwrite: { type: 'boolean' },
} as const;

const OPERAND_COUNTS: Readonly<
  Record<
    Command,
    { readonly allowed: readonly number[]; readonly text: string }
  >
> = {
  ls: { allowed: [1], text: 'ls takes 1 argument' },
  get: { allowed: [1, 2], text: 'get takes 1 or 2 arguments' },
  put: { allowed: [2], text: 'put takes 2 arguments' },
};

function isCommand(value: string): value is Command {
  return Object.hasOwn(OPERAND_COUNTS, value);
}

/**
 * Reads the command line. `--help`, `-h` and `--version` are found by a scan of the raw arguments
 * first, so they win over every other argument and over every error in them. An option is named
 * in an error by the text before its first `=` only: the value may be a secret. An unknown
 * command or option is shown through `shownUrl`: it may be a URL typed in the wrong place.
 */
export function parseCommandLine(args: readonly string[]): Parsed {
  if (args.includes('--help') || args.includes('-h')) return { kind: 'help' };
  if (args.includes('--version')) return { kind: 'version' };

  // Not strict: unknown options come back as tokens, so the CLI words every error itself and
  // never quotes a value that parseArgs would put in its own message.
  const { tokens } = parseArgs({
    args: [...args],
    options: OPTIONS,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });

  const positionals = tokens.flatMap((token) =>
    token.kind === 'positional' ? [token.value] : [],
  );
  const [command, ...operands] = positionals;
  if (command === undefined) throw usageError('no command given');
  if (!isCommand(command)) {
    throw usageError(`unknown command '${shownUrl(command)}'`);
  }

  let identity: string | undefined;
  let knownHosts: string | undefined;
  let overwrite = false;
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    const rawName = token.rawName.split('=')[0] ?? token.rawName;
    if (token.name === 'overwrite' && token.rawName === '--overwrite') {
      if (token.inlineValue === true) {
        throw usageError(`option '--overwrite' takes no value`);
      }
      if (command === 'ls') {
        throw usageError(`option '--overwrite' is not allowed with ls`);
      }
      overwrite = true;
    } else if (
      (token.name === 'identity' || token.name === 'known-hosts') &&
      token.rawName === `--${token.name}`
    ) {
      if (token.value === undefined) {
        throw usageError(`option '${rawName}' needs a value`);
      }
      if (token.name === 'identity') identity = token.value;
      else knownHosts = token.value;
    } else {
      throw usageError(`unknown option '${shownUrl(rawName)}'`);
    }
  }

  const counts = OPERAND_COUNTS[command];
  if (!counts.allowed.includes(operands.length)) {
    throw usageError(`${counts.text}, got ${operands.length}`);
  }
  return {
    kind: 'command',
    command,
    operands,
    identity,
    knownHosts,
    overwrite,
  };
}
