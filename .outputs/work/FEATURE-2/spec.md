---
id: FEATURE-2
kind: feature
source: local:FEATURE-2
status: draft
title: "Command-line interface to list, download and upload over a connection"
complexity: complex
---
# Command-line interface to list, download and upload over a connection

## Problem

A person cannot use the filesystem core of FEATURE-1 (`src/fs/` and the SFTP back-end in
`src/sftp/`). The core is a TypeScript library with no user interface. A command-line interface
(CLI) is the smallest surface that a person can use and that a test can drive end to end.

Who is missing it:

- **The person who moves files.** They need to list a remote directory, download a file and upload
  a file with one command each, against a URL such as `sftp://user@host/path`.
- **The person who scripts transfers and the person who supports them.** They need a clear message
  and a distinct non-zero exit code for each typed error of the core (`RemoteFsError.code`), so that
  a script can branch on the failure and a person can see what to fix.
- **The developers of the later back-ends** (S3 in FEATURE-3, WebDAV in FEATURE-4). A new back-end
  must become usable through the CLI without a change to the CLI's code.

Original item text:

> The filesystem core cannot be used by a person without an interface. A CLI is the smallest
> surface that can be tested end to end (proposal approved by the owner with the GOAL-1 split).
>
> Scope: commands `ls`, `get`, `put` against a URL such as `sftp://user@host/path`. Clear messages
> and non-zero exit codes for the core's typed errors. Back-ends added later become usable through
> the CLI without changing it.
>
> Depends on FEATURE-1 (filesystem abstraction and SFTP back-end).

## Decisions proposed in this spec (for the owner to approve)

1. **Program name and entry.** The command is `cyberduck-recap`. `package.json` gets a `bin` entry
   `cyberduck-recap` that points to the built entry file. The CLI uses `node:util` `parseArgs`. It
   adds no production dependency.
2. **Module layout and the back-end registry.** The CLI's code lives in `src/cli/`. It programs
   against `RemoteFileSystem` and `RemoteFsError` only. A registry maps a URL scheme (`sftp`) to a
   back-end factory. One composition module outside `src/cli/` registers the back-ends and starts
   the CLI. A later back-end adds one registration there and no change in `src/cli/`. The `design`
   node chooses the registry's shape and where the SFTP factory lives.
3. **Credentials never on the command line.** The CLI takes no password option and refuses a
   password in the URL. The sources, in this order: a private key file (`--identity <file>`, its
   passphrase from the environment variable `CYBERDUCK_RECAP_PASSPHRASE`, never from a prompt); the
   environment variable `CYBERDUCK_RECAP_PASSWORD`; a prompt without echo when standard input is a
   terminal (TTY). The password prompt comes before the connection, so before any host-key
   question. SSH-agent support and the OS keychain are out of scope (keychain: FEATURE-5).
4. **Own known_hosts file.** The default is `$XDG_CONFIG_HOME/cyberduck-recap/known_hosts` when
   `XDG_CONFIG_HOME` is set to an absolute path, else `<home>/.config/cyberduck-recap/known_hosts`.
   The CLI never writes OpenSSH's `~/.ssh/known_hosts` by default. `--known-hosts <file>` replaces
   the default.
5. **No silent overwrite.** `get` and `put` refuse to replace an existing destination file unless the
   person gives `--overwrite`.
6. **Exit codes.** The table in "Exit codes" below. Each `RemoteFsError` code has its own exit code,
   so that a script can tell the failures apart.

## Names the criteria refer to

- `runCli(args, context)`: the CLI's in-process entry in `src/cli/`. `args` is the argument list
  without `node` and the script path. It resolves to the exit code and never throws. `context`
  supplies `stdout`, `stderr`, `stdin` (with `isTTY` and, on a TTY, `setRawMode`), `env`, `cwd`,
  the home directory and the back-end registry. The tests drive the CLI through `runCli`, with the
  in-process SFTP server of `test/support/sftp-server.ts` or with a test-only in-memory back-end
  registered under the scheme `mem`. The `design` node may refine the signature; the criteria hold
  for the result.
- **Fake TTY**: a test `stdin` stream with `isTTY` true and a `setRawMode` spy. The test writes
  bytes to it. The raw-mode rules of AC-36 apply to these bytes as they would to a real terminal.
- **Error line**: the first line on `stderr` that begins with `cyberduck-recap: ` followed by an
  upper-case code and `: `. Its form is `cyberduck-recap: <CODE>: <message>`. `<CODE>` is the
  `RemoteFsError.code`, or `USAGE`, `LOCAL_FILE`, `CANCELLED` or `INTERNAL` (see "Exit codes").
  When the error has a `path` and `<message>` does not contain it, the CLI appends ` (<path>)`.
  Prompt text (AC-20, AC-24) can come before the error line on `stderr`. No prompt line begins with
  `cyberduck-recap: `.
- **Hint line**: a line on `stderr` after the error line, of the form `cyberduck-recap: <text>`
  with no code. Where a criterion gives the text of a hint line, the line is exactly that text.
- **Line end** (both prompts): a CR byte (0x0d), an LF byte (0x0a), or CR followed by LF. An LF
  byte that comes directly after a CR is discarded. Bytes after the line end stay unread for the
  next prompt.
- **Escaped**: every code point of the set of `cyberduck/standard.sanitised-server-text` is
  replaced by its escape. The set is U+0000-U+001F, U+007F-U+009F, U+2028, U+2029,
  U+202A-U+202E and U+2066-U+2069. A code point up to U+00FF becomes 4 ASCII characters: a
  backslash, `x` and 2 lowercase hex digits (U+001B gives `\x1b`). A higher code point becomes 6
  ASCII characters: a backslash, `u` and 4 lowercase hex digits (U+202E gives the characters
  backslash, `u`, `2`, `0`, `2`, `e`). No other code point changes. In this spec, a code point of
  the set is always written by its name `U+XXXX`, never as a raw character or an escape.
- **Remote path of a URL**: the percent-decoded URL path. An empty path (`sftp://u@h`) is `.`, the
  login directory. A path that starts with `/` is passed to the back-end as it is
  (`sftp://u@h/a%20b` -> `/a b`).
- **Basename**: the last `/`-separated segment of a path. The basename of `/a/` is empty, and
  the basename of `.` is `.`.
- **Default known_hosts path**: `$XDG_CONFIG_HOME/cyberduck-recap/known_hosts` when
  `XDG_CONFIG_HOME` is an absolute path, else `<home>/.config/cyberduck-recap/known_hosts`.
- **Known_hosts line**: `<host field> <key type> <base64 of the key blob>` and one LF. The host
  field is the lower-case host for port 22, else `[<host>]:<port>` (OpenSSH's form).
- **Temporary file of `get`**: the file that `get` writes before it renames it to the destination.
  It is in the destination's directory and its name matches `^\.<basename>\.[0-9a-f]{16}\.part$`,
  where `<basename>` is the destination's basename.

## Commands

```
cyberduck-recap ls  [options] <url>
cyberduck-recap get [options] <url> [<local-path>]
cyberduck-recap put [options] <local-path> <url>
cyberduck-recap --help | -h | --version

Options: --identity <file>  --known-hosts <file>  --overwrite (get, put only)
```

`ls` output: one line per entry, sorted by name in ascending UTF-16 code-unit order (JavaScript's
default sort). Each line is 4 fields separated by one TAB:
`<type>\t<size>\t<modifiedAt>\t<name>`. `<type>` is `-` (file), `d` (directory), `l` (symbolic
link) or `?` (other). `<size>` is the size in bytes in decimal. `<modifiedAt>` is
`Date.prototype.toISOString()` of `modifiedAt`. `<name>` is the entry's name, escaped. Because a
TAB (U+0009) in a name is escaped as `\x09`, each line has exactly 3 TAB characters.

## Exit codes

| Exit | `<CODE>` in the error line | When |
|---|---|---|
| 0 | none | The command succeeded. |
| 1 | `INTERNAL` | An error that is not a `RemoteFsError` and not a local file error (a defect). |
| 2 | `USAGE` | The command line or the URL is wrong (AC-17), no credential is available (AC-20), or the typed password is empty (AC-36). |
| 3 | `LOCAL_FILE` | A local file or directory cannot be read, written or created, or the local destination exists without `--overwrite`. |
| 10 | `AUTH_FAILED` | From the back-end. |
| 11 | `HOST_KEY_UNKNOWN` | From the back-end, or the person did not confirm the key. |
| 12 | `HOST_KEY_CHANGED` | From the back-end. |
| 13 | `CONNECTION_FAILED` | From the back-end, also when an existing known_hosts file cannot be read or the file cannot be written (AC-40). |
| 14 | `CONNECTION_LOST` | From the back-end. |
| 15 | `NOT_CONNECTED` | From the back-end. |
| 16 | `NOT_FOUND` | From the back-end. |
| 17 | `PERMISSION_DENIED` | From the back-end. |
| 18 | `ALREADY_EXISTS` | From the back-end, or the remote destination of `put` exists without `--overwrite`. |
| 19 | `NOT_A_DIRECTORY` | From the back-end (`ls` of a file). |
| 20 | `IS_A_DIRECTORY` | From the back-end (`get` of a directory). |
| 21 | `INVALID_ARGUMENT` | From the back-end, for example an `sftp` URL without a user name. |
| 22 | `OPERATION_FAILED` | From the back-end. |
| 130 | `CANCELLED` | The person pressed Ctrl-C, or the input ended, at the password prompt (AC-36). |

## USAGE error lines

Each case of AC-17 and AC-19 gives exactly this error line. `<x>` stands for the escaped text the
person gave, except in the "no basename" row (see that row). A hint line `cyberduck-recap: run 'cyberduck-recap --help' for usage` follows every
`USAGE` error line.

| Case | Error line |
|---|---|
| no argument | `cyberduck-recap: USAGE: no command given` |
| unknown command `cp` | `cyberduck-recap: USAGE: unknown command 'cp'` |
| `ls` with 0 or 2 arguments | `cyberduck-recap: USAGE: ls takes 1 argument, got <n>` |
| `get` with 0 or 3 arguments | `cyberduck-recap: USAGE: get takes 1 or 2 arguments, got <n>` |
| `put` with 1 or 3 arguments | `cyberduck-recap: USAGE: put takes 2 arguments, got <n>` |
| unknown option `--force` | `cyberduck-recap: USAGE: unknown option '--force'` |
| unknown option with a value, `--password=<sentinel>` | `cyberduck-recap: USAGE: unknown option '--password'` (the text before the first `=` only) |
| `--overwrite` with `ls` | `cyberduck-recap: USAGE: option '--overwrite' is not allowed with ls` |
| `--identity` as the last argument | `cyberduck-recap: USAGE: option '--identity' needs a value` |
| a URL that `new URL()` rejects (`not a url`, `mem://u@h:65536/`) | `cyberduck-recap: USAGE: invalid URL '<x>'` |
| scheme with no back-end (`ftp://u@h/`) | `cyberduck-recap: USAGE: no back-end for the scheme 'ftp' (registered: <schemes>)`, `<schemes>` sorted and joined by `, ` |
| port 0 (`mem://u@h:0/`) | `cyberduck-recap: USAGE: the port must be 1-65535, got 0` |
| invalid percent-encoding (`%zz`) | `cyberduck-recap: USAGE: invalid percent-encoding in the URL path` |
| path that decodes to U+0000 (`%00`) | `cyberduck-recap: USAGE: the URL path must not contain U+0000` |
| password in the URL | `cyberduck-recap: USAGE: passwords are not accepted in the URL; use --identity, CYBERDUCK_RECAP_PASSWORD or the prompt` |
| no basename for `get` (AC-7) | `cyberduck-recap: USAGE: the remote path '<x>' has no file name; give a local file path`. Here `<x>` is the remote path that AC-3 maps the URL to, escaped: the path after `new URL()` removes dot segments and after percent-decoding, or `.` for an empty path. It is not the URL as typed. |
| no credential (AC-20) | `cyberduck-recap: USAGE: no credential: give --identity <file>, set CYBERDUCK_RECAP_PASSWORD, or run from a terminal` |
| empty password (AC-36) | `cyberduck-recap: USAGE: the password is empty` |

## Acceptance criteria

In the criteria, "the server" is the in-process SFTP server of `test/support/sftp-server.ts`, with a
known_hosts file that trusts it, unless the criterion says otherwise. "No connection" means the
server's `stats.connections` stays 0, or, with the `mem` back-end, `connect()` is never called.
A criterion that checks a file mode is skipped on Windows. A criterion that needs a file the user
cannot read or write is skipped when the tests run as root.

| ID | Criterion | Verifier |
|---|---|---|
| AC-1 | `ls <url>` of a server directory that holds the file `a.txt` (5 bytes), the directory `sub` and the symbolic link `link` writes exactly 3 lines to `stdout`, in the order `a.txt`, `link`, `sub`. The lines are `-\t5\t<iso>\ta.txt`, `l\t<size>\t<iso>\tlink` and `d\t<size>\t<iso>\tsub`, where each `<iso>` equals `toISOString()` of the entry's `modifiedAt`. The exit code is 0 and `stderr` is empty. | `test/cli/ls.test.ts` > "lists a directory one entry per line in name order" |
| AC-2 | `ls <url>` of an empty server directory writes nothing to `stdout` and nothing to `stderr`, and exits 0. | `test/cli/ls.test.ts` > "lists an empty directory as no lines" |
| AC-3 | With the `mem` back-end, `ls` passes these remote paths to `list()`: `mem://u@h` -> `.`; `mem://u@h/` -> `/`; `mem://u@h/a/b` -> `/a/b`; `mem://u@h/a%20b` -> `/a b`; `mem://u@h/%C3%A9` -> `/é`. | `test/cli/url.test.ts` > "maps the URL path to the remote path" (`it.each` over the 5 URLs) |
| AC-4 | The SFTP factory gives `SftpFileSystem` the host and the port of the URL: `sftp://tester@127.0.0.1:<port>/dir` connects to the server on `<port>` and `ls` exits 0; `sftp://tester@[::1]:2222/` gives the host `::1` (no brackets) and the port 2222; `sftp://tester@example.com/` gives the port 22. | `test/cli/url.test.ts` > "passes host and port from the URL to the back-end" (the server case, and the 2 other URLs against the options the SFTP factory builds) |
| AC-5 | `get <url> <local-path>` writes a local file whose bytes equal the remote file's bytes, for remote files of 0 bytes, 1 byte and 5 242 880 bytes (5 MiB). The exit code is 0, `stdout` is empty and `stderr` is empty. | `test/cli/get.test.ts` > "downloads byte-identical content" (`it.each` over 0, 1 and 5 242 880 bytes) |
| AC-6 | `get` chooses the local destination as follows. (a) Without `<local-path>`: `<cwd>/<basename of the remote path>`. (b) When `<local-path>` is an existing local directory: `<local-path>/<basename of the remote path>`. (c) Else: `<local-path>` itself. (d) When the directory of the destination does not exist (`get <url> /no/such/dir/file`), `get` makes no connection, downloads nothing and exits 3 with the error line `cyberduck-recap: LOCAL_FILE: the directory /no/such/dir does not exist`. | `test/cli/get.test.ts` > "chooses the local destination" (`it.each` over cases a, b and c) and "refuses a destination in a missing directory" (asserts the error line and `connect()` not called) |
| AC-7 | `get` without `<local-path>`, or with an existing local directory as `<local-path>`, exits 2 with the "no basename" error line of "USAGE error lines" and makes no connection when the basename of the remote path is empty, `.` or `..` (URLs `mem://u@h/`, `mem://u@h/a/.`, `mem://u@h/a/..`, `mem://u@h/a/` and `mem://u@h`). The error line for each URL is exactly: `mem://u@h/` -> `cyberduck-recap: USAGE: the remote path '/' has no file name; give a local file path`; `mem://u@h/a/.` -> `... '/a/' ...`; `mem://u@h/a/..` -> `... '/' ...`; `mem://u@h/a/` -> `... '/a/' ...`; `mem://u@h` -> `... '.' ...` (`...` stands for the same text as in the first line). | `test/cli/get.test.ts` > "refuses a remote path without a usable basename" (`it.each` over the 5 URLs, asserting each full error line) |
| AC-8 | When the local destination exists (a file, or a symbolic link, also one whose target is missing), `get` without `--overwrite` exits 3 with the error line `cyberduck-recap: LOCAL_FILE: <local path> exists; give --overwrite to replace it`. It makes no connection, and the file or link is unchanged. With `--overwrite`, `get` replaces a file with the remote bytes and exits 0. | `test/cli/get.test.ts` > "refuses to replace a local file without --overwrite" (`it.each` over a file, a link to a file and a link to a missing file) and "replaces a local file with --overwrite" |
| AC-9 | When `get` fails, the local destination is as it was before the command: absent if it was absent, its earlier bytes if it existed (`--overwrite`). No other new file remains in the destination directory. This holds for each of these failures: the remote path does not exist (exit 16); the remote path is a directory (exit 20); the server drops the connection after 65 536 bytes of a 5 242 880-byte file (`dropAfterBytes`, exit 14). | `test/cli/get.test.ts` > "leaves the destination unchanged when the download fails" (`it.each` over the 3 failures, each with and without an existing destination) |
| AC-10 | `put <local-path> <url>` writes a remote file whose bytes equal the local file's bytes, for local files of 0 bytes, 1 byte and 5 242 880 bytes. The exit code is 0, `stdout` is empty and `stderr` is empty. | `test/cli/put.test.ts` > "uploads byte-identical content" (`it.each` over 0, 1 and 5 242 880 bytes) |
| AC-11 | `put` chooses the remote destination as follows. (a) When the remote path ends with `/`: `<remote path><basename of local-path>`. (b) When the remote path is an existing remote directory: `<remote path>/<basename of local-path>`. (c) Else: the remote path itself. | `test/cli/put.test.ts` > "chooses the remote destination" (`it.each` over cases a, b and c) |
| AC-12 | When the remote destination file exists, `put` without `--overwrite` exits 18 with the error line `cyberduck-recap: ALREADY_EXISTS: <remote path> exists; give --overwrite to replace it`. The remote file keeps its bytes. With `--overwrite`, `put` replaces it and exits 0. | `test/cli/put.test.ts` > "refuses to replace a remote file without --overwrite" and "replaces a remote file with --overwrite" |
| AC-13 | `put` makes no connection and exits 3 with exactly one of these error lines: `<local-path>` does not exist -> `cyberduck-recap: LOCAL_FILE: <local-path> does not exist`; it is a directory -> `cyberduck-recap: LOCAL_FILE: <local-path> is a directory`; it cannot be read (mode 0000) -> `cyberduck-recap: LOCAL_FILE: cannot read <local-path>`. | `test/cli/put.test.ts` > "refuses a local file it cannot read" (`it.each` over the 3 cases) |
| AC-14 | When the server drops the connection after 65 536 bytes of a 5 242 880-byte upload, `put` exits 14. `stderr` holds the `CONNECTION_LOST` error line and, after it, the hint line `cyberduck-recap: the remote file <remote path> may be incomplete`. | `test/cli/put.test.ts` > "warns that an interrupted upload may leave a partial remote file" (asserts the exact hint line) |
| AC-15 | For each code in `REMOTE_FS_ERROR_CODES`, when the `mem` back-end rejects `list()` with a `RemoteFsError` of that code, message `m` and path `/p`, `ls` exits with the code's exit code of the "Exit codes" table. The error line is `cyberduck-recap: <code>: m (/p)` and it is the first `stderr` line. The table has a distinct exit code from 10 to 22 for every code in `REMOTE_FS_ERROR_CODES` (13 codes). | `test/cli/exit-codes.test.ts` > "maps every RemoteFsError code to its exit code and error line" (`it.each` over `REMOTE_FS_ERROR_CODES`, so a new code fails the test until it has an exit code) |
| AC-16 | Against the server, end to end: a wrong password exits 10 (`AUTH_FAILED`); `ls` of a missing path exits 16 (`NOT_FOUND`); `ls` of a path the server denies (`deny`) exits 17 (`PERMISSION_DENIED`); `ls` of a file exits 19 (`NOT_A_DIRECTORY`); a port with no listener exits 13 (`CONNECTION_FAILED`). Each error line starts with `cyberduck-recap: <CODE>: `. | `test/cli/exit-codes.test.ts` > "reports the server's failures with their exit codes" (`it.each` over the 5 cases) |
| AC-17 | Each command line of the "USAGE error lines" table, from "no argument" to "path that decodes to U+0000", exits 2, makes no connection, and writes to `stderr` exactly 2 lines: the error line of its row, then the hint line `cyberduck-recap: run 'cyberduck-recap --help' for usage`. | `test/cli/usage.test.ts` > "refuses a wrong command line" (`it.each` over every row, asserting the exact 2 lines) |
| AC-18 | `--help` and `-h` write to `stdout` the 3 command forms, the 3 options, the registered schemes and the "Exit codes" table, write nothing to `stderr`, and exit 0. `--version` writes the `version` of `package.json` and a newline to `stdout`, and exits 0. `--help` or `-h` anywhere on the command line (`ls --help`, `get -h mem://u@h/x`, `--version --help`) gives the same output and exit 0, makes no connection, and wins over every other argument. `--version` with no `--help` or `-h` wins over every other argument. `help` is an unknown command (AC-17). | `test/cli/usage.test.ts` > "prints help", "prints help wherever --help is" (`it.each` over the 3 command lines) and "prints the version" |
| AC-19 | A URL with a password (`sftp://tester:<sentinel>@127.0.0.1:<port>/`) exits 2 with the "password in the URL" error line, and makes no connection. `--password=<sentinel>` exits 2 with the error line `cyberduck-recap: USAGE: unknown option '--password'`. In both cases neither `stdout` nor `stderr` contains `<sentinel>`. A URL with an empty password (`sftp://tester:@127.0.0.1:<port>/`) parses as `sftp://tester@127.0.0.1:<port>/` and counts as a URL without a password: no "password in the URL" error, and the CLI takes the credential as AC-20 states. | `test/cli/credentials.test.ts` > "refuses a password on the command line without echoing it" (asserts the exact error lines) and "treats an empty URL password as no password" (`CYBERDUCK_RECAP_PASSWORD` set, `ls` exits 0) |
| AC-20 | The CLI takes the credential from the first source that applies: (1) `--identity <file>`: the file's content is the private key, and `CYBERDUCK_RECAP_PASSPHRASE`, when set and not empty, is its passphrase; (2) else `CYBERDUCK_RECAP_PASSWORD`, when set and not empty; (3) else, when `stdin.isTTY` is true, the prompt `Password for <user>@<host>: ` on `stderr`, answered as AC-36 states. Each source authenticates against the server (with an encrypted key for source 1) and `ls` exits 0. When no source applies (no `--identity`, no `CYBERDUCK_RECAP_PASSWORD`, `stdin.isTTY` false), the CLI exits 2 with the "no credential" error line, reads nothing from `stdin`, and the server's `stats.authAttempts` stays 0. Only the first source that applies is used: with `--identity` and `CYBERDUCK_RECAP_PASSWORD` both set, against a server that accepts only the key, `ls` exits 0; with `--identity` or `CYBERDUCK_RECAP_PASSWORD` set and `stdin.isTTY` true, no password prompt is written. The CLI checks the user name before it takes a credential: an `sftp` URL with no user name (`sftp://127.0.0.1:<port>/`) exits 21 with exactly the error line `cyberduck-recap: INVALID_ARGUMENT: invalid option "username": must be a non-empty string`, also when `stdin.isTTY` is true. It writes no password prompt, reads nothing from `stdin`, and the server's `stats.authAttempts` stays 0. | `test/cli/credentials.test.ts` > "takes the credential from the first source that applies" (`it.each` over the 3 sources), "uses only the first source", "refuses to run without a credential" and "refuses an sftp URL without a user name before the prompt" (fake TTY) |
| AC-21 | `--identity` with a file that does not exist or cannot be read (mode 0000) exits 3 with the error line `cyberduck-recap: LOCAL_FILE: cannot read the identity file <file>`, and makes no connection. | `test/cli/credentials.test.ts` > "reports an unreadable identity file" (`it.each` over missing and mode 0000) |
| AC-22 | The password prompt of AC-20 (3) calls `stdin.setRawMode(true)` once before it reads and `stdin.setRawMode(false)` once after the answer ends, for every way the answer ends in AC-36 (line end, Ctrl-C, Ctrl-D, end of input, empty answer). After the answer ends, the CLI writes one LF to `stderr`. The typed characters do not appear in `stdout` or `stderr`. | `test/cli/credentials.test.ts` > "prompts for the password without echo" (fake TTY, `it.each` over the 5 ways the answer ends, asserting the `setRawMode` call sequence `[true, false]`) |
| AC-23 | A sentinel secret never appears in `stdout` or `stderr`. The secret is the password (from `CYBERDUCK_RECAP_PASSWORD` and from the prompt), the passphrase (from `CYBERDUCK_RECAP_PASSPHRASE`) and the private key's text (from `--identity`). The outcomes checked for each secret: success (exit 0), `AUTH_FAILED` (wrong secret, exit 10), `CONNECTION_FAILED` (port with no listener, exit 13) and `NOT_FOUND` (exit 16). | `test/cli/no-secret-leak.test.ts` > "never writes a secret to stdout or stderr" (`it.each` over each secret and each outcome) |
| AC-24 | When the server's host key is not in the known_hosts file and `stdin.isTTY` is true, the CLI writes to `stderr` exactly these 3 prompt lines, the last one without a line end: `The host key of <host>:<port> is not known.`, `<key type> key fingerprint: SHA256:<base64>`, `Type yes to trust it and record it in <known_hosts path>: `. It reads the answer with raw mode off, up to the first line end. It removes leading and trailing spaces and TABs from the answer. When the result is exactly `yes`, the CLI appends one known_hosts line for the key, runs the command and exits 0. For every other answer (`no`, `y`, `YES`, `yess`, an empty line, end of input before a line end), the CLI exits 11 with a `HOST_KEY_UNKNOWN` error line followed by the hint line `cyberduck-recap: the host key was not trusted; run the command again and type yes to trust it`, and the known_hosts file keeps its bytes. The answers `yes\n`, `yes\r`, `yes\r\n` and ` yes\t\n` are each accepted. When the existing known_hosts file does not end with LF (U+000A), the CLI first appends one LF, so the new line starts on its own line; the earlier bytes stay unchanged. | `test/cli/host-key.test.ts` > "asks the person to confirm an unknown host key" (fake TTY, `it.each` over the 4 accepted forms and each other answer) and "starts the new known_hosts line on its own line" (a file whose last byte is not LF) |
| AC-25 | When the server's host key is not in the known_hosts file and `stdin.isTTY` is false, the CLI reads nothing from `stdin`, writes no prompt, and exits 11. `stderr` holds the `HOST_KEY_UNKNOWN` error line with the `SHA256:` fingerprint and, after it, the hint line `cyberduck-recap: the host key is not in <known_hosts path>; run from a terminal to confirm it, or add it to that file`. The known_hosts file keeps its bytes. | `test/cli/host-key.test.ts` > "refuses an unknown host key without a terminal" (asserts the exact hint line) |
| AC-26 | When the known_hosts file holds a different key for the server, the CLI exits 12 and never asks, also when `stdin.isTTY` is true. `stderr` holds the `HOST_KEY_CHANGED` error line with the presented and the expected fingerprints and, after it, the hint line `cyberduck-recap: the host key differs from the one in <known_hosts path>; if the server's key changed on purpose, remove its line from that file`. The known_hosts file keeps its bytes. | `test/cli/host-key.test.ts` > "refuses a changed host key and never asks" (`it.each` over `isTTY` true and false) |
| AC-27 | Without `--known-hosts`, the back-end receives the default known_hosts path: `$XDG_CONFIG_HOME/cyberduck-recap/known_hosts` when `XDG_CONFIG_HOME` is an absolute path, else `<home>/.config/cyberduck-recap/known_hosts` (also when `XDG_CONFIG_HOME` is relative or empty). When a directory of the default path does not exist, the CLI creates it, and each directory it creates has mode 0700, before it connects. The CLI does not change the mode of a directory that exists. With `--known-hosts <file>`, the back-end receives `<file>` and the CLI creates no directory. | `test/cli/host-key.test.ts` > "chooses the known_hosts file" (`it.each` over XDG absolute, XDG relative, XDG empty, XDG unset and `--known-hosts`) and "creates missing directories with mode 0700" |
| AC-28 | Every entry name that `ls` writes is escaped and is not truncated. For every code point of the escaped set, a name `a<code point>b` prints as `a<escape>b`. The neighbours U+0020, U+00A0, U+2027, U+202F, U+2065 and U+206A, and the name `é文📁`, print unchanged. A name of 255 characters of which every character is U+001B prints in full (1020 characters). | `test/cli/escape.test.ts` > "escapes entry names in ls output" (`it.each` over every code point of the set and every neighbour, the test building each name with `String.fromCodePoint`) and "does not truncate a long name" |
| AC-29 | Every line the CLI writes to `stderr` is escaped. A `RemoteFsError` from the `mem` back-end whose message holds U+001B, U+0085, U+2028 and U+202E, and whose `path` holds U+0009, gives an error line in which each of them is escaped. A URL path that decodes to U+001B (`%1B`) is escaped in any `stderr` line that shows the path. No `stderr` line holds a raw code point of the set. | `test/cli/escape.test.ts` > "escapes server and URL text in stderr" |
| AC-30 | The escape of AC-28 and AC-29 and `sanitizeServerText` of `src/sftp/sanitize.ts` use one function from one module outside `src/sftp/` and `src/cli/` (`cyberduck/standard.single-source`). Every file under `src/cli/` that escapes text imports that function. Apart from that module, no file under `src/cli/` or `src/sftp/` holds, in its source text, any of these forms of the code points U+2028, U+2029, U+202A-U+202E and U+2066-U+2069: (a) the raw code point; (b) a backslash, the letter `u` and the 4 hex digits of the code point, in any letter case; (c) a backslash, the letter `u`, `{`, the hex digits of the code point with any leading zeros, in any letter case, and `}`. | `test/cli/boundary.test.ts` > "src/cli and src/sftp escape text through one function" (one case per form a, b and c; each case also proves its pattern finds a fixture line of that form) |
| AC-31 | No file under `src/cli/` imports `ssh2` (also a subpath), a module under `src/sftp/`, or any module outside `src/cli/`, `src/fs/`, the escape module of AC-30 and `node:` built-ins. No file under `src/cli/` contains the text `sftp` in any letter case. | `test/cli/boundary.test.ts` > "src/cli imports no protocol library and no back-end" and "src/cli names no back-end" |
| AC-32 | A back-end that only a test defines (`mem`, in `test/support/`) becomes usable through the registry with no file under `src/cli/` changed: `ls`, `get` and `put` with `mem://` URLs give the outcomes of AC-1, AC-5 and AC-10 for the `mem` back-end's content, and `--help` lists `mem` among the schemes. | `test/cli/registry.test.ts` > "a back-end registered outside src/cli works through ls, get and put" |
| AC-33 | After a command that called `connect()`, the CLI calls `disconnect()` exactly once, when the command succeeds and when it fails after `connect()` (a rejected `list()`, a stream error). A `disconnect()` that rejects after a successful command leaves the exit code 0. When `connect()` rejects, the CLI does not call `disconnect()`. | `test/cli/lifecycle.test.ts` > "disconnects once after every command" (`it.each` over success and the 2 failures), "ignores a disconnect failure after success" and "does not disconnect when connect rejects" |
| AC-34 | When the back-end throws something that is not a `RemoteFsError` (a `TypeError` with the message `<sentinel>`, the string `<sentinel>`, `undefined`), `runCli` resolves to 1 and writes to `stderr` exactly 2 lines: `cyberduck-recap: INTERNAL: unexpected error` and the hint line `cyberduck-recap: this is a defect; report it with the command line, without secrets, and the exit code 1`. No `stderr` line matches `/^\s+at /` and no line contains `<sentinel>`. `runCli` never rejects. | `test/cli/lifecycle.test.ts` > "reports an unexpected error without a stack trace" (`it.each` over the 3 values, asserting the exact 2 lines) |
| AC-35 | `package.json` has a `bin` entry `cyberduck-recap`. After `pnpm run build`, running the file it names with `node` and `--help` exits 0 and writes the help of AC-18 to `stdout`. | Command: `pnpm run build && node "$(node -p "require('./package.json').bin['cyberduck-recap']")" --help` exits 0 and its output contains `ls`, `get` and `put` |
| AC-36 | At the password prompt, the CLI reads `stdin` in raw mode, byte by byte, as UTF-8. (a) A line end ends the answer; the CLI then authenticates with the answer. (b) DEL (0x7f) or BS (0x08) removes the last code point of the answer, and does nothing when the answer is empty. (c) Ctrl-U (0x15) removes the whole answer. (d) Ctrl-C (0x03) ends the prompt: exit 130, the error line `cyberduck-recap: CANCELLED: the password prompt was cancelled`, no connection. (e) Ctrl-D (0x04), or end of input before a line end, gives the same outcome as (d). (f) A line end with an empty answer: exit 2 with the "empty password" error line, no connection, `stats.authAttempts` 0. (g) Every other C0 byte (0x00-0x1f) is discarded. Cases: `secret\r` and `secret\n` authenticate with `secret`; `secrex` DEL `t\r` authenticates with `secret`; `é` DEL `ok\r` authenticates with `ok`; `bad` Ctrl-U `secret\r` authenticates with `secret`; `sec` ESC `ret\r` authenticates with `secret`. | `test/cli/password-prompt.test.ts` > "reads the password in raw mode" (fake TTY, `it.each` over each case a-g, asserting the exit code, the error line, the password the server received and `stats.connections`) |
| AC-37 | The CLI asks for the password before it connects: while the password prompt waits, `stats.connections` is 0. With source 3 of AC-20 and a host key that is not known, `stderr` holds the password prompt before the host-key prompt lines. For the input `secret\r\nyes\n`, the LF after the CR is discarded, the password is `secret`, the host-key answer is `yes`, and `ls` exits 0. | `test/cli/password-prompt.test.ts` > "asks for the password before the host key" |
| AC-38 | `--identity` with a file that is readable but gives no usable key makes no connection and writes no prompt, also when `stdin.isTTY` is true. Each case exits 10 with an `AUTH_FAILED` error line, followed by the hint line given: (a) an encrypted OpenSSH or PEM key and `CYBERDUCK_RECAP_PASSPHRASE` unset or empty -> `cyberduck-recap: the private key in <file> is encrypted; set CYBERDUCK_RECAP_PASSPHRASE to its passphrase`; (b) an encrypted key and a wrong `CYBERDUCK_RECAP_PASSPHRASE` -> `cyberduck-recap: the passphrase in CYBERDUCK_RECAP_PASSPHRASE does not decrypt the private key in <file>`; (c) a file that is not a private key (a `.pub` public key, the text `hello`) -> `cyberduck-recap: <file> is not a private key; give the private key file, not the .pub file`. | `test/cli/credentials.test.ts` > "explains an identity file that gives no key" (`it.each` over a with `isTTY` true and false, b, and c with both files) |
| AC-39 | First run: the default known_hosts path is used, and neither its directory nor its file exists. (a) With `stdin.isTTY` true and the answer `yes`, the CLI creates the directory with mode 0700 and the file with mode 0600. The file holds exactly one known_hosts line for the server's key. `ls` exits 0. A second `ls` with the same home writes no host-key prompt and exits 0. (b) With the answer `no`, or with `stdin.isTTY` false, the CLI exits 11 and the known_hosts file does not exist after the command. (c) When `--known-hosts <file>` names a file that does not exist, in an existing directory, the answer `yes` creates `<file>` with mode 0600. | `test/cli/host-key.test.ts` > "records the first host key in a new known_hosts file" (`it.each` over the default path and `--known-hosts <file>`) and "creates no known_hosts file when the key is refused" (`it.each` over `no` and no TTY) |
| AC-40 | When the known_hosts directory or file cannot be written or read: (a) a directory of the default path cannot be created (`<home>/.config` is a regular file) -> exit 3, the error line `cyberduck-recap: LOCAL_FILE: cannot create the directory <directory path>`, no connection; (b) the person answers `yes` and the file cannot be written (`--known-hosts` names a file in a directory of mode 0500) -> exit 13, an error line that starts with `cyberduck-recap: CONNECTION_FAILED: could not record the host key in the known_hosts file <path>`, `stats.authAttempts` 0, and no file at `<path>`; (c) the known_hosts file exists and cannot be read (mode 0000) -> exit 13, an error line that starts with `cyberduck-recap: CONNECTION_FAILED: could not read the known_hosts file <path>`, no host-key prompt, `stats.authAttempts` 0, and the file keeps its bytes and mode. | `test/cli/host-key.test.ts` > "reports a known_hosts location it cannot write" (`it.each` over a and b) and "reports a known_hosts file it cannot read" (c) |
| AC-41 | `get` creates its temporary file in the destination's directory, with exclusive create and mode 0600. On success it renames the temporary file to the destination; a new destination then has mode `0o666 & ~umask`. With `--overwrite` over an existing destination, the destination keeps its earlier mode bits (a destination of mode 0600 stays 0600). While a download waits in the middle (a `mem` back-end stream that pauses after 1 byte), the directory holds exactly one file whose name matches the temporary-file pattern of "Names", with mode 0600. | `test/cli/get.test.ts` > "writes the download to a private temporary file", "gives the downloaded file the default mode" and "keeps the mode of an overwritten file" |
| AC-42 | When the local destination is a symbolic link and `--overwrite` is given, `get` replaces the link itself with a regular file that holds the remote bytes, and exits 0. The file the link pointed to keeps its bytes. | `test/cli/get.test.ts` > "replaces a symbolic link, not its target, with --overwrite" |

### Note for support (AC-15, AC-16)

The exit code alone tells the failure class. The error line's `<CODE>` is the same name that the
library reports in `RemoteFsError.code`, so a log line maps to the library's documentation of that
code. Exit 1 (`INTERNAL`) is always a defect of the program and worth a bug report (AC-34 says so to
the person). Exit 130 means the person cancelled the password prompt. A file that matches
`.*.part` beside a download target is a temporary file of an interrupted `get` (see "Out of
scope"); delete it.

## Behavior

- Given a server directory with `b`, `a` and `C`, when the person runs `ls`, then the lines come in
  the order `C`, `a`, `b` (code-unit order: uppercase letters sort before lowercase letters).
- Given `get sftp://tester@host/docs/r.pdf` in `/home/p`, when the download succeeds, then
  `/home/p/r.pdf` holds the remote bytes, and `stdout` and `stderr` are empty.
- Given `get` of a 5 MiB file and a dropped connection, when the command ends, then the local
  destination is as it was and the exit code is 14.
- Given `put ./r.pdf sftp://tester@host/docs/` and no `/docs/r.pdf` on the server, when the upload
  succeeds, then `/docs/r.pdf` holds the local bytes and the exit code is 0.
- Given a new user with no `~/.config/cyberduck-recap`, when the person runs `ls` from a terminal,
  types the password and then `yes`, then the CLI creates the directory (0700) and the known_hosts
  file (0600), and the next command connects without a question.
- Given a script (no TTY) and no credential source, when it runs `ls`, then it exits 2 at once and
  never waits for input.
- Given a person at the password prompt, when they press Ctrl-C, then the CLI exits 130 and the
  terminal is back in its normal mode.
- Given an encrypted key and no `CYBERDUCK_RECAP_PASSPHRASE`, when the person runs
  `ls --identity key`, then the CLI exits 10 and tells them to set `CYBERDUCK_RECAP_PASSPHRASE`.
- Given a name on the server that holds U+001B followed by `[31mred`, when the person runs `ls`,
  then the terminal shows `\x1b[31mred` as text and no colour changes.

## Must never allow

- A password, a passphrase or a private key's text in `stdout`, in `stderr`, or in an error line,
  for any outcome (AC-19, AC-23, AC-36, AC-38).
- A password taken from the URL or from a command-line option (AC-19).
- A connection to a server whose host key changed (AC-26), and a recorded host key that the person
  did not confirm with `yes` from a terminal (AC-24, AC-25, AC-39).
- A terminal left in raw mode after the password prompt ends, in any way (AC-22, AC-36).
- A raw code point of the escaped set on `stdout` or `stderr` (AC-28, AC-29).
- A local or remote destination file replaced without `--overwrite`, and a `get` that writes
  through a symbolic link into its target (AC-8, AC-12, AC-42).
- A failed `get` that leaves a truncated, partial or changed local destination (AC-9).
- A temporary download file or a known_hosts file that other users can read (AC-39, AC-41).
- A local path chosen from text that the server sends: the local destination of `get` comes only
  from the command line (AC-6, AC-7).
- A stack trace, or the text of an unexpected error, on `stderr`, and a `runCli` that rejects
  (AC-34).
- A command that waits for input when `stdin.isTTY` is false (AC-20, AC-25).
- An exit code 0 after any failure, and one exit code for two different `RemoteFsError` codes
  (AC-15).
- An import of `ssh2` or of `src/sftp/` from `src/cli/` (AC-31).

## Out of scope

- SSH-agent authentication, keyboard-interactive authentication, and credentials in the OS keychain
  (FEATURE-5). The back-end of FEATURE-1 accepts only a password or a private key.
- A prompt for the passphrase of an encrypted key. The passphrase comes only from
  `CYBERDUCK_RECAP_PASSPHRASE` (Decision 3); AC-38 tells the person so.
- A check of the identity file's permissions (OpenSSH refuses a key that others can read). The
  CLI reads the key as given. Reason: the work item asks for no such check; it is a follow-up
  for the credentials work of FEATURE-5.
- Line editing at the password prompt beyond AC-36 (arrow keys, Ctrl-W, history). An arrow key
  sends ESC and printable bytes; AC-36 (g) discards only the ESC.
- Bookmarks (`--bookmark`, FEATURE-5).
- Progress, concurrency, cancel, retry and resume of transfers (FEATURE-6). The CLI transfers one
  file per command and reports nothing on success.
- Recursive transfers of a directory, and wildcards.
- `ls` of a file path as a one-line listing: it exits 19 (`NOT_A_DIRECTORY`), as the back-end
  reports.
- A home-relative path such as `sftp://u@h/~/file`. A path that starts with `/` is absolute; an
  empty path is the login directory.
- A default user name: an `sftp` URL without a user exits 21 (`INVALID_ARGUMENT`) before the
  credential, with the error line of AC-20.
- `get` to `stdout` (`-` as the local path) and `put` from `stdin`.
- Atomic upload, and the mode of the remote file that `put` creates (the server's default
  applies). A failed `put` may leave a partial remote file, as FEATURE-1 states; AC-14 says so to
  the person.
- Clean-up when the process gets a signal (SIGINT, SIGTERM), also Ctrl-C at the host-key prompt,
  where the terminal sends SIGINT. The local destination of `get` stays unchanged, but its
  temporary file (AC-41: in the destination's directory, mode 0600, named
  `.<basename>.<16 hex digits>.part`) can remain. The known_hosts file is unchanged, because the
  CLI records a key only after `yes`. Raw mode is not on at the host-key prompt.
- A diagnostic option that prints the stack of an `INTERNAL` error. Reason: AC-34 forbids the
  text of an unexpected error on `stderr`; a debug option is a follow-up.
- A closed `stdout` (EPIPE, as in `ls | head -1`).
- An option to set the connect timeout. The back-end's default of 20 000 ms applies.
- An option that accepts an unknown host key without a terminal. A script adds the key to the
  known_hosts file first.
- Escaping the backslash itself. A name that holds the 4 ASCII characters `\x1b` prints as it is,
  as in BUG-2.
