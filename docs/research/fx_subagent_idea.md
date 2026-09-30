# fx Harness — Summary

- Zig 0.16+ minimal harness; embed via `libfx` WASM (`createFxAgent/Terminal`).
- Surfaces: interactive `fx`, one-shot `fx ask`, `fx acp` (JSON-RPC), `libfx` SDK.
- Sessions: `~/.fx/sessions/<id>/session.json + events.jsonl`; child `subagent/` dir.
- Spawn: `session/new` + `session/prompt`; resume: `session/load|resume|list`.
- One-shot: `cli_ask.zig` (`--model/--effort/--resume/--system/--json/--timeout`).
- Stop: ACP `session/cancel`, libfx `turn.cancel()`, CLI SIGINT.
- Tools: 17 builtins (`builtins/tools.zig`); contracts in `core/tooling/`.
- Skills: `SKILL.md` + frontmatter; host-supplied in libfx (`skills.js`).
- MCP: host-owned adapters (`sdk/mcp.js`, 64-tool cap, prefix names).
- Templates: per-spawn `instructions + tools[] + skills + MCP`, no global registry.
- Has native `subagent(run/message)` tool, but we use fx as engine, not host.

## Takeaway for Pi plugin

- Use `libfx`, not `fx ask` subprocess: isolated instance per subagent, real cancel.
- Pi tool `subagent(prompt, template) -> id`; `send/stop/resume/result`.
- Template = instructions + tool allowlist + skill files + MCP prefix.
- Persist `{checkpoint, templateId, model/effort}` in Pi state for resume.

> POSTSCRIPT (2026-09-28, post-Docker experiments): superseded in part —
> the default engine is now fx-over-ACP (binary/wasm), not libfx: libfx breaks
> on custom providers (v0.0.11) and ACP lacks steer (core queues sends).
> See docs/DESIGN.md §6 for the verdict and this file's facts remain valid.
