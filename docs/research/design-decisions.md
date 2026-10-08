# Design decisions and evidence - v0.1 draft

This is the dated pre-implementation decision record. It separates the primary-source evidence available on 2026-10-07, repository proposals, historical experiments, and decisions. No Subzero code was changed during that research checkpoint, and historical experiments were not rerun. Implementation-status statements below are preserved for provenance, not current qualification claims. See the [2026-10-08 audit](../AUDIT-2026-10-08.md) for the current implementation, verification and compatibility assessment.

## Decision inventory

| Topic | Evidence | v0.1 decision | Status |
|---|---|---|---|
| Product boundary | vision.md asks for a cross-harness subagent plugin; user clarified the coding agent uses it to spawn children and does not require arbitrary external CLI workers. | Subzero is host-facing delegation with a worker adapter behind it. | DECIDED |
| Common host surface | Codex MCP supports local stdio and HTTP. Claude Code supports stdio and HTTP and plugins can bundle MCP. OpenCode supports local stdio and remote. Pi extensions expose registerTool and registerMcpServer. | One shared MCP stdio server, thin host-specific registration packages. | DECIDED |
| Pi integration | Pi packages install npm packages with pi install npm:<name>; current API can register MCP servers per session and requires re-registration after session load. | Pi package is first and registers the same MCP executable. No second Pi-native tool registry. | DECIDED |
| Host process ownership | Claude docs say plugin MCP processes run alongside each enabled session. Codex and OpenCode launch configured local stdio processes. Pi session lifecycle expects idempotent cleanup. | One stdio broker per active host client/process. Host owns broker lifecycle; broker owns live workers. No global daemon or local HTTP listener. | DECIDED |
| Background updates | Claude backgrounds long MCP calls, but those tasks do not survive session exit. MCP progress is attached to a live call; unsolicited channels are host-specific. | Return a child ID promptly. Read updates/results via get/poll with cursor. Never trigger parent model calls. MCP Tasks are optional. | DECIDED |
| ACP role | ACP has agent session methods; it is a worker/session protocol, not a host plugin tool contract. Top-level M6 Subzero-as-ACP-agent is a proposal. | No ACP host facade in v1. ACP may be a worker adapter if selected. | DECIDED |
| Arbitrary CLI worker | Plan adds generic CLI engines but user clarified this is not required. | No CLI provider engine in v1. | DECIDED |
| Child session vs run | DESIGN conflates blocking spawn with returning {id}; stop/resume/event model requires long-lived IDs. | Child session is durable identity; run is one prompt execution. Spawn returns childId and runId promptly. | DECIDED |
| Send semantics | Historical design queues while ACP cannot steer. Current upstream ACP supports negotiated steering; worker engines differ. | Send returns steered, queued, or started; never promise delivery mode unsupported by engine. | DECIDED |
| Stop/resume | Stop and resume are owner requirements. Historical plan conflates cancellation, stopped state, and resumed execution. | Stop clears queued sends; record request and worker confirmation separately. Resume validates the last completed leaf; with a new message it starts a fresh run. Preserve the interrupted branch; never replay uncertain effects. | DECIDED |
| Parent context | Vision requires workspace visibility but does not require parent transcript inheritance. | Host supplies trusted workspace root. Prompt is explicit. No parent history copied implicitly. | DECIDED |
| Workspace isolation | PLAN explicitly says shared cwd/no worktree. No sandbox evidence for the common host path. | Shared workspace, no sandbox claim. Serialize only Subzero write-capable workers per workspace; host/external writers remain outside that guarantee. | DECIDED |
| Tools and profiles | PLAN/DESIGN say zero-default tools and exact grants; child must inspect codebase. | Require explicit profile. Researcher grants read-tool names; coder adds exact mutation/command tools. cwd supplies context, not confinement. No inherited tools, ambient discovery, or nested Subzero. | DECIDED |
| Interactive approvals | DESIGN proposes permission events/respond, but no owner requirement or portable host callback guarantee. | No general approval broker in v1. Unlisted capabilities fail closed. Interactive approval may be an optional later worker capability. | DECIDED |
| Model selection | Vision requires per-call URL/model/key; README/PLAN/DESIGN introduce config defaults and provider catalogs. | Core receives exact {url, model, key} on spawn/resume. No provider catalog or ambient provider credentials. | DECIDED |
| Secret boundary | A model-facing MCP tool should not expose key material as ordinary generated text. | Tool schema accepts a credential reference; the Subzero runtime resolves explicitly configured references and passes the key to core in memory. Never store raw key or return it. | DECIDED |
| Metadata persistence | Host-specific session entries in DESIGN cannot be common across adapters. Child transcript belongs to worker. | Shared local SQLite metadata per user/workspace; backend owns transcript/checkpoint. Use transactions and generation-checked exclusive ownership. | DECIDED |
| SQLite runtime | Node 24 SQLite docs show node:sqlite at Stability 1.2 Release Candidate from 24.15. Node 24 is LTS. Root downloaded Node 24.21 and ran a file-backed WAL/BEGIN IMMEDIATE persistence smoke successfully. | MCP sidecar reference runtime Node 24.15+; isolate storage adapter; recheck API stability before shipping. Do not import SQLite from public core or host adapter. | DECIDED WITH RC CAVEAT |
| Worker ownership after crash | SQLite can transact a claim, but cannot fence an external live worker. | Use a supervised per-child process that terminates on broker control-pipe EOF. Do not reclaim ambiguous ownership; surface busy/recovery-required. | DECIDED |
| Packaging | PLAN proposes @subzero/core/@subzero/pi; current host installation is not one universal plugin format. | Use @subzero/core, @subzero/runtime, and @subzero/pi with host-specific MCP registration. | DECIDED |
| Default limits | Historical DESIGN proposed four children, 64KiB instructions, 8KiB events and 64 tools; these were policy bounds, not transport limits. | Keep these as v1 policy defaults; verify against chosen worker and host limits. | DECIDED |
| Deno | Deno 2.2 added node:sqlite compatibility. The selected sidecar is Node 24.15+ and host packages launch it as a process. | Do not require or package Deno in v1; keep the JSON contract language/runtime-neutral. A Deno host can launch the Node sidecar if desired. | NOT REQUIRED FOR V1 |
| Worker engine | Official Pi SDK 1.0.4 probe passed all nine checks: empty tools/resources, exact custom tool execution, separate runtime auth/custom endpoint, steering, followup, queue abort, separate-process completed-session reopen, partial streamed tool-call abort, safe resume from the last completed leaf, and memory-only API key injection (recursive scan of six files found no synthetic key). | Select exact-pinned Pi SDK 1.0.4 in a per-child Node worker process behind the engine interface. Preserve interrupted branches and notify that the working tree may contain interrupted changes. | SELECTED; Subzero implementation gates remain |
| OpenHuman candidate | Official embed docs expose a Rust library with one Runtime per process, multiple AgentSpec instances, shared runtime keyring/config, and default wildcard tools unless explicitly narrowed. The workspace manifest declares GPL-3.0-only; Subzero is MIT. | Reject as v1 foundation: a GPL Rust dependency/runtime adds a second language/toolchain and runtime-wide credential/config ownership that does not match the selected Node worker architecture. | REJECTED FOR V1 |
| fx/libfx candidate | Official fx tool docs expose a fixed built-in tool family and permission rules. The libfx custom-provider issue #160 is still open; current SDK surface does not meet the required per-call remote URL/model/key path. | Reject for v1: exact tool grants and remote per-call provider selection need a translation/config bridge. Do not fork or claim that bridge is already supported. | REJECTED FOR V1 |

## Current primary sources

- MCP tools: https://modelcontextprotocol.io/specification/2025-11-25/server/tools - tools/list and tools/call with JSON-schema inputs, structured results, optional task support.
- MCP Tasks core: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/utilities/tasks.mdx - introduced as experimental.
- MCP Tasks extension: https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html - Draft extension for async tool-call tasks; cancellation is cooperative/eventually consistent. Tasks are not child sessions.
- ACP capabilities: https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/initialization.mdx - session methods and extension capabilities negotiated during initialize. ACP is a possible child-session protocol.
- Codex MCP setup: https://learn.chatgpt.com/docs/extend/mcp?surface=cli - stdio server command, shared CLI/IDE configuration, project trust, plugin MCP.
- Claude Code MCP: https://code.claude.com/docs/en/mcp - stdio/HTTP, plugin servers, per-session lifecycle, elicitation, ephemeral backgrounding.
- OpenCode MCP: https://docs.opencode.ai/docs/mcp-servers/ - local stdio and remote configuration.
- Pi extensions: https://pi.dev/docs/latest/extensions - custom tools, lifecycle, session metadata, and MCP registration.
- Pi packages: https://pi.dev/docs/latest/packages - npm/git package installation and gallery metadata.
- Node SQLite: https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html - Node 24.15+ API status and limitations.
- Node release status: https://nodejs.org/en/about/previous-releases - Node 24 LTS, Node 26 Current.
- fx tool contract: https://fx.sh/docs/capabilities/tools - built-in file/shell/web/MCP tools and permission modes; no generic exact Subzero allowlist schema.
- fx full-product subagents: https://fx.sh/docs/capabilities/subagents - own conversations, shared workspace, parent permission limits; not libfx worker API.
- libfx endpoint gap: https://github.com/vercel-labs/fx/issues/160 - open feature request for host-configured custom providers in libfx/WASM.
- OpenHuman embedding API: https://github.com/tinyhumansai/openhuman/blob/main/gitbooks/developing/embedding.md - Rust Runtime/Agent model and build-time feature set.
- OpenHuman license: https://github.com/tinyhumansai/openhuman/blob/main/LICENSE - GPL-3.0; current Subzero LICENSE is MIT.
- Deno Node SQLite API: https://docs.deno.com/api/node/sqlite/ - Deno v2.2 added node:sqlite compatibility; Deno is still not a v1 host target.

## Repository evidence notes

- vision.md is the owner requirements source; do not edit it.
- README.md, docs/PLAN.md, and docs/DESIGN.md mix requirements, proposals, and design conclusions.
- DESIGN appendix and Docker experiments are historical, authored in September 2026. They are preserved in docs/archive and were not rerun for this draft.
- The fx and Pi reference clones are stored outside this checkout in the sibling subzero-reference-material directory; they are not Subzero implementation. Local fx is stale relative to upstream. Current upstream docs supersede historical claims about current host APIs.
- The fixture was installed with npm ci from its lockfile, including Pi SDK 1.0.4 and its pi-ai 1.0.4 dependency. The portable behavior probe passed nine checks under official Node 24.21; source and results are in experiments/pi-sdk/qualification.mjs and experiments/pi-sdk/probe-result.json. This qualifies the worker seam, not a Subzero implementation.
- Root downloaded official Node 24.21 and passed file-backed WAL, BEGIN IMMEDIATE, close/reopen persistence. The smoke source is experiments/pi-sdk/sqlite-smoke.mjs; the command completed with exit 0 after close/reopen persistence. This is storage evidence only, not MCP or Subzero end-to-end.
- No Subzero implementation, release, or passing end-to-end gate is claimed.

## Host support details verified from primary documentation

| Host | Current local integration | Install/ownership implication | Evidence status |
|---|---|---|---|
| Pi | Extension API registers tools, MCP stdio/HTTP servers, commands, and session hooks. | Package install is Pi-specific. Register the shared server per session and close it idempotently on shutdown. | Official pi.dev docs. |
| Claude Code | MCP supports local stdio and remote HTTP; plugin bundles MCP config and launches servers while enabled. | Plugin packaging is available; server lifecycle follows Claude session. Its long-call backgrounding does not survive session exit. | Official Anthropic docs. |
| Codex CLI/IDE | Local stdio and Streamable HTTP; CLI and IDE share config. Project config requires trusted project. Plugin-bundled MCP is supported. | Use stdio configuration; do not depend on deprecated codex mcp-server. | Official OpenAI/ChatGPT Learn docs. |
| OpenCode | Local command with MCP stdio, remote MCP, and custom plugin tools. | Use same local server command in host config or thin plugin package. | Official OpenCode docs. |
| ACP | Negotiated agent session surface: new/list/resume/close/prompt/cancel/update, plus optional capabilities/extensions. | Useful worker/session protocol; it does not replace the host-facing delegation tools. | Official ACP spec/SDK. |

The common denominator is the MCP stdio server contract, not a common plugin manifest. Each product has its own package/config mechanism. HTTP is appropriate for a separately hosted service, but is unnecessary for a local single-user v1 and adds a listening endpoint and authentication surface.

## Owner requirement disposition

| Vision item | v0.1 treatment |
|---|---|
| 1. One agnostic subagent plugin | Shared core and MCP server; host adapters stay thin. |
| 2. Prompted child sees codebase | Host supplies trusted root; required profile explicitly grants workspace read access. |
| 3. Stop/resume as agent sessions | Stop confirmation is explicit; resume reloads durable transcript into a fresh run. |
| 4. Bare-minimal harness | Use one small worker interface and one qualified reference worker. |
| 5. Researcher/coder templates | Two built-ins with explicit per-profile grants. |
| 6. Works with hosts with and without native agents | MCP tools are additive; Pi has first adapter. No native-host passthrough promised in v1. |
| 7. Pi first / package catalog | Thin Pi extension registers the same stdio server; publish only after verification. |
| 8. URL/model/key from call args | Core receives values each spawn/resume. MCP schema passes a credential reference to the Subzero runtime resolver. |
| 9. Harness-agnostic core | Language-neutral JSON Schema and documented semantics; TypeScript is the reference implementation. Host APIs exist only in adapters. |
| 10. No nested Subzero/default tools | No ambient grants; child profiles expose no Subzero tools. |
| 11. fx dependency, not fork | Reject fx/libfx for v1; no fork or dependency. |

## Former design conflicts resolved in v0.1

| Former statement | Conflict | Resolution |
|---|---|---|
| spawn returns {id} and blocks for final result | ID-first async lifecycle conflicts with blocking wait | spawn returns IDs promptly; get reads output/result. |
| send is queued because ACP lacks steering | Current ACP docs expose negotiated steering; worker capabilities vary | send returns actual delivery mode. |
| child has zero tools and must inspect project | An empty tool set cannot inspect files | Explicit researcher profile grants read-only tools; no implicit grants. |
| config provider defaults plus per-call override | Vision requires endpoint/model/key per call | No provider registry/default; request carries values and key is resolved from a host reference. |
| event subscription pushes updates to parent | MCP clients do not provide a portable unsolicited model-call contract | Event cursor plus get/poll; progress is optional for a live call. |
| permission_request/respond required | No owner requirement; host callback is not universal | Omit approval broker in v1; ungranted calls fail. |
| Pi has no MCP client | Current Pi docs provide registerMcpServer | Use the documented Pi registration adapter. |
| ACP M6 makes Subzero an ACP agent | User clarified host-facing plugin path | No ACP facade in v1; retain ACP only as a candidate worker protocol. |
| arbitrary declarative CLI worker | Not required by clarified goal | Remove from v1 scope. |

## Storage and runtime evidence

Node's release table identifies Node 24 as LTS and Node 26 as Current. The Node 24.15 SQLite API is Stability 1.2 Release Candidate. Root installed official Node 24.21 and ran the file-backed WAL plus BEGIN IMMEDIATE smoke successfully. That verifies the storage API path, not Subzero broker ownership, crash recovery, or host integration.

Use one SQLite database per local user/workspace scope. Store metadata, run states, owner generation, and bounded event cursors only. Keep worker conversation data outside this database. SQLite transactions prevent concurrent claims at the row/update level; they do not fence a worker process after the claim commits. Each active child uses a supervised worker process that terminates on broker EOF. If prior worker termination cannot be proven, return busy/recovery_required rather than starting a duplicate.

The Node 24.15 minimum applies only to the stdio MCP sidecar that imports node:sqlite. Host applications may use Pi, Codex, Claude Code, or OpenCode runtimes independently. Core semantic types and JSON Schemas contain no Node modules. Deno is not required for v1; official Deno docs say node:sqlite is supported from Deno 2.2, but no Deno sidecar or worker adapter is qualified.

## Worker qualification matrix

| Candidate | Current disposition | Required evidence before selection |
|---|---|---|
| Pi SDK as worker | Official Pi SDK 1.0.4 plus pi-ai 1.0.4 passed nine portable behavior probes, including exact tool/resource empty set, custom tool execution, per-call auth/custom endpoint, steering/followup, cancellation queue handling, process-reopen, partial tool-call abort, safe branch resume, and memory-only key injection with a six-file scan. | Selected exact-pinned reference worker. Per-child process closes after its run queue settles. Subzero host integration remains an implementation gate. |
| fx ACP | Current docs list native built-in tools and parent permission inheritance; local checkout is stale. Exact Subzero per-child allowlist and per-call provider requirements do not map directly. | Rejected for v1; do not add a compatibility bridge or ambient-settings workaround. |
| libfx | Current SDK accepts host tool callbacks; official issue #160 remains open for host-configured remote providers. | Rejected for v1 because remote per-call endpoint/model/key needs are not met by the qualified surface. |
| OpenHuman package | The embed guide documents a Rust Runtime/Agent library, process-shared runtime keyring/config, and wildcard tool defaults; workspace manifest declares GPL-3.0-only. | Rejected as v1 foundation for its additional Rust toolchain, broader runtime, and different license and ownership model. |
| Deno runtime | Official Deno docs support node:sqlite from Deno 2.2, but v1 ships a Node sidecar and no Deno host/worker target. | Deno is not a v1 runtime requirement. |

Pi worker qualification passed nine checks under official Node 24.21. The probe and qualification script are experiments/pi-sdk/probe-result.json and qualification.mjs; the SQLite smoke source is experiments/pi-sdk/sqlite-smoke.mjs. These probes qualify the worker and storage API, not a Subzero package or host integration.

## Reproduce the observed results

Run the commands in [the probe README](../../experiments/pi-sdk/README.md). The checked-in [Pi result](../../experiments/pi-sdk/probe-result.json) contains nine passing checks; the [SQLite result](../../experiments/pi-sdk/sqlite-result.json) records WAL and commit/reopen verification. Both ran on Node 24.21.0 on Linux with a synthetic local model endpoint. No paid provider or complete Subzero host integration was exercised.
