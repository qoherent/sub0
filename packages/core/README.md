# @subzero/core

The dependency-free TypeScript reference implementation for Subzero v1. It owns child and run state transitions, admission limits, followup queues, event cursors, and public request validation. The normative host wire schemas are in `schemas/`; they use `credentialRef`. The trusted core `ModelArgs` type uses a literal `key` only in process memory.

## Runtime seams

`createSubzero()` receives a `Store`, `EngineFactory`, template definitions, an injected clock, and injected ID generators. The core imports no Node, Pi, MCP SDK, SQLite, or worker package.

The Store methods that change admission or run state must be atomic across broker processes sharing a database:

- `createChild` persists the child, initial run, and initial event while claiming the child and workspace capacity in one transaction.
- `admitRun` either queues under the current owner or claims a ready child and its workspace capacity. When supplied, `expectedGeneration` must be checked in that transaction before admission, rejecting stale model/ownership observations with `busy`. It advances the owner generation when ownership changes and atomically inserts the corresponding `run_queued` or `run_started` event.
- `requestStop` compares `expectedRunId` under the same transaction and atomically clears queued runs, changes stop state, and inserts the initial `stop_requested` event. Repeated requests do not duplicate that event. An unconfirmed worker exit reports `recovery_required`, never terminal confirmation, and a newer active run is never changed.
- `settleRun` receives `workerExitConfirmed`. A false value records interruption while retaining the owner claim and last completed checkpoint. A true value may atomically advance the checkpoint and dispatch metadata for the next core-queued run or release ownership. The terminal event and any successor's `run_started` event belong to that same transaction.
- `validateResume` is read-only: it returns `busy` for a live owner and `recovery_required` while an old worker's exit is ambiguous. For a ready child it returns a snapshot and observed owner generation; after the checkpoint is validated, `commitResume(childId, expectedGeneration, model)` rechecks ownership and generation atomically before updating model metadata and advancing the generation. Neither operation receives a key.

`appendEvent` assigns monotonically increasing per-child sequence numbers. `readEvents` returns the oldest retained cursor and marks gaps. `subscribe` must watch persisted events so a second adapter can observe the owner broker's event stream.

The Store persists `ModelMetadata`, not `ModelArgs`. Trusted native callers must supply non-secret metadata, including the model URL. The runtime's credential-reference resolver additionally rejects URLs containing the configured key. The Store persists immutable template snapshots including resolved skill text and explicit MCP launch descriptors. MCP `envRefs` are references such as `env:NAME` or `secret:NAME`, never secret values.

`EngineFactory.open()` receives model metadata and the raw credential separately. It must hold the credential only in memory. `Worker.run()` yields sanitized progress and a terminal event; `completed` must include the final completed transcript checkpoint. Core closes each worker before settling/releasing its owner claim. A failed, stopped, interrupted, or unconfirmed worker never advances `lastCompletedLeaf`.

An `open()` rejection must mean no worker was started or its exit was confirmed. If cleanup cannot confirm exit, return a failed worker handle whose `close()` reports `exitConfirmed: false`, so ownership remains held for recovery.

The core owns followup queues. The Worker/Pi adapter must not add a second queue. The next run starts from the last completed checkpoint in a newly opened worker after the previous worker exits. Cross-broker get/list are supported; send/stop against another broker's live worker return `busy` because v1 has no control daemon.
