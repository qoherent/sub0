// @sigil implements design/claude-routing-hooks.sigil ClaudeRoutingHooks (wake hook)
import { realpathSync } from 'node:fs';
import { dataDir, setting } from './parent-session.js';
import { WakeMarkers, waitForWake } from './wake-markers.js';

try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { session_id?: unknown };
  const project = setting(process.env.CLAUDE_PROJECT_DIR);
  if (typeof input.session_id === 'string' && input.session_id && project) {
    const markers = new WakeMarkers(dataDir(process.env), realpathSync(project));
    const notice = await waitForWake(markers, input.session_id);
    if (notice !== undefined) process.stderr.write(`${notice}\n`, () => process.exit(2));
  }
} catch {
}
