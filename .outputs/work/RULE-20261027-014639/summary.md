# Proposed specialization

## Manifest (sdlc.yaml)

```yaml
# RULE-20261027-014639: the manifest sections stay as they are; the rule adds one standard.
packages:
  - sdlc/default@^2
  - sdlc/baseline@^1
  - github/cloud@^1
integrations:
  source_control:
    provider: local
    integration: github/integration.github-com
    settings: { repository: jgabriellima/cyberduck-recap }
    credentials: { token: env:GITHUB_TOKEN }
  work_items: { provider: local }
  ci: { provider: local }
toolchains:
  - sdlc/toolchain.node-pnpm
  - cyberduck/toolchain.project
```

## Definition of Done (standards)

| Category | Standard | Rule | Enforced by |
| --- | --- | --- | --- |
| architecture | cyberduck/standard.protocol-boundaries | Code outside a protocol back-end (src/fs/, the CLI, queue, sync and UI) does not import a protocol library or a back-end module (e.g. ssh2, src/sftp/); an import-boundary test enforces it. | gate cyberduck/gate.import-boundaries at implement |
| architecture | cyberduck/standard.session-ending-settles-once | When a session ends at any point (transport close, an OPEN or request reply with no status, disconnect()), every pending request and stream settles exactly once with one typed RemoteFsError that carries its code and path, never an AggregateError or a second error, and a handle that arrives after the end is closed; an adversarial test covers each ending. | the review |
| code | baseline/standard.format | Every file the project's formatter covers is formatted by it; nobody formats by hand. | gate baseline/gate.format at implement |
| code | baseline/standard.lint | Every change leaves the project's linter with nothing to report — no error and no warning. | gate baseline/gate.lint at implement |
| code | baseline/standard.typecheck | Every change type-checks under the project's settings; no type error is silenced to get there. | gate baseline/gate.typecheck at implement |
| code | cyberduck/standard.single-source (new) | A behaviour or a list of names that src/ needs in more than one place has one source: a shared helper, or a constant the other places import or derive from, so that copies cannot drift. A change that adds or edits such a copy moves it to the one source; the copies on main at approval are follow-ups. | the review |
| comments | baseline/standard.why-comments | A comment explains why the code is the way it is — an intent, a constraint, a trade-off — never what the code already says; no commented-out code. | the review |
| comments | cyberduck/standard.records-follow-changes | A change that alters a value, module or rule recorded in the work item's design.md or in a doc comment updates that record in the same change. | the review |
| security | baseline/standard.audit | No dependency of the project has a known vulnerability of high or critical severity. | gate baseline/gate.audit at implement |
| security | baseline/standard.no-secrets | No credential, token, key or password is in the source, the tests or the history; the code reads them from the environment or the project's secret store. | the review |
| security | cyberduck/standard.clean-room-licences | No Cyberduck source code is reused, ported or translated, and every production dependency (direct and transitive) has a licence on the permissive allow-list (MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0, Unlicense, CC0-1.0, BlueOak-1.0.0), checked by test/licenses.test.ts. | gate cyberduck/gate.licences at implement |
| security | cyberduck/standard.sanitised-server-text | Server-supplied text (status messages, banners, file names) placed in an error message or log is sanitised: C0/C1 control characters, DEL and Unicode format characters (bidi overrides U+202A-U+202E, U+2066-U+2069, separators U+2028/U+2029) are escaped. | the review |
| security | cyberduck/standard.untrusted-server-replies | Every reply from a remote server is untrusted input: its shape is validated, a malformed or hostile reply maps to a typed error (never a crash, hang or leaked stream), and the back-end has a hostile-server test for it. | the review |
| testing | baseline/standard.tests | A change that adds or changes behaviour adds or changes the tests that show it, and the project's tests pass. | gate sdlc/gate.tests-pass at implement |

No standard, by decision: integration, review.

## Contracts and runtime content (.sdlc/overlay/)

- standards/single-source.yaml

## Decisions

| Subject | Value | How | Evidence |
| --- | --- | --- | --- |
| conventions.architecture | "baseline" | asked | “default (baseline)” |
| conventions.integration | "baseline" | asked | “default (baseline)” |
| conventions.review | "baseline" | asked | “default (baseline)” |
| follow-ups.scaffold | {"work":"Scaffold the file-transfer client in TypeScript with pnpm (the owner's choice; toolchain sdlc/toolchain.node-pnpm): create package.json, pnpm-lock.yaml, tsconfig.json, the ESLint and Prettier configurations and the Vitest setup, so the preset's tools (build, lint, typecheck, format-check, unit-tests, audit) run green. The linter and formatter exclude .claude/, .agent/, .outputs/ and .sdlc/. Until the scaffold lands, the sdlc/baseline gates over those tools cannot hold.","open_questions":["Desktop UI toolkit (e.g. Electron, Tauri), CLI, or both; target platforms and packaging/distribution.","Runtime and framework within TypeScript (Node version, bundler, monorepo or single package).","Protocol libraries for SFTP, S3, WebDAV and the other back-ends (\"SFTP/S3/WebDAV, etc.\" in the objective).","Where saved credentials live (OS keychain or otherwise) and how host keys and TLS are verified.","How Cyberduck is studied as the model (behaviour reference only; its licence governs any reuse)."]} | asked | “TypeScript + pnpm” |
| follow-ups.product | {"work":"Turn the objective into work items (/sdlc-goal): \"Build a new file-transfer client (SFTP/S3/WebDAV, etc.) modeled on Cyberduck\" — which protocols first, browsing, upload and download, bookmarks, transfer queue, synchronisation."} | asked | “Build a new file-transfer client (SFTP/S3/WebDAV, etc.) modeled on Cyberduck” |
| follow-ups.integrations.work_items | {"work":"Work items on GitHub Issues for jgabriellima/cyberduck-recap. The github/cloud package serves source control only (pull requests); no installed package serves GitHub Issues, so work items stay local (specs in the repository) until a GitHub Issues integration is added with /sdlc-evolve."} | asked | “https://github.com/jgabriellima/cyberduck-recap.git” |
| follow-ups.integrations.ci | {"work":"CI on GitHub Actions. The github/cloud package has no CI integration, so checks run locally through the engine's gates; once the scaffold has a toolchain, add a GitHub Actions workflow and a CI integration with /sdlc-evolve."} | asked | “https://github.com/jgabriellima/cyberduck-recap.git” |
| follow-ups.source_control.remote | {"work":"The repository has no remote yet: add origin https://github.com/jgabriellima/cyberduck-recap.git before the first pull request. GITHUB_TOKEN (contents and pull-request write access to that repository) is in the git-ignored .env.local, where the engine reads it."} | asked | “https://github.com/jgabriellima/cyberduck-recap.git” |
| follow-ups.security.sanitise-format-characters | {"work":"Bring sanitizeServerText (src/sftp/sanitize.ts) in line with cyberduck/standard.sanitised-server-text: it escapes C0/C1 controls and DEL (/[\\u0000-\\u001f\\u007f-\\u009f]/) but not the bidi overrides U+202A-U+202E, U+2066-U+2069 or the separators U+2028/U+2029. Add a test for each range. A bug work item, delivered with /sdlc-deliver."} | extracted | $ grep -n 'CONTROL_CHARACTERS =' src/sftp/sanitize.ts |
| follow-ups.code.stream-open-single-source | {"work":"Bring src/sftp/streams.ts in line with cyberduck/standard.single-source: SftpReadStream._construct and SftpWriteStream._construct hold the same OPEN logic (session check, settleOnce, track/abort, request, late-handle close, malformed handle, explainFailure) and differ only in the open flag 'r' or 'w'. Move it to one shared helper that both call. The tests under test/sftp/ and test/adversarial/ (open-teardown, settle-once, stream-session-ending) keep passing. A refinement work item, delivered with /sdlc-deliver."} | extracted | $ grep -n "override _construct\|sftp.open(this.#context.path" src/sftp/streams.ts |
| follow-ups.code.malformed-parts-single-source | {"work":"Bring src/sftp/error-map.ts in line with cyberduck/standard.single-source: MALFORMED_PARTS ('file handle', 'directory handle', 'directory entries', 'attributes', 'data') is copied by hand from the part names that src/sftp/connection.ts passes to expecting() and MalformedReplyError. Declare the part names once as a constant that both files import or derive from. A refinement work item, delivered with /sdlc-deliver."} | extracted | $ grep -n "const MALFORMED_PARTS" src/sftp/error-map.ts, $ grep -n "expecting('" src/sftp/connection.ts |
