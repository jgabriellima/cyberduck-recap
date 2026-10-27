# Proposed specialization

## Manifest (sdlc.yaml)

```yaml
# The project's manifest. The engine reads instance, agent_runtime, integrations, toolchains,
# packages, autopilot, memories and context_budget; agents read the invariants.
# Workflows, gates, roles and the policies the engine enforces are contracts of the protocol
# (`sdlc-engine protocol`), never sections of this file. `/sdlc-init` specializes it.

sdlc:
  schema_version: "4.0"

instance:
  name: your-project
  lanes:
    product_paths:
      - src/**
      - test/**
      - tests/**
      - packages/**
      - apps/**
      - scripts/**
      - assets/**
      - README.md
      - package.json
      - pnpm-lock.yaml
      - pnpm-workspace.yaml
      - tsconfig*.json
      - eslint.config.*
      - .prettierrc*
      - .prettierignore
      - vitest.config.*
      - LICENSE
    operator_paths:
      - .sdlc/**
      - .outputs/**
      - docs/**
  human_review:
    enabled: true
    keywords:
      targeted:
        - change
        - replace
        - typo
        - fix
        - add
        - remove
        - rename
        - style
        - small
        - minor
      complex:
        - redesign
        - rethink
        - reconsider
        - refactor
        - new feature
        - restructure
        - different approach
        - break into smaller parts
        - doesn't match the design
      vague:
        - didn't like
        - weird
        - wrong
        - improve
        - adjust
        - not good
        - doesn't feel right
      question:
        - why
        - why did
        - why does
        - what does
        - what is
        - what happens
        - how does
        - how is
        - could you explain
        - can you explain
        - is this intentional
        - does this handle
        - should this
    complex_diff_lines: 400
    behavior:
      reply_to_comments: true
    anti_loop:
      autopilot_max_rounds: 3

agent_runtime:
  active: claude

integrations:
  source_control:
    {
      provider: local,
      integration: github/integration.github-com,
      settings: { repository: jgabriellima/cyberduck-recap },
      credentials: { token: env:GITHUB_TOKEN }
    }
  work_items: { provider: local }
  ci: { provider: local }

toolchains:
  - sdlc/toolchain.node-pnpm
  - cyberduck/toolchain.project

memories:
  location: .sdlc/memories/
  files:
    - id: architecture
      path: architecture.md
      max_tokens: 800
      inject_modes:
        - session_start
        - hydrate
    - id: business-rules
      path: business-rules.md
      max_tokens: 600
      inject_modes:
        - hydrate
    - id: operational-context
      path: operational-context.md
      max_tokens: 500
      inject_modes:
        - session_start
        - hydrate

context_budget:
  session_capsule_max_tokens: 1500

invariants:
  - Workflow node gates must pass before dispatch continues.
  - AGENTS.md rules supersede agent priors when they conflict.
  - Providers are integration contracts bound under integrations:; local is the
    default.
  - One PR per lane; main is protected.
  - Approved specs execute end-to-end through merge.
packages:
  - sdlc/default@^2
  - sdlc/baseline@^1
  - github/cloud@^1
```

## Definition of Done (standards)

| Category | Standard | Rule | Enforced by |
| --- | --- | --- | --- |
| architecture | cyberduck/standard.protocol-boundaries | Code outside a protocol back-end (src/fs/, the CLI, queue, sync and UI) does not import a protocol library or a back-end module (e.g. ssh2, src/sftp/); an import-boundary test enforces it. | gate cyberduck/gate.import-boundaries at implement |
| architecture | cyberduck/standard.session-ending-settles-once | When a session ends at any point (transport close, an OPEN or request reply with no status, disconnect()), every pending request and stream settles exactly once with one typed RemoteFsError that carries its code and path, never an AggregateError or a second error, and a handle that arrives after the end is closed; an adversarial test covers each ending. | the review |
| code | baseline/standard.format | Every file the project's formatter covers is formatted by it; nobody formats by hand. | gate baseline/gate.format at implement |
| code | baseline/standard.lint | Every change leaves the project's linter with nothing to report — no error and no warning. | gate baseline/gate.lint at implement |
| code | baseline/standard.typecheck | Every change type-checks under the project's settings; no type error is silenced to get there. | gate baseline/gate.typecheck at implement |
| code | cyberduck/standard.single-source | A behaviour or a list of names that src/ needs in more than one place has one source: a shared helper, or a constant the other places import or derive from, so that copies cannot drift. A change that adds or edits such a copy moves it to the one source; the copies on main at approval are follow-ups. | the review |
| comments | baseline/standard.why-comments | A comment explains why the code is the way it is — an intent, a constraint, a trade-off — never what the code already says; no commented-out code. | the review |
| comments | cyberduck/standard.comment-width | Comments wrap at 100 columns; a lint rule checks it, because the formatter does not wrap comments. | the review |
| comments | cyberduck/standard.records-follow-changes | A change that alters a value, module or rule recorded in the work item's design.md or in a doc comment updates that record in the same change. | the review |
| security | baseline/standard.audit | No dependency of the project has a known vulnerability of high or critical severity. | gate baseline/gate.audit at implement |
| security | baseline/standard.no-secrets | No credential, token, key or password is in the source, the tests or the history; the code reads them from the environment or the project's secret store. | the review |
| security | cyberduck/standard.clean-room-licences | No Cyberduck source code is reused, ported or translated, and every production dependency (direct and transitive) has a licence on the permissive allow-list (MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0, Unlicense, CC0-1.0, BlueOak-1.0.0), checked by test/licenses.test.ts. | gate cyberduck/gate.licences at implement |
| security | cyberduck/standard.sanitised-server-text | Server-supplied text (status messages, banners, file names) placed in an error message or log is sanitised: C0/C1 control characters, DEL and Unicode format characters (bidi overrides U+202A-U+202E, U+2066-U+2069, separators U+2028/U+2029) are escaped. | the review |
| security | cyberduck/standard.untrusted-server-replies | Every reply from a remote server is untrusted input: its shape is validated, a malformed or hostile reply maps to a typed error (never a crash, hang or leaked stream), and the back-end has a hostile-server test for it. | the review |
| testing | baseline/standard.tests | A change that adds or changes behaviour adds or changes the tests that show it, and the project's tests pass. | gate sdlc/gate.tests-pass at implement |
| testing | cyberduck/standard.verifier-proves-criterion (new) | The Verifier of each acceptance criterion proves the whole criterion: it checks the same bound, scope and list that the criterion states, so no outcome fails the criterion and still passes its Verifier. When a test waits up to a tolerance, the criterion states that bound, or the Verifier also asserts the tighter bound the criterion states. | the review |

No standard, by decision: integration, review.

## Contracts and runtime content (.sdlc/overlay/)

- standards/verifier-proves-criterion.yaml

## Decisions

| Subject | Value | How | Evidence |
| --- | --- | --- | --- |
