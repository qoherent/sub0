import { describe, expect, it } from 'vitest';
import { completionNotice, describeTaskReply, formatElapsed, stopNotice } from '../../src/service/status-text.js';

describe('status text', () => {
  it('formats elapsed time', () => {
    expect(formatElapsed(65_000)).toBe('1m05s');
  });

  it('uses the parent adapter tool names in a started reply', () => {
    const reply = { kind: 'started' as const, taskId: 'task-1', startedAt: '2026-01-01T00:00:00Z' };
    expect(describeTaskReply(reply, undefined, { collect: 'subzero_await', cancel: 'subzero_cancel' }, Date.parse(reply.startedAt)))
      .toContain('collect it with subzero_await or cancel it with subzero_cancel');
  });

  it('reports the completed task and other live tasks without including results', () => {
    const now = Date.parse('2026-01-01T00:00:10Z');
    const live = [{ taskId: 'two', agent: 'reviewer', status: 'running' as const, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:00Z' }];
    const notice = completionNotice('one', 'completed', live, 'subzero_await', now);
    expect(notice).toMatch(/one.*completed/);
    expect(notice).toContain('subzero_await');
    expect(notice).toMatch(/two.*running, started/);
    expect(notice).toMatch(/wait/i);
    expect(completionNotice('one', 'failed', [], 'subzero_await', now)).not.toMatch(/wait for/i);
    expect(stopNotice('one')).toMatch(/stopped.*no action/i);
  });
});
