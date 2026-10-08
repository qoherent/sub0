# Subzero v0.1 reference specification and implementation record

Status: v0.1 TypeScript implementation and local M1–M3 gates have audit hardening. The [2026-10-08 audit](AUDIT-2026-10-08.md) is the current record of regression fixes, fresh setup, package/CLI/MCP checks, real LongCat evidence and unresolved risks. Packages remain private and unpublished. Pi 1.0.4 and 1.1.0 hosts have been exercised with the worker pinned to SDK 1.0.4; other host workflows remain untested. See [testing evidence](TESTING.md) for verified scope and limits.

## Goal

Give a parent coding agent a portable way to create and control durable child sessions in the shared code workspace.

## Architecture decisions

1. Define a language-neutral JSON Schema and conformance fixtures for the public contract; TypeScript is the reference implementation. Use a local MCP stdio server as the common host surface. Pi is first via a thin extension that registers that same server.
2. Run one broker process per active host MCP client/process. Do not add a global daemon, HTTP listener, ACP host facade, or arbitrary CLI worker providers in v1.
3. Split packages: @subzero/core owns contracts/orchestration; @subzero/runtime owns MCP, SQLite, and the Pi worker; @subzero/pi registers the same MCP server. The host adapter imports neither SQLite nor worker code.
4. The core owns child/run IDs, state, events, limits, queues, and routing. A per-child worker process owns its agent loop and durable transcript only while that child has active or queued runs. It closes when settled and idle. EOF cancels the worker and its tool subtree.
5. Require an explicit template ID. Built-in researcher and coder templates grant exact tool names; user-defined string template IDs are allowed. Templates include instructions, tools, skills[], and explicit MCP servers/tools[]. Nothing is inherited or discovered ambiently; no nested Subzero.
6. The core receives {url, model, key} on each spawn/resume in memory. MCP schemas expose a credential reference resolved by the Subzero runtime from explicitly configured environment/secret references. No raw key in prompts, results, logs, or persisted metadata.
7. Host adapter supplies the canonical workspace root. Children share the checkout; one write-capable Subzero run per workspace across broker processes. This does not control host/external writers and is not an OS sandbox.
8. Use SQLite metadata shared by broker processes. Store child identity, state, event cursor/tail, profile/grant snapshot, worker version/session reference, and owner generation. Worker owns the transcript/artifact. No automatic transcript/artifact GC.
9. Stop requires the expected runId, clears pending follow-ups, and distinguishes stop-requested from stop-confirmed. Resume without a message validates credentials/checkpoint and returns ready at the last completed transcript leaf. The ready session retains no worker process; a later followup reopens it using in-memory credentials until the broker exits. After restart, call resume with credentialRef again. With a message it starts a fresh run from that leaf. Preserve the interrupted branch and show that the working tree may include interrupted changes. Never auto-replay an interrupted prompt or effect.
10. Send has explicit steer or followup mode. Unsupported requested steering rejects; it never silently changes into a queue. Followup starts when idle and queues a new run when busy.
11. Provide info, native subscribe, and bounded get(childId, waitMs, cursor) for adapters. MCP exposes polling and results; no unsolicited parent model call. MCP Tasks remain optional.
12. Pin the Pi SDK worker dependency to 1.0.4. Maintain explicit host/worker tested-version data; never promise wildcard compatibility or best-effort session mutation across versions.
13. Node 24.15+ is required only for the stdio sidecar's node:sqlite storage adapter. Node 24.21 file-backed WAL transaction smoke passed; node:sqlite remains Release Candidate.

## Public contract outline

- info() returns protocol/core/worker versions, templates, and capability matrix.
- spawn(prompt, templateId, modelArgs, workspaceRoot) returns {childId, runId}.
- get(childId, waitMs?, cursor?) returns state, bounded new events, and result/artifact reference.
- subscribe(childId, cursor?) yields core events to native adapters.
- list(workspace?) returns child summaries discoverable after restart.
- send(childId, mode, message) where mode is steer or followup; return actual runId/delivery.
- stop(childId, expectedRunId) requests cancellation for exactly that run.
- resume(childId, modelArgs, message?) validates credentials/checkpoint and returns ready if no message; otherwise starts a fresh run from the last completed transcript leaf.

## Ordered implementation milestones

1. M1: publish JSON Schemas and conformance fixtures; implement the TypeScript reference core, SQLite metadata, session/run state machine, exact template snapshots, and safe cursor/event contract.
2. M2: implement @subzero/runtime with the per-child Pi SDK 1.0.4 process, credential-reference resolution, EOF subtree cleanup, last-completed-leaf recovery, and local artifacts.
3. M3: implement @subzero/pi registration, host MCP setup guides, explicit tested-version table, package build/release checks, and a full Pi-to-Subzero end-to-end gate.

## Required gates

- Same child ID is discoverable after broker restart; no auto-replay.
- Two brokers sharing the workspace cannot resume the same child or run concurrent Subzero writes.
- Stop with a stale runId never cancels a later run; stop-confirmed follows worker confirmation.
- EOF cancels the child worker and its tool subprocess tree.
- Template snapshot cannot gain tools, skills, or MCP servers during resume.
- Raw model keys never enter MCP tool arguments/results, event rows, logs, or persistent metadata.
- Full results are stored in worker-owned local artifacts; MCP output stays bounded and identifies the artifact.
- Pi worker: 1.0.4 dependency pinned; all nine worker behavior checks pass, including partial tool-call abort and safe branch resume. This is worker qualification, not a Subzero end-to-end gate.
- Host compatibility is recorded in a tested-version table; no wildcard version claim.

## Not in v1

Global daemon, remote HTTP service, arbitrary CLI workers, Subzero as an ACP-facing host agent, unsolicited background callbacks, general approval broker, worktree isolation, OS sandbox claims, Deno runtime support, and automatic deletion of child transcripts/artifacts.
