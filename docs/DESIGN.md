# Subzero v0.1 reference design and implemented behavior

Status: the selected v0.1 architecture has a working TypeScript implementation. Build, typecheck, 93 tests, and the `.env`-based LongCat delegation check passed on Node 26.3.1/Linux. The original 90 tests and local package/CLI/MCP checks passed on Node 24.21.0/Linux. Pi 1.0.4 is the tested host; other host setups remain untested. Process exit evidence covers ordinary POSIX descendants on Linux; deliberately detached sessions and other operating systems are outside the tested guarantee. This shared-workspace design is not an OS sandbox. See [testing evidence](TESTING.md).

## 1. Responsibility boundaries

Subzero is a host-facing delegation layer. The parent agent calls Subzero tools through the host adapter. It is not a second host conversation, an external CLI provider catalog, or an ACP host facade.

Host session: parent conversation, transcript, model, and UI. Owned by Codex, Pi, Claude Code, OpenCode, or another host.

Child session: persistent child-agent conversation with a stable childId, template snapshot, workspace scope, model choice, and worker-owned transcript.

Run: one attempt to process a prompt in a child session, with a stable runId, status, result, and events.

Architecture:

    Host agent
      -> host registration adapter
        -> Subzero MCP stdio process
          -> @subzero/core: state, limits, queues, routing, events
          -> @subzero/runtime: SQLite, MCP server, Pi SDK worker
            -> one worker process per child while runs are active or queued

The host owns the parent conversation. Subzero owns child identity, run routing, queues, state, metadata, and event cursors. The worker owns its model loop, transcript/checkpoint, and child tool execution.

## 2. Host transport and process ownership

Use one local MCP stdio process per active host MCP client/process. Codex, Claude Code, and OpenCode configure the same executable. The Pi package uses the documented registerMcpServer API to register that executable for its session; it does not implement a second native tool set or registry.

No global daemon or HTTP listener in v1. The host starts/stops its MCP process. Each broker process owns the live child-worker process handles it created. A worker process exists only while that child has active or queued runs; after all runs settle it closes, releasing memory and the writer slot while the durable child session remains ready. Control-pipe EOF cancels the run and kills the worker/tool subprocess tree. Workers must not detach.

On clean broker shutdown, request stop for active runs, clear queued follow-ups, wait for worker termination, and persist stopped/interrupted state. On broker crash, the worker observes EOF and tears down its tool subtree. Another broker may claim the child only after exclusive ownership is released and worker termination is confirmed. If that cannot be confirmed, return busy/recovery_required; do not start a second transcript writer.

Child IDs are persisted under a canonical OS-user/workspace scope, not a host-specific session ID. A restarted host can list and resume by childId. Hosts do not need to share their own conversation IDs.

## 3. Package boundaries

- @subzero/core: language-neutral JSON Schemas/conformance fixtures plus TypeScript reference orchestration, state transitions, limits, queues, event cursor logic. No Node, Pi, MCP SDK, SQLite, ACP, or worker package imports.
- @subzero/runtime: MCP stdio server, Node 24.15+ SQLite storage adapter, per-child Pi SDK worker process, event/result normalization, host-secret-reference resolution.
- @subzero/pi: thin Pi extension package. Registers @subzero/runtime with pi.registerMcpServer and optional command aliases. Imports neither SQLite nor the worker SDK.

The worker dependency is exact-pinned to Pi SDK 1.0.4. No wildcard host or worker compatibility claim. Publish a tested-version table for each host adapter. Reject an incompatible worker transcript/session version; do not perform best-effort mutation across versions.

## 4. Public JSON contract and reference API

The normative contract is a versioned JSON Schema set plus documented state/capability semantics. It is independent of TypeScript and can be implemented by non-JavaScript hosts. The TypeScript reference API is illustrative. Ship conformance fixtures with the schemas.

Core reference values:

    type TemplateId = string;
    type ModelArgs = { url: string; model: string; key: string; api?: string };
    type SendMode = "steer" | "followup";
    type Delivery = "steered" | "queued" | "started";

    type SpawnInput = {
      prompt: string;
      templateId: TemplateId;
      model: ModelArgs;
      workspaceRoot: string; // host supplied execution context
    };

Core operations:

    info()
    spawn(input) -> { childId, runId }
    get(childId, { waitMs?, cursor? }) -> ChildSnapshot
    subscribe(childId, cursor?) -> AsyncIterable<ChildEvent>
    list(workspaceRoot?) -> ChildSummary[]
    send(childId, mode, message) -> { runId, delivery }
    stop(childId, expectedRunId) -> StopRequest
    resume(childId, modelArgs, message?) -> ready | new Run
    readArtifact(artifactId, offset, length) -> ArtifactChunk

The core receives the literal model key in memory. The MCP schema receives credentialRef and the runtime resolves it before calling core. The API protocol defaults to openai-completions, as qualified by the probe; other protocols must be explicitly selected from the engine's advertised supported protocols. Do not infer a protocol from the endpoint URL. Worker/session SDK types are private to the runtime adapter.

## 5. Template and capability contract

Built-in templates are researcher and coder. User templates are keyed by arbitrary string templateId and contain:

- instructions;
- exact tool descriptors and grants;
- explicit skills[];
- explicit MCP server configurations and allowed tool names.

At spawn, resolve and persist an immutable template/grant snapshot. A resume reuses the same snapshot. If its required worker adapter/version is unavailable, return a typed incompatibility error. Never add new tools, skills, or MCP servers silently on resume.

Researcher gets exact read-tool names and no write or shell tools. Coder gets its own exact read, write, and command tool names. User-defined string template IDs follow the same schema. No tools are inherited from the host or ambiently discovered. Subzero delegation tools are not registered in a child; nested delegation is outside the v1 contract.

The runtime MCP client connects only to the MCP servers explicitly in the template. It maps only their declared tools to the worker's custom-tool surface. Skill files and tool catalogs are loaded only from the snapshot, not from ambient host folders.

If the worker cannot enforce the exact requested grant set, fail spawn before model execution. No general permission-approval broker is part of v1; ungranted capabilities fail closed.

## 6. Workspace and model inputs

The host adapter supplies the canonical workspace root. It selects the working directory and metadata scope, not a filesystem boundary: Pi's native file tools accept paths outside cwd, and a granted shell runs with the launching user's OS authority. The prompt and template are explicit. Parent transcript/history is not copied implicitly.

Children share the workspace. SQLite-backed admission serializes Subzero write-capable runs across broker processes sharing the workspace. Read-only children may run concurrently. This serialization does not prevent the parent host, another non-Subzero process, or external tools from editing files. It is not a sandbox.

The core receives {url, model, key} for spawn and explicit resume in memory. Do not read ambient Pi, fx, Codex, or host-provider credentials. Do not store raw keys. The MCP-visible schema accepts credentialRef; the runtime resolves it against explicitly configured environment or secret references, then passes key material to core in memory. A missing reference returns credentials_required. Within a live broker, a later followup reopens the worker using the selected child model and its in-memory key. After broker restart, the host must call resume with a credential reference before sending more work.

The caller selects model URL, model, API protocol, and credential reference on spawn and explicit resume. The credential resolver accepts only references configured for this runtime; it is not an arbitrary environment-variable lookup. No provider catalog or config default overrides the supplied model values.

## 7. Session and run semantics

Child state: ready, running, interrupted. A ready child has no worker process; it retains its transcript reference and template snapshot.

Run state: queued, running, stop_requested, stopped, completed, failed, interrupted. Interrupted means execution ended without a confirmed terminal result.

Each prompt is a distinct run. Spawn creates a child session and its initial run. Subzero owns the follow-up queue and dispatches each prompt after the preceding run settles; it does not duplicate that queue inside Pi. Persist each completed run's transcript leaf before dispatching the next queued run. A follow-up while idle reopens the child and starts a new run immediately.

Send requires a mode:
- steer modifies the current active run only. If the worker does not advertise steering, reject unsupported_steer. Never reinterpret it as followup.
- followup adds a new run. When busy it queues; when idle it starts.

Stop requires expectedRunId. If it does not match the active run, return stale_run without effect. A matching stop clears queued follow-ups and sets stop_requested. Set stopped only after the worker confirms cancellation and process-tree exit. The response distinguishes requested from confirmed.

Resume without a message validates credentials and the exact checkpoint, then returns a ready child at its last completed transcript leaf; it starts no run or worker process. Resume with a message starts a fresh worker process and run from that leaf. Never retry or replay an interrupted prompt/effect automatically. For a partial Pi tool call, use SessionManager.branch(lastCompletedLeaf), preserve the interrupted branch, and append a recovery notice that the working tree may include interrupted changes. If the worker version cannot load the exact checkpoint, refuse resume and preserve stored state.

## 8. Events, info, and MCP calls

info returns Subzero protocol/core versions, selected worker name/version, worker capabilities, available templates with descriptions/grants, configured model/auth references without secrets, supported host adapter versions, and limits.

Events have monotonically increasing per-child sequence numbers and include child/run lifecycle, text updates, tool activity names, stop request/confirmation, completion, and error. Omit raw tool arguments, secrets, and full worker transcripts.

MCP tools: subzero_info, subzero_spawn, subzero_get, subzero_list, subzero_send, subzero_stop, subzero_resume, and subzero_output. There is no clear/delete tool in v1. subzero_get accepts bounded waitMs and cursor. The wait is bounded; the response includes the current state, bounded event batch, next cursor, oldest available cursor, and result/artifact reference. When a requested cursor is older than retained history, report an explicit cursor gap.

The core exposes native subscribe for Pi or other adapters able to consume an async iterator. MCP callers poll with get; progress notifications may update a currently active tool call. Do not push an unsolicited model turn or assume the host will react to background notifications.

## 9. Results, artifacts, and limits

Full child output/result is stored as a local worker-owned artifact. MCP returns a bounded preview and opaque artifact reference; subzero_output reads chunks by offset/length. Event history is bounded and may be pruned, with cursor gaps explicit. Do not automatically delete child transcripts or full result artifacts in v1.

Initial policy defaults:
- maximum four active worker processes per workspace; idle child sessions do not retain worker processes.
- maximum one write-capable Subzero run per workspace across brokers;
- maximum 64 KiB UTF-8 prompt/instructions;
- maximum 64 granted tools;
- maximum 8 KiB per event payload, with larger output in artifacts.

These are policy limits, not transport maxima. No automatic retry after worker or model failure.

## 10. Persistence, ownership, recovery

SQLite stores Subzero metadata and bounded event rows: child/run IDs, state, worker session reference/version, template and grant snapshot, model URL/model/API protocol, workspace scope, owner generation, stop request/confirmation, artifact refs, and event cursors. It does not store API keys or the full transcript.

The worker owns the durable transcript. Workers exist only during active/queued runs; after a busy episode settles, persist the completed leaf/result and close the process to release memory and writer ownership. Record the last completed transcript leaf in SQLite so interrupted resumes can branch safely while preserving the interrupted branch. Use transactions plus an exclusive child ownership generation to prevent simultaneous resumes or transcript writers across MCP broker processes. All Subzero brokers use the same workspace database path.

A DB transaction only protects a claim update; it cannot prove a live external worker is dead. The worker must be a supervised per-child process whose control-pipe EOF cancels work and terminates its tool subprocess tree. Broker startup cannot claim a child until the prior worker has confirmed exit. Ambiguous ownership remains busy/recovery_required; never use a PID/TTL-only lease to start a duplicate.

The reference sidecar targets Node 24 LTS, minimum 24.15, where node:sqlite reached Release Candidate status; the API also exists in earlier Node versions. Pi itself requires Node 22.19+. The local probe verified WAL, BEGIN IMMEDIATE, and close/reopen persistence on Node 24.21. Keep the SQLite adapter isolated. Hosts launch the sidecar and need not use its runtime internally.

## 11. Host adapters and evidence

Pi 1.0.4 is the first host integration. It registers the shared MCP executable with Pi's documented registerMcpServer API; no second Pi-native tool set or registry. The @subzero/pi package is an installer/registration adapter only.

Codex, Claude Code, and OpenCode configure the same local stdio executable through their own host settings. There is no common plugin package manager. Exact host tested versions belong in the compatibility table; no wildcard range is a compatibility promise.

Pi worker process model is selected for bounded stop/fault containment. The tested package set is exact-pinned: Pi SDK 1.0.4 and pi-ai 1.0.4. Root measured 135 MB installed dependencies (121 packages), about 143 MB baseline RSS per loaded worker test process, and about 178 MB after multiple sessions in one process. Idle child sessions close their worker; a four active-process cap is an initial policy limit, not a performance guarantee. Record footprint in package docs.

The September Docker experiments are historical evidence in [the archive](archive/research/2026-09-30-experiments.md). They are not current worker qualification.
