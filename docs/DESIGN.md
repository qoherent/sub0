# Subzero core design (implementation-ready; strategy in PLAN.md)

> Adapters (Pi/CC/ACP) are deferred to the end — they are thin doors over this spec.

## 1. Core API (harness-free, dependency-free ESM TS)
`createCore({ engine, config, registry, clock? }) -> { spawn, send, stop, resume, list, subscribe, respond, info }`
`respond { requestId, optionId }` — answers a pending `permission_request` (E12 round-trip).

- `spawn { prompt, template?, provider?, cwd? } -> { id }` **blocking**; resolves with final child
  message. Details: `{ id, provider, model?, usage?, stopReason, durationMs }`. AbortSignal (from
  host) cancels the child and rejects with `stopped`.
- `send { id, message }` — running → park (emits `steer_queued`), drained as new prompt on
  `end_turn`; idle → prompt now. CLI providers: park-until-exit is pointless → `busy` error unless
  idle (capability-gated, see §5).
- `stop { id }` — ACP: `session/cancel` (session kept for resume); CLI: SIGTERM → 5s → SIGKILL.
  Idempotent. Registry entry kept.
- `resume { id, message? }` — fresh engine attach to stored session (`session/load`); optional
  prompt after load. Requires live registry ref (else `unknown_id`).
- `list {}` — registry snapshot `{ id, provider, template?, state: idle|running|parked|stopped, startedAt }`.
- `subscribe { id }` — async iterator of §2 events; multiple subscribers allowed; late joiners get
  state snapshot event first.
- `info {}` — catalog for the parent agent: providers + capability matrix + auth-state, templates +
  behavior text, backend (native/wasm), versions (`subzero`, `fx`, `fxSdkApiVersion`).

## 2. Event vocabulary (subscribe; stable, versioned `subzero.events.v1`)
`spawned`, `turn_start`, `update` (text delta, truncated), `tool_start`/`tool_end` (name only), `permission_request` {requestId, tool, rawInput, options[]} — host MUST answer via `respond`,
`steer_queued` {position}, `turn_end` {stopReason, usage?}, `parked_drained`, `stopped` {cause},
`error` {code, message}, `exit` (cli only, {exitCode}). Adapters map these to their native surfaces
(ACP updates, MCP notifications, Pi `onUpdate`) — never expose raw fx/CLI wire formats.

## 3. Engine interface (the seam — fx stays replaceable, vision #4)
```ts
interface Engine {
  capabilities: { steer: boolean; resume: boolean; stream: boolean };
  spawn(req: { prompt, cwd, instructions, tools[], env? }, signal): ChildHandle;
  // ChildHandle: { id, events: AsyncIterable<Event>, result: Promise<Result>, send?(text), stop() }
}
```
`Result = { output: string; stopReason: end_turn|cancelled|failed|max_output_tokens|refused; usage? }`.
Capabilities drive `send` behavior and `info`; unsupported ops fail with `unsupported_by_provider`.

## 4. Engines
- **AcpEngine (default, llm providers)** — one `fx acp` process per child; `initialize` →
  `session/new` → `session/prompt`; **tools = fx native builtins, projected per permission mode**
  (E12-proven: `write_file` ran; under `ask`, `session/request_permission` arrives structured —
  `{toolCall{name,rawInput}, options:[{optionId:"allow_once"...}]}` — core relays it as a
  `permission_request` event; host answers via `respond {optionId}`; template sets the mode:
  researcher=read-only, coder=ask). Provider/model per session via `session/set_config_option`
  (E3-proven). Stop = `session/cancel`; resume = new process + `session/load` (history replays via
  updates — adapters must not double-render). Version probe at first spawn: `fx --version` ≥
  minimum floor (0.0.11), else `version_unsupported` with 'update fx' pointer. Wasm fallback: deferred to M4+ (16 `fx.*` host
  imports — bounded but not worth it while binary works).
- **CliEngine (declarative CLI backends, DESIGN §7 of old; now §6)** — one generic process driver;
  prompt via arg/flag/stdin; stdout tail (bounded) as `update`s; session-id regex → resume flag;
  exit code → stopReason map. No per-CLI code, ever.
- **LibfxEngine (gateway-only)** — `createFxAgent` in-proc; steer-capable; kept because it is the
  only engine with true mid-turn steer today; blocked from custom providers upstream (bug filed).

## 5. Providers & capability matrix
Provider = child backend (llm endpoint OR coding CLI). Matrix in `info`:
| provider kind | steer | resume | stream | notes |
|---|---|---|---|---|
| llm (gateway/codex/custom) | queue-only* | yes | yes | *true steer only on LibfxEngine |
| cli | no | if `resume` declared | tail | stop = SIGTERM→KILL |
Unknown provider → `provider_unknown` with `info`-style suggestions. Fleet rule: custom base_url
needs https off-loopback, no underscore hostnames (fx enforces).

## 6. Zero default, parent grants (non-negotiable)
Children start with the LEAST capable mode. Templates grant via: `permissionMode`
(read-only | ask | auto | yolo) — on AcpEngine this projects fx's builtin tool set (read-only
projection vs full) and routes mutations through `session/request_permission`; nested spawn is
impossible because fx's own `subagent` builtin is never in the child's projection (depth 1 by
construction). `mcpServers[]` per template (B5: MCP SDK client in core, lazy, approval-brokered).
LibfxEngine additionally supports explicit host-descriptor allowlists. Evidence: E12 (both modes).

## 7. Config (`subzero.json`; home > project > builtins; version + forward-only migration)
```jsonc
{ "version": 1,
  "defaults": { "provider": "gateway", "maxChildren": 4 },
  "providers": { /* llm: fx-shaped pass-through | cli: declarative (§4) */ },
  "templates": { "researcher": { "extends": "builtin:researcher" },
                 "coder": { "extends": "builtin:coder", "tools": ["read","bash","edit","write"],
                            "instructionsFile": "./coder.md" } } }
```
Secrets via `apiKeyEnv` only. Merge: per-key, project wins; `extends` deep-merges builtin data files.
CC-side `.claude/subzero.local.md` overrides merge OVER this (adapter-layer only).

## 8. Registry, persistence, GC
Registry = `{ id, provider, template?, sessionId|cliSession?, state, startedAt }` persisted as tiny
entries in the HOST's session store (Pi: `appendCustomEntry`; plain JSONL elsewhere). Blobs live in
fx's own `~/.fx/sessions/<id>/` (AcpEngine) — never copied into host sessions. Restore on
`session_start` from host branch; `session_shutdown` → stop all running (idempotent). GC at start:
registry refs whose host session is gone, or mtime > 30d. CLI children: no blobs, registry only.

## 9. Ops
- Version policy (owner: track latest; no host pins):
  - Hosts (Pi, Claude Code): NO version constraints — `peerDependencies: "*"`; track latest
    (pi@0.99.x today). Adapter Node floor = whatever the latest host declares (Pi: `>=22.19`
    today); core itself needs only Node >=20 (fx native). Not our constraint to pin.
  - fx-family (`libfx` dep, `fx` binary): track latest via **deliberate tested bumps** (bump gate:
    rerun cancel-matrix + provider-switch + resume on each new version). Exact-pin the dep because
    npm 0.0.x semver makes `^0.0.12` resolve to exactly 0.0.12 anyway — pinning is free and makes
    intent explicit. Binary floor `>=0.0.11` (evidence base) + prompt users to latest.
    Never ambient floats: fx broke API in 6 of 11 releases.
  - `@modelcontextprotocol/sdk` / ACP TS SDK: latest at implementation start (M3 / M6).
  Envelope `{subzeroVersion, fxSdkApiVersion, sessionId}`.
- Resume across versions: same SDK → resume; newer → best-effort; older → refuse `update_subzero`.
- Errors (codes, stable): `provider_unknown`, `provider_unavailable`, `unsupported_by_provider`,
  `template_unknown`, `version_unsupported`, `busy`, `unknown_id`, `stopped`, `depth_exceeded`.
- Limits: `maxChildren` (default 4, refuse `busy` beyond), instructions ≤64 KiB, update tail ≤8 KiB
  per event, tool results spill to files (8 MiB fx frame / 50 KiB Pi / 25k tok CC walls).

## 10. Hosts (deferred — build last, each maps §1–§2 onto native surface)
Pi: `registerTool` + `/subagent` commands + `promptSnippet` catalog + `session_shutdown` hook.
CC: plugin + MCP server (namespace automatic; `subscribe`→polling). ACP: stdio agent
(`session/*` = §1; steer as `_subzero/steer` until upstream).

## 11. Evidence appendix (Docker-verified 2026-09-28/30, repro in `docker/{fx-src,libfx-play,pi-proof}`)
ACP: spawn/prompt/cancel/load work (`end_turn`, usage, `configOptions`); steer absent. libfx@0.0.11:
custom providers broken (streams then `refused`; no upstream issue exists — file it, refs #160/#514
near-misses). Credentials: `$HOME/.fx` profile files, inherited (parent token proven on codex
transport). TLS: http loopback-only; no underscore hostnames. Runtimes: fx native Node≥20 + glibc
2.34+; Pi needs Node ≥22.19.

Experiment round 2 (2026-09-30):
- E3 provider switch mid-session: `session/set_config_option` (`configId:"provider"`, value=provider
  id) WORKS — routing changed to second mock; per-session provider selection is ACP-native, so
  subzero needs NO per-child settings.json (configOptions also enumerate gateway/codex/grok/custom).
- E4 `fx --version`: bare semver `0.0.11`, exit 0 — parse-stdout gate is stable.
- E5 concurrency: 4 parallel `fx acp` processes, one shared `$HOME/.fx` — 4/4 `end_turn`, zero lock
  errors. `maxChildren` default 4 is safe.
- E6 cancel matrix: mid-turn → `cancelled` (settles); double-cancel → no-op, process healthy;
  cancel after `end_turn` → no-op; `session/load` while busy → fast typed `Session is busy`.
  Upstream leaves these unspecified (E9) — our matrix IS the contract.
- E10 limits: 512 KiB prompt accepted; 40 KiB deltas delivered untruncated → OUR clamps
  (8 KiB/update tail, 64 KiB instructions) are policy, not transport necessity.
- E1 wasm-direct: DEFERRED (M4+). fx-core.wasm needs 38 WASI fns + 16 `fx.*` host imports
  (sessions, oauth, tools, steering, http) — bounded work (~200–400 LOC, reference in
  `fx-sdk.js createRuntime`) but coupled to fx internals; binary mode already proven, so the
  zero-install win does not justify the maintenance now. libfx-in-proc remains the steer-capable
  wasm option (gateway-only).
- E2 Pi lifecycle (pi@0.99.1, Docker): `session_start` fires only after `session.bindExtensions()`
  (SDK does not auto-bind — M1 adapter must call it); `session_shutdown` fires on `/reload` and
  session replacement (reason field) — exactly the stale-ctx risk; abrupt parent death is covered
  by **stdin EOF self-exit** (fx acp exits ~10ms after pipe close, code 0) — no orphans. Real LLM
  round-trip via `models.json` compatible endpoint (`api:"openai-completions"`, dummy apiKey)
  works; drift check 0.87.1→0.99.1: registerTool/appendCustomEntry/models.json shapes unchanged.
- E9 upstream sweep: no existing libfx+providers issue (ours to file); ACP `session/cancel`
  core semantics specified, double/no-op/load cases UNSPECIFIED; PR #1261 (steer) still open;
  **PR #1992 subagents RFD MERGED 2026-09-30 (unstable)** — M6 must adopt upstream subagent
  schema when stable instead of inventing child-session conventions.
