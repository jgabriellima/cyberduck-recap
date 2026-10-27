# Decision — Command-line interface `cyberduck-recap` over the back-end registry (FEATURE-2)

## Context

FEATURE-2 (spec: `.outputs/work/FEATURE-2/spec.md`, 42 acceptance criteria) adds the CLI
`cyberduck-recap` with the commands `ls`, `get` and `put` against a URL. The spec fixes the
program name, the credential order, the known_hosts location, `--overwrite`, the exit-code table
and the error-line form. It leaves these choices to design:

1. The shape of the back-end registry, and where the SFTP factory lives (spec Decision 2).
2. Where the CLI learns why an identity file gives no key (AC-38). `src/sftp/connection.ts`
   reports "encrypted key, no passphrase" and "not a private key" with the same text: "the
   private key could not be parsed". The CLI must not import `ssh2` or `src/sftp/` (AC-31).
3. Where the escape function moves, so that `src/sftp/` and `src/cli/` use one source (AC-30).
4. How `get` writes the local file, so that a failure leaves the destination unchanged (AC-9,
   AC-41, AC-42).
5. How the CLI reads the terminal for two prompts that share one input (AC-22, AC-24, AC-36,
   AC-37).
6. How `put` refuses a remote file that appears after its check (AC-12, "Must never allow").

Forces on the choice:

- **Standards.** `cyberduck/standard.protocol-boundaries`: code outside a back-end imports no
  protocol library and no back-end module; a test enforces it. `cyberduck/standard.single-source`:
  a behaviour that `src/` needs in two places has one source. `cyberduck/standard.sanitised-server-text`:
  server text in an error or log is escaped. `baseline/standard.no-secrets` and the spec's "Must
  never allow" list: no secret on `stdout` or `stderr`. `cyberduck/standard.clean-room-licences`:
  every production dependency has a permissive licence.
- **Code on main.** `src/fs/` holds `RemoteFileSystem`, `RemoteFsError` and the 13 codes.
  `src/sftp/` holds `SftpFileSystem`. `validateOptions` (`src/sftp/options.ts`) checks host,
  username and port in that order and gives the message `invalid option "username": must be a
  non-empty string` (AC-20 quotes it). `parsePrivateKey` (`src/sftp/connection.ts`) parses the
  key before any I/O. `readKnownHosts` treats a missing file as empty. `appendKnownHost` creates
  a file with mode 0600, adds an LF before the line when the last byte is not LF, and writes only
  after the handshake proves the key. `sanitizeServerText` (`src/sftp/sanitize.ts`) escapes the
  full set of the standard and caps the result at 256 characters.
- **Later work.** S3 (FEATURE-3) and WebDAV (FEATURE-4) must work through the CLI without a change
  in `src/cli/`. The keychain is FEATURE-5. The transfer queue is FEATURE-6. The desktop UI
  (FEATURE-7) also needs a map from a URL to a back-end.
- **Tests written first.** `test/support/cli.ts` and `test/adversarial/support/cli-harness.ts`
  import `createRegistry()` and `runCli` from `src/cli/index.ts`, and `registerBackends(registry)`
  from `src/backends.ts`. They call `register(scheme, factory)`, where a factory is a bare function
  of one argument. The `mem` back-ends read `target.knownHostsPath`. Both harnesses build the
  context with `home`, and with no `umask` and no `version`. They cast the context and the registry
  (`as never`, `as unknown as`), so `tsc` cannot show a mismatch: only the tests' behaviour shows
  it. The implement node does not edit tests. The product API must therefore be the API that these
  harnesses use.
- **Settled decisions** (`.sdlc/decisions/`): TypeScript strict, ESM, Node >= 22, pnpm, Vitest,
  ESLint, Prettier. No new production dependency is needed: `node:util` `parseArgs`,
  `node:fs/promises`, `node:crypto` and `node:stream` cover the work.

The record has one group of options for each choice. Each option is judged on the criteria and on
the four pre-mortem lenses: scale, cost, security and maintainability.

## Option 1A: Back-end contract in `src/fs/`, each definition beside its back-end, one composition module

How it works:

- `src/fs/backend.ts` declares the protocol-neutral contract: a back-end definition (a factory
  and what the back-end needs from the CLI), `BackendTarget`, `Credential`, `HostKeyInfo` and the
  registry.
- `src/sftp/backend.ts` exports `sftpBackend`. It maps a `BackendTarget` to
  `SftpFileSystemOptions` and builds `SftpFileSystem`.
- `src/backends.ts` (the composition module, outside `src/cli/`) registers the back-ends.
  `src/bin.ts` is the program entry; it builds the context and calls `runCli`.
- `src/cli/` imports only `src/fs/`, the escape module and `node:` built-ins.

The first version of 1A named its API `createBackendRegistry(backends)` and `defaultBackends()`,
and required each back-end to declare every field. That API differs from the tests' API (see
Option 1D and Option 1E). The chosen form keeps the 1A contract and exposes it with the tests'
names (Decision 1).

Trade-offs:

- Criteria: meets AC-31 and AC-32. AC-4 can test the options that `sftpBackend` builds with no
  connection.
- Scale: the registry is a `Map`; one lookup per command.
- Cost: 3 small new files outside `src/cli/`. A later back-end adds one file and one line.
- Security: the contract carries the credential in one typed field. The CLI sees no back-end
  option, so it cannot weaken host-key checks (the closed `KNOWN_OPTIONS` set stays the guard).
- Maintainability: the dependency direction is one way: `src/cli/` -> `src/fs/` <- `src/sftp/`,
  and `src/backends.ts` -> both. The UI of FEATURE-7 can reuse the same contract and registry.
  `src/fs/` grows by one module; its boundary test already covers it.

## Option 1B: Contract in `src/cli/`, the SFTP factory in the composition module

How it works: `src/cli/registry.ts` declares the factory type. `src/main.ts` holds the SFTP
factory code and imports `src/sftp/` and `src/cli/`.

Trade-offs:

- Criteria: meets AC-31 and AC-32.
- Scale and cost: as 1A.
- Security: as 1A.
- Maintainability: weaker. The contract belongs to the CLI, so the UI of FEATURE-7 must import
  `src/cli/` or copy the contract (a single-source breach). The composition module grows by one
  factory body per back-end, and each body knows that back-end's options. Each back-end's mapping
  code lives far from the back-end that it maps to.

## Option 1C: Self-registering back-ends (a module-level registry that each back-end fills on import)

How it works: `src/sftp/index.ts` calls `register('sftp', …)` as an import side effect. The entry
imports each back-end for its side effect.

Trade-offs:

- Criteria: meets AC-31. AC-32 is harder: a global registry keeps state between tests, and the
  `mem` back-end leaks into other test files (`.claude/rules/testing-evidence.md`: no shared state).
- Security: any imported module can register or replace a scheme. A dependency could take over
  `sftp://`.
- Maintainability: the import order decides what exists. A bundler can drop a side-effect import
  and remove a back-end with no error.

## Option 1D: The tests' API as the whole contract (bare factories only)

How it works: `src/cli/index.ts` exports `createRegistry()`; `register(scheme, factory)` takes
only a function `(target) => RemoteFileSystem`. `src/backends.ts` exports
`registerBackends(registry)`. The CLI gives every back-end the same treatment: it always takes a
credential and always resolves a known_hosts path.

Trade-offs:

- Criteria: the harnesses run unchanged. But AC-20 and ATK-3 conflict under it. AC-20 needs exit
  2 when no credential source applies (tested over `sftp`). The adversarial tests run `mem` with no
  credential source (no `CYBERDUCK_RECAP_PASSWORD`, `stdin.isTTY` false) and expect a connection
  (ATK-3, `cli-get-partial-failure.test.ts`). One treatment for all back-ends cannot give both.
- Security: as 1A.
- Maintainability: weak. The CLI cannot learn that S3 (FEATURE-3) needs no known_hosts file and no
  SSH credential, so FEATURE-3 must change `src/cli/` (breaks the "Later work" force). The
  registry type lives in `src/cli/`, as in 1B.

## Option 1E: Keep the first 1A API and change the tests to it

How it works: the product exports `createBackendRegistry(backends)` and `defaultBackends()`;
`test/support/cli.ts`, `test/adversarial/support/cli-harness.ts`, `test/support/mem-backend.ts`
and the `memBackend` of the adversarial harness change to that API and to `homeDir`.

Trade-offs:

- Criteria: the same criteria hold after the edit.
- Cost: 3 test files change, and the role that may edit them is not the implement node. The run
  needs a second tests node or an edit by the implementer outside its writes.
- Security: none.
- Maintainability: weak. The `as never` casts hide every mismatch from `tsc`, so a missed
  harness field fails only at run time (AC-18, AC-27, AC-41 fail with no type error). The test
  that a criterion names changes in the same run as the code that it checks.

## Option 2A: The back-end gives a protocol-neutral reason on the `AUTH_FAILED` error

How it works: `RemoteFsError` gets an optional `reason` detail from a closed list in
`src/fs/errors.ts`: `PRIVATE_KEY_ENCRYPTED`, `PRIVATE_KEY_PASSPHRASE_WRONG`,
`PRIVATE_KEY_INVALID`. `parsePrivateKey` sets it. The CLI maps a reason to the hint line of
AC-38. The CLI knows the identity file path and the variable name, so the hint text stays in
`src/cli/`.

Trade-offs:

- Criteria: meets AC-38 (a), (b) and (c). The key is parsed in `connect()` before
  `readKnownHosts` and before the socket opens, so there is no connection and no host-key prompt.
- Scale and cost: no extra parse. One more field on an error.
- Security: the reason is a fixed word; it carries no key material, so no secret can leak through
  it. A wrong classification still exits 10 with `AUTH_FAILED`; only the hint is wrong (fail-safe).
- Maintainability: one source for key parsing (`ssh2` in `src/sftp/`). Callers branch on a typed
  value, never on message text. A later back-end with keys (SCP, FTPS client certificates) uses
  the same reasons. The closed list must grow on purpose, with a test.

## Option 2B: The CLI reads the identity file text and classifies it

How it works: `src/cli/` looks for `-----BEGIN OPENSSH PRIVATE KEY-----`, decodes the
`openssh-key-v1` header to find the cipher name, looks for `Proc-Type: 4,ENCRYPTED` in PEM, and
looks for `ssh-` public key lines.

Trade-offs:

- Criteria: it can meet AC-38 (a) and (c), but not (b): only a real decrypt tells a wrong
  passphrase. The CLI would then still need the back-end's message for (b).
- Security: a second key parser in the CLI handles secret material. It is a new attack surface
  and a place where key text can reach an error message.
- Maintainability: it breaks the spirit of `cyberduck/standard.protocol-boundaries` (SSH key
  formats in the CLI) and `cyberduck/standard.single-source` (two parsers that can drift).
  `ssh2` accepts formats (PuTTY PPK, PKCS#8) that the copy must follow.

## Option 2C: A `checkCredential` method on the back-end contract, called before `connect()`

How it works: `Backend.checkCredential(credential)` parses the key and returns a verdict. The CLI
calls it after it takes the credential.

Trade-offs:

- Criteria: meets AC-38.
- Cost: the key is parsed twice (once in the check and once in `connect()`); with bcrypt-pbkdf
  key derivation, each parse of an encrypted OpenSSH key costs about 0.1 s to 1 s of CPU.
- Maintainability: the contract grows by a method that every back-end must implement, also those
  with no key (S3). The verdict type is the same closed list as 2A, so 2C adds a method and saves
  nothing.

## Option 3A: A leaf module `src/text/escape.ts` that `src/sftp/` and `src/cli/` import

How it works: `escapeUnsafeText(text: string): string` and the regex of the escaped set move to
`src/text/escape.ts`. The module imports nothing. `sanitizeServerText` keeps its coercion of a
non-string and its 256-character cap, and calls `escapeUnsafeText`. The CLI calls
`escapeUnsafeText` with no cap (AC-28: a name of 255 escapes prints in full).

Trade-offs:

- Criteria: meets AC-30 (one function in one module outside `src/sftp/` and `src/cli/`) and the
  allow-list of AC-31 ("the escape module").
- Scale: one regex replace per line; linear in the text length.
- Security: one regex for the whole project. A fix to the set lands in both users at once.
- Maintainability: a new top-level folder needs a boundary rule (it imports nothing). Escaping
  for display is not a filesystem concern, so `src/fs/` stays the remote-filesystem contract only.

## Option 3B: The escape function in `src/fs/escape.ts`

How it works: as 3A, with the module in `src/fs/`.

Trade-offs:

- Criteria: meets AC-30. AC-31 lists "`src/fs/`, the escape module of AC-30" as two items, which
  reads as two modules; 3B makes the second item empty.
- Maintainability: the existing `src/fs/` boundary test covers it at no cost. But `src/fs/`
  then holds a terminal-display helper beside the remote-filesystem contract, and the public
  index tempts a re-export of an internal helper.

## Option 3C: Keep the escape in `src/sftp/sanitize.ts`, and a copy in `src/cli/`

Rejected at once: it breaks AC-30, AC-31 and `cyberduck/standard.single-source`.

## The race window of `get`

The destination check (`lstat`, AC-8) runs before `connect()`, so that a refused `get` makes no
connection. The destination name gets its file only at the final step, after the last byte. The
window between the two is the whole download: the connection, the authentication and the
transfer. For a 1 GiB file at 10 MiB/s it is more than 100 s. In that window any process of the
same user can create a file or a symbolic link at the destination. ATK-3
(`test/adversarial/cli-get-destination-race.test.ts`) plants one while the download waits. It
expects exit 3, the planted file or link unchanged, and no `.part` file left. With `--overwrite`,
it expects the planted link replaced by a regular file and its target unchanged.

The spec lists "a local destination file replaced without `--overwrite`" under "Must never
allow". So the final step must refuse an object that exists at that moment, not only one that
existed at the check. Each option below is judged on that.

## Option 4A: Private temporary file, then `rename(2)` in every case

How it works: before the connection, `get` checks the destination's directory and, without
`--overwrite`, that `lstat(destination)` fails with `ENOENT`. It opens
`.<basename>.<16 hex>.part` in the destination's directory with `wx` and mode 0600, pipes the
remote stream into it, sets the final mode, and renames it over the destination. On any failure
it removes the temporary file.

Trade-offs:

- Criteria: meets AC-9, AC-41 and AC-42. Fails ATK-3 (a) and (b): `rename(2)` replaces a planted
  file or link without `--overwrite`, and exits 0. This breaks "Must never allow".
- Scale: one extra file in the same directory; no copy; memory bounded by stream backpressure.
- Cost: 1 system call at the final step.
- Security: `wx` (`O_CREAT|O_EXCL`) refuses a planted file or link at the temporary name. 64
  random bits make the name hard to guess. The no-clobber rule is broken for the whole download.
- Maintainability: one code path.

## Option 4B: `get` writes the destination directly (truncate, then write)

Trade-offs: a failure leaves a partial file (breaks AC-9). An existing symbolic link is followed,
so the write reaches its target (breaks AC-42). Rejected.

## Option 4C: Temporary file, then `link(2)` without `--overwrite`, `rename(2)` with it

How it works: as 4A up to the final step. Then:

- Without `--overwrite`: `link(temp, destination)`. The kernel creates the name only when no
  object has it, as one step. `EEXIST` (a file, a link, also a dangling link, or a directory)
  means "exists": `get` removes the temporary file and exits 3 with the AC-8 error line. On
  success, `get` removes the temporary name with `unlink(temp)`; the destination keeps the inode,
  so it keeps the final mode set before the link.
- With `--overwrite`: `rename(temp, destination)`. It replaces a file or a symbolic link itself and
  never follows a link (AC-42, ATK-3 (c)).
- When `link` fails with `EPERM`, `ENOTSUP`, `EOPNOTSUPP`, `ENOSYS` or `EXDEV`, the file system has
  no hard links (FAT, exFAT, some SMB and NFS mounts). `EXDEV` cannot occur in one directory; it is
  in the list as a guard. The fallback is Option 4E.

Trade-offs:

- Criteria: meets AC-8, AC-9, AC-41, AC-42 and ATK-3 (a), (b), (c). The check before the
  connection stays, so AC-8 still makes no connection when the destination exists at the start.
- Scale: no data copy on a file system with hard links.
- Cost: 2 system calls (`link`, `unlink`) instead of 1 (`rename`): some microseconds per `get`.
  About 40 more lines in `commands/get.ts` and 4 unit tests (EEXIST on a file, on a dangling link,
  the fallback, `--overwrite` over a swapped link).
- Security: closes the race for the whole download on every file system with hard links. No
  window is left: `link` checks and creates in one kernel step.
- Maintainability: 2 code paths at the final step (no-clobber and `--overwrite`) and one fallback.
  A crash between `link` and `unlink` leaves the destination complete and a `.part` file beside it
  (spec, "Out of scope": clean-up on a signal).

## Option 4D: A second `lstat` just before `rename(2)`

How it works: as 4A; without `--overwrite`, `get` runs `lstat(destination)` again after the last
byte and renames only on `ENOENT`.

Trade-offs:

- Criteria: meets ATK-3 as the test runs it (the plant comes before the release). It does not meet
  "Must never allow" in full: a plant between the second `lstat` and the `rename` is still
  replaced.
- Cost: 1 more system call; no extra code path.
- Security: the window shrinks from the whole download to the time between 2 system calls (some
  microseconds), but it stays open. An actor that loops on `symlink()` can still win it.
- Maintainability: simple, but it records a known gap against the spec.

## Option 4E (fallback of 4C only): exclusive create of the destination, then a copy

How it works: used only when `link` fails with a code of the 4C list, without `--overwrite`.

1. `open(destination, 'wx', finalMode)`. `O_CREAT|O_EXCL` fails with `EEXIST` on any object,
   also a symbolic link (POSIX: it never follows a link). `EEXIST` gives exit 3, as in 4C.
2. `pipeline(createReadStream(temp), handle.createWriteStream())`.
3. On success: `unlink(temp)`. On a copy error: compare `lstat(destination)` with the open
   handle's `fstat` (device and inode); remove the destination only when they are equal, then
   remove the temporary file, and exit 3.

Trade-offs:

- Criteria: no object that exists at the final step is ever replaced; the guarantee of "Must
  never allow" holds in full. AC-9 holds for every error the CLI sees. AC-41 holds: the
  temporary file stays 0600; the destination is created with its final mode.
- Cost: one more read and write of the whole file, only on file systems with no hard links. At a
  USB 2 speed of 30 MB/s, a 1 GiB file takes about 35 s more, and needs twice its size of free
  space until the temporary file is removed.
- Security: the destination is visible while the copy runs, with partial content, under the
  final mode. A signal during the copy can leave that partial destination. *Accepted*: clean-up on
  a signal is "Out of scope" in the spec, and this case occurs only on a file system with no hard
  links. FAT and exFAT also have no symbolic links and no owners, so the link half of ATK-3 cannot
  occur there.
- Maintainability: one more path, reached only through an error code. A unit test reaches it by an
  injected `link` function that fails with `EPERM`.

## Option 4F (fallback of 4C only): refuse with exit 3

How it works: when `link` fails with a code of the 4C list, `get` removes the temporary file and
exits 3 with "cannot create <destination> without replacing it; give --overwrite".

Trade-offs: full no-clobber and atomic content, at no cost. But `get` to a FAT or exFAT disk then
always needs `--overwrite`, and the spec has no such error line. It makes `--overwrite` the
normal flag for those disks, which removes its protection there. Rejected.

## Option 5A: One byte reader on `stdin`, shared by the password prompt and the host-key prompt

How it works: `src/cli/terminal.ts` holds a reader with a byte buffer and a "last byte was CR"
flag. It attaches a `data` listener only while a prompt waits, then pauses `stdin`. Bytes after a
line end stay in the buffer for the next prompt. The password prompt reads in raw mode, byte by
byte, as AC-36 states. The host-key prompt reads one line with raw mode off.

Trade-offs:

- Criteria: meets AC-37 (`secret\r\nyes\n`: the LF after the CR is discarded across the two
  prompts), AC-22 and AC-36. With `isTTY` false, no listener is attached, so the CLI reads
  nothing (AC-20, AC-25).
- Security: raw mode is turned off in a `finally` block for every way the answer ends.
- Maintainability: about 100 lines of own code with full unit tests over a fake TTY.

## Option 5B: `node:readline` for both prompts

Trade-offs: `readline` reads ahead and owns the stream until it closes. It has no way to discard
an LF after a CR across two interfaces. With `terminal: true` it echoes and edits by its own
rules (Ctrl-W, arrows), not by AC-36. Its `SIGINT` handling differs from AC-36 (d). Rejected.

## Option 6A: `put` checks with `stat`, then opens the remote file with exclusive create

How it works: without `--overwrite`, `put` keeps the `stat` check (exit 18 before it reads the
local file). It then calls `createWriteStream(path, { exclusive: true })`. The contract of
`RemoteFileSystem` gains this option. The SFTP back-end maps it to the open flags
`SSH_FXF_WRITE|SSH_FXF_CREAT|SSH_FXF_TRUNC|SSH_FXF_EXCL` (ssh2 mode string `'wx'`). SFTP v3 says
that an open with `SSH_FXF_EXCL` fails when the file exists. The server answers with a status
error (`SSH_FX_FAILURE` in v3, `SSH_FX_FILE_ALREADY_EXISTS` in later versions). On that failure,
and only then, the back-end sends a `stat`; when the path exists, the stream fails with
`ALREADY_EXISTS`. The CLI reports it with the AC-12 error line and exit 18. With `--overwrite`,
`put` opens with `'w'`, as today.

Trade-offs:

- Criteria: meets AC-12 also for a file that appears between the `stat` and the open. AC-10 and
  AC-14 do not change.
- Scale and cost: no extra round trip on success; one `stat` on an exclusive-open failure.
- Security: the server decides "exists" and "create" in one step, so no window is left on the
  client side. A server that ignores `SSH_FXF_EXCL` breaks SFTP v3; then the `stat` check is the
  only guard. *Accepted*: the server owns its storage and can change any file at any time, so a
  client cannot protect a file against the server that keeps it.
- Maintainability: an optional, additive parameter. Existing implementations of the interface
  (the test back-ends) still type-check. Each later back-end must honour it: S3 with
  `If-None-Match: *`, WebDAV with `If-None-Match: *`.

## Option 6B: `stat`, then a plain open (the first version of this record)

Trade-offs: a remote file created between the `stat` and the open is truncated without
`--overwrite`. That breaks "Must never allow" (AC-12). The window is one round trip (100 ms at
100 ms RTT), and another client of the same account can hit it. Rejected.

## Option 6C: Upload to a temporary remote name, then rename without replace

How it works: write `.<name>.<hex>.part` on the server, then SFTP `RENAME`, which fails in v3 when
the target exists.

Trade-offs: an atomic upload, which the spec puts "Out of scope". OpenSSH maps `RENAME` to
`link`+`unlink` and falls back to `rename(2)` on file systems with no hard links, so the guarantee
depends on the server's disk. It adds 2 round trips and a remote `.part` file that a failure can
leave. Rejected for this change; a candidate for FEATURE-6.

## Decision

1. **Registry: Option 1A, exposed through the tests' API.** The contract has no owner among its
   users, so the CLI and the later UI share it with no copy. Its entry points have the names and
   shapes that the harnesses use: `createRegistry()` with `register(scheme, backend)`, re-exported
   from `src/cli/index.ts`, and `registerBackends(registry)` in `src/backends.ts`. `register`
   takes a bare factory or a full definition. A bare factory gets fixed defaults (below), so the
   `mem` back-ends of both harnesses run unchanged. No test file changes. 1B puts the contract in
   the CLI. 1C adds global state. 1D cannot give AC-20 and ATK-3 together, and makes FEATURE-3
   change `src/cli/`. 1E changes 3 test files outside the implement node's writes, behind casts
   that hide errors from `tsc`.
2. **AC-38: Option 2A.** The back-end already parses the key. Only a decrypt tells a wrong
   passphrase. A typed reason keeps the hint text in the CLI and keeps SSH out of the CLI. 2B
   adds a second key parser in the CLI. 2C parses each key twice and adds a method that S3 does
   not need. *Refined at implementation:* ATK-1 (`cli-secrets-on-command-line.test.ts`) gives
   `--identity` with an unusable key to the test-only `mem` back-end and expects exit 10 with
   `connect()` never called; `mem` parses no key. So the parse of 2A also runs once before any
   back-end gets the credential: the registry holds one `PrivateKeyCheck`, which the composition
   module sets to `checkSftpPrivateKey` (the same `parsePrivateKeyOrFail` that `connect()` uses,
   with the same reasons). The CLI calls `registry.checkPrivateKey` after it takes a key
   credential, whatever the back-end. It stays one parser, in `src/sftp/`; the CLI still sees only
   a typed reason. Cost: an `sftp` command with a key parses it twice (CO-4).
3. **Escape: Option 3A.** AC-31 names the escape module apart from `src/fs/`, and display
   escaping is not part of the remote-filesystem contract. 3B is acceptable but mixes concerns.
4. **`get`: Option 4C, with Option 4E as its fallback.** `link(2)` refuses an existing object in
   one kernel step, so the race of the whole download closes on every file system with hard links.
   4E keeps the same no-clobber guarantee where `link` is not supported, at the cost of one copy.
   4A breaks "Must never allow" and fails ATK-3. 4D leaves a window of 2 system calls. 4F makes
   `--overwrite` the normal flag on FAT and exFAT disks. The `lstat` check before the connection
   stays: it gives AC-8 its "no connection" when the destination exists at the start.
5. **Prompts: Option 5A.** Only own code can keep the bytes after the first line end for the
   second prompt and apply AC-36 exactly.
6. **`put`: Option 6A.** The server creates the file only when no file has the name, in one step.
   6B leaves a one-round-trip window that the spec forbids. 6C is an atomic upload, which is out of
   scope, and costs 2 round trips.

### Contract the implementer keeps

#### New module `src/fs/backend.ts` (exported from `src/fs/index.ts` and `src/index.ts`)

```ts
import type { RemoteFileSystem } from './types.js';

/** What a confirmation callback is shown for an unknown host key. Moved from src/sftp/options.ts. */
export interface HostKeyInfo {
  readonly host: string;
  readonly port: number;
  readonly keyType: string;
  /** `SHA256:` and the unpadded base64 SHA-256 of the key blob, as OpenSSH prints it. */
  readonly fingerprint: string;
}

export interface PrivateKeyCredential {
  readonly kind: 'privateKey';
  readonly privateKey: Buffer;
  /** `undefined` when CYBERDUCK_RECAP_PASSPHRASE is unset or empty. */
  readonly passphrase: string | undefined;
}

export type Credential =
  | { readonly kind: 'password'; readonly password: string }
  | PrivateKeyCredential;

/** The parts of a URL that a back-end needs before a credential exists. */
export interface Endpoint {
  readonly host: string;           // brackets of an IPv6 literal removed
  readonly port: number | undefined; // undefined: the back-end's default port
  readonly username: string;       // percent-decoded; '' when the URL has none
}

/** The one argument a factory gets. The `mem` back-ends read `knownHostsPath` from it. */
export interface BackendTarget extends Endpoint {
  readonly credential: Credential | undefined;  // undefined when no source applied (see `credential`)
  readonly knownHostsPath: string | undefined;  // undefined only when usesKnownHosts is false
  readonly confirmHostKey: ((key: HostKeyInfo) => Promise<boolean>) | undefined;
}

export type BackendFactory = (target: BackendTarget) => RemoteFileSystem;

/**
 * How the CLI takes a credential for a back-end:
 * - 'required': sources 1 to 3 of AC-20; none applies -> exit 2 (the "no credential" line).
 * - 'optional': sources 1 and 2 only; none applies -> `credential` undefined. No prompt, no exit 2.
 * - 'none': no source is read; `credential` is undefined.
 */
export type CredentialPolicy = 'required' | 'optional' | 'none';

export interface BackendDefinition {
  readonly create: BackendFactory;
  readonly credential?: CredentialPolicy;      // default 'optional'
  readonly usesKnownHosts?: boolean;           // default true
  /** Throws a RemoteFsError (INVALID_ARGUMENT) for an endpoint it cannot use. No I/O. */
  readonly checkEndpoint?: (endpoint: Endpoint) => void; // default: accepts every endpoint
}

/** A definition with the defaults applied. */
export interface ResolvedBackend {
  readonly scheme: string;
  readonly create: BackendFactory;
  readonly credential: CredentialPolicy;
  readonly usesKnownHosts: boolean;
  checkEndpoint(endpoint: Endpoint): void;
}

/** Parses a private-key credential before any back-end gets it; throws AUTH_FAILED with a reason. */
export type PrivateKeyCheck = (credential: PrivateKeyCredential, endpoint: Endpoint) => void;

export interface BackendRegistry {
  /** Throws an Error (a defect of composition) for an empty, upper-case or duplicate scheme. */
  register(scheme: string, backend: BackendFactory | BackendDefinition): void;
  get(scheme: string): ResolvedBackend | undefined;
  /** Sorted; for `--help` and the "no back-end for the scheme" line. */
  schemes(): readonly string[];
  /** Set once by the composition module; a second call throws (a defect of composition). */
  setPrivateKeyCheck(check: PrivateKeyCheck): void;
  /** Runs the check that was set; does nothing when none was. */
  checkPrivateKey(credential: PrivateKeyCredential, endpoint: Endpoint): void;
}

/** A new, empty registry. No module-level state: each call is independent. */
export function createRegistry(): BackendRegistry;
```

Defaults for a bare factory (a function passed to `register`): `credential: 'optional'`,
`usesKnownHosts: true`, `checkEndpoint` accepts every endpoint. So the `mem` back-ends of
`test/support/mem-backend.ts` and `test/adversarial/support/cli-harness.ts` get:

- the credential from `--identity` or `CYBERDUCK_RECAP_PASSWORD` when the test gives one, and
  `undefined` otherwise. The `test/cli/` tests over `mem` pass `CYBERDUCK_RECAP_PASSWORD`; the
  adversarial tests pass none and still connect (ATK-3, `cli-get-partial-failure.test.ts`).
- the known_hosts path of AC-27 in `target.knownHostsPath`, with the default directories created
  before `connect()` (AC-27 over `mem`, `host-key.test.ts`).
- the AC-32 outcomes for `ls`, `get` and `put`, and `mem` in the `--help` scheme list.

AC-20 (exit 2, the prompt, the user-name check before the prompt) runs over `sftp`, which
declares `credential: 'required'` and a `checkEndpoint`. `src/cli/` branches only on the
`ResolvedBackend` fields, never on a scheme name.

`src/sftp/options.ts` imports `HostKeyInfo` from `src/fs/backend.ts` and re-exports it, so the
public name stays. Its own copy of the interface goes.

#### Change in `src/fs/types.ts`

```ts
export interface WriteStreamOptions {
  /** Create the file only when no file has the path; else the stream fails with ALREADY_EXISTS. */
  readonly exclusive?: boolean;
}
// RemoteFileSystem:
createWriteStream(path: string, options?: WriteStreamOptions): Writable;
```

The parameter is optional, so each existing implementation still type-checks. A back-end must
honour `exclusive: true` in one server-side step; it must not emulate it with a `stat` before the
open. The doc comment of `RemoteFileSystem` states this rule.

#### Changes in `src/fs/errors.ts`

```ts
export const REMOTE_FS_ERROR_REASONS = [
  'PRIVATE_KEY_ENCRYPTED',        // encrypted key, no passphrase given
  'PRIVATE_KEY_PASSPHRASE_WRONG', // encrypted key, the passphrase does not decrypt it
  'PRIVATE_KEY_INVALID',          // not a private key (a public key, other text)
] as const;
export type RemoteFsErrorReason = (typeof REMOTE_FS_ERROR_REASONS)[number];
// RemoteFsErrorDetails and RemoteFsError gain: readonly reason?: RemoteFsErrorReason
```

The reason is set like the other details: absent when not given, enumerable, read-only.

#### Changes in `src/sftp/`

- `options.ts`: extract `validateEndpoint(input: Record<string, unknown>): { host; port;
  username }` from `validateOptions`, with the same checks, order and messages (host, username,
  port). `validateOptions` calls it. This keeps one source for the AC-20 message.
- `connection.ts`, `parsePrivateKeyOrFail` (exported; `parsePrivateKey` and the registry's key
  check both call it, with `authFailed`, also exported, as the one source of the message):
  classify each failure and set `reason`:
  - parse fails, no passphrase, the error text matches `/encrypted/i` ->
    `PRIVATE_KEY_ENCRYPTED`, message `the private key is encrypted and no passphrase was given`;
  - parse fails, a passphrase was given, a parse without it matches `/encrypted/i` ->
    `PRIVATE_KEY_PASSPHRASE_WRONG`, the current message;
  - every other failure, also a parsed public key -> `PRIVATE_KEY_INVALID`, the current message.
  The error carries no cause, as today. Update `test/sftp/auth.test.ts` for the new message and
  assert the reason for an OpenSSH key and a PEM key (this pins the `ssh2` error text).
- `backend.ts` (new): `export const sftpBackend: BackendDefinition` (a full definition, not a bare
  factory) with `credential: 'required'`, `usesKnownHosts: true`, and `checkEndpoint` that calls
  `validateEndpoint`. Also `export const checkSftpPrivateKey: PrivateKeyCheck`, which the
  composition module sets on the registry (Decision 2). `DEFAULT_PORT` (22) is exported from
  `options.ts`, so the check and `validateEndpoint` share it. Also `export function sftpOptionsFor(target: BackendTarget):
  SftpFileSystemOptions`, which AC-4 tests. `create` returns
  `new SftpFileSystem(sftpOptionsFor(target))`. A missing port is left out of the options, so
  the back-end's default (22) applies.
- `session.ts`: `SftpChannel.open` accepts the mode `'r' | 'w' | 'wx'`.
- `sftp-file-system.ts`: `createWriteStream(path, options)` passes `options.exclusive` on.
- `streams.ts`: the write stream opens with `'wx'` when `exclusive` is true, else `'w'`. When an
  exclusive open fails with a status error, the stream sends one `stat` (as `explainFailure`
  does for directories); when the path exists, it fails with `ALREADY_EXISTS`, the remote path in
  `details.path`. Else the first error stands. Fix the doc comment of `WINDOW` in the same commit:
  `WINDOW × CHUNK_SIZE` is 16 × 31 KiB = 496 KiB in flight, not 512 KiB (ATK-8).
- `sanitize.ts`: the regex and `escapeCharacter` go. `sanitizeServerText` becomes
  `cap(escapeUnsafeText(textOf(text)))`. Its doc comment names `src/text/escape.ts`.

#### New module `src/text/escape.ts`

```ts
/** Escapes every code point of cyberduck/standard.sanitised-server-text; changes nothing else. */
export function escapeUnsafeText(text: string): string;
```

Up to U+00FF: `\xhh`. Above: `\uhhhh`. Lowercase hex. It imports nothing. It is the only file in
`src/` that holds the forms of AC-30 (a), (b) and (c).

#### `src/cli/` (imports only `src/fs/`, `src/text/escape.ts` and `node:`; no text `sftp`)

`src/cli/index.ts` exports `runCli`, the type `CliContext`, and re-exports `createRegistry` and
the registry types from `src/fs/backend.ts`.

```ts
export interface CliContext {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly stdin: NodeJS.ReadableStream & {
    readonly isTTY?: boolean;
    setRawMode?(mode: boolean): unknown;
  };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly home: string;            // the name both harnesses pass
  readonly registry: BackendRegistry;
  readonly umask?: number;          // default: process.umask(), read once per runCli call
  readonly version?: string;        // default: the `version` of package.json
}

/** Resolves to the exit code. Never rejects, never throws. */
export function runCli(args: readonly string[], context: CliContext): Promise<number>;
```

These are the fields that both harnesses pass (`stdout`, `stderr`, `stdin`, `env`, `cwd`, `home`,
`registry`). `umask` and `version` are optional, so the harnesses need no change:

- `umask`: `get.test.ts` computes the expected mode with `process.umask()` of the same process,
  so the default gives AC-41 its value. `runCli` reads it with `process.umask()` (the read-only
  form) when the context gives none, once per call.
- `version`: `src/cli/version.ts` reads it with
  `createRequire(import.meta.url)('../../package.json')`. The relative path holds from `src/cli/`
  and from `dist/cli/`. `node:module` is a `node:` import, so AC-31 allows it. `usage.test.ts`
  reads the same file, so AC-18 gets the same text.

Files (names are a proposal; the boundaries are the contract):

- `run.ts`: `runCli`, the order of steps, the one `try/catch` that maps every outcome to an exit
  code.
- `args.ts`: `parseArgs` with `strict: true`, `allowPositionals: true`. `--help`/`-h` and
  `--version` are found by a scan of the raw arguments before `parseArgs`, so they win over every
  other argument (AC-18). An unknown option is reported by the text before its first `=` (AC-19).
- `url.ts`: `new URL()`; scheme lookup; port 1-65535; a non-empty password is a USAGE error, an
  empty one is ignored; `decodeURIComponent` on the user name and the path (a `URIError` gives
  the "invalid percent-encoding" line); U+0000 refused; empty path -> `.`; IPv6 brackets removed.
- `exit-codes.ts`: `EXIT_CODES: Readonly<Record<RemoteFsErrorCode, number>>` (10-22) and the CLI
  codes (`INTERNAL` 1, `USAGE` 2, `LOCAL_FILE` 3, `CANCELLED` 130). The `Record` type fails the
  type check when a new code has no exit code. `--help` prints the table from this constant.
- `errors.ts`: `CliError(code, message, hints)` for `USAGE`, `LOCAL_FILE` and `CANCELLED`.
- `output.ts`: `writeError`, `writeHint` and `writeLine`. Every `stderr` line passes through
  `escapeUnsafeText`. `ls` escapes each name. The ` (<path>)` suffix is added when the raw
  message does not contain the raw path.
- `terminal.ts`: the shared reader of Option 5A, `promptPassword` and `promptLine`.
- `credentials.ts`: the order of AC-20 under the back-end's `CredentialPolicy`; `--identity` read
  as a `Buffer` (`LOCAL_FILE: cannot read the identity file <file>` on any read error).
- `known-hosts-path.ts`: the default path of AC-27. Each missing directory is created one at a
  time with `mkdir(dir, 0o700)`, then `chmod(dir, 0o700)`, so a strict umask cannot change the
  mode. When `mkdir` fails with `EEXIST` and `lstat` shows a directory, another process created it
  first: that counts as success, and the CLI does not `chmod` it (it did not create it). `EEXIST`
  on an object that is not a directory is the AC-40 (a) failure. A failure names the directory it
  could not create.
- `version.ts`: the default version above.
- `help.ts`: the `--help` text, with the exit-code table derived from `exit-codes.ts`.
- `commands/ls.ts`, `commands/get.ts`, `commands/put.ts`.

Details fixed at implementation (no criterion names them):

- `ls` prints `?` for a size that is not a non-negative safe integer and for an invalid
  `modifiedAt`, so an out-of-range entry keeps its 3 TABs and is never an `INTERNAL` defect
  (ATK-6).
- The `invalid URL '<x>'` line reads the URL as the parser does (ASCII TAB, LF and CR removed,
  leading and trailing C0 controls and spaces removed), then replaces the text from the first `:`
  after the scheme up to the last `@` with `***`: a URL that fails to parse may still hold a
  password, an unencoded one may hold `/`, `?`, `#`, `:` or `@`, and a TAB or newline may split
  `://` (ATK-1, ATK-68, ATK-70). A path with `@` is over-redacted; that costs only detail in an
  error line.
- The same function, `shownUrl` in `redact.ts`, is the one source for every other error line and
  hint that shows typed text: an unknown command, an unknown option name, a local path of `get`
  or `put`, the `--identity` file and the known_hosts path. A URL typed in the wrong place never
  shows its password (ATK-1).
- `parseArgs` runs with `strict: false` and `tokens: true`; the CLI words every option error
  itself, so no option value reaches an error line (ATK-1).
- After the host-key answer the CLI writes one LF, so the next line starts on its own line when
  the input does not echo (a pipe, a test). `confirmHostKey` is set only when `stdin.isTTY` is
  true and the back-end uses known_hosts.
- `get --overwrite` over a local directory exits 3 with `<path> is a directory`.

Order of steps in `runCli` (each step makes no connection before the step that connects):

1. Arguments: help, version, command, options, argument count.
2. URL: parse, `registry.get(scheme)`, `backend.checkEndpoint(endpoint)` (AC-20: exit 21 before
   any prompt).
3. Local checks of the command: `get` destination (AC-6, AC-7, AC-8); `put` opens the local file
   and checks it with `fstat` (AC-13). The descriptor stays open for the upload.
4. When `backend.usesKnownHosts`: the known_hosts path, and the default directories (AC-27,
   AC-40 (a)).
5. The credential, as `backend.credential` states (AC-20, AC-21, AC-36).
6. `backend.create(target)`; `confirmHostKey` is set only when `stdin.isTTY` is true.
7. `connect()`, then the command, then `disconnect()` once in a `finally` that follows a
   successful `connect()`. A rejection of `disconnect()` is ignored (AC-33).

Hints by outcome:

- `AUTH_FAILED` with a `reason` and `--identity`: the hint of AC-38 for that reason.
- `HOST_KEY_UNKNOWN`: the hint of AC-24 when `stdin.isTTY` is true, else the hint of AC-25.
- `HOST_KEY_CHANGED`: the hint of AC-26.
- `CONNECTION_LOST` during `put` after the write stream opened: the hint of AC-14.
- Not a `RemoteFsError` and not a `CliError`: the 2 fixed lines of AC-34; the value is never
  written.

`get` (Option 4C with fallback 4E) in detail:

1. Before the connection: the checks of AC-6, AC-7 and AC-8 (`lstat`; without `--overwrite`,
   anything but `ENOENT` gives exit 3). With `--overwrite` over a regular file, keep its
   `mode & 0o7777`.
2. Temporary name: `.${basename}.${randomBytes(8).toString('hex')}.part` in the destination's
   directory, opened with flags `wx` and mode `0o600`.
3. `pipeline(remote.createReadStream(path), file.createWriteStream())`.
4. Final mode: the kept mode when `--overwrite` replaces a regular file; else `0o666 & ~umask`
   (AC-41). It is set only after the last byte, so partial data is never under a wider mode, and
   with `fchmod` on the open descriptor (`FileHandle.chmod`), never by path: the mode lands on
   the file that was written, whatever the name points to by then. The bytes go through a small
   `Writable` over `FileHandle.write`, because a `FileHandle` stream with `autoClose: false`
   keeps the handle referenced and its `close()` never settles.
5. The final step:
   - `--overwrite`: `fchmod(temp, finalMode)`, then `rename(temp, destination)`.
   - no `--overwrite`: `fchmod(temp, finalMode)`, then `link(temp, destination)`, then
     `unlink(temp)`. The temporary file is complete at that point, so the mode change exposes no
     partial data. `EEXIST` -> `unlink(temp)`, exit 3 with the AC-8 line
     `<local path> exists; give --overwrite to replace it`.
   - `link` fails with `EPERM`, `ENOTSUP`, `EOPNOTSUPP`, `ENOSYS` or `EXDEV`: Option 4E.
   - any other `link` error: `unlink(temp)`, exit 3, `cannot write <local path>`.
6. On every failure: `unlink(temp)`, errors of the unlink ignored. `disconnect()` runs once in
   the `finally` of step 7 above (ATK-3 checks `disconnects` 1).
7. `commands/get.ts` takes its local file functions (`link`, `lstat`, `open`, `rename`, `stat`,
   `unlink`) from one
   object that a unit test can replace, so the fallback is tested with a `link` that fails with
   `EPERM`.

`put` (Option 6A): when the remote path ends with `/`, append the local basename; else `stat` it,
and append the basename when it is a directory. Then `stat` the final path: when it exists and
there is no `--overwrite`, `ALREADY_EXISTS` with the message `<remote path> exists; give
--overwrite to replace it` (exit 18). Then
`pipeline(localStream, remote.createWriteStream(path, { exclusive: !overwrite }))`. An
`ALREADY_EXISTS` from that stream gets the same AC-12 message and exit 18. A `CONNECTION_LOST`
from it gets the hint of AC-14. The first stream to fail names the side: a local read failure is
`LOCAL_FILE: cannot read <local-path>`.

One source for what `get` and `put` share:

- `commands/transfer.ts`: `download` (`get`) and `upload` (`put`) run the pipeline and return the
  side (local or remote) whose stream failed first; a remote stream that cannot be made is a
  remote failure.
- `existsText` in `errors.ts`: the AC-8 and AC-12 line `<path> exists; give --overwrite to replace
  it`.
- `errnoOf` in `src/fs/errors.ts`: the one reading of a Node.js error `code`, for the CLI and the
  SFTP back-end (`src/fs/` is the module both may import).
- `--help` builds the credential variable names from `credentials.ts` and the default known_hosts
  path from the parts that `defaultKnownHostsPath` joins.

#### Composition and entry

- `src/backends.ts`: `export function registerBackends(registry: BackendRegistry): void` calls
  `registry.setPrivateKeyCheck(checkSftpPrivateKey)` and `registry.register('sftp', sftpBackend)`.
  A later back-end adds one line here.
- `src/bin.ts`: `#!/usr/bin/env node`; builds the context from `process` (`home` from
  `os.homedir()`; `umask` and `version` left to their defaults); `const registry =
  createRegistry(); registerBackends(registry)`; `process.exitCode = await
  runCli(process.argv.slice(2), context)`.
- `package.json`: `"bin": { "cyberduck-recap": "dist/bin.js" }`. No new dependency.

#### Tests the contract needs (beyond the spec's Verifiers)

The tests written first stay as they are: the API above is the API that they import. The
implementer adds:

- `test/text/escape.test.ts`: every code point of the set and its neighbours;
  `test/text/boundary.test.ts`: `src/text/` imports nothing.
- `test/fs/backend.test.ts`: the defaults of a bare factory; `register` refuses an empty,
  upper-case or duplicate scheme; two registries share nothing.
- `test/fs/boundary.test.ts` keeps passing with `src/fs/backend.ts`.
- `test/sftp/backend.test.ts`: `checkEndpoint` messages equal `validateOptions` messages.
- `test/sftp/streams.test.ts` (or the existing write-stream test): an exclusive open over an
  existing file fails with `ALREADY_EXISTS` and the file keeps its bytes, over the in-process
  server (its `OPEN` handler maps the flags with `flagsToString`, so `'wx'` gives `EEXIST`).
  An exclusive open refused with `NO_SUCH_FILE` or `PERMISSION_DENIED`, whose follow-up `stat`
  fails too, keeps its own code (`NOT_FOUND`, `PERMISSION_DENIED`); `test/cli/put.test.ts` checks
  exit 16 for a missing remote directory.
- `test/cli/get-final-step.test.ts`: the 4C and 4E paths with an injected `link`.
- `test/cli/known-hosts-path.test.ts`: `EEXIST` on a directory that another caller created counts
  as success and keeps its mode (`known-hosts-path.ts` takes `chmod`, `lstat` and `mkdir` from one
  replaceable object, `directoryFiles`, as `get.ts` does).

Tests outside the tests written first that change with this record:

- `test/fs/contract.test.ts`: `createWriteStream` has the type
  `(path: string, options?: WriteStreamOptions) => Writable` (Option 6A).
- `test/sftp/auth.test.ts`: the message for an encrypted key with no passphrase, and the
  `reason` of each key failure.
- `test/cli/escape.test.ts` (a test written first): its helper checked whole `ls` lines for a raw
  code point of the set, so the 3 field-separating TABs that AC-28 requires failed every case. It
  now checks each field of a `stdout` line, as `cli-hostile-server-text.test.ts` does.

## Pre-mortem

Each failure the panel could name, with its mitigation or an explicit acceptance. The options
above were compared on the same four lenses.

### Scale

- **SC-1. 5 MiB and larger transfers.** `get` and `put` use `stream.pipeline`, so memory is
  bounded by the back-end's window and the `highWaterMark` (about 1 MiB for SFTP, FEATURE-1
  S-1b), whatever the file size. *Mitigated.* No file is read whole into memory.
- **SC-2. `ls` of a very large directory.** `list()` returns an array (the FEATURE-1 contract),
  so memory is O(entries). The CLI sorts once (O(n log n)) and writes in chunks that respect the
  `stdout` backpressure. *Accepted*: a streaming `list` is a contract change for FEATURE-6 or
  later.
- **SC-3. Many CLI processes at once on one known_hosts file.** `appendKnownHost` writes one line
  in one write on an `O_APPEND` descriptor (FEATURE-1). Two processes that both get `yes` can add
  two equal lines. *Accepted*: OpenSSH reads duplicate lines without harm.
- **SC-4. Many back-ends.** The registry is a `Map`; the help lists schemes in sorted order.
  *No risk.*
- **SC-5. Temporary files on a full disk.** `get` needs free space for the whole file beside the
  destination before the final step (no in-place write). A write error removes the temporary file
  and exits 3. *Accepted*: the same space is needed for the final file. On a file system with no
  hard links, fallback 4E needs twice the file's size until it removes the temporary file.
- **SC-6. Concurrent first runs create the known_hosts directories.** Two CLI processes with a new
  home both find `~/.config/cyberduck-recap` missing. The second `mkdir` fails with `EEXIST`.
  *Mitigated*: `EEXIST` on an object that `lstat` shows as a directory counts as success, and the
  CLI does not `chmod` a directory it did not create (AC-27). Only `EEXIST` on a non-directory
  fails (AC-40 (a)). `test/cli/known-hosts-path.test.ts` covers it.

### Cost

- **CO-1. Dependencies.** No new production dependency (`parseArgs`, `node:fs`, `node:crypto`,
  `node:stream`). `test/licenses.test.ts` and `pnpm audit` see no change. *Mitigated.*
- **CO-2. Test time.** The 5 MiB cases (AC-5, AC-9, AC-10, AC-14) run over the in-process SFTP
  server; the other criteria use the `mem` back-end, which needs no socket. *Mitigated*: only the
  criteria that name the SFTP server use it.
- **CO-3. Round trips.** `put` sends up to 2 `stat` requests before it uploads; `get` sends none.
  At 100 ms RTT that adds at most 0.2 s per `put`. The exclusive open (6A) adds no round trip on
  success, and one `stat` after a refused open. *Accepted* for a one-file command.
- **CO-4. Key derivation.** Option 2A parses an encrypted key once in `connect()`; the registry's
  key check (Decision 2) parses it once more before the back-end gets it, so an `sftp` command
  with a key parses it twice. On a wrong passphrase the parse runs twice (the existing classification). *Accepted*.
- **CO-5. Change size.** Outside `src/cli/`: 3 new small modules (`src/fs/backend.ts`,
  `src/text/escape.ts`, `src/sftp/backend.ts`), 2 entry files, and edits in `types.ts`,
  `errors.ts`, `options.ts`, `connection.ts`, `session.ts`, `sftp-file-system.ts`, `streams.ts`
  and `sanitize.ts`. The no-clobber final step of `get` adds about 40 lines and 4 unit tests.
  *Accepted*: each edit has a test.
- **CO-6. The `get` fallback copy.** On a file system with no hard links, Option 4E reads and
  writes the file a second time (about 35 s more for 1 GiB at 30 MB/s). *Accepted*: it runs only
  where `link` is not supported, and only without `--overwrite`.

### Security

- **SE-1. A secret on `stdout` or `stderr`.** The CLI has no password option and refuses a URL
  password without echo (AC-19). Error lines come only from `RemoteFsError` messages, which
  FEATURE-1 keeps free of secrets, and from fixed CLI text. The `reason` is a fixed word. The
  identity file content and the passphrase never enter a message. An unknown error prints only
  the fixed lines of AC-34, never its message or stack. *Mitigated*; AC-23 tests each secret and
  each outcome.
- **SE-2. Terminal injection through names, messages or URL text.** Every `stderr` line and every
  `ls` name passes through `escapeUnsafeText`, which also escapes U+009B (C1 CSI) and the bidi
  overrides. *Mitigated*; AC-28 and AC-29 test it. *Accepted*: the backslash is not escaped, so a
  name can hold the literal text `\x1b` (spec, "Out of scope").
- **SE-3. Terminal left in raw mode.** `setRawMode(false)` runs in a `finally` block. In raw
  mode, Ctrl-C reaches the CLI as byte 0x03, not as SIGINT, so no signal can skip the `finally`.
  *Mitigated*; AC-22 tests the 5 endings. *Accepted*: a SIGTERM from another process during the
  prompt can leave raw mode on (spec, "Out of scope").
- **SE-4. Disclosure or hijack of the temporary file.** `wx` and mode 0600 in the destination's
  directory; 64 random bits in the name; `O_EXCL` refuses a planted file or link. *Mitigated*;
  AC-41 tests the mode.
- **SE-5. A write through a symbolic link.** The pre-check uses `lstat`. With `--overwrite`, the
  final step is `rename(2)`, which replaces a link and never follows it. Without it, `link(2)`
  and `open(…, O_CREAT|O_EXCL)` fail on a link, also a dangling one, and never follow it.
  *Mitigated*; AC-8, AC-42 and ATK-3 (b), (c).
- **SE-6. A destination that appears during the download of `get`.** The window is the whole
  download: the `lstat` check runs before `connect()`, and the destination name is made after the
  last byte. Any process of the same user can plant a file or a link there. *Mitigated in full*
  (Option 4C): without `--overwrite`, the final step is `link(2)`, which fails with `EEXIST` when
  any object has the name, in one kernel step. `get` then removes its temporary file and exits 3;
  the planted object is unchanged. Where `link` is not supported, fallback 4E creates the
  destination with `O_CREAT|O_EXCL`, which has the same guarantee. ATK-3 tests (a) a file,
  (b) a link and (c) `--overwrite` over a swapped link. *Accepted* (4E only): a signal during the
  fallback copy can leave a partial new destination. The spec puts clean-up on a signal "Out of
  scope", and 4E runs only on a file system with no hard links.
- **SE-15. A remote file that appears between the `stat` of `put` and its open.** Another client
  of the same account creates the file in that round trip; a plain open would truncate it.
  *Mitigated* (Option 6A): without `--overwrite`, the open carries `SSH_FXF_EXCL`, so the server
  refuses an existing file in one step, and `put` exits 18 with the AC-12 line. *Accepted*: a
  server that ignores `SSH_FXF_EXCL` breaks SFTP v3; the client cannot protect a file against the
  server that stores it, and the `stat` check still refuses a file that existed before.
- **SE-7. A host key trusted without the person.** `confirmHostKey` exists only when
  `stdin.isTTY` is true. Only the exact answer `yes` (after trimming spaces and TABs) returns
  `true`. A changed key never reaches the callback (FEATURE-1). The key is recorded only after the
  handshake proves it (FEATURE-1 S-2). *Mitigated*; AC-24 to AC-26 and AC-39.
- **SE-8. A local path chosen by the server.** The destination of `get` comes from the command
  line and the URL path only; no server name is used. *Mitigated*; AC-6 and AC-7.
- **SE-9. A known_hosts directory or file that others can read or write.** Each created
  directory gets `chmod 0700` after `mkdir`, so umask cannot loosen or tighten it; the file is
  created with 0600 by `appendKnownHost`. *Mitigated*; AC-27 and AC-39. *Accepted*: the CLI does
  not change the mode of a directory that exists (spec AC-27).
- **SE-10. A password in the environment.** `CYBERDUCK_RECAP_PASSWORD` is visible to the same
  user through `/proc/<pid>/environ` and to child processes. The CLI starts none. *Accepted*:
  the spec chose it (Decision 3) for scripts; the keychain is FEATURE-5.
- **SE-11. A hostile host in the URL.** A WHATWG URL with a non-special scheme keeps the host
  opaque, so it can hold percent-escapes. `checkEndpoint` runs `isValidHost` (FEATURE-1 G-1)
  before any I/O, which refuses everything but a DNS name or an IP literal. *Mitigated*.
- **SE-12. A wrong AC-38 classification after an `ssh2` update.** The classification reads the
  `ssh2` error text (`/encrypted/i`). If that text changes, the reason becomes
  `PRIVATE_KEY_INVALID` and the hint is wrong, but the exit is still 10 and no key is used
  (fail-safe). *Mitigated*: `test/sftp/auth.test.ts` asserts the reason for OpenSSH and PEM keys,
  so an update that changes the text fails the tests; the lockfile pins `ssh2`.
- **SE-13. A test back-end in production.** `mem` lives only in `test/`; `registerBackends`
  registers `sftp` only; `register` refuses a duplicate scheme, so a later entry cannot replace
  `sftp`. A bare factory gets `credential: 'optional'`, which never prompts and never weakens
  `sftp`, because `sftp` declares `'required'`. *Mitigated*.
- **SE-14. A secret kept in memory.** The password and the key are JavaScript strings and
  buffers; a string cannot be wiped. *Accepted*: the process is short-lived and the same holds for
  `ssh2`.

### Maintainability

- **MA-1. The boundary drifts.** `test/cli/boundary.test.ts` (AC-30, AC-31),
  `test/fs/boundary.test.ts`, `test/boundary/ssh2-imports.test.ts` and the new
  `test/text/boundary.test.ts` run in `import-boundaries`. *Mitigated*.
- **MA-2. A new error code without an exit code.** `EXIT_CODES` is a
  `Record<RemoteFsErrorCode, number>`, so `tsc` fails; AC-15 iterates `REMOTE_FS_ERROR_CODES`.
  *Mitigated*.
- **MA-3. A later back-end needs a credential the CLI does not know** (S3 access keys). Such a
  back-end declares `credential: 'none'` and reads its own variables in its factory, so
  `src/cli/` does not change. *Accepted*: a new interactive credential kind (for example an
  SSH-agent or keychain choice, FEATURE-5) is a change of `CredentialKind` and of the CLI. That
  change is FEATURE-5's design.
- **MA-4. Copied messages drift.** The AC-20 message comes from `validateEndpoint`, the one source
  for `validateOptions` and `checkEndpoint`. The exit table in `--help` is derived from
  `EXIT_CODES`. The escape set has one regex. *Mitigated* (`cyberduck/standard.single-source`).
- **MA-5. Records follow changes** (`cyberduck/standard.records-follow-changes`). The doc comments
  of `sanitize.ts`, `options.ts` (`HostKeyInfo`) and `connection.ts` (`parsePrivateKey`) change in
  this change. *Mitigated*; the implementer edits them in the same commit as the code.
- **MA-6. `process.umask()` without an argument is deprecated (DEP0139, documentation only).**
  `runCli` calls it once, when the context gives no `umask` (both harnesses give none); `src/bin.ts`
  leaves it to that default. A test that needs another value sets `umask` in the context.
  *Accepted*; if Node makes it a runtime warning, the CLI derives the umask from the mode of a
  probe file instead.
- **MA-7. Open follow-ups touch the same files.** `follow-ups.code.stream-open-single-source`
  edits `src/sftp/streams.ts` and `follow-ups.code.malformed-parts-single-source` edits
  `src/sftp/error-map.ts`. This change does not edit `error-map.ts` (it keeps its import of
  `sanitizeServerText`). It edits `streams.ts` in 2 places: the open mode of the write stream
  (6A) and the `WINDOW` doc comment (ATK-8). *Accepted*: the follow-up rebases over a change of a
  few lines; the exclusive-open path goes into its single open helper.
  `follow-ups.code.comment-width-lint` applies: new comments wrap at 100 columns.
- **MA-8. The closed reason list grows by accident.** `REMOTE_FS_ERROR_REASONS` is a constant; a
  new reason is a change in `src/fs/` with a test and a CLI hint. *Mitigated*.
- **MA-9. The product API and the tests' API drift.** The harnesses cast the registry and the
  context (`as never`, `as unknown as`), so `tsc` shows no mismatch. *Mitigated*: the product
  exports the names and shapes that the harnesses use (`createRegistry`, `register(scheme,
  factory)`, `registerBackends`, `home`; `umask` and `version` optional), and the bare-factory
  defaults are fixed in `src/fs/backend.ts` with `test/fs/backend.test.ts`. No test file changes
  in this change.
- **MA-10. Two harnesses copy the registry glue.** `test/support/cli.ts` and
  `test/adversarial/support/cli-harness.ts` each declare `Registry` and `BackendFactory` and each
  build the test registry. *Accepted* for this change (the implement node does not edit tests).
  Follow-up: both harnesses import `BackendFactory` and `BackendRegistry` from `src/fs/index.ts`,
  share one `testRegistry` from `test/support/cli.ts`, and drop the casts, so `tsc` checks them.

## Consequences

- The implementer creates `src/fs/backend.ts`, `src/text/escape.ts`, `src/sftp/backend.ts`,
  `src/backends.ts`, `src/bin.ts` and `src/cli/` (with `src/cli/index.ts` and
  `src/cli/version.ts`), and edits `src/fs/types.ts`, `src/fs/errors.ts`, `src/fs/index.ts`,
  `src/index.ts`, `src/sftp/options.ts`, `src/sftp/connection.ts`, `src/sftp/session.ts`,
  `src/sftp/sftp-file-system.ts`, `src/sftp/streams.ts`, `src/sftp/sanitize.ts` and
  `package.json` (`bin`), as the contract above states.
- No file of the tests written first changes. `test/support/cli.ts`,
  `test/support/mem-backend.ts` and `test/adversarial/support/cli-harness.ts` run against the
  product API as they are. `test/sftp/auth.test.ts` follows the new key message (an existing
  test of FEATURE-1, edited with the code it checks).
- `RemoteFsError` gains the optional `reason` detail, and `createWriteStream` gains the optional
  `{ exclusive }` parameter. Both are additive changes of the public contract; existing callers
  see no difference. Each later back-end (FEATURE-3, FEATURE-4) must honour `exclusive`.
- `HostKeyInfo` moves to `src/fs/backend.ts`; `src/sftp/options.ts` re-exports it, so the public
  name in `src/index.ts` is unchanged.
- The message for an encrypted key with no passphrase changes from "the private key could not be
  parsed" to "the private key is encrypted and no passphrase was given".
- Records follow the change (`cyberduck/standard.records-follow-changes`): the doc comment of
  `WINDOW` in `src/sftp/streams.ts` changes from "at most 512 KiB in flight" to "at most
  496 KiB in flight (16 × 31 KiB)" (ATK-8). The doc comments of `sanitize.ts`, `options.ts`
  (`HostKeyInfo`), `connection.ts` (`parsePrivateKey`) and `RemoteFileSystem.createWriteStream`
  (the `exclusive` rule) change in the same commit as their code.
- ATK-3 (`test/adversarial/cli-get-destination-race.test.ts`) passes under Option 4C: exit 3, the
  planted file or link unchanged, no `.part` file left; with `--overwrite`, the link is replaced.
- Accepted risks: SC-2, SC-3, SC-5, CO-3, CO-4, CO-5, CO-6, SE-10, SE-14, MA-6, MA-7, MA-10, the
  parts marked *Accepted* in SE-2, SE-3, SE-6 (a signal during fallback 4E), SE-9 and SE-15 (a
  server that ignores `SSH_FXF_EXCL`), and MA-3.
- Follow-ups: a streaming `list` for very large directories (with FEATURE-6); an atomic upload
  through a remote temporary name (Option 6C, with FEATURE-6); one test-side source for the
  registry glue of the two harnesses, without casts (MA-10); a check of the identity file's mode
  (FEATURE-5, spec "Out of scope").
