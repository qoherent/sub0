# subzero: implementation status

Status as of 2026-11-12 on branch `feat/pi-parent-extension`. The pi parent,
Claude cancellation paths and background completion fallback are implemented.
The real two-parent acceptance checks in the plan remain to be run by a person.

This page compares what is built with what the design asks for. It has two
sources that do different jobs:

- **The contract** is the Sigil designs in [design/](../design/). They describe
  the spike and the work since then, and where they differ from the prose
  documents they win.
- **The target** is [design.md](design.md), [decisions.md](decisions.md) (its
  "Suggested phasing" section) and [problem.md](problem.md). They describe the
  whole product, most of which is planned for v0.2 and later.

**Versions.** v0.1 is the preview release (`0.1.0-preview.N`): the spike, tiered
routing and the plugin distribution, which is what this repository builds
today. v0.2 starts the task model with `continue` and `ask`, and the later
milestones follow the phasing in decisions.md.

The three plans in [plans/](plans/) record what each piece of work set out to
do, what it deferred, and how it was checked.

## At a glance

| Area | State |
|---|---|
| Sigil contract (13 components) | Both parent adapters and the Claude plugin commands have implementing code. `sigil check .` reports no diagnostics. |
| Claude Code parent, pi child | Built and checked live with Claude Code 2.1.318 and pi 0.87. |
| Tiered subagent routing for compound-engineering | Built and accepted in the R17 live run and its probes. |
| Plugin distribution (`subzero@qoherent`) | Built and tested locally. A previous `plugin` branch is published; these changes and the pi package branch have not been published. The release workflow, first tag and model-backed walkthroughs are still to do. |
| Spike experiment (A/B on sigil-evaluate) | Partly run. Planned passes are missing and no go/no-go decision has been written. |
| v0.2 and later (task model, config layering, other hosts) | Not started. |

The test suite, typecheck and release build are run locally for this branch.

## What is implemented

### By Sigil component

| Component | Design | Code | What it covers |
|---|---|---|---|
| Kernel | [kernel.sigil](../design/kernel.sigil) | `src/kernel/` | Child drivers registered by host, parent adapter names; the child port, attach command, session export, starter tools and prerequisites check of a host. |
| TaskCore | [task-core.sigil](../design/task-core.sigil) | `src/core/` | Task, run and result shapes, the launch spec, task ids, result shaping (whole, never cut). |
| AgentConfig | [agent-config.sigil](../design/agent-config.sigil) | `src/config/` | `.agents/subzero.yaml`: `models.tiers`, `general` and `fallback` agents, `endpoints` with `parallel`, `routing`, load and unknown-agent errors, `init`'s starter entries. |
| DelegationService | [delegation-service.sigil](../design/delegation-service.sigil) | `src/service/` | Project root, start-up sweep, agent lookup per delegation, live task registry, per-endpoint parallel limit (queued vs started), status and result wording. |
| TaskStore | [task-store.sigil](../design/task-store.sigil) | `src/store/` | `.agents/subzero/` (owner-only, self-ignoring), `index.jsonl`, task records, `abandoned` status. |
| PiDriver | [pi-driver.sigil](../design/pi-driver.sigil) | `src/pi/` | `pi --mode rpc` with skill isolation (`--no-skills --skill`, `-ne`, `-nc`), skill verification, timeouts, typed failures, cancel, attach, HTML export, `pi --version` prerequisite check. |
| ClaudeMcpServer | [claude-mcp-server.sigil](../design/claude-mcp-server.sigil) | `src/mcp/` | Four MCP tools (`delegate`, `tasks`, `await`, `cancel`), progress notifications, the 48,000-character reply budget, parent session id per session. It reports the `package.json` version, which the build stamps into the bundle. |
| PiExtension | [pi-extension.sigil](../design/pi-extension.sigil) | `src/pi-parent/` | pi as a second parent host: `subagent`, `subzero_await`, `subzero_tasks`, `subzero_cancel`, `/subzero`, `/subzero init` with its run-scoped init tools, and a session core for each pi session. |
| ClaudePluginCommands | [claude-plugin-commands.sigil](../design/claude-plugin-commands.sigil) | `skills/cancel/` | The user-only `/subzero:cancel` plugin skill. |
| ClaudeRoutingHooks | [claude-routing-hooks.sigil](../design/claude-routing-hooks.sigil) | `src/routing/` | SessionStart routing text; PreToolUse redirect on `Agent\|Task` with readiness marker, deny memory, pass-back, fork and `isolation` exemptions. |
| Cli | [cli.sigil](../design/cli.sigil) | `src/cli/` | `subzero init`, `config`, `run`, `tasks`, `attach`, `show`. |
| SigilWiring | [sigil-wiring.sigil](../design/sigil-wiring.sigil) | `examples/sigil/` | The agent file and README of the sigil experiment. |
| SpikeHarness | [spike-harness.sigil](../design/spike-harness.sigil) | `bench/`, [spike-results.md](spike-results.md) | The measurement harness, scorer and results table. |

Each source file names the component it implements in an `@sigil implements`
line. A conformance review (the `sigil-align` skill) was last run on Kernel,
PiDriver, TaskCore and Cli for the prerequisites check (2026-11-10). The other
components were last reviewed during the tiered routing work.

### By plan

| Plan | Units | State |
|---|---|---|
| [Spike](plans/2026-11-02-1109-feat-subzero-spike-plan.md) | U1–U8 | U1–U7 done. U8 (the comparison and the decision) is partly done; see below. |
| [Tiered subagent routing](plans/2026-11-06-0953-feat-tiered-subagent-routing-plan.md) | U0–U6 | Done. The R17 acceptance run and its probes are in [spike-results.md](spike-results.md). Decision 24 (results are never cut) replaced the plan's `await` share. |
| [Plugin distribution](plans/2026-11-10-1355-feat-claude-plugin-distribution-plan.md) | U1–U7 | U1–U6 done. U7 (the acceptance walkthroughs) is not run. |

The distribution work added:
- the Apache-2.0 license and version `0.1.0-preview.1`;
- the `bin/subzero` launcher, which checks for Node 22;
- the `/subzero:init` and `/subzero:tasks` commands;
- the release zip and local marketplace build (`npm run release:build`);
- `npm run release:branch`, which builds the `plugin` branch (the built plugin plus its
  marketplace file) that users add with `claude plugin marketplace add
  qoherent/sub0@plugin`, and pushes it only with `--push`;
- the marketplace generator and the tag-triggered release workflow;
- the [README](../README.md), the [configuration reference](configuration.md)
  and [releasing.md](releasing.md).

## What is left

### 1. To finish the current work

- Deny-memory cleanup uses per-session operating-system locks so it cannot
  remove a denial while another hook uses that session. A missing `lockf`
  (macOS) or `flock` (Linux) makes the hook allow the Agent call through.

**Release (distribution plan U7 and the transfer)**
- Stage 1 walkthrough: install from `dist-release/local-marketplace` on a clean
  profile and run `init`, `tasks` and a routed task. It needs a logged-in
  profile and a reachable model endpoint.
- The rest of the [after-the-transfer checklist](releasing.md): Actions write
  permission, tag and branch protection, and the first tag. The transfer and the
  scan are done; see [distribution-results.md](distribution-results.md).
- The first tag. The release workflow has never run, so its push of
  `.claude-plugin/marketplace.json` to the default branch is untested.
- Stage 2 walkthrough: a newcomer follows the README alone, then updates from
  one preview to the next (AE1, AE3).
- A code review of the distribution changes, which has not been run.

**Parent extension changes (2026-11-12)**
- `AgentConfig`: `medium` is the default tier and `default` has no special role; the file must hold `medium`, `general` and
  `fallback`; the routing settings moved to the hooks; no `parent session model`, session agent definition or
  starter general agent.
- `DelegationService`: the completion notice and the stop notice (one for each stopped task) and the session
  cancel; the project root is resolved once for each service.
- `ClaudeMcpServer`: MCP tasks, the task mode in the readiness marker, `wait` defaulting by task mode, `cancel`
  with no task id, a cancel on session change.
- `ClaudeRoutingHooks`: mode-neutral routing text and deny reason while no task mode is known; it owns the
  routing settings.
- `Cli`: `init` writes the `medium` tier; `SigilWiring`: the example file holds `medium`, `general`, `fallback`.
- `PiExtension` and `ClaudePluginCommands` are built (see the table above).
- The plan for this work is [plans/2026-11-11-1012-feat-pi-parent-extension-plan.md](plans/2026-11-11-1012-feat-pi-parent-extension-plan.md).

**Guided init (2026-11-16)**
- `/subzero:init` with no model in Claude Code and `/subzero init` in pi run the
  same guided setup: they list the child host's models, suggest a model for
  `small`, `medium` and `large`, ask each endpoint's `parallel` limit, offer a
  one-turn reachability check, and write `.agents/subzero.yaml` only after the
  user confirms subzero's diff. `init <model>` stays as the quick path.
- One setup service serves both parents. Claude Code reaches it through the
  `subzero config` commands; pi through init tools that are on only during a
  `/subzero init` run.
- `subzero init` with no model in a terminal is a usage error that names both
  parent commands. Load errors that said "run subzero init" now name them too.
- The plan for this work is [plans/2026-11-16-1601-feat-guided-subzero-init-plan.md](plans/2026-11-16-1601-feat-guided-subzero-init-plan.md).

**Decisions waiting on the user**
- Answered and implemented 2026-11-12: `subzero init` writes a `medium` tier,
  and the file must also hold `general` and `fallback`.
- The README lists a fifth known limit: a cloned project's agent file is
  executable-grade configuration. It was added as the conservative default and
  needs the user's confirmation.

**Open problems**
- A newcomer cannot easily run `subzero show` or `subzero attach`. The plugin
  puts no `subzero` command on the user's PATH, and the distribution plan
  deferred slash commands for both (`attach` follows a live child and suits a
  terminal; `show` opens an exported page). For now the README says to run them
  as `node <plugin folder>/dist/cli.js show <task id>` (or `attach`), with the
  folder taken from `claude plugin list --json`, and gives plain `pi` commands
  for reading a child session.
- The install commands in the README name `qoherent/sub0@plugin`, which is published. The repository
  has no marketplace file on `main`. When a release is cut, the
  catalog moves to `main` and users who installed from the branch must remove the
  `qoherent` marketplace before they add the release one.

**Spike experiment (spike plan U8)**
- Not all planned passes were run. The plan asked for three passes each of A and
  B and one each of B-low, A-cheap and B-control. The table holds one A pass,
  three B passes, one B-low pass, one A-cheap pass and no B-control pass.
- The manual review-quality table is empty.
- In the plumbing checks, several live checks are still "pending": R3, the
  orphan check of R4, R5, the attach check of R7, and R9 and R10.
- The go/no-go paragraph for v0.2 is empty. The user writes it.

**Small loose end**
- The demo files name the `r9700` endpoint on purpose. The R17 run used a
  `local` provider in its copy because `r9700` was down, and spike-results.md
  records that.

### 2. Known limits of what is built

These are listed on the install page and are not fixed:
- The routing hook ignores plan mode. A generic spawn in plan mode still goes to
  the `general` agent, which can write files and run commands inside pi.
- The general agent works outside Claude Code's permission prompts; git is the
  only record of what it changed.
- The parallel limit and the queue are per Claude Code session.
- If the MCP server fails to start, the session-start text still says routing is
  on, and every subagent runs on Claude.
- Worktree-isolated and fork spawns always stay on Claude.
- The agent file is not gated by a trust step (design.md §4.2 asks for one).
- pi is the only child host, Claude Code the only parent, and Windows is not
  supported.

### 3. Deferred by the plans

From the tiered routing plan:
- a worktree mode for `delegate`, so worktree-isolated spawns can route;
- a plain model id on `delegate` beside tiers;
- cancelling several tasks in one call;
- an endpoint queue shared across Claude sessions;
- per-host tool lists, to decide when a second host exists;
- a use for parent adapter names beyond refusing a duplicate;
- a server-verified pass-back permit;
- a hook-side host check;
- tiers in a user-level config file.

From the distribution plan:
- automatic installation of pi (the guided `/subzero:setup` it also deferred is
  now built as guided `init`; see above);
- a preview channel beside a stable one;
- an npm package and a CLI usable outside Claude Code;
- a central directory listing;
- an automated install check of the release zip;
- slash commands for `show` and `attach`.

### 4. The rest of the design (v0.2 and later)

The spike plan left these out on purpose. They come from design.md and the
phasing in decisions.md, and none of them is built.

**v0.2**
- The rest of the task model: `continue` (with respawn), `ask` (read-only probe
  fork), `fork`, `rerun` and the report (design.md §3.5, §6.3). The MCP server
  has four of the six tools in §5.1 (`continue` and `ask` are missing), and
  `delegate` has no `from` input.
- The other CLI commands of §6.3: `report`, `ask`, `continue`, `fork`, `rerun`,
  `logs` and `prune`, plus `subzero validate` and `subzero config`.
- Config layering (§4.1): `subzero.local.yaml`, `~/.agents/subzero.yaml`, skill
  manifests (`agents/subzero.yaml` in a skill, D17), `enabled: false`.
- Skill sources and pinning: git sources and `subzero.lock` (D13).
- Endpoint fields `base_url`, `api` and `api_key`; today pi's own `models.json`
  holds the server.
- The repo trust step for `.agents/subzero.yaml` (§4.2).
- Permissions mapped to the host (`read-only`, `workspace-write`, `full`, D8)
  and `needs_input` results for questions and permissions (D9).
- `record: none`, `process: keep`, `retention`, an idle timeout, and
  `result.report_file`.
- Structured output (`output.schema`).
- Proxy skills (§5.2), generated `host: native` subagents (D12), and
  `host: inline` agents.
- Nested delegation with `delegates:` and `maxDepth` (D14).
- sigil-write as the second workload.
- A Codex child driver.

**v0.3**
- A Claude child driver.
- The pi parent extension and the Codex parent plugin.

**v0.4**
- A generic ACP child driver.
- Worktree mode.
- Structured outputs on every host.
- Compiling to native features where it pays (D12).

**Product goals not yet met** ([problem.md](problem.md)): a parent in Codex and
in pi (G3 and the first success criterion); a definition shipped with a skill
(G1); follow-up, rerun, resume and fork of a task (G4). G2 and G5 hold for the
Claude Code to pi pair.
