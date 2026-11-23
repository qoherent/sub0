import { describe, expect, it } from 'vitest';
import { completionNotice, describeContinueReply, describeTaskReply, formatElapsed, formatResult, statusFacts, stopNotice } from '../../src/service/status-text.js';

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
    const live = [{ taskId: 'two', agent: 'reviewer', status: 'running' as const, createdAt: '2026-01-01T00:00:00Z', enqueuedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:00Z' }];
    const notice = completionNotice('one', 'completed', live, 'subzero_await', undefined, now);
    expect(notice).toMatch(/one.*completed/);
    expect(notice).toContain('subzero_await');
    expect(notice).toMatch(/two.*running, started/);
    expect(notice).toMatch(/wait/i);
    expect(completionNotice('one', 'failed', [], 'subzero_await', undefined, now)).not.toMatch(/wait for/i);
    expect(stopNotice('one')).toMatch(/stopped.*no action/i);
  });

  it('names the turn from turn 2 on, with the task id first, and says when held messages did not reach the child', () => {
    const base = { taskId: 'sz-aaaaaa', agent: 'helper', status: 'completed' as const, summary: 'ok' };
    expect(formatResult(base).split('\n')[0]).toBe('task: sz-aaaaaa · helper · status: completed');
    expect(formatResult({ ...base, turn: 2 }).split('\n')[0]).toBe('task: sz-aaaaaa · turn 2 · helper · status: completed');
    expect(formatResult({ ...base, status: 'failed', heldNotDelivered: 2 })).toMatch(/note: 2 follow-up messages held for this turn did not reach the child/);
  });

  it('words each delivery outcome with the task id first', () => {
    const tools = { collect: 'await', cancel: 'cancel' };
    expect(describeContinueReply({ kind: 'steered', taskId: 'sz-aaaaaa', turn: 1 }, tools)).toMatch(/^task: sz-aaaaaa · steered: .*turn 1.*single result/);
    expect(describeContinueReply({ kind: 'queued', taskId: 'sz-aaaaaa', turn: 1 }, tools)).toMatch(/^task: sz-aaaaaa · queued: .*held/);
    expect(describeContinueReply({ kind: 'not_delivered', taskId: 'sz-aaaaaa', reason: 'no such task' }, tools)).toBe('task: sz-aaaaaa · not delivered: no such task');
    const started = describeContinueReply({ kind: 'new_turn', taskId: 'sz-aaaaaa', turn: 3, replayed: 2, status: { kind: 'started', taskId: 'sz-aaaaaa', startedAt: new Date().toISOString() } }, tools);
    expect(started).toMatch(/^task: sz-aaaaaa · new turn: turn 3 started from your message, after 2 earlier messages that never reached the child; running/);
  });

  it('says a task started with no conversation cannot be continued', () => {
    const line = describeTaskReply({ kind: 'started', taskId: 'sz-aaaaaa', startedAt: new Date().toISOString(), continuable: false }, undefined, { collect: 'await', cancel: 'cancel' });
    expect(line).toMatch(/conversation could not be identified, so the task cannot be continued/);
  });

  it('adds the line that the task cannot be continued to a waited result too', () => {
    const text = describeTaskReply({ kind: 'result', result: { taskId: 'sz-aaaaaa', agent: 'helper', status: 'completed', summary: 'ok' }, continuable: false }, undefined, { collect: 'await', cancel: 'cancel' });
    expect(text.split('\n')[0]).toBe('task: sz-aaaaaa · helper · status: completed');
    expect(text.split('\n').at(-1)).toMatch(/conversation could not be identified, so the task cannot be continued/);
  });

  it('gives the status line or first result line of a task a continuation did not reach', () => {
    const tools = { collect: 'await', cancel: 'cancel' };
    expect(describeContinueReply({ kind: 'not_delivered', taskId: 'sz-aaaaaa', reason: 'this task belongs to another conversation', status: 'task: sz-aaaaaa · helper · status: completed' }, tools)).toBe(
      'task: sz-aaaaaa · not delivered: this task belongs to another conversation; task: sz-aaaaaa · helper · status: completed',
    );
  });

  it('counts the time waited from the enqueue time of the latest turn', () => {
    expect(statusFacts({ createdAt: '2026-01-01T00:00:00.000Z', enqueuedAt: '2026-01-01T01:00:00.000Z' })).toMatchObject({ state: 'queued', enqueuedAt: '2026-01-01T01:00:00.000Z' });
    expect(statusFacts({ createdAt: '2026-01-01T00:00:00.000Z' })).toMatchObject({ enqueuedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('names turn 2 in a completion notice and lists no turn for turn 1', () => {
    expect(completionNotice('sz-aaaaaa', 'completed', [], 'subzero_await', 2)).toMatch(/^task sz-aaaaaa turn 2 completed/);
    expect(completionNotice('sz-aaaaaa', 'completed', [], 'subzero_await')).toMatch(/^task sz-aaaaaa completed/);
  });
});
