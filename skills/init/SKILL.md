---
name: init
description: Set up or change the models subzero's tiers run on, for every project (~/.agents/subzero.yaml) or only this one (.agents/subzero.yaml). Run it yourself with /subzero:init for guided setup, or /subzero:init <model> for the quick starter entries, which write this project's file only.
argument-hint: "[<model> [--host pi] [--timeout seconds] [--thinking level]]"
disable-model-invocation: true
allowed-tools:
  - 'Bash(SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" init *)'
  - 'Bash(cat "${CLAUDE_PLUGIN_ROOT}/skills/init/guided-init.md")'
  - 'Bash(SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" config show)'
  - 'Bash(SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" config models)'
  - 'Bash(SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" config check *)'
  - 'Bash(SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" config preview *)'
  - 'Bash(SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" config apply *)'
---

# Set up subzero

The user's arguments are: `$ARGUMENTS`

Do not create, edit or delete any file yourself, including `.agents/subzero.yaml`, and do not install anything. Only subzero's own commands write the file.

## With a model: the quick starter entries

If the arguments above are not empty, run exactly this command, with the user's arguments in place of `$ARGUMENTS`:

```sh
SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" init $ARGUMENTS
```

`init <model>` writes the project file (`.agents/subzero.yaml`) only, never the general file. The arguments are `<model>` (for pi, a `provider/model` name such as `local/qwen`) and, optionally, `--host <host>` (default `pi`), `--timeout <seconds>` and `--thinking <level>`. Show the command's output to the user unchanged, whether it succeeded or failed. If it reports that something is missing, such as Node 22 or pi, relay that message and stop.

## Without a model: guided setup

If the arguments above are empty, run the guided setup.

1. Read the shared guide with exactly this command, then follow it to the end:

   ```sh
   cat "${CLAUDE_PLUGIN_ROOT}/skills/init/guided-init.md"
   ```

2. Run the guide's steps with these commands. Each prints one JSON document. `ok: false` carries a `code` and a `message` to relay.

   | Guide step | What to run |
   |---|---|
   | ask | The AskUserQuestion tool, for every question. Never ask in plain text: that ends your turn and the guided setup with it. |
   | show | `SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" config show` |
   | models | `SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" config models` |
   | check | `SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" config check <model>:<thinking>`, once per model, with the Bash tool's timeout set to 180000 ms, because a cold local model can take two minutes to answer. |
   | preview | `SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" config preview --scope <scope> <changes>` |
   | apply | `SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" config apply --scope <scope> --expect <fingerprint> <changes>` with exactly the changes you previewed. |

   `<scope>` is `general` for every project or `project` for this one, the answer to the guide's scope question. Pass the same `--scope` to preview and apply: an apply with a different scope than its preview is refused as a stale preview. `show` takes no scope.

   `<changes>` is any mix of these flags:
   - `--tier <tier>=<model>:<thinking>`, for example `--tier medium=ollama/qwen2.5-coder:7b:medium`; the thinking level is always last;
   - `--unset <tier>`;
   - `--limit <endpoint>=<n>`;
   - `--no-limit <endpoint>`.

3. After a write that created the file, or added or removed a tier, tell the user to start a new Claude Code session. Claude's routing text is built once per session, so the new tiers route only from the next session. A write of the general file also needs a new session in every other open project.

If a command is denied or fails, stop and tell the user. Never fall back to editing the file.
