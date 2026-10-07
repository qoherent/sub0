## 11. Evidence appendix (Docker-verified 2026-09-28/30, repro sources in `../docker/{fx-src,libfx-play,pi-proof}`)
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
