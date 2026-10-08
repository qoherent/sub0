# Subagent Delegation with Subzero

You have access to Subzero MCP tools (`mcp__subzero__*`) to spawn and supervise persistent subagents.

When the user asks to spawn, run, or delegate a task to a subagent:
1. **Model Defaults**:
   - `url`: `"https://opencode.ai/zen/go/v1"`
   - `model`: `"longcat-2.5-preview-free"`
   - `credentialRef`: `"longcat"`
2. **Template Selection**:
   - Use `"researcher"` for investigation, read-only analysis, file reading, and searching.
   - Use `"coder"` for writing code, editing files, running bash commands, and testing.
3. **Autonomous Execution**:
   - Call `mcp__subzero__subzero_spawn` with the prompt, chosen `templateId`, and the default model settings above.
   - Call `mcp__subzero__subzero_get` (with `{ childId, waitMs: 10000 }`) until the child reaches `"ready"` state or a `"completed"` event is emitted.
   - Retrieve the final output via `mcp__subzero__subzero_output` if an `artifactId` is present, or summarize the completed result preview.
   - Report the final outcome cleanly to the user.
