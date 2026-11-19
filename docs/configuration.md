# Configuring subzero

subzero reads one file per project, `.agents/subzero.yaml`, and can read a
global file, `~/.agents/subzero.yaml`, under it. The files say which models the
children run on, which agents you can ask for by name, and how routing behaves.
This page is the full reference for both, for version `0.1.0-preview.1`. The
README has the short path: install, then run `/subzero:init` in Claude Code or
`/subzero init` in pi. You do not have to write either file by hand; see
[Writing the file with init](#writing-the-file-with-init).

What is documented here is what the code accepts today. The design in
[design.md](design.md) §4 describes more (a personal override file, skill
manifests, endpoint connection fields). Those parts are not built; see
[Not supported yet](#not-supported-yet).

## Where the file lives

- The file is `.agents/subzero.yaml` under the project root. It is meant to be
  committed with the project.
- The project root is `SUBZERO_PROJECT_DIR`, which the plugin sets to the folder
  Claude Code was opened in. From the command line it is the working directory.
- The file is read again on every delegation, so an edit applies to the next
  task without restarting Claude Code. The session-start routing text is built
  once per session, so after you add or remove a tier, start a new session.
- A missing, unreadable or malformed file, or any invalid entry, is a load error.
  It fails the whole load and starts no task; the error names the file it comes
  from, the entry and the problem. A project with no file is the exception when
  the [global file](#the-global-file-one-setup-for-every-project) gives it a
  `medium` tier.
- The folder `.agents/subzero/` next to it is subzero's own store (task records,
  the task index and child sessions). It is created owner-only and ignores
  itself in git. Do not put skills or configuration in it.

A project with no agent file and no `medium` tier in the global file is not an
error for the plugin: the hooks do nothing, no routing text is added and every
subagent runs on Claude. With a `medium` tier in the global file, subzero is on
in that project; see
[the global file](#the-global-file-one-setup-for-every-project).

## A complete example

```yaml
skills:
  file-facts: ../subzero-skills/file-facts

endpoints:
  local:
    parallel: 1

models:
  tiers:
    small:   { host: pi, model: local/qwen3-4b, thinking: off }
    medium:  { host: pi, model: local/qwen3-coder-30b, thinking: medium }

routing:
  hook: true
  generic_agents: [general-purpose, claude]

agents:
  general:
    tools: [read, bash, edit, write, grep, find, ls]
    timeout: 1200
  fallback:
    tools: [read, grep, find, ls]
    timeout: 1200
  file-facts:
    description: Reports three facts about one source file.
    skills: [file-facts]
    tools: [read, grep, find, ls]
    timeout: 120
    tier: medium
    tiers:
      medium: { thinking: high }
```

The top-level keys are `enabled`, `skills`, `endpoints`, `models`, `routing` and
`agents`. After merging with the global file, the configuration must contain
the `medium` tier. The `general` and `fallback` agents are required too, but a
project that does not define them gets built-in ones (see
[Built-in agents](#built-in-agents)).

`enabled` is optional. `enabled: false` switches subzero off in this project;
see [Switching subzero off in a project](#switching-subzero-off-in-a-project).
Any other value is an error.

## `models.tiers`: what runs a child

A tier names a host, a model and a thinking level. It is the only place that
says what runs a child; agents never set these themselves.

```yaml
models:
  tiers:
    small:   { host: pi, model: local/qwen3-coder-30b, thinking: low }
    medium:  { host: pi, model: local/qwen3-coder-30b, thinking: medium }
```

| Key | Required | Meaning |
|---|---|---|
| `host` | yes | The kind of child. `pi` is the only host that exists in this preview. |
| `model` | yes | `provider/model`, as `pi --list-models` shows it. The part before the first slash is the **endpoint** that the parallel limit counts. |
| `thinking` | yes | One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. It is passed to pi's `--thinking`. |

Rules:
- `medium` is required. `init` adds it for you.
- A tier name is free text. The names `small`, `medium` and `large` have a
  meaning for routing (below); other names work only when a request names them.
- A tier whose host has no child driver still loads. It fails only when a
  request uses it, with an error that names the tier, the host, the supported
  hosts and the configured tiers.
- Any other key in a tier is an error.

## `agents`: what you can ask for by name

```yaml
agents:
  file-facts:
    description: Reports three facts about one source file.
    skills: [file-facts]
    tools: [read, grep, find, ls]
    timeout: 120
    tier: medium
    tiers:
      medium: { thinking: high }
```

| Key | Required | Meaning |
|---|---|---|
| `description` | yes, except on `general` and `fallback` | What the agent is for. It is not shown to Claude in this preview (see [Limits](#limits)). On `general` and `fallback` a description is an error. |
| `tools` | yes | The pi tools the child may use, at least one: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Passed to pi's `--tools`. subzero does not check the names. |
| `timeout` | yes | Seconds from the child's start until it settles. Time spent waiting in the queue does not count. A child past it is stopped and the task fails with `timeout`. |
| `skills` | no | Names from the top-level `skills:` map. Default none. |
| `tier` | no | The agent's own tier when a request names none. Must exist in `models.tiers`. Default `medium`. |
| `tiers` | no | Per-tier overrides of `host`, `model` and `thinking` for this agent only, field by field. Each key must be a configured tier. |

Rules:
- `host`, `model` and `thinking` cannot be set on an agent. Put them in a tier,
  or override them with `tiers:`.
- Any key not in the table is an error.
- An agent name is free text; `general` and `fallback` are the two special names.

### `general`

The agent for work that names no agent, and for tiered work (CE's generic
subagents). A request with no agent runs it on `medium`; a request that names a
tier runs it on that tier and is recorded as `general:<tier>`. Give it the full
tool list if routed subagents must write files or run commands, as
compound-engineering's reviewers do. A project that does not define `general`
gets the built-in one.

### `fallback`

Runs a request whose agent name is not configured. Its reply starts with a
notice that the named agent is not configured and lists the configured ones.
A project that does not define `fallback` gets the built-in one, which is
read-only, so a mistyped name cannot write files or run commands.

### Resolving an agent to a model

For a request, the tier is the first of:
1. the tier the request names (`tier` on `delegate`, or the tier word Claude
   chose);
2. the agent's own `tier:`;
3. `medium`.

Then the agent's `tiers.<tier>` override, if any, is laid over that tier's
fields. The result is the host, model and thinking of the child. A request that
names a tier records the task as `<agent>:<tier>`, for example `general:medium`.

## `skills`: folders an agent loads

```yaml
skills:
  file-facts: ../subzero-skills/file-facts
```

Each entry maps a skill name to a folder, resolved against the folder that holds
the agent file (`.agents/`). The folder holds a `SKILL.md` as for any Agent
Skill. A child loads only the skills its agent lists, copied into its task
folder when it starts; a task keeps the copy it started with.

- An agent that lists a skill missing from this map fails the whole load.
- A skill folder that does not exist fails the task as `skill_mismatch` before
  the child starts work. So does a difference between the skills pi loaded and
  the ones declared.
- Keep skill folders out of `.claude/skills/` (Claude would load the skill
  itself) and out of `.agents/subzero/` (git ignores that folder).

## `endpoints`: limits per model server

```yaml
endpoints:
  local:
    parallel: 1
```

The key is an endpoint name, the part of a model before its first slash
(`local` in `local/qwen3-coder-30b`). `parallel` is the most children one
Claude Code session runs at once on it; it must be a positive whole number.
Past the limit a delegation waits as queued, first come first served, and
starts when a child ends. A one-GPU model server usually wants `parallel: 1`.

- The count is per session. A second Claude Code window is not counted, and
  nothing is locked across processes.
- An endpoint with no entry has no limit.
- An entry that no tier or tier override uses is a load error, which catches a
  mistyped endpoint name.
- An entry holds only `parallel` in this preview. The model server's address and
  key are in pi's own configuration (`~/.pi/agent/models.json`).

## `routing`: Claude Code subagent routing

```yaml
routing:
  hook: true
  generic_agents: [general-purpose, claude]
```

| Key | Default | Meaning |
|---|---|---|
| `hook` | `true` | `false` keeps the session-start text but lets every Agent spawn through, so Claude's own subagents are never redirected. |
| `generic_agents` | `[general-purpose, claude]` | The Agent types the hook treats as generic, and so may redirect. A list here replaces the default. |

Both are optional, and any other key is an error. How routing uses the tiers:

- **Tier words.** `small` is "cheapest capable", `medium` is "mid-tier" and
  `large` is "session model". At session start Claude is told which of these
  words go to subzero: the ones whose tier is configured and routable. No
  routable word means no text.
- **The hook.** A generic Agent spawn is denied, with an instruction to call
  `delegate`, when the tier its model maps to is configured: `haiku` is
  `small`, `sonnet` is `medium`, no model is `large`, and `opus` and `fable`
  never map. Spawns with `isolation`, forks (`subagent_type: "fork"`) and named
  agent types are not generic and always stay on Claude.
- **Routable.** A tier is routable when its host, after `general`'s override, has a child driver.
- **Failing open.** The hook denies nothing unless the subzero server is running
  for the session and the agent file loads.

Adding `large` also moves compound-engineering's session-model reviewers and
plain "use a subagent" requests. Read
[what a large tier changes](../README.md#what-configuring-a-large-tier-changes)
before adding it.

## The global file: one setup for every project

`~/.agents/subzero.yaml` is the global file. It holds the models you want in
every project, so you set them up once instead of per project. The project file
`.agents/subzero.yaml` is read over it and only has to list what differs.

```yaml
# ~/.agents/subzero.yaml
models:
  tiers:
    small:  { host: pi, model: local/qwen3-4b, thinking: off }
    medium: { host: pi, model: local/qwen3-coder-30b, thinking: medium }

endpoints:
  local:
    parallel: 1

routing:
  hook: true
```

```yaml
# .agents/subzero.yaml in one project
models:
  tiers:
    medium: { host: pi, model: local/qwen3-coder-30b, thinking: high }
    small:
```

Here the project runs `medium` with its own thinking level, drops `small`, and
inherits the limit of `local`.

- **Path.** `~/.agents/subzero.yaml`, or the full file path in
  `SUBZERO_GLOBAL_CONFIG` (an empty value counts as unset). A missing file
  means there is no global layer.
- **Allowed keys.** Only `models.tiers`, `endpoints.<endpoint>.parallel`,
  `routing` and `pi.extensions` (next section). Any other key, such as `agents`,
  `skills` or `enabled`, is a load error that names the file and the key. Agents
  and skills stay in the project, so a file in your home folder cannot give
  every repository tool access or skill folders.
- **Read on every delegation.** Like the project file, it is read again each
  time. An edit applies to the next task, with the session-start exception below.

### `pi.extensions`: pi extensions your children load

Every pi process subzero starts runs with `-ne`, which keeps all pi extensions
out so a child cannot be changed by whatever you have installed. Some setups
need one extension, for example a pi package that registers the model provider
of your office gateway when it loads. Name it in the global file and subzero
adds `-e <path>` for it, and only for the files you name:

```yaml
# ~/.agents/subzero.yaml
pi:
  extensions:
    - ~/.pi/reggiellm-pi/index.ts
```

- **Every pi process loads it.** Child runs, the model listing of guided init
  (`subzero config models`) and the model check (`subzero config check`) all
  start pi with the listed extensions, so the models the extension registers
  appear in the listing, pass the check and run children. The task record of a
  child shows the `-e` flags in its launch spec, and `subzero attach` reopens
  the session with them.
- **Paths.** Each entry is a non-empty path that is absolute or starts with
  `~/` (your home folder). A relative path is a load error, because there is no
  folder it could be relative to. The file must exist when the config loads,
  or the load error names the global file and the path. Duplicates are dropped,
  and the order of the file is kept.
- **Global file only.** A project file that holds a `pi` key is a load error that
  names the project file. The project file is committed to repositories, and a
  repository must not be able to load code into your children. Any other key
  under `pi` is a load error too.
- **Only pi.** The list is read for the host `pi` and ignored for any other host.
- **No questions at load.** An extension loads when the child starts. A
  background child cannot answer a question, and an extension dialog blocks in
  RPC mode, so an extension that asks you something while it loads leaves the
  child waiting until its timeout. Name only extensions that load without a
  prompt, for example by reading a key from pi's `auth.json` or from an
  environment variable.

### How the two files merge

- **By name.** Tiers merge by tier name, limits by endpoint and routing by key.
  A project entry replaces the global entry of the same name whole: a project
  `medium` replaces the model and the thinking level together, so a model never
  keeps a thinking level chosen for another one. Entries the project does not
  name are inherited.
- **Removing an inherited entry.** The project writes the tier or limit name
  with nothing after the colon: `large:` under `models.tiers`, or `local:` under
  `endpoints`. Only the project file accepts this; in the global file it is an
  error. A tier removed this way that an agent still names is the usual load
  error for an agent with an unknown tier.
- **Unused inherited limits.** A limit from the global file that no model of
  the project's tiers (or of an agent's `tiers:` overrides) uses is ignored in
  that project. A limit the project writes itself that no model uses is still a
  load error.
- **Agents and skills** come from the project file only, and so does nothing
  under `pi`: `pi.extensions` comes from the global file only.

### When subzero is on in a project

| Global file | Project file | Result |
|---|---|---|
| any | `enabled: false` | Off. The global file is not read. |
| has a `medium` tier | none | On, with the built-in agents. |
| has a `medium` tier | valid | On. The project's entries override by name. |
| no `medium` tier | none | Off, as before. |
| no `medium` tier | has a `medium` tier | On. |
| no `medium` tier | exists, no `medium` tier | Load error. |
| any | exists but does not load | Load error naming the file. |

This changes one behavior of earlier previews: a global file with a `medium`
tier turns subzero on in every project, with or without a project file. The way
out in one project is `enabled: false` (next).

### Switching subzero off in a project

```yaml
enabled: false
```

in the project's `.agents/subzero.yaml` switches subzero off there, the same as
a project with no file: no hooks, no routing text, and every subagent runs on
Claude. It is checked first. The global file is not read, so a broken global
file cannot fail a project that is off, and the file needs no `medium` tier.
`enabled: true` is accepted and changes nothing.

### Built-in agents

A project that does not define `general` or `fallback` gets a built-in one,
whatever other agents it defines:

- the tools are the starter tools of the child driver of the `medium` tier's
  host: the general tool list for `general`, a read-only list for `fallback`
  (for pi, the same lists the example above shows);
- the timeout is 1200 seconds, and there are no skills;
- a project agent with the same name replaces the built-in one.

If the child driver offers no starter tools, delegation fails with an error that
names the host.

### Errors and the session-start text

- Every load error names the file it comes from, the global file or the
  project's. A broken global file fails the load in every project that is on.
- When routing is switched off because a file does not load, the session-start
  text says "the config file" and names the file.
- The session-start routing text (Claude Code) and the tier description are
  built once per session. After the global file changes, delegation applies at
  once, but start a new session for the routing text. In pi the tier text
  refreshes at once after a guided write.

## Writing the file with `init`

Run init with no model for guided setup: `/subzero:init` in Claude Code, or
`/subzero init` in pi. It works the same in both:

- It asks first whether the models are for every project or only this one. Every
  project writes the global file, and creates it when it is missing. Only this
  one writes the project file.
- It shows what the files hold now, with each tier and limit marked as coming
  from the global file or from this project, and what it will repair, such as
  a missing `medium` tier. A file that fails to load for another reason is
  refused; fix it by hand or move it aside.
- It lists the models the child host offers (for pi, what `pi --list-models`
  shows) and suggests a model and a thinking level for `small`, `medium` and
  `large`. A tier that is set keeps its model unless you change it. You can
  leave `small` and `large` unset, or remove them. Tiers with other names are
  left alone.
- It asks the `parallel` limit of each endpoint the chosen tiers use.
- It offers to check that each chosen model answers a one-turn prompt.
- It shows the change as a diff and writes it only after you confirm. For an
  every-project write it first reads out what this project keeps its own, so
  you know the change does not apply here. It also says the change is checked
  against this project only: another project whose agents use a tier you remove,
  or whose own limit uses an endpoint you move away from, may fail to load until
  it is fixed.
- When you answer "every project", the defaults it offers are the tiers and
  limits that come from the global file. A tier or limit this project
  overrides is asked as if it were not set in the global file.
- It writes tiers and limits only, never agents. The built-in agents cover
  `general` and `fallback`.

After a write that creates a file or adds or removes a tier, start a new
Claude Code session so the routing text names the new tiers. A write of the
global file also needs a new session in every other open project. pi refreshes
its `subagent` tier text in place in the session that wrote. A change to the
global file applies to the next delegation at once.

In Claude Code the init skill does its work through `subzero config` commands
(`models`, `show`, `check`, `preview` and `apply`), which print one JSON
document each. They are the interface the skill uses, not a reference for
users. `config apply` writes only with the fingerprint of a matching
`config preview`. `config preview` and `config apply` take
`--scope global|project` (default `project`), and apply must repeat the
preview's scope. `config show` marks each tier and limit as coming from the
global file or from the project. In pi the same steps are tools that are on
only during a `/subzero init` run.

The quick path takes a model and writes only the starter entries:

```sh
/subzero:init <model> [--host pi] [--timeout 1200] [--thinking medium]
```

In pi it is `/subzero init <model> [--timeout 1200] [--thinking medium]`, and in
a terminal `subzero init <model>` with the same options as in Claude Code.
`subzero init` with no model in a terminal is a usage error, because guided
setup needs an agent to run it.

`init <model>` is unchanged by the global file. It writes the project file only, never the global file: it
adds a `medium` tier (with that host, model and thinking), a `general` agent
with the full tool list and a read-only `fallback` agent, each only when the
file lacks it. It preserves existing entries and lines, except
that it rewrites an empty or flow-style map when adding entries to it. It
refuses and writes
nothing when the pi check fails, the existing file fails to load for a reason
other than missing starter entries, or the medium tier is on another host.
To add `small` or `large` afterwards, run guided init, or add them by hand.

## Environment variables

| Variable | Meaning |
|---|---|
| `SUBZERO_GLOBAL_CONFIG` | The full path of the global file, instead of `~/.agents/subzero.yaml`. An empty value counts as unset. |
| `SUBZERO_PROJECT_DIR` | The project root. The plugin sets it from `CLAUDE_PROJECT_DIR`. An empty value counts as unset. Set it when you run `subzero` from outside the project. |
| `SUBZERO_DATA` | Where the plugin keeps its per-session files (the session id and the readiness marker). Defaults to `CLAUDE_PLUGIN_DATA`, then `~/.subzero`. |
| `SUBZERO_PI` | The pi command to run instead of `pi` on the PATH. |

Children also run with `PI_OFFLINE=1` and `PI_TELEMETRY=0`. They use your own pi
login and configuration, so a model that works in `pi` works as a tier.

## Not supported yet

These appear in design.md but are not read by this preview. The global file
`~/.agents/subzero.yaml` and `enabled: false` are built; see
[the global file](#the-global-file-one-setup-for-every-project).

- **Unknown top-level keys are ignored, not rejected.** In the project file,
  `version:`, `defaults:` and any other key you add do nothing (the global file
  rejects them). In particular `defaults.timeout` does
  not give agents a timeout: every agent needs its own.
- **A personal override file and skill-shipped agents.** No
  `.agents/subzero.local.yaml`, and no agent definitions that a skill ships
  (`agents/subzero.yaml`).
- **Skill sources.** Local folders only. No git or npm sources and no
  `subzero.lock`.
- **Endpoint fields** `base_url`, `api` and `api_key`; pi's `models.json`
  holds them.
- **Agent fields** `instructions`, `permissions`, `delegates`, `expose`,
  `result`, `output`, `process`, `record`, `retention` and `workspace`; setting
  one on an agent is an unknown-key error.
- **Hosts** other than `pi`.
- **A trust step** for a project's agent file. See below.

## Limits

- **The agent file is executable configuration.** It chooses the models, the
  tools and the skills of processes that run on your machine, and it can switch
  routing on. A repository you clone can carry one. subzero does not ask you to
  trust it first, so use routing only in repositories you trust.
- **`tools` is the only restriction on a child.** pi has no folder sandbox and
  asks no permission, so a child with `read` can read any file your user can and
  one with `bash`, `edit` or `write` can change anything.
- **Claude does not see your agents.** Names and descriptions are not shown to
  Claude, so only a request that names an agent runs it.
- **Each task is one turn.** There is no `continue` or `ask` yet.

## Errors you may see

| Message (start) | Cause and fix |
|---|---|
| `agent file is missing` | There is no `.agents/subzero.yaml` under the project root and the global file has no `medium` tier. Run `/subzero:init` in Claude Code or `/subzero init` in pi. |
| `agent file is malformed` | The YAML does not parse, or a top-level section has the wrong type. The message names the file and says where. |
| `global file is malformed` | The same for `~/.agents/subzero.yaml`. It fails every project that is on. |
| `the global file holds only` | The global file has a key other than `models.tiers`, `endpoints` and `routing`. The message names the file and the key. |
| `subzero is switched off for this project` | The project file says `enabled: false`. Remove it to turn subzero on here. |
| `the medium tier is required in models.tiers` | The file has no `medium` tier. Add one, or run `init`. |
| `agent "<name>": description is required` | A named agent has no description. |
| `<agent>: <key> cannot be set on an agent` | `host`, `model` or `thinking` is on an agent. Move it to a tier. |
| `<agent>: unknown key "<key>"` | A key this preview does not read. See [Not supported yet](#not-supported-yet). |
| `<agent>: timeout is required (seconds)` | Every agent needs its own `timeout`. |
| `<agent>: skill "<name>" is not in the skills map` | Add the skill to the top-level `skills:` map, or fix the name. |
| `endpoint "<name>": no model of a tier ... belongs to it` | An `endpoints:` entry matches no tier's model. Fix the name. |
| `the fallback agent is required` | Only a load made without built-in agents says this. Add a `fallback` agent. |
| `the general agent is required` | The same for `general`. |
| `offers no starter tools` | The `medium` tier's child driver has no starter tools, so a built-in agent cannot be filled. The message names the host. |
| `unknown tier "<name>"` | A request named a tier that is not in `models.tiers`. |
| `tier "<name>" runs on the host "<host>"` | The tier's host has no child driver. Use `pi`. |
| `failure: skill_mismatch` | A declared skill folder is missing, or pi loaded other skills than declared. |
| `failure: timeout` | The child ran past the agent's `timeout`. Raise it or narrow the task. |
