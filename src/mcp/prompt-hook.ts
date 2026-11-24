// @sigil implements design/claude-routing-hooks.sigil ClaudeRoutingHooks (prompt hook)
//
// UserPromptSubmit hook: records when the user typed in this session, so the server
// can end a wait early on a message typed during it. It prints nothing (a
// UserPromptSubmit hook's stdout becomes Claude's context), keeps no text of the
// message, never delays or blocks it, and exits 0 on every error.
import { realpathSync } from 'node:fs';
import { dataDir, setting, writePromptMarker } from './parent-session.js';

try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { session_id?: unknown };
  const project = setting(process.env.CLAUDE_PROJECT_DIR);
  if (typeof input.session_id === 'string' && input.session_id.trim() !== '' && project) {
    writePromptMarker(dataDir(process.env), realpathSync(project), input.session_id, Date.now());
  }
} catch {
  // Record nothing; the message goes through.
}
process.exit(0);
