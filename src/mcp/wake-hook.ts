// @sigil implements design/claude-routing-hooks.sigil ClaudeRoutingHooks (wake hook)
import { closeSync, openSync, realpathSync } from 'node:fs';
import { dataDir, setting } from './parent-session.js';
import { WakeMarkers, waitForWake } from './wake-markers.js';

/**
 * A result may be written as JSON with the notice text and the path of the turn's
 * collected marker; plain text is delivered as it is, with no marker.
 */
function parseNotice(raw: string): { text: string; collectedMarker?: string } {
  try {
    const value = JSON.parse(raw) as { notice?: unknown; collectedMarker?: unknown } | null;
    if (value !== null && typeof value === 'object' && typeof value.collectedMarker === 'string' && value.collectedMarker !== '') {
      return { text: typeof value.notice === 'string' ? value.notice : raw, collectedMarker: value.collectedMarker };
    }
  } catch {
    // Plain text.
  }
  return { text: raw };
}

try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { session_id?: unknown };
  const project = setting(process.env.CLAUDE_PROJECT_DIR);
  if (typeof input.session_id === 'string' && input.session_id && project) {
    const markers = new WakeMarkers(dataDir(process.env), realpathSync(project));
    const notice = await waitForWake(markers, input.session_id);
    if (notice !== undefined) {
      const { text, collectedMarker } = parseNotice(notice);
      process.stderr.write(`${text}\n`, () => {
        // The result is delivered: record that the turn was collected. Exclusive create; any error is ignored.
        if (collectedMarker !== undefined) {
          try { closeSync(openSync(collectedMarker, 'wx', 0o600)); } catch { /* Already there or unwritable. */ }
        }
        process.exit(2);
      });
    }
  }
} catch {
}
