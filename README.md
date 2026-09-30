# subzero — harness-agnostic subagents, fx-backed

One `subagent` core (`spawn/send/stop/resume/list/subscribe`), three doors:
Pi extension (first), Claude Code MCP plugin, ACP agent (Zed & friends).
Each child is an isolated fx agent — its own LLM endpoint (Vercel Gateway,
Codex sub, your own fleet), zero-default tools, checkpoint resume.
Targets harnesses without native subagents; additive for the rest.

## Layout
- `vision.md` — owner requirements (human-only; agents must not edit).
- `docs/PLAN.md` — strategy: interface, engine verdicts, milestones (80 lines, keep it).
- `docs/DESIGN.md` — engineering details: config, persistence, versioning, Docker findings.
- `docs/research/` — harness studies: Codex, OpenCode, DeepSeek-harness, fx, Pi.
- `docker/` — reproducible experiments: `fx-src` (build + ACP driver), `libfx-play`, `pi-proof`.
- `fx/`, `pi/` — reference clones (upstream sources; do not modify here).

## Current decisions (evidence in docs/DESIGN.md)
- Engine: fx per child via ACP (`session/new|prompt|cancel|load`) — native binary
  on PATH, `fx-core.wasm` fallback. libfx SDK = gateway-only (custom providers
  broken upstream, v0.0.11).
- Providers: pass-through to fx configured-provider settings; no provider logic of
  our own. Codex-sub/credentials inherit via shared `$HOME/.fx` (mock-proven).
- Steer: ACP has none — core queues `send` while running, delivers on `end_turn`.
- Language: TypeScript, dependency-free ESM; adapters are thin.

## Next steps
1. M1: scaffold `@subzero/core` + `@subzero/pi`; `spawn/send/list` end-to-end in Docker.
2. File upstream libfx+providers issue (repro in `docker/libfx-play/`).
3. M2 stop/resume; M3 templates + MCP; M4 commands + e2e; M5 CC adapter; M6 ACP adapter.
