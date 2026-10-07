const MAX_OUTPUT_CHARS = 800;
const SAFE_EVENT_TYPES = new Set(['tool', 'completed', 'failed', 'stopped', 'interrupted', 'progress', 'message']);
const SAFE_CODES = /^[a-z0-9_-]{1,80}$/i;

export function sanitizeOutput(value, secretValues = []) {
  let output = String(value ?? '');
  for (const secret of [...secretValues].filter(Boolean).sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join('[REDACTED]');
  }
  if (output.length > MAX_OUTPUT_CHARS) output = `[truncated]${output.slice(-MAX_OUTPUT_CHARS)}`;
  return output;
}

export function summarizeLiveFailure({ child, runs = [], events = [], stdout = '', stderr = '', secretValues = [] }) {
  const result = child?.last_result;
  const parsedResult = typeof result === 'string' ? tryParse(result) : result;
  const summary = {
    child: child ? {
      state: safeValue(child.state),
      ownership: safeValue(child.ownership_state),
      completionResultPresent: Boolean(parsedResult && typeof parsedResult === 'object'),
      completionArtifactPresent: Boolean(parsedResult && typeof parsedResult === 'object' && parsedResult.artifactId),
    } : null,
    runs: runs.slice(-8).map(run => ({ status: safeValue(run.status), code: safeCode(run.error_code) })),
    events: events.slice(-20).map(summarizeEvent),
    piOutput: {
      stdout: sanitizeOutput(stdout, secretValues),
      stderr: sanitizeOutput(stderr, secretValues),
    },
  };
  return JSON.stringify(summary);
}

export function requireCompletionResult(raw, diagnostic) {
  let result = null;
  try { result = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { /* Report malformed and missing results the same way. */ }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`Child completion result is missing or invalid. Lifecycle diagnostic: ${diagnostic}`);
  }
  return result;
}

function summarizeEvent(event) {
  const payload = typeof event.payload === 'string' ? tryParse(event.payload) : event.payload;
  const type = SAFE_EVENT_TYPES.has(event.type) ? event.type : 'other';
  const entry = { type };
  if (type === 'tool') {
    if (payload?.name === 'write') entry.name = 'write';
    if (['started', 'finished', 'failed'].includes(payload?.state)) entry.state = payload.state;
  }
  if (type === 'failed' || type === 'interrupted' || type === 'stopped') {
    const code = safeCode(payload?.code);
    if (code) entry.code = code;
  }
  if (type === 'completed') entry.artifactPresent = Boolean(payload?.artifactId);
  return entry;
}

function safeValue(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,80}$/i.test(value) ? value : null;
}

function safeCode(value) {
  return typeof value === 'string' && SAFE_CODES.test(value) ? value : undefined;
}

function tryParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}
