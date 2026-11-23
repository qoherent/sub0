<!-- @sigil implements design/sigil-wiring.sigil SigilWiring (README) -->
# subzero with sigil: the experiment wiring

These files run sigil's interpreter children on pi through subzero (arm B), or as
Claude subagents (arm A), so the two arms differ only in where interpreters run.

| Arm | Evaluator | Interpreter |
| --- | --- | --- |
| A | `agents/evaluator-a.md` | Claude subagent `agents/interpreter-a.md` (inherits the evaluator's model) |
| A-cheap | `agents/evaluator-a-cheap.md` | Claude subagent `agents/interpreter-a-cheap.md` (Haiku) |
| B | `agents/evaluator-b.md` | subzero agent `sigil-interpreter` (r9700/Qwen3.8, thinking high) |
| B-control | `agents/evaluator-b-control.md` | subzero agent `sigil-interpreter-control` (A's Claude model on pi) |
| B-low | `agents/evaluator-b-low.md` | subzero agent `sigil-interpreter-low` (r9700/Qwen3.8, thinking low) |

`.agents/subzero.yaml` holds the three subzero agents. Their skill folders point at
`skills/` of the pass directory, where the sigil skills are staged; the sigil
repository itself is never modified. Set the model of `sigil-interpreter-control`
to the Claude model that arm A's interpreters use, and log pi into Anthropic.

## Using arm B interactively

1. Add an allow rule for the subzero tools to your user or project settings
   **first**. A plugin cannot ship one:

   ```json
   { "permissions": { "allow": ["mcp__plugin_subzero_subzero__*"] } }
   ```

   Without it, a delegation from the evaluator subagent raises an approval prompt
   in the main session, and under `--permission-mode dontAsk` it is denied.
2. Copy `agents/evaluator-b.md` into `.claude/agents/` of the project.
3. Copy `.agents/subzero.yaml` into the project and stage the sigil skills in its
   `skills/` folder.
4. Ask the main conversation to have `sigil-evaluator` review the design.

## What subzero does not do

- **subzero does not track what a child writes.** It takes no snapshot and gates
  no write; a child is limited only by its tool list. Review the tree with git
  afterwards, and keep a parent and a child, or two children, from writing the
  same files.
- **The store folder holds plain text.** `.agents/subzero/` keeps the briefs,
  event logs and child sessions, which can hold secrets from tool output. It is
  created readable by its owner only and holds its own `.gitignore` that ignores
  everything in it. subzero never edits your own `.gitignore`, and leaves an
  existing `.gitignore` in the store folder unchanged.
- **Listings are per project, not per window.** Two Claude sessions started in
  one project at the same time may mix the tasks listed for their parent session
  id.
- **A parallel limit holds only among the child runs of one process.** A
  terminal `subzero run` or a second session is not counted against it. A model
  with no entry in `models.parallel`, such as a Claude model, has no parallel
  limit.
- **The command line has no cancel.** A task started with `subzero run` ends
  only by Ctrl-C in its terminal; while it runs, the server reports it as running
  in another process.
