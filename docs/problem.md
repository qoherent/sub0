# Problem statement

> **Vocabulary (2026-11-12).** Below, "host" means either kind of coding agent. In the design, a **parent host** is
> the agent you work in and a **child host** is the agent subzero starts; see [design.md](design.md) §1.

## Context

Coding agents (Claude Code, Codex CLI, pi, ...) are extended with **skills**: folders with a `SKILL.md`
plus scripts and references, following the [Agent Skills](https://agentskills.io) standard. All three hosts
load skills the same way. The name and description of every skill sit in the system prompt on every turn.
The full body is read into the main conversation when the model decides to use the skill.

## In one paragraph

subzero lets a skill say how it should run as a sub-agent (model tier, tools, reasoning), once.
Whichever agent you work in (Claude Code, Codex or pi) delegates to it, on the model you choose,
including a local one. The skill's instructions and tool output stay in the child. Your main
conversation only sees the brief and a short result.

## The problem

1. **One model for everything.** A skill runs with the parent's model and reasoning level. Many skills
   (format conversion, codebase search, a domain-specific checklist) would run better or cheaper on a
   different model, effort level, or even a different agent CLI, such as a local Qwen model under pi.
   Routing bulk work to a local LLM also takes it off the paid model and its quota.
2. **Each host has its own composition format.** Claude Code subagents (`.claude/agents/*.md`), Codex
   subagents (`.codex/agents/*.toml`) and pi's subagent example (`~/.pi/agent/agents/*.md`) are
   configured differently and only spawn their own kind of agent. A skill author cannot say "this
   skill runs as a sub-agent on a medium model" once and have it work from every parent agent.
3. **Skills pollute the main context.** Once a skill is loaded, its instructions, the files it reads and
   its tool output stay in the parent conversation long after the task is done. Claude Code even keeps
   invoked skill content through compaction (up to 5k tokens per skill, 25k in total). The parent pays
   for that in tokens, attention and drift on every later turn. It hurts most in **long parent
   sessions** and on **models with small context windows**, where one skill body plus its tool output
   is a large share of what is available. Within a single host, native features already cover this
   (see the positioning section below). subzero gives the same benefit across hosts and models.

**Not a problem subzero solves: the skill listing.** Every installed skill's name and description sits
in the parent's prompt on every turn. A proxy skill (design §5.2) needs the same description so the
parent knows when to use it, so the listing costs the same. The only saving is when one agent bundles
several skills behind one proxy, or when helper skills are used only by the child.

## What subzero is

A **declarative composition layer for skill-scoped sub-agents**, the way docker-compose is for containers.

```yaml
agents:
  semanticizer:
    description: Extracts a semantic model from source files.  # what the parent routes on
    skills: [skill-a, skill-b]
    host: pi            # claude | codex | pi | any ACP agent
    model: ollama/qwen3-coder
    reasoning: high
```

- A **parent adapter** gives the parent agent a tool, a plugin or an extension. The parent delegates a
  task to a named agent, and only a short result comes back.
- The **core** resolves the definition, prepares an isolated child with exactly those skills, runs it,
  tracks its state, and disposes of it when done.
- A **child adapter** drives the sub-agent's CLI, either through its native headless protocol or
  through ACP.

Because the child is a separate process with a fresh context, the skill content lives and dies with
the child. The parent only ever sees the agent's description and the result.

## Who it's for (v1)

Two users who meet in the skill manifest (D17):

- **Skill authors.** They know their skill should run in its own context, on a certain class of model,
  with certain tools. They say so once, in `agents/subzero.yaml` next to `SKILL.md`, using model
  *tiers* rather than endpoints. The skill then runs as a sub-agent under whatever parent the user has.
- **Solo developers.** They install those skills and decide where they actually run: `tier:medium`
  becomes their local Qwen, a cheaper hosted model, or another agent CLI. They own endpoints,
  permissions and trust.

The author recommends and the developer decides, like a Dockerfile and a compose file.

**Not the v1 user:** teams that want one shared config across teammates on different hosts. The design
supports them (a committed `.agents/subzero.yaml`, the lock file, repo trust), but v1 is not built
around them.

## Goals

- G1: YAML defines skill-scoped agents. It is versionable, reviewable and works across hosts. The
  definition can live in the workspace (`.agents/subzero.yaml`), be shipped with the skill itself
  (`agents/subzero.yaml`), or both, with the workspace taking precedence.
- G2: The parent context grows only by the delegation request and the result (the child's final answer, never its transcript).
- G3: Any supported parent can call a child on any supported host. Mixed pairs, such as a Claude Code
  parent with a pi + Qwen child, are a first-class case.
- G4: The core manages child lifecycle and state: start, stream, follow-up, cancel, timeout and cleanup.
  The child's *context* is thrown away when the task ends. Its *session record* is kept, so a run can
  be inspected, rerun, resumed, forked or taken over interactively in the child agent.
- G5: Skills are strictly isolated. A child sees exactly the declared skills and nothing from the user's
  or the repo's global skill directories. It still runs under the user's own login and session storage,
  with no API keys and no copied credentials.

## Non-goals (v1)

- Not a general multi-agent framework: no agent-to-agent chat graphs and no planner.
- Not a skill authoring tool or a marketplace.
- Not a sandbox. Process and filesystem safety are left to the host's own sandbox and permission modes.
- Not a replacement for native subagents when parent and child are the same host and model family.

## Positioning against native features (honest overlap)

As of Oct 2026, every host can already do part of this on its own:

| Host | Native feature | What it does not cover |
|---|---|---|
| Claude Code | Skill `context: fork` with `agent:`, `model:` and `effort:` set in the skill. Subagents can preload skills with `skills:`. Skills can be hidden with `disable-model-invocation`. | Anthropic models only (officially). Runs in the same process with the parent's permissions and MCP servers. Claude Code only. |
| Codex | Subagents (TOML) with `model`, `model_reasoning_effort` and per-agent skill *disabling* | Skills can't be *added* per agent. Sandbox, provider and MCP can't be changed per agent. Codex only. |
| pi | `examples/extensions/subagent` spawns `pi` subprocesses | It is an example, not a product. No skill scoping. pi only. |

**subzero only earns its place for:** cross-host or cross-model delegation, one portable definition, a
real process boundary with strict skill isolation, and managed sessions you can observe. If a team only
uses Claude Code with Claude models, `context: fork` skills cover most of this. The design must stay
honest about that and could compile to native features where that is possible (see
[decisions.md](decisions.md), D12).

## Success criteria

- A parent in each of Claude Code, Codex and pi can list the agents, delegate a task, and get a result.
  The parent's context grows by the child's final answer only, whole; the brief tells the child a reply budget.
- The child's loaded-skill set, checked from the host's own init event, equals the declared set.
- A child that hangs, crashes or overruns its budget is reported as a typed failure. It never hangs
  the parent.

See [design.md](design.md) for the domain design, [feasibility.md](feasibility.md) for the integration
research, and [decisions.md](decisions.md) for open decisions and pitfalls.
The first target pair (Claude Code parent → pi child) is analysed in depth in
[target-claude-pi.md](target-claude-pi.md).
