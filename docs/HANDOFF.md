---
artifact_contract: "ce-handoff/v1"
created_at: "2026-10-13T19:59:01Z"
title: "Subzero Pi-first continuation"
summary: "Latest-only Pi 1.2.0, verified delegation and cancellation, cleaned documentation, and remaining integration work."
keywords: ["subzero", "pi-first", "latest-only", "codemode", "handoff"]
cwd: "/home/mahmoud/Desktop/AI_Projects/qoherent/subzero"
repository: "subzero"
repo_root_sha: "429b2625a2a6b111f880859bba5506c69c0d9cdf"
branch: "feat/token-efficient-subagents"
head: "dce84c1439f27454a90cc996dc55e9c23cceb041"
resume_focus: "Continue Pi-first integration qualification, then settle child context limits and background observation."
---

# Handoff

## Current state

Subzero is a private npm workspace: protocol 0.2, package version 0.2.0, Node 24.15+. Host and worker dependencies are exact-pinned to Pi 1.2.0, verified as npm's latest release on 2026-10-13. The core remains host-neutral; Pi is the first delivery target.

**All changes are local and uncommitted.** HEAD predates the implementation in the working tree. Modified files, approved deletions, untracked conformance fixtures, the observation benchmark and historical reports are part of this state. A fresh clone will not contain them until they are committed or transferred. No commit or push was requested. Recheck current Git status before proceeding.

## User decisions

- Latest Pi only: no older-version matrix, fallback SDK or compatibility shim. Resolve the current npm latest tag for future upgrades, then pin and test that exact version rather than use floating ranges.
- Pi-first subagents, small tested increments, concise docs and an organized codebase.
- Use Hermes for heavy upstream research. The local `.agents/skills/hermes-subagent/SKILL.md` restricts Hermes to online research, not local coding; this ignored helper is machine-local and may be absent in a clone.
- The user approved the specific prototype/plan/review deletions and chose this repository handoff. `vision.md` is human-owned and was kept unchanged.

## Completed

- Durable exact-run observation, bounded `subzero_run`, run-specific `get`, compact results, active-request progress, and no new per-token event rows.
- Fixed custom MCP cancellation: Pi passes the AbortSignal as `execute` argument three. The bridge now forwards it and uses the SDK's `ToolDefinition` type. A permanent regression failed before the fix and passed after it.
- Packaged a bounded static `subzero_delegation` parent prompt section via `before_agent_start`; it preserves other sections and is not implicitly inherited by children.
- Repeatable latest-host tests cover direct MCP calls, codemode `on`/`only`, handled credential errors, file/run/artifact identity, progress isolation and process exit. A CLI override accepts only another installation of the same pinned release.
- User-confirmed cleanup removed `experiments/`, the superseded token-efficiency plan and its planning-review report. The Pi test no longer depends on the retired prototype. No active runtime API or safety guard was removed.
- Active docs are concise; `docs/PLAN.md` remains a short pointer because `vision.md` links it. Historical implementation evidence, benchmark JSON and the runnable benchmark are retained separately.

## Source pointers

Repository paths below are relative to the captured root.

- `AGENTS.md`: delegation acceptance contract, model defaults, latest-only policy and secret-handling rules.
- `README.md`, `docs/DESIGN.md`, `docs/USAGE.md`, `docs/TESTING.md`: entry point, current contract, setup/tool workflow and verification commands. Historical receipts are not current compatibility promises.
- `packages/core/src/index.ts` and `packages/core/src/types.ts`: exact-run waiting, follow-up ownership, stop semantics and Store/EngineFactory seams. Wire schemas and fixtures under `packages/core/` remain normative.
- `packages/runtime/src/store.ts` and `packages/runtime/src/application.ts`: atomic state/event transitions, generation claims, canonical workspace checks and conservative recovery.
- `packages/runtime/src/engine/pi-engine.ts`: supervised process groups, exact SDK/checkpoint guards and proven-exit handling. `packages/runtime/src/engine/worker-child.ts`: model loop, explicit grants, redaction and corrected MCP signal forwarding.
- `packages/pi/src/index.ts` and `packages/pi/test/pi.test.ts`: thin MCP registration, parent guide, latest CLI selector and direct/codemode qualification.
- `packages/runtime/test/worker.test.ts` and `packages/runtime/test/mcp.test.ts`: cancellation, privacy, checkpoint/interruption, request-budget and broker-loss regressions.
- `docs/reports/2026-10-09-token-efficient-subagents-implementation.md` and `docs/reports/2026-10-09-token-efficient-subagents-benchmark.json`: frozen historical evidence. `packages/pi/test/observation-benchmark.mjs` compares actual core implementations; it is not an LLM billing benchmark.

## Verification

After the cleanup, `npm run verify` exited 0: **155/155 passed**, build/typecheck clean, no failures, cancellations or skips, Node v26.3.1/Linux, latest Pi 1.2.0 host and worker. Only documentation clarification and this handoff were added afterward.

The Pi file-level suite passed 8/8. `npm run typecheck -- --noUnusedLocals --noUnusedParameters` also passed; this is not proof that every exported API is unused or removable. No latest real-provider call or benchmark rerun was made in this session.

Machine-local evidence: `/tmp/subzero-audit.0dsFsv/cleanup-final/verify.log`; earlier RED/GREEN and upgrade receipts are siblings under that temporary root. `/tmp` is OS-managed, not a durable dependency. Test fixtures were cleaned up; no task-owned servers remain. `.env` is ignored/private and was neither read nor printed.

## Remaining work

These are open topics, not an approved implementation plan. The suggested next small increment is latest-Pi TUI/RPC, reload/session replacement and custom-triggered runtime qualification; current evidence covers controlled print/JSON mode only. Other hosts and non-Linux platforms remain unqualified.

Child context policy is unresolved: unknown models currently receive 128,000 context / 8,192 output metadata in `worker-child.ts`, and compaction is disabled. Those defaults have not been qualified for arbitrary models or long-lived conversations.

Automatic parent completion delivery remains deferred. `ctx.executeTool()` is scoped to tool execution; it is not a public idle observer for the registered MCP connection. No private Pi imports, second broker, direct SQLite watcher, automatic redispatch or detached execution was introduced. Lost dispatch responses remain ambiguous without caller admission idempotency.

`pi-durable` remains a separate experimental concept source, not an adopted runtime. Owned tasks, request IDs and replay policies would overlap with Subzero's current queue/recovery ownership. Codemode `on` retains direct declarations; `only` hides callable direct declarations but can leave model-only tools. Neither mode proves zero schema/context overhead or billing savings.

## Existing boundaries

The current SDK guard preserves and refuses incompatible checkpoints; there is no automatic migration or effect replay. A ready child is not proof that its requested run succeeded. Observation abort is not explicit child stop; broker loss can interrupt accepted work. Ownership cannot be reclaimed from PID/TTL alone. Workspace admission serializes Subzero writers sharing a database, not the parent or other OS processes. This is not an OS sandbox, and detached process groups are outside the tested cleanup guarantee.
