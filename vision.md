# Vision (owner's requirements — human-written, do not edit via agents)

1. Agnostic subagent plugin: study Codex, OpenCode, DeepSeek harnesses, then build one plugin that works across harnesses.
2. Spawn a subagent with a prompt; the subagent must see the codebase.
3. Subagents can be stopped and resumed (normal agent sessions underneath).
4. Use a bare-minimal harness under the hood (fx proposed; open to change).
5. Two or three subagent templates (e.g. researcher, coder), each with own skills, tools, and MCPs.
6. Any harness is allowed: harnesses WITHOUT native subagents (e.g. Pi) use us as the subagent system; harnesses WITH native subagents (e.g. Claude Code) get us as an additive fx-backed path.
7. First target is Pi; publish at pi.dev/packages.
8. LLM endpoint (URL/model/key) comes from call args, not host config.
9. Core is harness-agnostic (a tool or equivalent); per-harness thin adapters, never Pi-specific core.
10. fx stays barebone: no subagents of its own, no weird tools — minimal engine only.
11. fx as dependency, not a fork, unless a kernel-level need forces it.

Anything not listed here is agent-proposed (see docs/PLAN.md), not a requirement.
