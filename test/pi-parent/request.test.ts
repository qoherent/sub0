import { describe, expect, it } from 'vitest';
import { mapPiRequest } from '../../src/pi-parent/request.js';

describe('pi subagent request', () => {
  it('maps tier words and aliases and reports ignored model values', () => {
    expect(mapPiRequest({ task: 'review', agent: 'delegate', model: 'cheapest capable' }, ['medium', 'small'], 'session')).toEqual({ delegation: { briefText: 'review', tier: 'small', parentSessionId: 'session' } });
    expect(mapPiRequest({ task: 'review', agent: 'reviewer', model: 'other/model' }, ['medium'], 'session')).toEqual({ delegation: { agent: 'reviewer', briefText: 'review', parentSessionId: 'session' }, notice: 'model "other/model" was not used' });
    expect(mapPiRequest({ task: 'review', model: 'session model' }, ['medium'], 'session')).toEqual({ delegation: { briefText: 'review', tier: 'large', parentSessionId: 'session' } });
  });
  it('refuses isolation and management requests before delegating', () => {
    for (const extra of [{ worktree: true }, { isolation: 'worktree' }, { context: 'fork' }]) {
      expect(mapPiRequest({ task: 'x', ...extra }, ['medium'], 'session')).toMatchObject({ error: expect.stringMatching(/isolation.*not supported/i) });
    }
    expect(mapPiRequest({ task: 'x', action: 'status' }, ['medium'], 'session')).toMatchObject({ error: expect.stringMatching(/subzero_tasks/) });
  });
});
