# Token-Efficient Subagent Subscription and Background Task Architecture Plan

## 1. Overview & Context

This document captures the diagnosis, external architectural research, and multi-tier implementation plan for eliminating context token bloat in Subzero's subagent interactions. It serves as the primary artifact for plan review.

For the full session handoff metadata, see `/tmp/compound-engineering-1000/ce-handoff/subzero-429b2625/token-efficient-subagents-plan.md`.

---

## 2. Problem Statement: Polling Token Explosion

Currently, parent agents (like Pi or Claude Code) interact with Subzero subagents by calling `subzero_spawn`, followed by a polling loop on `subzero_get({ childId, waitMs: 10000 })`.

### Root Causes
1. **Unfiltered Token Delta Streaming** (`packages/runtime/src/engine/worker-child.ts`): The child worker emits every single token delta over IPC stdio.
2. **SQLite Event Stream Pollution** (`packages/core/src/index.ts`): The broker's `pump()` loop appends every token delta as an individual row in SQLite's `events` table.
3. **Premature Unblocking in `subzero_get`** (`packages/runtime/src/store.ts` & `packages/core/src/index.ts`): `store.subscribe()` wakes up immediately whenever *any* event row is inserted. A single 5-character token delta resolves `iterator.next()` within 10–30 ms, completely ignoring the requested `waitMs: 10000`.
4. **Flawed Model Guidance** (`AGENTS.md` & `docs/DESIGN.md`): Prompt guidelines instruct models to repeatedly poll `subzero_get`.

### Token Cost
* Over a 60-second subagent task, the parent LLM performs **30–50 round-trip turns**.
* Each turn introduces ~400–600 tokens of JSON frames into the conversation history.
* Cumulative token cost scales quadratically ($O(N^2)$), consuming **350k–770k+ context tokens** for a single subagent run.

---

## 3. Findings from External Architectures

### A. OpenAI Codex CLI (`codex-cli 0.161.0`)
1. **Thread Isolation**: Subagents execute in dedicated threads (`agent_thread_id`). Intermediate tool outputs and reasoning remain in local thread storage and never enter parent conversation history.
2. **UI Activity Items (`SubAgentActivityItem`)**: Tool events stream directly to the terminal TUI widgets (`subAgentActivity`). The user sees live status updates, but the model receives **zero prompt tokens**.
3. **Delegation Protocol**: Four tools (`spawn_agent`, `wait_agent`, `close_agent`, `resume_agent`).
4. **Anti-Polling Guidance**: Prompt explicitly instructs the model: *"Call `wait_agent` very sparingly. Only call `wait_agent` when you need the result immediately for the next critical-path step... Do not repeatedly wait by reflex."*
5. **Completion Delivery**: Delivers only `Agent Final Message: <summary>` upon completion.

### B. Hermes Agent Framework (`tools/delegate_tool.py`)
1. **Core Invariant**: *"The parent only ever sees the delegation call and the summary result, never the child's intermediate tool calls or reasoning."*
2. **Synchronous Mode (`background=False`)**: Tool call blocks on the host while the child executes. Progress is rendered to terminal stdout via callbacks. When finished, returns only `{"status": "completed", "summary": "...", "artifacts": [...]}`. **Cost: exactly 1 tool call + 1 tool result turn.**
3. **Asynchronous Mode (`background=True`)**: Dispatches the child to a background thread pool and immediately returns `{"status": "dispatched"}` (~35 tokens). A background completion registry wakes the parent LLM via an idle turn hook when the child settles.

### C. Pi Framework (`@earendil-works/pi-coding-agent`)
1. **Native MCP Progress Forwarding**: Pi's built-in MCP client registers an `onProgress` handler on tool calls and pipes it to `onUpdate()`. Standard MCP `notifications/progress` stream live UI updates to the user with **zero conversation tokens**, while resetting client request timeouts.
2. **Reactive Wakeup (`pi.sendMessage`)**:
   - Idle agent: `pi.sendMessage({ customType: "subzero_notification", content: "..." }, { triggerTurn: true })` starts a new LLM turn immediately without user input.
   - Streaming agent: passing `{ triggerTurn: true, deliverAs: "followUp" }` schedules the notification as the immediate subsequent turn.
   *(Note: `deliverAs: "nextTurn"` must not be used for agent wakeups, as it delays the message until the human user types their next prompt).*
3. **Session Audit Logging (`pi.appendEntry`)**: `pi.appendEntry(customType, data)` writes structured run metrics into the session JSONL file without entering LLM context.

---

## 4. Proposed Architectural Plan

### Tier 1: Agnostic Core & MCP Protocol Enhancements (All Hosts)

1. **Core Stream Separation**:
   - In `packages/core/src/index.ts` (`emitWorkerEvent`), stop appending `event.type === 'text'` into the SQLite `events` table.
   - Text deltas are saved in the child's session file and artifact buffer, but excluded from the subscription event log that wakes `store.subscribe()`.
   - SQLite `events` records only lifecycle milestones (`run_started`, `tool`, `completed`, `failed`, `stopped`).

2. **Add `subzero_run` (One-Shot Synchronous Tool)**:
   - **Schema** (`packages/core/schemas/wire-operations.schema.json`): Accepts `prompt`, `templateId`, `model`, and optional `timeoutMs`.
   - **Runtime Handler** (`packages/runtime/src/server.ts`):
     - Spawns the child worker via `application.spawn()`.
     - Extracts `_meta.progressToken` from the incoming MCP request context.
     - When the child emits tool execution events, emits standard MCP progress notifications (`notifications/progress`).
     - Awaits child terminal settlement (`completed`, `failed`, `stopped`).
     - Returns final structured output directly:
       ```json
       {
         "status": "completed",
         "childId": "...",
         "runId": "...",
         "result": { "preview": "...", "artifactId": "..." }
       }
       ```
   - **Token Impact**: Replaces 30–50 polling turns with **exactly 1 tool call + 1 tool result turn (>99.7% token reduction)**.

3. **Upgrade `subzero_get` with Level Filtering**:
   - Add parameter `level?: "terminal" | "milestone"` (default: `"terminal"`).
   - In `packages/core/src/index.ts` (`readSnapshot`), when `level === "terminal"`, sleep until `child.state !== 'running'` or timeout. Omit intermediate text chunks from the returned `events` array.

---

### Tier 2: Dedicated Pi Extension Enhancements (`@subzero/pi`)

1. **Automatic MCP Progress Forwarding**:
   Because `subzero_run` emits MCP `notifications/progress`, Pi's existing MCP client automatically forwards milestones to `onUpdate()`. The human user sees an animated spinner and live tool execution details in the terminal with zero prompt tokens.

2. **Reactive Background Wakeup for `subzero_spawn`**:
   For tasks spawned asynchronously, the extension registers a background watcher:
   - When the child reaches terminal status in SQLite:
     ```typescript
     const isStreaming = pi.isStreaming;
     pi.sendMessage({
       customType: 'subzero_notification',
       content: `<subagent_notification childId="${childId}" status="${status}">\n${preview}\n</subagent_notification>`,
       display: true,
     }, {
       triggerTurn: true,
       ...(isStreaming ? { deliverAs: 'followUp' } : {})
     });
     ```
   - Eliminates polling loops completely.

3. **Session Audit Logging**:
   Call `pi.appendEntry('subzero_run', runStats)` so the user can inspect full subagent metrics in the transcript without polluting LLM tokens.

---

### Tier 3: Model Instruction Updates (`AGENTS.md`)

Update `AGENTS.md` to establish synchronous execution as default:
```markdown
# Subagent Delegation with Subzero

1. **Synchronous Delegation (Default)**:
   - Call `mcp__subzero__subzero_run` with `prompt`, `templateId`, and default model settings.
   - The tool blocks until completion and returns the final summary and artifact ID in a single turn. Do NOT poll.

2. **Asynchronous Delegation (Parallel Tasks Only)**:
   - Call `mcp__subzero__subzero_spawn` only when running background work in parallel.
   - Do NOT poll `subzero_get` by reflex. Continue other work; Subzero will notify you automatically when the run settles.
```

---

## 5. Reviewer Decision Points

1. **MCP Client Request Timeouts**:
   - What should `subzero_run` do if an MCP host enforces a hard wall-clock timeout (e.g., 60 seconds)?
   - *Option A*: Block with progress notifications (resets timeout in spec-compliant clients).
   - *Option B*: If approaching a client deadline (e.g., 50s), return `{ status: "running", childId, resumeWith: "subzero_wait" }`.
2. **Event Stream Retention vs Complete Omission of Text Deltas**:
   - Should text deltas be omitted entirely from the SQLite `events` table, or written to a separate `text_chunks` table that is ignored by subscription queries?
3. **Recovery for Disconnected Background Runs in Pi**:
   - Should `@subzero/pi` perform an orphan sweep on `session_start` to inject any completed results that finished while Pi was offline?

---

## 6. Verification Plan

1. **Offline Verification Gate**: Must pass `npm run verify` (128+ tests passing).
2. **Progress & Token Benchmark**: Assert that a 10-turn child subagent run dispatched via `subzero_run` generates exactly 1 tool call and 1 tool response, with 0 intermediate polling turns.
3. **Live Pi Delegation Verification**: Run live OpenCode Go test via `./demo.sh` to confirm `subzero_run` streams terminal progress to Pi's TUI and completes with 0 token leaks.
