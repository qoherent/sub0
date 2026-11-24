export const TIER_WORDS = [
  { tier: 'small', phrase: 'cheapest capable' },
  { tier: 'medium', phrase: 'mid-tier' },
  { tier: 'large', phrase: 'session model' },
] as const;

export function tierForPhrase(value: string): string | undefined {
  return TIER_WORDS.find(({ phrase }) => phrase === value)?.tier;
}

export type MappedTier = { kind: 'none' } | { kind: 'tier'; name: string } | { kind: 'unmatched'; value: string };

export function mapRequest(agent: string | undefined, tierText: string | undefined, configuredTiers: readonly string[]): { agent: string | undefined; tier: MappedTier } {
  const mappedAgent = agent === 'delegate' || agent === 'general' || agent === '' ? undefined : agent;
  const value = tierText?.trim() ?? '';
  if (!value) return { agent: mappedAgent, tier: { kind: 'none' } };
  const explicit = value.startsWith('tier:') ? value.slice(5) : value;
  const name = value.startsWith('tier:') ? explicit : configuredTiers.includes(value) ? value : tierForPhrase(value);
  return { agent: mappedAgent, tier: name ? { kind: 'tier', name } : { kind: 'unmatched', value } };
}

/**
 * What configuring `large` moves off Claude, told before `large` is set. The one
 * source of this sentence; README "What configuring a large tier changes" explains it.
 */
export const LARGE_TIER_WARNING =
  "Setting large sends compound-engineering's session-model reviewers and plain subagent requests to the child model instead of Claude.";
