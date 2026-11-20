// @sigil implements design/claude-routing-hooks.sigil ClaudeRoutingHooks (PreToolUse hook)
//
// Thin entry of the PreToolUse hook on the Agent tool: reads the hook input, asks the
// routing logic and prints a deny decision. Any error, missing input or malformed
// stdin allows the spawn: exit 0 with no output.
import { realpathSync } from 'node:fs';
import { dataDir, setting } from '../mcp/parent-session.js';
import { decideAgentSpawn, type SpawnInput } from './routing.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

let output = '';
try {
  const input = JSON.parse(await readStdin()) as { session_id?: unknown; tool_input?: unknown };
  // Only CLAUDE_PROJECT_DIR names the project, the source of the server's SUBZERO_PROJECT_DIR.
  const project = setting(process.env.CLAUDE_PROJECT_DIR);
  if (typeof input.session_id === 'string' && project && typeof input.tool_input === 'object' && input.tool_input !== null) {
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
