# subzero

subzero lets Claude Code or pi hand subagent work to a pi agent running on
a model you choose, such as a local model or a cheaper hosted one. The parent keeps
the conversation and gets back the child's final reply. The child's reading,
thinking and tool calls stay in a separate pi session.

It is built for the compound-engineering plugin. That plugin asks for subagents by
tier ("cheapest capable", "mid-tier", "session model"). When your project, or your
global file in `~/.agents/`, has a matching tier, subzero sends those subagents to
your model instead of Claude's. Tiers you do not configure stay on Claude.

## Preview and known limits

The pi extension and updated Claude plugin are built in this branch. The pi
package branch must be published before the git install command below works.
The live checks on both parents are still pending. A *parent host* is where you
work (Claude Code or pi); a *child host* is what subzero starts (pi today).
See [docs/design.md](docs/design.md) §5.5.

This is an experimental preview, version 0.1.0-preview.1. It makes no
compatibility promise, and what it does may change between previews. Know these
limits before you use it:

- **Plan mode is not respected.** The routing hook does not read the session's
  permission mode, so a generic subagent spawned in plan mode is still sent to the
  general agent, which can write files and run shell commands inside pi.
- **pi is the only child host.** There is no Codex or Claude child yet.
- **The general agent can write files and run shell commands inside pi, outside
  Claude Code's permission prompts.** Review what a routed subagent did with git.
- **The queue is per session.** The `parallel` limit of an endpoint counts only the
  children of one parent session, so two sessions do not wait for each other.
- **A cloned project's agent file (.agents/subzero.yaml) is executable-grade
  configuration (it chooses models, tools and can enable a general agent with
  shell access); use routing only in repositories you trust.**
- If the subzero server fails to start, the session-start text still says routing
  is on, but the hook denies nothing and every subagent runs on Claude.
- Worktree-isolated and fork spawns always stay on Claude, because a subzero child
  works in the shared checkout.

The plugin's hooks run in every project where it is installed: one when a session
starts, one on every Agent call, and a background completion hook at Stop. In a project
with no agent file, and no `medium` tier in your global file, the hook does nothing:
it prints no message, adds no routing text and lets every subagent run on Claude.
Once your global file has a `medium` tier, subzero is on in every project; put
`enabled: false` in a project's `.agents/subzero.yaml` to switch it off there.

## Prerequisites

- A current Claude Code, and `git` (Claude Code uses it to add the marketplace).
- Node 22 or later.
- pi, with a model you can reach. Install it with
  `npm install -g @earendil-works/pi-coding-agent` (see [pi.dev](https://pi.dev)),
  then set up a provider or a local endpoint and check that `pi --version` runs and
  `pi --list-models` shows your model. subzero installs nothing and does not edit
  your pi configuration.
- macOS or Linux. Windows is not supported in this preview.
- The system `lockf` utility on macOS or `flock` on Linux. The Agent routing
  hook uses it to coordinate concurrent sessions; if it is unavailable, the
  hook allows every Agent call through to Claude, and the text subzero adds at
  session start says routing is off and names the missing utility.
- `ps`, used to identify the parent session. Minimal Linux images may need the
  `procps` package.

If Node or pi is missing, `/subzero:init` and the plugin's hooks print one line
saying what to install.

## Install

There is no published release yet, so the plugin comes from the `plugin` branch of
this repository, which holds the built plugin. Claude Code adds it as a
marketplace named `qoherent` straight from git. In your shell:

```sh
claude plugin marketplace add qoherent/sub0@plugin
claude plugin install subzero@qoherent
```

In a Claude Code session the same two steps are `/plugin marketplace add
qoherent/sub0@plugin` and `/plugin install subzero@qoherent`; the install command
opens the plugin's details, where you choose a scope. Run `/reload-plugins` or
start a new session. There is nothing to clone or build. Typing `/subzero:` should
now list `init`, `tasks` and `cancel`.

When releases are published, the install command will change to the `qoherent`
marketplace of the organization. Remove this one first, because both use the name
`qoherent`: `claude plugin marketplace remove qoherent`.

### Install the pi extension

Remove pi-subagents from `~/.pi/agent/settings.json` before installing: both
packages register `subagent`. Once the `pi` branch is published, run:

```sh
pi install git:github.com/qoherent/sub0@pi
```

For a local checkout, run `npm run release:pi:build` and load the staged
extension with `pi -e ./dist-pi-package/dist/pi-extension.js`. Set up the
project from inside pi with `/subzero init` (see
[Set up a model](#set-up-a-model)). The pi `subagent` tool runs in the background
by default and reports completed results; `/subzero` shows tasks and
`/subzero cancel` stops a task or the session's tasks. On Claude, use
`/subzero:cancel` to stop the current session's tasks.

## Set up a model

Open Claude Code in a project, then run the init command with no arguments:

```text
/subzero:init
```

This is guided setup. It first asks whether the models are for every project or
only this one. Then it lists the models pi offers and suggests a model and a
thinking level for each tier: `small`, `medium` and `large`. You choose each
one; only `medium` is required. Then it asks how many children may run at once
on each model server the chosen models use, and offers to check that each
chosen model answers a one-turn prompt. Last it shows the change as a diff and
writes it only after you confirm. Claude Code may ask you to allow its commands
the first time. If pi is not installed, it says so and writes nothing.

Set up once for every project, or per project:

- **Every project** writes `~/.agents/subzero.yaml`, the global file, and
  creates it when it is missing. After that, subzero is on in every project with
  built-in `general` and `fallback` agents, with no file of its own. It tells you
  what this project keeps its own, because the change does not apply there.
- **Only this one** writes `.agents/subzero.yaml` in the project, which overrides
  the global file by tier name and limit name.

A project switches subzero off with `enabled: false` in its own file. Guided
init writes tiers and limits only, never agents.

In pi, with the [pi extension](#install-the-pi-extension) loaded, run
`/subzero init` instead. It is the same guided setup, with pi's own dialogs.

If you already know the model, the quick path takes the model name that pi
lists, as `provider/model`:

```text
/subzero:init <model>
```

For example `/subzero:init local/qwen`, or `/subzero init local/qwen` in pi. It
writes the project's `.agents/subzero.yaml`, never the global file, with a `medium` tier on that model, a `general`
agent that can read, write and run commands, and a read-only `fallback` agent.
Optional arguments are `--timeout <seconds>` (default 1200) and
`--thinking <level>` (default medium). If pi is not installed, it says so and
writes nothing. In an existing file, init adds missing starter entries and
keeps existing settings; it refuses incompatible or invalid entries. Empty or
flow-style maps are rewritten to add missing entries.

Compound-engineering asks for the tiers `small`, `medium` and `large`. The
`medium` tier routes mid-tier work, and `small` and `large` route theirs when
they are set. A tier in the file looks like this:

```yaml
models:
  tiers:
    medium: { host: pi, model: local/qwen, thinking: medium }
```

After init creates a file or adds or removes a tier, start a new Claude Code
session in the project, so the session-start hook reads the files. A change to
the global file applies to the next delegation at once, but the routing text is
built once per session. pi refreshes its tier text in place, so it needs no new
session. To add `small` or `large`
later, run `/subzero:init` (or `/subzero init` in pi) again and choose them, or
add them to a file by hand; read
[what a `large` tier changes](#what-configuring-a-large-tier-changes) first.

Every key of the files, the global file and how it merges, how a request picks
its model, the checks the files must pass and what is not supported yet are in the
[configuration reference](docs/configuration.md).

## Confirm it works

Ask Claude for a mid-tier subagent:

```text
Use a mid-tier subagent to list the files in this folder and reply with their names.
```

Claude sends it to subzero on its own. Then run `/subzero:tasks`: the task shows
as `general:medium`, with its status. The reply came from your model, not from
Claude.

To see routing without asking for it, install the compound-engineering plugin and
run one of its reviews, such as `/ce-code-review`, on a project with changes.
Its mid-tier subagents appear as subzero tasks in `/subzero:tasks`.

## Usage and prompting guide

subzero routes subagents by model tier. Claude learns at session start which tier
words go to subzero, and a hook catches a generic subagent spawn for a
configured tier that slips past. What reaches your model depends on whether the
request names a tier.

| What you ask Claude | With `medium` | With `large` added too |
|---|---|---|
| "Use a mid-tier subagent to ..." | subzero, `general:medium` | subzero, `general:medium` |
| "Use the general agent on the medium tier to ..." | subzero, `general:medium` | subzero, `general:medium` |
| "Use subzero's delegate tool with tier medium to ..." | subzero, `general:medium` | subzero, `general:medium` |
| "Use a subagent to ..." (no tier) | usually Claude | subzero |
| "Spawn a general-purpose subagent with the Agent tool ..." | Claude | subzero (the hook redirects it) |
| A built-in or plugin agent type, such as `Explore` | Claude | Claude |

The table comes from headless runs with Claude Code 2.1.318 and a local model.
Each cell that says subzero routed every time it was tried; "usually" means the
plain request went to Claude in two of three runs. The delegate-tool row, and
`Explore` with `medium`, follow from how routing works and were not
run separately.

The rules behind it:

- **Name the tier.** The session-start text gives Claude three phrases:
  "cheapest capable" for `small`, "mid-tier" for `medium` and "session model"
  for `large`. A request that uses one of them, or names the tier ("the medium
  tier"), goes to subzero when that tier is configured.
- **A request with no tier asks for Claude's own session model,** which subzero
  files under `large`. It stays on Claude unless `large` is configured.
- **The hook maps a generic Agent spawn by its model:** `haiku` to `small`,
  `sonnet` to `medium`, no model to `large`. `opus` and `fable` never route. A
  spawn whose tier is not configured runs on Claude.
- **Some spawns always stay on Claude:** named agent types (`Explore`, a
  plugin's agents), worktree-isolated spawns and forks.
- **Write the request as a self-contained task.** The child sees only the brief
  Claude writes, not your conversation, so say which files and what answer you
  want.
- **Batches queue.** Several subagents at once go out together and wait for the
  endpoint's `parallel` limit; `/subzero:tasks` shows each as queued or
  running.

### Named agents

Besides `general`, you can define your own agents in `.agents/subzero.yaml`,
with or without skills. An agent with a skill runs a pi child that has only that
skill loaded: the skill's instructions and files stay in the child, and Claude
gets only the reply.

```yaml
skills:                      # skill name -> folder, relative to .agents/
  file-facts: ../subzero-skills/file-facts

agents:
  file-facts:
    description: Reports three facts about one source file.
    skills: [file-facts]     # names from the skills map; leave out for no skills
    tools: [read, grep, find, ls]
    timeout: 120             # seconds, required
    tier: medium             # optional; without it the agent runs on medium
```

A skill folder holds a `SKILL.md`, as for any Agent Skill. Keep it out of
`.claude/skills/`, or Claude loads the skill itself and nothing is delegated.
Keep it out of `.agents/subzero/` too, because that folder ignores itself in git.
A folder of its own, such as `subzero-skills/`, works.

Ask for the agent by name:

```text
Use the file-facts agent on app.py and show me its reply.
```

Claude calls `delegate` with `agent: "file-facts"`, and `/subzero:tasks` shows the
task as `file-facts`. In headless runs with Claude Code 2.1.318, every request
that named the agent ran it, with or without a skill, and the child's reply
followed the skill's format. The agent file is read again on each delegation,
so a new agent works without restarting Claude Code.

All agent keys are in the [configuration reference](docs/configuration.md#agents-what-you-can-ask-for-by-name).
Limits of named agents in this preview:

- **Claude does not see your agents.** Their names and descriptions are not
  shown to Claude, so only a request that names the agent runs it. A request
  that fits the description but does not name the agent goes to `general` (or
  stays on Claude), even when the description matches it word for word. Listing
  agents for Claude is planned for v0.2.
- **A misspelled name runs `fallback`.** The reply starts with a notice that the
  agent is not configured and lists the configured agents. Without a `fallback`
  entry it is an error and no task is made.
- **A skill missing from the `skills` map fails the whole file to load**, so no
  delegation runs until it is fixed. A skill folder that does not exist fails
  the task as `skill_mismatch` before the child starts work.
- **Skills are local folders only.** Git sources, a lock file, skills that ship
  their own agent definition, and a personal local override file are planned
  for v0.2.
- **The child copies the skill when it starts.** A task keeps the version of the
  skill it started with; an edit applies to the next task.
- **`tools` is the only restriction on a child.** pi has no folder sandbox, so a
  child with `read` can read any file your user can, and one with `bash`,
  `edit` or `write` can change anything. There is no permission prompt.
- **Each task is one turn.** You cannot continue a named agent's task or ask it
  a follow-up question yet; a new request starts a new child. `continue` and
  `ask` are planned for v0.2.
- **The child sees only the brief.** It does not see your conversation, so the
  request must say which files and what answer you want.

### What configuring a large tier changes

Adding `large` to `models.tiers` makes subzero take every generic subagent that
does not name a smaller model, not only the work you ask for by tier. Before you
add it, know what moves:

- **Plain "use a subagent" requests** go to your model in that project, in every
  session, without a tier word.
- **compound-engineering's session-model work moves too.** In `/ce-code-review`
  the correctness, security and adversarial reviewers run on the session model,
  which compound-engineering chooses on purpose for its hardest lenses. With
  `large` configured they run on your model, so a weaker model can miss the
  findings these reviewers exist to catch.
- **More children share one endpoint.** Every routed subagent waits for the
  endpoint's `parallel` limit. With `parallel: 1`, a review that used to run its
  session-model reviewers on Claude beside the routed ones now runs them all one
  after another on your model, and takes longer.
- **The known limits reach more spawns.** Plan mode is still not respected, and
  the `general` agent still writes files and runs commands inside pi outside
  Claude Code's prompts. With `large` that applies to most subagents.

To undo it, remove the `large` line from `.agents/subzero.yaml` and start a new
Claude Code session. Use a separate model for `large` only if it can do the
session model's work; otherwise route `small` and `medium` and keep `large` on
Claude.

## Look at what a child did

Each child's pi session is saved in the project, under
`.agents/subzero/sessions/`, in a file named after its task id (for example
`2026-11-05T10-07-23-137Z_sz-lqnjho.jsonl`). The folder keeps the children out
of your own pi history, and only you can read it. Get the task id from
`/subzero:tasks`, then, from the project folder:

```sh
pi --export .agents/subzero/sessions/<file>.jsonl out.html    # the whole session as a page, read-only
pi --session-dir .agents/subzero/sessions --resume            # pick a child session in pi
pi --session-dir .agents/subzero/sessions --session <task id> # open one child session in pi
```

Reading is safe. Before you type into a child session opened this way, know two
things:

- Plain `pi` loads your own skills, extensions and AGENTS.md, which the child ran
  without. Typing continues the conversation under a different setup than the
  child had.
- pi does not lock session files. Do not type while the task is still running
  (`/subzero:tasks` shows it as running): you and the child would write to the
  same file.

The subzero command line does the same jobs with the child's own launch flags:
`subzero show <task id>` exports the page, and `subzero attach <task id>` opens
the child in pi and refuses while it is running. In this preview neither is a
slash command; run `node <plugin folder>/dist/cli.js show <task id>` (or
`attach`) in the project folder. `claude plugin list --json` shows the plugin
folder as `installPath`.

## Update

A new version reaches you only when the `plugin` branch gets a new version
number. A change that keeps the same number does not. Refresh the marketplace,
then update the plugin, in a session:

```text
/plugin marketplace update qoherent
```

and in your shell:

```sh
claude plugin update subzero@qoherent
```

You can also open `/plugin`, choose the **Marketplaces** tab, select `qoherent`
and choose **Update marketplace**, which does both. Third-party marketplaces
do not update on their own unless you turn on auto-update there. A running session
keeps the version it loaded: run `/reload-plugins` or restart Claude Code to use
the new one.

## License

Apache-2.0, see [LICENSE](LICENSE). The agent file is documented in
[docs/configuration.md](docs/configuration.md). How the routing works is in
[docs/design.md](docs/design.md), section 5.4. Maintainers: see
[docs/releasing.md](docs/releasing.md).
