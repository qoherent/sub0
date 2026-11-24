# subzero demo: Claude Code hands work to pi agents on a local model

Claude Code runs the `/subzero:review` skill from the subzero plugin. For each
file in `src/` it calls subzero's `delegate` MCP tool, which starts a pi agent
(`reviewer`, on `r9700/Qwen3.8`) loaded with its own `code-review` skill. Each pi
agent reads one file and replies with its findings, one line each. Claude
collects the results with `await` and gets only those replies, never the pi
session: the reading, thinking and tool calls stay on the local model. Claude
checks the serious findings against the source and writes `REVIEW.md`. The
reviewers are read-only; they have no write tool.

```
Claude Code ── /subzero:review (plugin skill)
   └─ delegate ×3 (subzero MCP) ── pi reviewer + code-review skill ── Qwen3.8 on r9700
   └─ await ── each reviewer's final reply ── checks findings ── REVIEW.md
```

`src/` holds three short files with planted bugs: a discount that multiplies by
the whole percent, a loop that skips the first item, a shared default list, an
inverted session-expiry check, a predictable token, a 0-based month and
`getYear()`. Each pi review takes 10–40 s; the whole run about 1–2 minutes.

## Before recording

- Build subzero once: `npm run build` in the repository root.
- pi has the `r9700` provider in `~/.pi/agent/models.json`, and the model server is up:
  `curl http://<model-server>:8216/health`.
- Copy the demo out of the repository and work in the copy:
  `./demo.sh setup` (to `~/subzero-demo`, or `./demo.sh setup <dir>`), then
  `cd ~/subzero-demo`. Claude Code will not write files inside a folder loaded
  as a plugin, and the whole repository is the plugin, so `REVIEW.md` could not
  be written here.
- Run `./demo.sh` in the copy once and accept the trust dialog, so it does not
  appear in the recording. Always start Claude Code with `./demo.sh`, never plain
  `claude`: the subzero plugin is loaded only by the `--plugin-dir` flag that
  `demo.sh` passes, so plain `claude` has no `/subzero:review`.
- `./demo.sh reset` for a clean folder.

## Recording

Terminal 1, Claude Code, in the copy:

```sh
./demo.sh            # opens Claude Code here with the subzero plugin
/subzero:review      # type this in Claude Code
```

Claude prints the task ids as it starts the reviewers. Terminal 2, while they run:

```sh
./demo.sh tasks              # all tasks of this folder
./demo.sh attach <task id>   # one pi reviewer, live
```

Afterwards:

```sh
./demo.sh show <task id>     # the pi session as <task id>.html: thinking, tool calls, the reply
cat REVIEW.md
```

To open a pi session in pi itself:
`pi --session-dir .agents/subzero/sessions --session <task id>` (scroll; typing continues it).

## pi on its own

The same skill works in pi without Claude:

```sh
./demo.sh pi src/cart.py     # interactive pi, replies with the findings
```

## Compound-engineering review (tier routing)

`./demo.sh ce` opens Claude Code with the subzero and compound-engineering
plugins and prints the line to type, `/ce-code-review base:<baseline> depth:full`
(`setup` makes the copy a git repository with an empty baseline commit, so CE
has a diff to review). The agent file holds a `medium` tier, a `general` agent and
a read-only `fallback`. At session start subzero tells Claude to send CE's
mid-tier subagents to `delegate` with `tier: "medium"`, and a PreToolUse hook on
the Agent tool redirects any generic spawn for that tier that slips past.
Session-model and cheapest-capable reviewers stay on Claude, because no `large`
or `small` tier is configured. `./demo.sh tasks` shows the routed reviewers as
`general:medium`. How this works: [docs/design.md](../../docs/design.md) §5.4.

Known limits:

- **Plan mode is not respected.** The hook does not read the session's
  permission mode, so a generic subagent spawned in plan mode is still sent to
  the `general` agent, which can write files and run shell commands inside pi,
  outside Claude Code's permission prompts. Do not rely on plan mode to keep a
  routed subagent read-only; run the demo from its copy.
- If the subzero server fails to start, the session-start text still says routing
  is on, but the hook denies nothing and every subagent runs on Claude.
- Worktree-isolated and fork spawns always stay on Claude: a subzero child works
  in the shared checkout.

## Notes

- `./demo.sh` passes the allow rules for the subzero tools and `REVIEW.md` on the
  command line. The same rules are in `.claude/settings.json`; Claude Code applies
  them only after you trust the folder.
- `--setting-sources project,local` keeps your own Claude Code plugins out of the
  demo; your login is unaffected.
- The model serves one request at a time (`models.parallel` in
  `.agents/subzero.yaml`), so the reviewers run one after another.
- Keep reviewer output small: the model server caps one reply at 4096 tokens.
  subzero passes a reply back to Claude whole, never cut, and tells the child
  to keep it under 48,000 characters.
