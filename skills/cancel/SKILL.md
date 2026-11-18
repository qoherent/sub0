---
name: cancel
description: Stop one subzero task or all tasks in this Claude session.
argument-hint: "[task id]"
disable-model-invocation: true
allowed-tools:
  - mcp__plugin_subzero_subzero__cancel
---

# Stop subzero tasks

Call `mcp__plugin_subzero_subzero__cancel` with `task` set to the supplied task
id, or with no arguments when no id was supplied. Show the result to the user.
