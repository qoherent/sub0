> Historical research snapshot. Current v0.1 decisions and up-to-date host/worker evidence are in [design-decisions.md](../../research/design-decisions.md).

# Codex Subagents — Summary

- Delegation via model tools, not SDK calls:
  `spawn_agent, send_message, followup_task, wait/interrupt/list_agents`.
- Core: `codex-rs/core/src/tools/handlers/multi_agents_v2/`, spec in `spec_plan.rs`.
- Every spawn = real thread: `SessionSource::SubAgent{parent, depth, agent_path, role}`.
- API shape: `spawn/resume/send/interrupt/close/inspect/list/watch` (`agent/api.rs`).
- Context: `fork_turns: none|all|N` controls inherited history.
- Codebase: shared cwd/container, no auto worktree isolation.
- Stop/resume: `interrupt/close` + `thread/resume/list/read` over JSONL rollouts.
- Templates: `agent_type` -> `codex-rs/agent-roles/` (role + prompts + model override).
- Skills/MCP/tools inherited from parent; collab tools are trusted-direct.
- Concurrency cap: `max_concurrent_threads_per_session`.
- Parent notified via `<subagent_notification>` events.
- SDKs lack `spawnSubagent()`; spawning happens inside a turn.

## Takeaway for agnostic plugin

- Scope: native passthrough where subagents exist; fx fallback only where missing (e.g. Pi).
- Codex needs no shim — use its native `spawn_agent` + roles directly.
- For fallback harnesses, copy Codex shape: `spawn(prompt, fork, type) -> id`.
- Map `type` -> role/skills/tools/MCP/model; default shared cwd.
- Persist thread IDs + spawn edges for stop/resume.
