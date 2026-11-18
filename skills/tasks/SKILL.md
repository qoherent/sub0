---
name: tasks
description: List the subzero tasks of this project with their status. Run it yourself with /subzero:tasks.
argument-hint: ""
disable-model-invocation: true
allowed-tools:
  - 'Bash(SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" tasks)'
  - 'Bash(SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" tasks *)'
---

# List subzero tasks

Run exactly this command:

```sh
SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" tasks
```

Show the command's output to the user unchanged, whether it succeeded or
failed. Do not create, edit or delete any file yourself and do not summarize
the list. If it reports that something is missing, such as Node 22, relay that
message and stop.

Use `/subzero:cancel` to stop this session's tasks, or `/subzero:cancel <id>`
to stop one task.
