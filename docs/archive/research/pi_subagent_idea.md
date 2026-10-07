> Historical research snapshot. Current v0.1 decisions and up-to-date host/worker evidence are in [design-decisions.md](../../research/design-decisions.md).

# Pi Harness — Summary

- TS monorepo; host = `packages/coding-agent` (CLI), runtime = `packages/agent`.
- Extensions: `pi.registerTool({name, parameters(TypeBox), execute(...)})` (`extensions/types.ts`).
- Tool ctx: `{cwd, sessionManager(read-only), modelRegistry, model, signal, abort(), isIdle()}`.
- Sessions: JSONL tree (`session-manager.ts`); run via `AgentSession prompt/steer/abort/waitForIdle`.
- No subagent/Task/background tool in product; pico spec says "not yet available".
- No MCP client in-repo; skills = `SKILL.md` dirs, loaded on demand.
- Nested LLM today: `modelRegistry.streamSimple/complete` (single-shot, no toolbelt).
- `newSession/fork/switchSession` are command-context only, not in tool `execute()`.

## Takeaway for Pi plugin

- Greenfield: new extension `pi-subagent-fx` with `subagent` tool + `/subagent` commands.
- Spawn via `libfx createFxAgent`, not Pi sessions; persist `{agentId, fxSessionId}` in details.
- Actions: `spawn/send/stop/resume/list`; stream via `onUpdate`, honor Pi `signal`.
- Templates = per-spawn instructions + tool allowlist + skill files + MCP prefix.

> POSTSCRIPT (2026-09-28): naming superseded — the package is `@subzero/pi`
> (lockstep with `@subzero/core`); engine detail moved to docs/DESIGN.md §6.
> Extension-API facts above were runtime-verified (../docker/pi-proof).
