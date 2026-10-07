import assert from 'node:assert/strict';
import test from 'node:test';
import { requireCompletionResult, summarizeLiveFailure } from './live-pi-diagnostics.mjs';

test('ready child without a completion result gets a bounded, secret-safe diagnosis', () => {
  const summary = summarizeLiveFailure({
    child: { child_id: 'child-123', state: 'ready', ownership_state: 'none', last_result: null },
    runs: [{ run_id: 'run-1', status: 'interrupted', error_code: 'worker_exit_unconfirmed' }],
    events: [
      { type: 'tool', payload: JSON.stringify({ name: 'write', state: 'finished', content: 'do-not-print-this' }) },
      { type: 'interrupted', payload: JSON.stringify({ code: 'worker_exit_unconfirmed', message: 'do-not-print-this-either' }) },
    ],
    stdout: `${'x'.repeat(5000)} request failed with token ${'parent-secret-1'}`,
    stderr: 'plain error',
    secretValues: ['parent-secret-1', 'child-secret-2'],
  });

  assert.match(summary, /"state":"ready"/);
  assert.match(summary, /"ownership":"none"/);
  assert.match(summary, /"completionResultPresent":false/);
  assert.match(summary, /"status":"interrupted"/);
  assert.match(summary, /"type":"interrupted","code":"worker_exit_unconfirmed"/);
  assert.match(summary, /\[REDACTED\]/);
  assert.ok(summary.length < 3000, 'diagnostic output must stay bounded');
  assert.doesNotMatch(summary, /parent-secret-1|child-secret-2|do-not-print-this/);
  assert.throws(() => requireCompletionResult(null, summary), /Child completion result is missing or invalid[\s\S]*"state":"ready"[\s\S]*\[REDACTED\]/);
});
