// @sigil implements design/claude-routing-hooks.sigil ClaudeRoutingHooks (PreToolUse hook)
//
// Thin entry of the PreToolUse hook on the Agent tool: reads the hook input, asks the
// routing logic and prints a deny decision. Any error, missing input or malformed
// stdin allows the spawn: exit 0 with no output.
//
// The same hook also sees subzero's own delegate, continue and await calls: for those
// it records a call marker (the tool-use id, with the id of the subagent that made the
// call, if any) and always allows the call.
import { realpathSync } from 'node:fs';
import { dataDir, setting, writeCallMarker } from '../mcp/parent-session.js';
import { decideAgentSpawn, type SpawnInput } from './routing.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const SUBZERO_TOOLS = new Set(['mcp__plugin_subzero_subzero__delegate', 'mcp__plugin_subzero_subzero__continue', 'mcp__plugin_subzero_subzero__await']);

let output = '';
try {
  const input = JSON.parse(await readStdin()) as { session_id?: unknown; tool_input?: unknown; tool_name?: unknown; tool_use_id?: unknown; agent_id?: unknown };
  // Only CLAUDE_PROJECT_DIR names the project, the source of the server's SUBZERO_PROJECT_DIR.
  const project = setting(process.env.CLAUDE_PROJECT_DIR);
  if (typeof input.tool_name === 'string' && SUBZERO_TOOLS.has(input.tool_name)) {
    if (project && typeof input.tool_use_id === 'string' && input.tool_use_id !== '') {
      writeCallMarker(dataDir(process.env), realpathSync(project), input.tool_use_id, typeof input.agent_id === 'string' ? input.agent_id : undefined);
    }
  } else if (typeof input.tool_name === 'string' && input.tool_name !== 'Agent' && input.tool_name !== 'Task') {
    // Any other tool is not the hook's concern: allow.
  } else if (typeof input.session_id === 'string' && project && typeof input.tool_input === 'object' && input.tool_input !== null) {
    const decision = decideAgentSpawn(input.tool_input as SpawnInput, {
      projectRoot: realpathSync(project),
      dataDir: dataDir(process.env),
      sessionId: input.session_id,
    });
    if (decision.decision === 'deny') {
      output =
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason },
        }) + '\n';
    }
  }
} catch {
  // Allow: no output.
}
// Exit once stdout has flushed, so a piped reader never sees a cut JSON line.
if (output === '') process.exit(0);
process.stdout.write(output, () => process.exit(0));
