# Changelog

## Unreleased (v0.2)

- `continue` on both parents: the Claude Code tool `continue` and the pi tool
  `subzero_continue` take a task id and a self-contained message. A task whose
  child has not started holds the message and delivers it right after the
  prompt; a running child is steered and the task stays one turn with one
  result; a finished task gets a new turn in the same child session, on the
  task's own agent, model and thinking level. The reply names which happened.
  Each turn returns one result, named from turn 2, and collecting a task returns
  every turn not yet delivered, oldest first. Each new turn gets the full agent
  `timeout`, and each delivered steering message restarts it. Only tasks of the
  current conversation can be continued. After a pi reload or resume, the next
  turn gets one notice of the tasks the session end stopped and the messages
  that never reached them.
- A message you type ends a waited call. On pi, it ends a waited `subagent`
  (`async: false`), `subzero_continue` or `subzero_await`. On Claude Code, it
  ends a waited `delegate`, `continue` or `await` made by the main conversation,
  through a new UserPromptSubmit prompt hook and a PreToolUse call marker; a call
  made inside a subagent never ends early. The children keep running and report
  by completion notice or wake marker. Limits: a message submitted before a
  waited call started does not end it, and after `/clear` the server can follow
  the old session id for up to 5 seconds.
- Parallel limits per model: `models.parallel` maps a full model id to a limit,
  in the global file and the agent file. A limit belongs to one model id and is
  shared by every tier that names it. A model with no entry has no limit, a
  continued task's model included. An agent-file limit for a model no tier or
  tier override uses is a load error that names the model; a global-file limit
  no tier of the project uses is ignored. An empty value (`local/qwen:`) in the
  agent file removes an inherited limit. `subzero config` takes
  `--limit <model>=<n>` and `--no-limit <model>`.
- Behavior change: the `endpoints:` key is removed. A file that holds it fails to
  load until guided init repairs it. The error names the file, says
  `models.parallel` replaced it and lists each old limit with the models it
  covered. `/subzero:init` and `/subzero init` pre-fill each model's limit with
  the old value, show the diff and write only after you confirm, repairing first
  the file that the chosen scope does not write. `init <model>` does not repair.
- Behavior change: the Claude Code MCP server no longer offers MCP tasks.
  Claude Code never selected them, so the branch was never used. A background
  result always arrives through the wake hook.
- Behavior change: on Claude Code, `delegate` and `continue` run in the
  background unless the call sets `wait: true`, as `subagent` and
  `subzero_continue` already do on pi. A non-interactive or unidentified
  session still always waits.

## 0.1.0-preview.1

- Initial preview of subzero delegation and its pi parent extension.
- Guided setup: `/subzero:init` with no model in Claude Code and `/subzero init`
  in pi list the child host's models, suggest a model for each tier, ask the
  endpoint limits, can check that each model answers, and write
  `.agents/subzero.yaml` only after you confirm the diff. `init <model>` stays
  as the quick path. The plugin's init skill uses the new `subzero config`
  commands.
- Global config file: `~/.agents/subzero.yaml` (or the path in
  `SUBZERO_GLOBAL_CONFIG`) holds `models.tiers`, endpoint `parallel` limits and
  `routing` for every project. A project's `.agents/subzero.yaml` is read over it
  and merged by name; a project entry replaces the global one whole, and
  `large:` or `local:` with nothing after the colon removes an inherited tier or
  limit. Any other key in the global file is a load error.
- Behavior change: a global file with a `medium` tier turns subzero on in every
  project, with or without a project file, using built-in `general` and
  `fallback` agents. Put `enabled: false` in a project's `.agents/subzero.yaml`
  to switch subzero off there.
- Guided init asks first whether the models are for every project or only this
  one, and writes tiers and limits only, never agents. `subzero config preview`
  and `apply` take `--scope global|project`, and `config show` marks where each
  tier and limit comes from. `init <model>` is unchanged.
- Load errors name the file they come from, the global file or the project file.
- Global file key `hosts.pi.extensions`: a list of pi extension files (absolute or
  `~/` paths) that every pi process of subzero loads with `-e` next to `-ne`:
  child runs, `subzero config models` and `subzero config check`. A project file
  with a `hosts` key is a load error. The process environment, including
  `SUBZERO_GLOBAL_CONFIG`, is trusted. The pi driver, not the config, checks the
  section. A path
  that names no file loads, and pi is not started for it: the child run, listing
  or check fails with a message that names the path.
