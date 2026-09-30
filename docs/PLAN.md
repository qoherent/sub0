# Harness-agnostic subagents (fx-backed) — Plan

## Goal
Ship a harness-agnostic core (`spawn/send/stop/resume/list/subscribe`) where each
child is an isolated fx agent driven over ACP (engine verdict: docs/DESIGN.md §4).
Adapters: Pi (extension), Claude Code (MCP plugin), ACP (stdio agent) — core stays harness-free.
LLM endpoints: named providers resolved against fx's catalog (`gateway`, `codex`, `custom` baseUrl for Ollama/local/fleet) — config-default, args-override (DESIGN §2).
Packaging: `@subzero/core` (plain TS) + `@subzero/pi` thin adapter (lockstep versions; see docs/DESIGN.md).
Language: TypeScript, dependency-free ESM; Zig only if the fx kernel is ever forked.

## Reference lessons (one line each)
- Codex: `spawn_agent/send/interrupt` + `fork_turns` + role templates; copy its spawn shape.
- OpenCode: `task` tool with permission shrink, model inherit, `task_id` resume; copy cancel path.
- dsh: `SubagentProvider` seam + foreground/background/continuable split + `tools.restrict()`; copy split.
- fx: per-spawn `instructions+tools+skills+MCP`, checkpoints, cancel; this is the engine (via ACP per DESIGN §6).
- Pi: extension `pi.registerTool`, no native subagent/MCP client; Pi ships a pi-process subagent example — our diff is the fx engine (own LLM endpoint, checkpoints), keep core host-side.

## Plugin interface
Core (no Pi imports): `spawn { prompt, template?, llm: { provider, ...params }, cwd? } -> { id }`.
Providers = child backends: fx LLM endpoints (gateway/codex/custom) or whole coding CLIs (declarative `type:"cli"`, e.g. devin) — one generic driver, no per-CLI code, capability matrix per provider (DESIGN §5–6).
- Child sees the codebase via `cwd` passthrough (default: host session cwd); no worktree isolation.
- `spawn` blocks and returns the child's final message (OpenCode `task` shape); `subscribe` gives live events instead.
- `send { id, message }` (running → steer, idle → new turn); `stop { id }`; `resume { id, message? }`; `list {}`; `subscribe { id }` (events)
Pi adapter maps `registerTool execute()` → core; `llm` provider params per-call or env default.
Template: `{ name, instructions, permissionMode (read-only|ask|auto|yolo), skills[], mcpServers[] }` — tools are fx-native, projected per mode (E12); depth 1 by construction.

## Config & discovery (friendly-first, agent-visible)
- User configures once: `subzero.json` (home or project) — named providers (`codex`, `local {baseUrl}`...) + templates, each with clear behavior text (what it may do, tools, when to use).
- Adapter injects the catalog into the parent agent BEFORE spawning: Pi `promptSnippet`/`promptGuidelines` (`types.ts:463`), MCP tool descriptions (CC), ACP session config options.
- `subagent_info` action returns the live catalog (authenticated providers, templates, limits) so the agent can check availability at runtime.
- `spawn { prompt, template }` uses the configured provider implicitly; explicit `llm` arg still wins (args override config).

## fx mapping (AcpEngine — proven in Docker; libfx mapping only for gateway-only LibfxEngine)
- spawn: `fx acp` process per child → `initialize` → `session/new` (+ `session/prompt`); tools/instructions via host descriptors.
- send: running → core parks message (no upstream steer); idle → `session/prompt`. stop: `session/cancel` (settles `cancelled`).
- resume: new `fx acp` + `session/load` (history replays via updates). list: core registry; provider/model via ACP `configOptions`.

## Barebone fx (non-negotiable)
- Engine = fx per child (ACP binary or wasm); libfx only for gateway-only. Default backend native (no JSPI); assert via `getBackendInfo()`.
- RULE — dynamic adoption: never hardcode fx provider/tool/skill names; resolve via fx's runtime catalog. fx updates flow through with a dep bump, zero core change.
- RULE — zero default, parent grants: child starts with NO tools/skills/MCP; fx builtins absent unless granted (README:401-402 is upstream policy).
- researcher: read-only host tools; coder: + write/edit/shell-run. No ambient discovery.
- B1 exit must include: child lists exactly the passed tools, `subagent` absent.

## Pi wiring (adapter only, core stays harness-free)
- Tool: `pi.registerTool({ name: "subagent", parameters, execute(toolCallId, params, signal, onUpdate, ctx) })`; honor `signal`, stream via `onUpdate`.
- Commands: `/subagent spawn|send|stop|list` thin wrappers over the tool.
- Registry: `Map<id, { fxProc, sessionId, templateId, state }>` in extension scope.
- Engine behind an interface so fx stays replaceable (vision: fx proposed, open to change).
- MCP/skills: per B5 decision — child = MCP SDK client in core; parent skills via Pi's own discovery. Details: docs/DESIGN.md.

## Persistence / cancel
- ACP engine: fx file sessions (`~/.fx/sessions/<id>`) are the store; registry entry `{id, sessionId, templateId, provider, state}` in Pi session entries + our envelope versions. libfx engine: `checkpoint()` ≤4 MiB, resupply template on recreate.
- Cancel: Pi `signal` → `session/cancel`; late updates ignored; parked sends dropped on stop.
- Limits: 1 prompt/agent; drain update stream; instructions ≤64 KiB; 64-tool cap; session/load busy-locks (one process per session).

## Phase 0 — blocker spikes: COMPLETE (all evidence in DESIGN §11)
Verified in Docker/source: ACP engine works (spawn/prompt/cancel/resume/providers/concurrency);
libfx = gateway-only (custom-providers bug, ours to file); no upstream steer (core queue policy);
credentials inherit via `$HOME/.fx`; TLS + hostname rules; cancel-edge + provider-switch semantics;
limits are policy not transport. Deferred: wasm-direct (M4+), libfx bug report (draft at docs/research/libfx-issue-draft.md).
Pi lifecycle PROVEN (session_start via bindExtensions; shutdown on /reload; stdin-EOF orphan protection).

## Milestones (gated)
- M1: `spawn/send/list` + 1 template, registry, fx version probe (bare-semver stdout, E4), spawn-result e2e. M2: `stop/resume` + queue delivery + `subscribe` events + GC + `/subagent setup` + per-session provider switch via `set_config_option` (E3-proven, no per-child settings).
- M3: template set, skill+MCP wiring, depth guard, CLI-provider type (devin/hermes as config; DESIGN §7); pi.dev positioning note (additive path for native-subagent hosts). M4: `/subagent` commands, concurrency cap, `pi.dev/packages` publish (vision #7) + CC-screening checklist, lockstep npm publish, e2e.
- M5: CC adapter (`.claude-plugin` + MCP server, `subscribe`→polling, TTL note). M6: ACP adapter — subzero as ACP agent (stdio, TS SDK 1.5.1, v1 stable): `session/new=spawn, prompt=send, cancel=stop, resume/load=resume, updates=subscribe`; steer `_subzero/steer` (watch PRs: DESIGN). Clients: Zed/JetBrains/VS Code/Neovim.

## Risks
1. Cancel/steer races: unread-stream backpressure stalls `turn.result` — always drain/discard stream.
2. Checkpoint amnesia: resume must resupply template or capability silently changes.
3. Pi ctx stale after `/reload`/session replacement (`runner.ts:680`): registry dies — shutdown hook + persist/restore per docs/DESIGN.md (lifecycle firing PROVEN, E2).
4. Runtimes: fx native needs Node ≥20 + glibc 2.34+ (no JSPI); host (Pi latest) declares the real adapter Node floor (≥22.19 today) — we never pin hosts. WASM backend needs JSPI; cap concurrency (one fx process/child).
5. Size walls: host-tool result 8MiB frame (`fx-sdk.js:1619`), Pi tool output 50KB/2000 lines, CC 25k MCP tokens — truncate + spill to files.
6. Restored session history = untrusted input (injection replay on `session/load`); credentials live in files, never in session bytes.
7. Semantics guards: mid-turn `session/prompt` rejected (queue, don't retry); `session/load` busy-fails if another process holds it; `gatewayChatUrl` loopback-only; custom providers need https off-loopback, no underscore hostnames.
8. Pi ctx limits: `sessionManager` read-only in tools — children live in libfx, never Pi sessions.
