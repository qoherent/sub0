# Subagent delegation with Subzero

Subzero exposes nine MCP tools: `subzero_info`, `subzero_spawn`, `subzero_run`, `subzero_get`, `subzero_list`, `subzero_send`, `subzero_stop`, `subzero_resume`, and `subzero_output`.

## Delegation contract

Every delegated prompt must state the task scope and requested effect, the allowed actions (including whether edits or commands are allowed), acceptance checks, and the evidence the child must return. For code work, name the files or paths in scope and ask for exact commands, exit outcomes, and relevant evidence paths. Ask children to label checks they did not run or that failed.

Before accepting a task as successful, inspect the requested effect or changed artifact and compare it with the acceptance checks. Review relevant evidence and actual test/build/command outcomes. A `ready` child, process exit, completed event, or success claim in model prose alone does not prove the requested effect. Do not report unsupported success; state unrun and failed checks plainly.

## Run and observe

Prefer `subzero_run` for one bounded dispatch-and-wait call. It defaults to a 30-second wait and returns that call's `childId`, `runId`, status, `waitExpired`, and any run-specific result or error. If it returns unsettled, continue with `subzero_get` for that same `childId` and `runId`; run-specific `get` defaults to `waitMs: 0`, so request a bounded wait when desired. Never substitute the child's latest result for the requested run.

The run snapshot has only that run's status, result, error code, and wait-expiry metadata; it does not include child events. Child-only `subzero_get` remains available for explicit child inspection and cursor-based events. Worker text is not added as new per-token event rows; older persisted text rows can remain visible while retained. Request full output only when needed, by calling `subzero_output` with the returned artifact ID and explicit bounded `offset` and `length` chunks.

There is no automatic redispatch or promised unsolicited host wakeup. A wait deadline or request abort detaches observation; it does not stop accepted work. Use `subzero_stop` with the exact active run ID to request cancellation. A stop during local worker initialization records the request and prevents execution if the worker opens later. Treat stop as confirmed only when Subzero proves cleanup. Broker loss shuts down its supervised workers and may interrupt the run; inspect the run outcome before reporting success.

## Model and template defaults

Honor explicit user model, endpoint, API, credential-reference, or route choices. Otherwise use the Subzero defaults:

- `url`: `https://opencode.ai/zen/go/v1`
- `model`: `longcat-2.5-preview-free`
- `credentialRef`: `longcat`
- template: `researcher` for investigation and read-only analysis; `coder` for edits, commands, and tests

The MCP model accepts an optional `api` value. Do not place a raw key in a prompt or MCP argument. The host-visible model uses a configured credential reference.

## Pi version policy

Support only the latest published stable Pi release. Resolve npm's latest tag when upgrading, then pin that verified version exactly in active Pi manifests and lockfiles. Do not add older-version test matrices, compatibility shims or fallback SDKs. Historical verification receipts are evidence, not support promises. Preserve incompatible stored sessions and refuse them; do not delete or migrate them automatically.
