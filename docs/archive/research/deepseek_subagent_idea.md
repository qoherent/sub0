> Historical research snapshot. Current v0.1 decisions and up-to-date host/worker evidence are in [design-decisions.md](../../research/design-decisions.md).

# DeepSeek Harness (`dsh`) — Summary

- Architecture: everything-is-a-plugin on Cordis; agents/tools/sessions are services.
- No `Task` tool; equivalent = `subagent` + `subagent_fork` model tools.
- Core seam: `packages/subagent/subagent/src/types.ts` (`Provider/StartRequest/Run/Continuable`).
- Providers: `spawn` (fresh), `fork` (inherits parent turns), `acp/codex/claude-code/dsh-sdk`.
- Tool: `tool-subagent/src/index.ts` (`description, prompt, provider?, model?, run_in_background?`).
- Control: `tool-subagent-control` (`send_message/interrupt_agent/list_agents`).
- Sessions: `core/session` (events log, `create/fork/flush`); agents: `core/agent` (`create/resume/cancel`).
- Stop: `agent.cancel()` + `handle.dispose()`; background via `ctx.jobs` (`job_output/list/kill`).
- Resume: `agents.resume(sessionId)` or `sendMessage` to continuable child; JSONL persistence.
- Templates: presets = standing Cordis subtrees (`preset/agent-preset`), persona rows.
- Scoping: per-agent ctx + `tools.restrict()`, skills `{scope}`, MCP `mcp__server__tool`.
- Isolation: worktree mode deferred/not implemented.

## Takeaway for Pi plugin

- Best reference: `SubagentProvider + capabilities + toolFilter/persona/maxDepth` seam.
- Copy: foreground vs background-job vs continuable split; `send/interrupt/list` controls.
- Pi = fallback case: implement minimal `subagent` tool on `fx` with preset-like templates.
