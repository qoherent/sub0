import { describe, expect, it } from 'vitest';
import { mapRequest, tierForPhrase } from '../../src/config/tier-words.js';

describe('shared request mapping', () => {
  it('maps CE phrases and explicit configured tiers', () => {
    expect(tierForPhrase('cheapest capable')).toBe('small');
    expect(tierForPhrase('mid-tier')).toBe('medium');
    expect(tierForPhrase('session model')).toBe('large');
    for (const value of ['small', 'tier:small', 'cheapest capable']) {
      expect(mapRequest('delegate', value, ['small']).tier).toEqual({ kind: 'tier', name: 'small' });
    }
    expect(mapRequest('general', 'session model', []).tier).toEqual({ kind: 'tier', name: 'large' });
    expect(mapRequest('reviewer', 'anthropic/claude-opus', []).tier).toEqual({ kind: 'unmatched', value: 'anthropic/claude-opus' });
    expect(mapRequest('general', '', []).tier).toEqual({ kind: 'none' });
    expect(mapRequest('delegate', undefined, []).agent).toBeUndefined();
    expect(mapRequest('general', undefined, []).agent).toBeUndefined();
    expect(mapRequest('reviewer', undefined, []).agent).toBe('reviewer');
  });
});
