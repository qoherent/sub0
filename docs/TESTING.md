# Verification

## Full gate

```sh
npm run verify
```

This builds every package, typechecks the workspace and runs the offline suite with Node's test runner. It uses loopback providers and fixtures, loads no `.env` and makes no external model call. There is no separate lint command. Run `npm run build` before any standalone `npm test` or single test file, because package exports resolve to compiled JavaScript even under the development condition. A single file can be run with `node --conditions=development --test <file>`.

Last recorded full gate: 2026-10-13, after the documentation and prototype cleanup, 155/155 passing with build and typecheck clean, on Node v26.3.1/Linux with host and worker both at Pi 1.2.0. This is a dated receipt; rerun the gate to validate a later checkout.

## Test areas

| Area | Files |
| --- | --- |
| Core state machine, limits, queues, contracts | `packages/core/test/core.test.ts` |
| SQLite storage, generation-guarded state | `packages/runtime/test/storage.test.ts` |
| Runtime config and credential resolution | `packages/runtime/test/config.test.ts` |
| Worker lifecycle, redaction, privacy, checkpoints, MCP bridge, cancellation, process cleanup | `packages/runtime/test/worker.test.ts` |
| MCP server, CLI, recovery, broker behavior | `packages/runtime/test/mcp.test.ts` |
| Packaging and entrypoints | `packages/runtime/test/packaging.test.ts` |
| Pi host extension and real-host matrix | `packages/pi/test/pi.test.ts` |
| Live-test diagnostics and credential loading | `packages/pi/test/live-pi-*.test.mjs` |

The worker tests cover exact version and checkpoint refusal with stored state preserved, secret redaction in events, transcripts and artifacts, exact tool grants, MCP tool bridging, and stop cancellation reaching an in-flight MCP call.

## Pi host matrix

`packages/pi/test/pi.test.ts` runs Pi's JavaScript CLI in controlled print/JSON mode against loopback providers, with isolated agent, data and workspace directories. Cases: direct MCP tools, `codemode` on, `codemode` only, and a handled `credentials_required` result. Every case asserts one parent round trip, the bounded `subzero_delegation` section in each parent request, and worker and runtime exit. The completed cases additionally assert non-empty nested run progress that never appears in parent model messages, the exact child file effect, the persisted run and artifact, 12 controlled child requests, and no parent guide in child requests. The handled credentials error case asserts no admitted child, no child request and no file effect. Linux only.

```sh
npm run build
node --conditions=development --test packages/pi/test/pi.test.ts
```

Only the latest Pi release, currently 1.2.0, is supported. The repository's installed Pi CLI runs by default. `SUBZERO_TEST_PI_CLI` points the test at another installation of the same release:

```sh
SUBZERO_TEST_PI_CLI="/absolute/path/to/pi/dist/bundle/cli.js" node --conditions=development --test packages/pi/test/pi.test.ts
```

The path must be absolute and the CLI must answer `--version` within 5 seconds with exactly the `@earendil-works/pi-coding-agent` version pinned in `packages/pi/package.json`. A relative, missing, hung or differently versioned CLI fails with an explicit error; there is no fallback and no older-version lane. Each host test reports the actual version as a test diagnostic.

## Live provider check (opt-in)

`npm run test:live` builds the workspace and runs `packages/pi/test/live-pi.mjs` against a real provider. It is never part of `verify` and makes a real model request with a 180 second timeout.

```sh
npm ci
cp -n .env.example .env
# Edit .env and set OPENCODE_API_KEY to the provider key.
npm run verify
npm run test:live
```

Keep `.env` in the repository root; Git ignores it. Do not source it into a shell or print it: the command asks Node to load it directly. `.env.example` has variable names only. The child key defaults to the parent key; `SUBZERO_TEST_KEY` is an optional separate override. The test uses provider `opencode-go`, model `longcat-2.5-preview-free` and URL `https://opencode.ai/zen/go/v1`.

Success requires a completed child run with an artifact, `subzero-live-child.txt` containing exactly `subzero-live-ok`, ready state with released ownership, and a clean scan of generated files and captured output for the configured keys. Set `SUBZERO_TEST_KEEP_ARTIFACTS=1` to retain artifacts after a passing run. Provider availability and responses vary. The harness uses Linux `/proc` inspection. No live provider run is recorded against the latest-only Pi 1.2.0 setup.

## Observation benchmark (optional)

```sh
node --experimental-strip-types packages/pi/test/observation-benchmark.mjs
```

It compares the baseline and candidate cores on the same synthetic controller calls and serialized JSON bytes. It needs the baseline git object and fails rather than substituting an imitation. It does not measure MCP transport bytes, model token billing or production latency.

## Not qualified

TUI, RPC and reload modes; custom-triggered runtime turns; other hosts (Codex, Claude Code, OpenCode); non-Linux platforms; deliberately detached descendants outside the worker process group; context-window limits; and any background wakeup of the parent.

## Historical evidence

Earlier milestone counts, review narratives, benchmark data and measurements, recorded against older Pi SDKs, are retained in the [implementation report](reports/2026-10-09-token-efficient-subagents-implementation.md) and its benchmark JSON. They are evidence of that point in time, not support promises or validation of the current checkout.
