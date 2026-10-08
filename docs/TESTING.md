# Verification and evidence

## Local gate

The latest verification gate ran on Node 26.3.1/Linux on 2026-10-08, including the new live-credential tests. The original 90-test suite passed on Node 24.21.0/Linux on 2026-10-07 after implementation, simplification, review fixes, and the live-test diagnostic improvement:

```sh
npm run verify
```

Build and workspace typecheck passed. The current test suite passed **93/93** with zero failures:

| Area | Tests |
| --- | ---: |
| Core state machine and contracts | 30 |
| SQLite storage | 14 |
| Runtime configuration | 7 |
| Worker lifecycle and Pi SDK behavior | 23 |
| MCP server, CLI, recovery, and broker behavior | 11 |
| Pi host extension, live-test diagnostics, and credentials | 8 |
| **Total** | **93** |

The runtime and worker tests use loopback/fake provider and MCP fixtures unless a test is explicitly described below as live. Normal `npm test` makes no external model call. No separate lint command is configured. The local workspace remains private and unpublished.

On 2026-10-07, a scan of 95 project and generated files found zero occurrences of the temporary provider key.

Local package checks passed. `npm pack` produced all three package archives with compiled JavaScript, declarations, and core wire schemas, while excluding tests, source, and `node_modules`. A fresh external temporary project installed all three archives (132 dependencies); Node loaded the installed core and Pi extension, the Pi config resolved the installed runtime CLI, and an installed runtime process exposed eight MCP tools and returned protocol version `0.1`. The installed npm executable returned `0.1.0` for `--version`. No package was published.

## Test-first evidence

The temporary implementation receipts recorded observed REDs before fixes; they do not claim every passing test had a corresponding failing run. Examples:

- Core: repeated stop of an already completed run incorrectly returned `stale_run`; a controlled worker echo showed a model key could enter output; shutdown was initially absent; and a peer broker could enqueue work against another broker's active child. Tests exposed these cases before the relevant fixes.
- Storage/config: the initial suites could not load the missing store and artifact modules. Later behavioral REDs caught duplicate artifact writes, queued work left behind after unconfirmed worker exit, and missing atomic generation checks.
- Worker/runtime: a compiled import attempted to start a TypeScript child file that was not emitted by the build; a malicious provider echo reached the persisted Pi transcript in an early worker implementation; and runtime process tests initially had no CLI to connect to.
- Pi package: the initial focused test could not import the missing extension entrypoint. The passing host test then exercised Pi against local fixtures through the real extension and MCP process.

The final fixes include two-phase resume: `validateResume` reads and validates a snapshot without changing it, while `commitResume` atomically checks the observed owner generation before saving metadata. The worker-exit recovery receipts preserve process identity through the SQLite settle window and refuse to preempt a live or ambiguously owned process.

## Review closeout

Eight GPT-6 Luna reviewers completed the code review, followed by a validation pass. All eight retained findings were addressed:

The preceding simplification pass applied one quality change (selecting the first model with `find`) and one efficiency change (removing an unused text buffer). There were no reuse changes. One suggestion to remove an unused Store parameter was skipped because its small benefit did not justify interface churn. The final build, typecheck, and 90-test gate cover the applied changes.

| Finding | Change and verification |
| --- | --- |
| #1, #5: response contract drift | List and handled-error schemas match actual MCP structured output; conformance tests validate both. Unknown error codes normalize to the documented fallback. |
| #2: admission/event split | Started, queued, and successor events commit with their state changes. Three SQLite abort-trigger tests prove rollback and retry. |
| #3: uncertain initialization exit | A failed worker handle preserves exit uncertainty during shutdown; ownership is retained when exit cannot be confirmed. |
| #4: unresponsive control request | Control requests have a deadline and stop escalates to process-group cleanup. The controlled worker test also proves RUN is not limited by that deadline. |
| #6: false interruption notice | Ordinary checkpoint followups receive a truthful continuation notice. |
| #8: configured key in endpoint metadata | Runtime credential references reject the configured key in URLs, including encoded forms. Non-secret query parameters remain intact; this does not claim compatibility with every query-bearing provider endpoint. |
| #9: unavailable MCP grant | Initialization rejects a missing declared tool before model execution and reaps the MCP child. |

The separate archive smoke found that npm's symlinked executable skipped CLI startup. A regression test and real-path entrypoint check fixed it. A proposed extra skill-symlink test was rejected during review validation because no implementation defect was established; the containment guard remains in place.

The control-timeout test's initial RED was a missing controlled-worker entrypoint seam; the resulting fixture then verified bounded stop and unrestricted RUN behavior. That initial failure was not a measurement of an actual hung provider. Settlement-storage faults preserve the original ownership and queued successor through transaction rollback; continued broker availability during a storage fault is not claimed.

Three Luna implementation units applied the boundary findings (#1, #5, #8 and the CLI regression), atomic admission (#2), and worker findings (#3, #4, #6, #9). No retained finding remains unresolved.

## Live LongCat check

Two opt-in checks used the actual LongCat model service. These were run separately from the normal test suite:

1. The compiled engine used `https://opencode.ai/zen/go/v1`, model `longcat-2.5-preview-free`, and the `openai-completions` API. It wrote and read a file, closed and reopened the child, and recalled a completed checkpoint. A scan of seven generated files found no key material.
2. `packages/pi/test/live-pi.mjs` exercised the actual chain from parent Pi through the runtime MCP server to an actual LongCat child. The final run limited the parent to spawn and polling tools. The child wrote the exact requested file. The check observed ready database state, no remaining owner, a completed write event, a completed event with an artifact, a non-empty result, and a clean key scan of generated files and captured output. This passed again after the review fixes. Muse was not used.

An intermediate live run wrote the file but had no completed result; its exact cause could not be established after cleanup. This exposed a harness assumption: `ready` also covers idle failed/stopped runs. The harness now requires explicit completion, reports bounded sanitized failure diagnostics, and scans for key values before cleanup on failures as well. The improved final run passed.

The `.env`-based `npm run test:live` command passed on Node 26.3.1/Linux on 2026-10-08 using the previously supplied testing key. The key itself is kept only in the ignored local `.env` and is absent from `.env.example`.

The live script is opt-in and makes a real provider call. To reproduce the Pi-to-child check from a fresh clone on Linux:

```sh
npm ci
cp -n .env.example .env
# Edit .env and set OPENCODE_API_KEY to the provider key.
npm run verify
npm run test:live
```

Use Node.js 24.15 or newer. Dependencies are pinned by `package-lock.json`. `cp -n` preserves an existing local `.env`; on a fresh clone, edit the new file and set `OPENCODE_API_KEY`. The live test uses provider `opencode-go`, model `longcat-2.5-preview-free`, and URL `https://opencode.ai/zen/go/v1`. The same key is passed to the child by default. Set `SUBZERO_TEST_KEY` in `.env` only when the child needs a separate key; an explicit non-empty value overrides the parent key.

The test makes a real model request and has a 180 second timeout. Success prints the child ID after confirming that the child completed, emitted a completion artifact, and wrote `subzero-live-child.txt` with exactly `subzero-live-ok`. Captured output and generated files are scanned for either configured key; failure diagnostics are bounded and redact configured keys, and temporary files and processes are cleaned up. Provider availability and model responses can change, so identical model output is not guaranteed. The harness depends on Linux `/proc` process inspection and shell process cleanup; other operating systems have not been verified.

Keep `.env` in the repository root. It is ignored by Git. Do not source it into a shell or print its contents; `npm run test:live` asks Node to load it directly. `.env.example` contains variable names only. Normal `npm test` and `npm run verify` never load `.env` and make no external model call.

## Tested versions and limits

- Node.js 24.21.0/Linux qualified the original 90-test suite. Node.js 26.3.1/Linux passed the current 93-test suite and the `.env`-based live command. The runtime requires Node.js 24.15 or newer for `node:sqlite`.
- The worker dependency is pinned to Pi SDK 1.0.4 (and `pi-ai` 1.0.4). Pi 1.0.4 is the only host integration exercised.
- Codex, Claude Code, and OpenCode examples in [USAGE.md](USAGE.md) were checked against official configuration documentation. They are syntax examples; no host runtime compatibility test was performed for them.
- Linux process-group cleanup was verified for ordinary POSIX descendants. A descendant that deliberately starts a new session/process group is outside the guarantee. Other operating systems have not been tested.
- Workspace scoping and writer admission do not sandbox file access or constrain other processes running as the same OS user.

The detailed red/green receipts were temporary implementation artifacts and are not part of this checkout; representative observed failures and their fixes are summarized above. The runtime's persistent result artifacts are local files; there is no automatic artifact or transcript garbage collection.
