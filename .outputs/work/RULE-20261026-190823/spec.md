---
id: RULE-20261026-190823
kind: rule
status: active
---
# The standards run FEATURE-1 proposes for the project:

## Rule

The standards run FEATURE-1 proposes for the project:

1. [architecture] Code outside a protocol back-end (src/fs/, the CLI, queue, sync and UI) does not import a protocol library or a back-end module (e.g. ssh2, src/sftp/); an import-boundary test enforces it.
   - From: ticket
   - Evidence: FEATURE-1 ticket: 'the CLI, queue, sync and UI must not depend on a specific protocol.'
   - Evidence: FEATURE-1 AC-2, test/fs/boundary.test.ts and test/boundary/ssh2-imports.test.ts
   - Evidence: Design pre-mortem note (FEATURE-1): 'no test enforces it: neither AC-2 nor G-7 scans test/support/remote-fs-assertions.ts for ../sftp or src/sftp imports.'
2. [security] No Cyberduck source code is reused, ported or translated, and every production dependency (direct and transitive) has a licence on the permissive allow-list (MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0, Unlicense, CC0-1.0, BlueOak-1.0.0), checked by test/licenses.test.ts.
   - From: ticket
   - Evidence: FEATURE-1 ticket: 'Cyberduck is a behaviour reference only (GPL; no code reuse).'
   - Evidence: FEATURE-1 AC-23 and test/licenses.test.ts ('keeps Cyberduck's GPL code and copyleft libraries out of the product')
3. [security] Every reply from a remote server is untrusted input: its shape is validated, a malformed or hostile reply maps to a typed error (never a crash, hang or leaked stream), and the back-end has a hostile-server test for it.
   - From: run
   - Evidence: FEATURE-1 sdlc/gate.attacks-refuted sent work back 2 times (sdlc-engine insights: gate.reworked:sdlc/gate.attacks-refuted)
   - Evidence: FEATURE-1 hotspots: malformed server replies (high), stream teardown (high), session lifecycle (high); attacks ATK-11, ATK-20, ATK-21, ATK-24
   - Evidence: test/adversarial/hostile-sftp-replies.test.ts, test/adversarial/stream-integrity.test.ts, test/adversarial/fix-variants.test.ts
4. [security] Server-supplied text (status messages, banners, file names) placed in an error message or log is sanitised: C0/C1 control characters, DEL and Unicode format characters (bidi overrides U+202A-U+202E, U+2066-U+2069, separators U+2028/U+2029) are escaped.
   - From: review
   - Evidence: FEATURE-1 design pre-mortem: 'G-4 escapes C0/C1 control characters and DEL but not Unicode bidi overrides or other invisible format characters (U+202A-U+202E, U+2066-U+2069).'
   - Evidence: FEATURE-1 code review (security): 'sanitizeServerText ... passes Unicode format characters (bidi overrides ..., line/paragraph separators U+2028/U+2029)'
5. [comments] A change that alters a value, module or rule recorded in the work item's design.md or in a doc comment updates that record in the same change.
   - From: review
   - Evidence: FEATURE-1 code review: 'CHUNK_SIZE changed from 32 KiB to 31 KiB, but the WINDOW doc comment still says at most 512 KiB in flight (it is 496 KiB).'
   - Evidence: FEATURE-1 code review (maintainability/architecture): 'design.md: the module table and the chunk-size rule (min(32 KiB, server max)) do not record entries.ts, CHUNK_SIZE = 31 KiB'
