> Historical research snapshot. Current v0.1 decisions and up-to-date host/worker evidence are in [design-decisions.md](../../research/design-decisions.md).

# OpenCode Subagents — Summary

- Delegation via `task` tool, not SDK: `packages/opencode/src/tool/task.ts`.
- Input: `{ description, prompt, subagent_type, task_id?, background? }`.
- Spawn = child session: `sessions.create({ parentID })`, no message copy.
- Fork (`createNext` + copy) is separate from subagent create.
- Depth guard: walk `parentID` chain, cap `subagent_depth ?? 1`.
- Permission shrink: deny `todowrite/task/primary_tools` (`subagent-permissions.ts`).
- Model inherit: `next.model ?? parent model/variant`.
- Stop: `ops.cancel(child)` + `background.cancel(child)` + abort listener.
- Resume: call `task` again with `task_id` (= child sessionID).
- Background: `background.start({id})`, return `running`, inject result later.
- Templates: builtins `build/plan/general/explore` (`agent/agent.ts`).
- Custom: `{agent,agents}/**/*.md` + `{mode,modes}/*.md`.
- Tools/MCP/skills filtered per turn by `agent.permission + session.permission`.
- Isolation: none per-subagent; shared cwd, `worktree/` not wired to `task`.

## Takeaway for Pi plugin

- Reference design: `spawn(prompt, type) -> childID; cancel; resume(task_id)`.
- Copy shapes: permission shrink, model inherit, `<task id state>` envelope.
- Pi = fallback case: implement this on `fx` sessions; OpenCode needs no shim.
