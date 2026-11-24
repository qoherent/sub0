# subzero: implementation status

Status as of 2026-11-23 on branch `docs/v0.2-continue-steering`. The pi parent,
Claude cancellation paths, background completion fallback, guided init, the
global config file and v0.2 (`continue` with steering on both parents, parallel
limits per model) are implemented. The live acceptance checks of the v0.2 plan
and the real two-parent acceptance checks remain to be run by a person.

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
today. Some later work is built already: the pi parent (planned for v0.3), and
guided init and the global config file (part of the old v0.2). v0.2 was narrowed
on 2026-11-23 to `continue` with steering on both parents and parallel limits
per model (decisions 35–60 in decisions.md), and is built on this branch; the
later milestones follow the phasing there.

The plans in [plans/](plans/) record what each piece of work set out to
do, what it deferred, and how it was checked.

## At a glance

| Area | State |
|---|---|
| Sigil contract (13 components) | Both parent adapters and the Claude plugin commands have implementing code. `sigil check .` reports no diagnostics. |
| Claude Code parent, pi child | Built and checked live with Claude Code 2.1.318 and pi 0.87. |
| pi parent, pi child | Built (planned for v0.3, done early). The two-parent acceptance checks are still to be run by a person. |
| Guided init and the global config file | Built: `init` with no model in both parents, `~/.agents/subzero.yaml` under the project file, `enabled: false`, pi extensions for every pi run. Init now asks a limit per model and repairs an `endpoints:` file. |
| Tiered subagent routing for compound-engineering | Built and accepted in the R17 live run and its probes. |
| Plugin distribution (`subzero@qoherent`) | Built and tested locally. A previous `plugin` branch is published; these changes and the pi package branch have not been published. The release workflow, first tag and model-backed walkthroughs are still to do. |
| Spike experiment (A/B on sigil-evaluate) | Partly run. Planned passes are missing; the go decision for v0.2 is written (2026-11-23). |
| v0.2 (`continue` with steering, parallel limits per model) | Built on both parents: `continue` and `subzero_continue`, steering, turns, waits that end when the user types, `models.parallel`. Documented in the README and the configuration reference. Not yet done: the live acceptance checks of [the plan](plans/2026-11-23-2054-feat-continue-steering-model-limits-plan.md) (a person runs them on both parents) and the `sigil-align` run on the eight components (the orchestrator runs it). |
| v0.3 and later (the rest of the task model, other hosts) | Not started. |

The test suite, typecheck and release build are run locally for this branch.

## What is implemented

### By Sigil component

| Component | Design | Code | What it covers |
|---|---|---|---|
| Kernel | [kernel.sigil](../design/kernel.sigil) | `src/kernel/` | Child drivers registered by host, parent adapter names; the child port, attach command, session export, starter tools and prerequisites check of a host. |
| TaskCore | [task-core.sigil](../design/task-core.sigil) | `src/core/` | Task, turn and result shapes, the launch spec, task ids, result shaping (whole, never cut). A task is a list of turns; each turn has its message, its run and its result. |
| AgentConfig | [agent-config.sigil](../design/agent-config.sigil) | `src/config/` | `.agents/subzero.yaml`: `models.tiers`, `models.parallel` (limits keyed by full model id, a null value removing an inherited one), `general` and `fallback` agents, `routing`, load and unknown-agent errors, the `endpoints:` load error with its repair data, `init`'s starter entries. |
| DelegationService | [delegation-service.sigil](../design/delegation-service.sigil) | `src/service/` | Project root, start-up sweep, agent lookup per delegation, live task registry, per-model parallel limit counted per turn (queued vs started), `continue` (held, steered or new turn), takeover of another process's task, status and result wording. |
| TaskStore | [task-store.sigil](../design/task-store.sigil) | `src/store/` | `.agents/subzero/` (owner-only, self-ignoring), `index.jsonl`, task records, one store file per turn, `abandoned` status. |
| PiDriver | [pi-driver.sigil](../design/pi-driver.sigil) | `src/pi/` | `pi --mode rpc` with skill isolation (`--no-skills --skill`, `-ne`, `-nc`), skill verification, timeouts (restarted by each delivered steering message), typed failures, cancel, `steer`, session resume for a new turn, attach, HTML export, `pi --version` prerequisite check. |
| ClaudeMcpServer | [claude-mcp-server.sigil](../design/claude-mcp-server.sigil) | `src/mcp/` | Five MCP tools (`delegate`, `tasks`, `await`, `continue`, `cancel`), waits that end when a prompt marker or call marker shows the user typed, progress notifications, the 48,000-character reply budget, parent session id per session. It reports the `package.json` version, which the build stamps into the bundle. |
| PiExtension | [pi-extension.sigil](../design/pi-extension.sigil) | `src/pi-parent/` | pi as a second parent host: `subagent`, `subzero_await`, `subzero_continue`, `subzero_tasks`, `subzero_cancel`, a message typed during a wait ends it, the notice after a reload or resume, `/subzero`, `/subzero init` with its run-scoped init tools, and a session core for each pi session. |
| ClaudePluginCommands | [claude-plugin-commands.sigil](../design/claude-plugin-commands.sigil) | `skills/cancel/` | The user-only `/subzero:cancel` plugin skill. |
| ClaudeRoutingHooks | [claude-routing-hooks.sigil](../design/claude-routing-hooks.sigil) | `src/routing/` | SessionStart routing text; PreToolUse redirect on `Agent\|Task` with readiness marker, deny memory, pass-back, fork and `isolation` exemptions; the UserPromptSubmit prompt hook and the PreToolUse call markers keyed by tool-use id that end a waited call early. |
| Cli | [cli.sigil](../design/cli.sigil) | `src/cli/` | `subzero init`, `config` (with `--limit <model>=<n>` and `--no-limit <model>`), `run`, `tasks`, `attach`, `show`. |
| SigilWiring | [sigil-wiring.sigil](../design/sigil-wiring.sigil) | `examples/sigil/` | The agent file and README of the sigil experiment. |
| SpikeHarness | [spike-harness.sigil](../design/spike-harness.sigil) | `bench/`, [spike-results.md](spike-results.md) | The measurement harness, scorer and results table. |

Each source file names the component it implements in an `@sigil implements`
line. A conformance review (the `sigil-align` skill) was last run on Kernel,
PiDriver, TaskCore and Cli for the prerequisites check (2026-11-10). The other
components were last reviewed during the tiered routing work. The v0.2 changes
have not been reviewed yet: `sigil-align` on TaskCore, TaskStore, PiDriver,
DelegationService, ClaudeMcpServer, ClaudeRoutingHooks, PiExtension and
AgentConfig is still to run (the orchestrator runs it).

### By plan

| Plan | Units | State |
|---|---|---|
| [Spike](plans/2026-11-02-1109-feat-subzero-spike-plan.md) | U1–U8 | U1–U7 done. U8 (the comparison and the decision) is partly done; see below. |
| [Tiered subagent routing](plans/2026-11-06-0953-feat-tiered-subagent-routing-plan.md) | U0–U6 | Done. The R17 acceptance run and its probes are in [spike-results.md](spike-results.md). Decision 24 (results are never cut) replaced the plan's `await` share. |
| [Plugin distribution](plans/2026-11-10-1355-feat-claude-plugin-distribution-plan.md) | U1–U7 | U1–U6 done. U7 (the acceptance walkthroughs) is not run. |
| [v0.2: continue, steering, limits per model](plans/2026-11-23-2054-feat-continue-steering-model-limits-plan.md) | U1–U13 | Built, with docs (U13 steps 1 and 2). Pending: `sigil-align` (U13 step 3) and the live acceptance checks of its Verification Contract, which a person runs on both parents. |

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
  `small`, `medium` and `large`, ask each model's `parallel` limit, offer a
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
- The go/no-go decision for v0.2 is written: go, in the narrowed scope (2026-11-23).

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
- The parallel limit and the queue are per process, and a limit belongs to one
  model id.
- A message submitted before a waited call started does not end it. After
  `/clear` the Claude Code server can follow the old session id for up to 5
  seconds, so a message typed then may not end a wait. A waited call made inside
  a Claude Code subagent never ends early.
- A model with no `models.parallel` entry has no limit, including the model of
  a continued task.
- A steer answer that arrives more than a second after its run ended is neither
  replayed nor counted in the result.
- If the MCP server fails to start, the session-start text still says routing is
  on, and every subagent runs on Claude.
- The routing hook needs `lockf` (macOS) or `flock` (Linux) for its per-session
  locks. Without it every Agent call goes through to Claude; the session-start
  text then says routing is off and names the missing utility.
- Worktree-isolated and fork spawns always stay on Claude.
- The agent file is not gated by a trust step (design.md §4.2 asks for one).
- pi is the only child host, Claude Code and pi are the only parents, and
  Windows is not supported.

### 3. Deferred by the plans

From the tiered routing plan:
- a worktree mode for `delegate`, so worktree-isolated spawns can route;
- a plain model id on `delegate` beside tiers;
- cancelling several tasks in one call;
- a model queue shared across processes;
- per-host tool lists, to decide when a second host exists;
- a use for parent adapter names beyond refusing a duplicate;
- a server-verified pass-back permit;
- a hook-side host check;
- tiers in a user-level config file (built since: the global file).

From the distribution plan:
- automatic installation of pi (the guided `/subzero:setup` it also deferred is
  now built as guided `init`; see above);
- a preview channel beside a stable one;
- an npm package and a CLI usable outside Claude Code;
- a central directory listing;
- an automated install check of the release zip;
- slash commands for `show` and `attach`.

### 4. The rest of the design (v0.2 and later)

None of this is built. The phasing is in decisions.md ("Suggested phasing"),
narrowed on 2026-11-23.

**v0.2** (built; acceptance pending)
- `continue` with steering on both parents: one tool (`continue` on Claude
  Code, `subzero_continue` on pi) that holds a message for a task that has not
  started, steers a running task and starts a new turn on a settled one, for
  the tasks of the current parent session. One result per turn. A message
  the user types during a subzero wait ends the wait early, on both parents.
  Decisions 35–47, 49–51, 54, 55, 57 and 58–60.
- Parallel limits per model: `models.parallel` keyed by model id replaces
  `endpoints:`, which is a load error that guided init repairs. Decisions 48,
  52, 53 and 56.
- Checked on pi 1.5.2 (2026-11-23): the session relaunch, late `steer`
  delivery and `/reload` session ids behave as the contracts need (see the end
  of the v0.2 decisions). Probed on Claude Code 2.1.322 (2026-11-23): a
  `UserPromptSubmit` hook fires when the user types during a blocking MCP call
  (see spike-results.md), so a waited call on Claude Code ends early when the
  user types, as on pi (decision 57).
- Still to do: the live acceptance checks of the plan's Verification Contract,
  which a person runs on each parent with a reachable model (steer a running
  task, continue a finished one, type during a waited `await` from the main
  conversation and from inside a subagent, a limit of 1 across two tiers on one
  model), and `sigil-align` on the eight components, which the orchestrator runs.

**v0.3** (to be split when v0.2 ships)
- The rest of the task model: `ask` (read-only probe fork), `fork`, `rerun`
  and the report (design.md §3.5, §6.3); `delegate` has no `from` input.
- The other CLI commands of §6.3: `report`, `ask`, `continue`, `fork`, `rerun`,
  `logs` and `prune`, plus `subzero validate`.
- The rest of config layering (§4.1): `subzero.local.yaml` and skill manifests
  (`agents/subzero.yaml` in a skill, D17).
- Skill sources and pinning: git sources and `subzero.lock` (D13).
- Model server fields `base_url`, `api` and `api_key`; today pi's own `models.json`
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
- A Codex child driver, a Claude child driver and the Codex parent plugin.

**v0.4**
- A generic ACP child driver.
- Worktree mode.
- Structured outputs on every host.
- Compiling to native features where it pays (D12).

**Product goals not yet met** ([problem.md](problem.md)): a parent in Codex
(G3 and the first success criterion; the pi parent is built); a definition
shipped with a skill (G1); follow-up, rerun, resume and fork of a task (G4;
follow-up is built in v0.2). G2 and G5 hold for the Claude Code to pi pair; the pi to
pi pair awaits its acceptance checks.
