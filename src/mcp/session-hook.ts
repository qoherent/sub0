// @sigil implements design/claude-mcp-server.sigil ClaudeMcpServer (SessionStart hook)
//
// Records the Claude session id for the project (named by CLAUDE_PROJECT_DIR alone;
// with it unset nothing is recorded), so the tasks tool can list the
// tasks of this conversation, including after /clear. It then adds the routing text
// (or a one-line warning) to Claude's context. It never blocks a session.
import { realpathSync } from 'node:fs';
import { ancestorPids, routingContext } from '../routing/routing.js';
import { dataDir, liveReadinessMarkers, setting, writeParentSessionId } from './parent-session.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

let project: string | undefined;
try {
  const input = JSON.parse(await readStdin()) as { session_id?: string };
  // The plugin's .mcp.json sets the server's SUBZERO_PROJECT_DIR from
  // CLAUDE_PROJECT_DIR, so that is the key both sides share.
  project = setting(process.env.CLAUDE_PROJECT_DIR);
  if (!project || typeof input.session_id !== 'string' || input.session_id.trim() === '') process.exit(0);
  writeParentSessionId(dataDir(process.env), realpathSync(project), input.session_id, ancestorPids());
} catch {
  process.exit(0);
}
let output = '';
try {
  const root = project === undefined ? undefined : realpathSync(project);
  const ancestors = ancestorPids();
  const taskMode = root === undefined ? null : liveReadinessMarkers(dataDir(process.env), root).find((marker) => ancestors.has(marker.ppid))?.taskMode ?? null;
  const context = routingContext(root, taskMode);
  if (context !== undefined) {
    output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }) + '\n';
  }
} catch {
  // Routing text is optional; any error adds nothing.
}
// Exit once stdout has flushed, so a piped reader never sees a cut JSON line.
if (output === '') process.exit(0);
process.stdout.write(output, () => process.exit(0));
