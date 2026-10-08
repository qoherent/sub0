# Subzero

Subzero is a local MCP service that lets coding agents spawn and control persistent subagents. Children run in isolated Pi SDK worker processes while the parent agent retains its own clean conversation. `@subzero/pi` is a thin extension connecting Pi to the service; other MCP-capable coding agents (Codex, Claude Code, OpenCode) configure the same local MCP server executable.

```mermaid
flowchart TB
  subgraph HOSTS["1. Host Coding Agents (Parent Sessions)"]
    Pi["Pi Coding Agent<br/><code>@subzero/pi</code> extension"]
    Codex["Codex CLI / IDE<br/>MCP stdio client"]
    Claude["Claude Code<br/>MCP stdio client"]
    OpenCode["OpenCode<br/>MCP stdio client"]
  end

  subgraph TRANSPORT["2. MCP Stdio Transport"]
    Broker["Local MCP Stdio Server<br/><code>@subzero/runtime (cli.js)</code>"]
  end

  subgraph METHODS["Subagent Lifecycle Methods (MCP Tools)"]
    direction TB
    M_Spawn["<code>subzero_spawn</code><br/>Spawn child & start initial run"]
    M_Get["<code>subzero_get</code><br/>Bounded poll & cursor event stream"]
    M_Send["<code>subzero_send</code><br/>Steer active run or queue followup"]
    M_Stop["<code>subzero_stop</code><br/>Idempotent stop & process cleanup"]
    M_Resume["<code>subzero_resume</code><br/>Branch from last completed leaf"]
    M_Output["<code>subzero_output</code><br/>Read full result artifact chunks"]
    M_List["<code>subzero_list</code><br/>Discover children across restarts"]
  end

  subgraph CORE["3. Core Orchestration Layer (@subzero/core)"]
    direction TB
    StateMachine["State Machine & Admission<br/>Ready | Running | Interrupted"]
    QueueMgr["Followup Queue & Event Cursors"]
    Templates["Template Snapshots<br/>researcher | coder (Immutable)"]
  end

  subgraph RUNTIME["4. Runtime & Persistence Layer (@subzero/runtime)"]
    direction TB
    SQLiteDB[("SQLite Database (node:sqlite)<br/>Metadata, Run State & Monotonic Generations")]
    CredResolver["In-Memory Credential Resolver<br/>Maps alias to key (never persisted)"]
    ArtifactStore["Local Artifact Storage<br/>Full results stored on disk"]
  end

  subgraph WORKER["5. Isolated Worker Process (Pi SDK 1.0.4)"]
    direction TB
    PiWorker["Child Agent Worker Loop<br/>Runs ONLY during active/queued work"]
    PrivateTranscript["Private Child Transcript<br/>Never pollutes parent context"]
    ExactTools["Exact Granted Tools<br/>Read / Write / Shell (No ambient host tools)"]
  end

  subgraph EDGES["⚡ What Edges Us (Architectural & Security Advantages)"]
    direction TB
    Edge1["<b>Clean Separate Conversations</b><br/>Parent context stays clean; child runs private loop in isolated process"]
    Edge2["<b>Stateful Stream Redaction</b><br/>Keys split across tokens, tool arguments, or property keys redacted"]
    Edge3["<b>SQLite Generation Guarding</b><br/>Atomic transactions + monotonic generations prevent race & split-brain"]
    Edge4["<b>Process Group Confinement</b><br/>EOF/SIGKILL reaps worker & all POSIX shell descendants within 5s"]
    Edge5["<b>Zero Ambient Grants</b><br/>No host secrets or tools leaked; immutable least-privilege templates"]
  end

  Pi -->|MCP stdio| Broker
  Codex -->|MCP stdio| Broker
  Claude -->|MCP stdio| Broker
  OpenCode -->|MCP stdio| Broker

  Broker --> METHODS
  METHODS --> StateMachine
  StateMachine --> QueueMgr
  QueueMgr --> Templates

  CORE --> RUNTIME
  RUNTIME -->|Supervised Process Fork| PiWorker
  RUNTIME <--> SQLiteDB

  PiWorker -.->|Protected by| EDGES
  CORE -.->|Enforces| EDGES
```

---

## The Design Stack

1. **Host Layer**: The parent agent (Pi, Codex, Claude Code, OpenCode) maintains its primary conversation and calls Subzero via standard MCP tools.
2. **Transport Layer**: A single local stdio MCP server per active host session (`@subzero/runtime`). No background daemons, listening ports, or network attack surface.
3. **Core Orchestration (`@subzero/core`)**: Dependency-free TypeScript engine enforcing the state machine, admission limits, follow-up queues, immutable template snapshots, and monotonic event cursors.
4. **Runtime & Storage (`@subzero/runtime`)**: Uses Node 24.15+ `node:sqlite` for transactional state, manages in-memory credential resolution, and stores large tool/result artifacts on disk.
5. **Worker Execution**: Supervised per-child worker processes (`@earendil-works/pi-coding-agent` v1.0.4). Workers exist only while work is active or queued, shutting down when idle to free resources.

---

## Subagent Lifecycle Methods

The MCP server exposes eight dedicated tools:

| Method | Role | Description |
|---|---|---|
| `subzero_spawn` | Lifecycle | Spawns a durable child session and starts its initial run with prompt, template, and model credential reference. |
| `subzero_get` | Observation | Bounded long-poll returning state (`ready`, `running`, `interrupted`), monotonic events, next cursor, and artifact pointers. |
| `subzero_send` | Interaction | Sends instructions to a child: mode `steer` modifies the active run; mode `followup` queues or starts a new run. |
| `subzero_stop` | Control | Idempotently stops `expectedRunId`, cancels queued work, and verifies process-group exit. |
| `subzero_resume` | Recovery | Restores a child after restart or idle. Read-only checkpoint check without message; branches a fresh run from the last completed leaf if message provided. |
| `subzero_output` | Artifacts | Streams full result artifacts in bounded chunks by `offset` and `length`. |
| `subzero_list` | Discovery | Lists persistent children across broker restarts scoped to the workspace. |
| `subzero_info` | Metadata | Returns protocol version, capabilities, available templates, and safe credential references. |

---

## ⚡ What Edges Us

- **Clean Separate Conversations**: Children never pollute, truncate, or consume the parent agent's context window. Each child maintains its own private conversation transcript in an isolated worker process.
- **Stateful Stream Redaction**: Real-time secret defense. Model keys split across streaming SSE deltas, tool argument payloads, or JSON property names are intercepted and redacted in-memory before entering transcripts, events, or disk.
- **SQLite Generation Guarding**: Atomic multi-broker concurrency control. Monotonic owner generations and immediate transactions prevent race conditions, duplicate writers, and stale resumes across independent processes.
- **Process Group Confinement**: Workers are bound to the broker lifecycle. Control-pipe EOF or broker SIGKILL tears down the entire POSIX process group—including spawned shell subprocesses—within 5 seconds.
- **Zero Ambient Grants**: Strict least-privilege immutable templates (`researcher` vs `coder`). Children inherit no host tools, no ambient skills, no environment secrets, and no nested delegation tools.

---

## Quickstart

### Prerequisites
Node.js 24.15 or newer and npm.

```sh
# Clone and build
npm ci
npm run verify

# Run Pi with the Subzero extension
pi -e /absolute/path/to/subzero/packages/pi/dist/index.js
```

`npm run verify` builds all packages, typechecks the workspace, and executes the complete offline test suite (128/128 passing).

For real LongCat provider verification, copy `.env.example` to `.env`, add `OPENCODE_API_KEY`, and run `npm run test:live`. See [docs/TESTING.md](docs/TESTING.md#live-longcat-check).

---

## Repository Layout

- `packages/core`: Language-neutral JSON Schemas, conformance fixtures, and dependency-free TypeScript orchestration.
- `packages/runtime`: Local MCP stdio broker, Node SQLite storage, credential resolver, and Pi SDK worker adapter.
- `packages/pi`: Thin Pi extension that registers the Subzero MCP server.
- `docs/`: Reference documentation:
  - [Reference design](docs/DESIGN.md): System architecture, capability contract, and state machine.
  - [Usage](docs/USAGE.md): Local setup, credential references, tool schemas, and host configs (Codex, Claude, OpenCode).
  - [Testing](docs/TESTING.md): Verification gates, test suite details, and live test reproduction.
  - [Audit (2026-10-08)](docs/AUDIT-2026-10-08.md): Hardening findings, regression fixes, and handoff record.
  - [Plan](docs/PLAN.md): Completed milestone record.
- `experiments/pi-sdk/`: Pi SDK 1.0.4 and Node SQLite qualification probes.
