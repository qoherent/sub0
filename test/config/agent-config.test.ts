import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addStarterEntries,
  buildCatalog,
  configuredTierNames,
  getAgent,
  getRouting,
  globalFile,
  LoadError,
  listAgentNames,
  loadAgentFile,
  loadChildHostOptions,
  MissingAgentFileError,
  parseCatalog,
  ProjectDisabledError,
  resolveAgent,
  resolveProjectRoot,
  routableTiers,
  StarterHostConflictError,
  TierError,
  UnknownAgentError,
  UnresolvedRootError,
  type StarterSpec,
} from '../../src/config/agent-config.js';
import { makeProject, tempDir } from '../helpers.js';

const TIERS = `models:
  tiers:
    default: { host: pi, model: local/m, thinking: high }
    medium: { host: pi, model: local/m, thinking: high }
`;

/** Tier text with a `models.parallel` map of the given entries, such as `r9700/Qwen3.8: 1`. */
function withLimits(tiers: string, ...entries: string[]): string {
  return tiers.replace('models:\n', `models:\n  parallel:\n${entries.map((e) => `    ${e}\n`).join('')}`);
}

function project(agents: string, extra = '', tiers = TIERS): string {
  const required = `${agents.includes('  general:') ? '' : GENERAL}${agents.includes('  fallback:') ? '' : FALLBACK}`;
  return makeProject(`skills:\n  alpha: ./skills/alpha\n${extra}${tiers}agents:\n${agents}${required}`);
}

const VALID = `  a:
    description: d
    skills: [alpha]
    tools: [read]
    timeout: 10
`;

const GENERAL = `  general:
    tools: [read, write, bash]
    timeout: 20
`;

const FALLBACK = `  fallback:
    tools: [read]
    timeout: 20
`;

const MEDIUM_TIERS = `models:
  tiers:
    default: { host: pi, model: r9700/Qwen3.8, thinking: high }
    small: { host: pi, model: local/s, thinking: off }
    medium: { host: pi, model: r9700/Qwen3.8, thinking: low }
    large: { host: claude, model: anthropic/opus, thinking: max }
`;

describe('AgentConfig load', () => {
  it('requires medium, general and fallback and defaults a request to medium', () => {
    const complete = `${MEDIUM_TIERS}agents:\n${GENERAL}${FALLBACK}`;
    expect(getAgent(makeProject(complete), undefined).model).toBe('r9700/Qwen3.8');
    // Each message names the init command of both parents.
    const init = '; run /subzero:init in Claude Code or /subzero init in pi';
    expect(() => loadAgentFile(makeProject(complete.replace('    medium: { host: pi, model: r9700/Qwen3.8, thinking: low }\n', '')))).toThrow(`the medium tier is required in models.tiers${init}`);
    expect(() => loadAgentFile(makeProject(`${MEDIUM_TIERS}agents:\n${FALLBACK}`))).toThrow(`the general agent is required${init}`);
    const named = makeProject(`${MEDIUM_TIERS}agents:\n${FALLBACK}`);
    expect(() => loadAgentFile(named)).toThrow(path.join(named, '.agents', 'subzero.yaml'));
    expect(() => loadAgentFile(makeProject(`${MEDIUM_TIERS}agents:\n${GENERAL}`))).toThrow(`the fallback agent is required${init}`);
  });
  it('loads a valid agent on the default tier with absolute skill folders', () => {
    const root = project(VALID);
    const agent = getAgent(root, 'a');
    expect(agent).toMatchObject({ name: 'a', host: 'pi', model: 'local/m', thinking: 'high', parallel: null });
    expect(agent.tools).toEqual(['read']);
    expect(agent.timeout).toBe(10);
    expect(agent.skills[0]!.folder).toBe(path.join(root, '.agents', 'skills', 'alpha'));
    expect(path.isAbsolute(agent.skills[0]!.folder)).toBe(true);
  });

  it('rejects a host, model or thinking set directly on an agent, naming the entry', () => {
    for (const key of ['host: pi', 'model: local/m', 'thinking: low']) {
      const root = project(VALID + `    ${key}\n`);
      expect(() => loadAgentFile(root)).toThrow(/agent "a": .*(host|model|thinking)/);
    }
    expect(() => loadAgentFile(project(GENERAL + '    model: x/y\n'))).toThrow(/^general: .*model/);
  });

  it('rejects an unknown key, naming the entry first, in general and fallback and in any agent', () => {
    expect(() => loadAgentFile(project(GENERAL + '    colour: red\n'))).toThrow(/^general: unknown key "colour"/);
    expect(() => loadAgentFile(project(FALLBACK + '    colour: red\n'))).toThrow(/^fallback: unknown key "colour"/);
    expect(() => loadAgentFile(project(VALID + '    colour: red\n'))).toThrow(/^agent "a": unknown key "colour"/);
  });

  it('rejects a missing or non-positive timeout', () => {
    expect(() => loadAgentFile(project(VALID.replace('    timeout: 10\n', '')))).toThrow(/agent "a": timeout is required/);
    expect(() => loadAgentFile(project(VALID.replace('timeout: 10', 'timeout: 0')))).toThrow(/agent "a": timeout must be a positive/);
  });

  it('rejects a skill missing from the skills map, naming agent and skill', () => {
    const root = project(VALID.replace('[alpha]', '[alpha, gamma]'));
    expect(() => loadAgentFile(root)).toThrow(/agent "a": skill "gamma"/);
  });

  it('still loads a skill folder that does not exist on disk', () => {
    const root = makeProject(`skills:\n  ghost: ./nowhere\n${TIERS}agents:\n${VALID.replace('[alpha]', '[ghost]')}${GENERAL}${FALLBACK}`);
    expect(getAgent(root, 'a').skills[0]!.folder).toBe(path.join(root, '.agents', 'nowhere'));
  });

  it('gives an unknown agent error that lists every configured agent entry', () => {
    const root = project(VALID + VALID.replace('  a:', '  b:'));
    try {
      getAgent(root, 'zed');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownAgentError);
      expect((err as UnknownAgentError).configured).toEqual(['a', 'b', 'general', 'fallback']);
      expect((err as Error).message).toMatch(/zed.*a, b/);
    }
  });

  it('fails the whole load on one invalid agent entry', () => {
    const root = project(VALID + VALID.replace('  a:', '  b:').replace('timeout: 10', 'timeout: 0'));
    expect(() => getAgent(root, 'a')).toThrow(/agent "b"/);
  });

  it('reports a missing or malformed agent file', () => {
    const root = tempDir();
    expect(() => loadAgentFile(root)).toThrow(LoadError);
    expect(() => loadAgentFile(root)).toThrow(/missing/);
    expect(() => loadAgentFile(root)).toThrow(/; run \/subzero:init in Claude Code or \/subzero init in pi$/);
    mkdirSync(path.join(root, '.agents'));
    writeFileSync(path.join(root, '.agents', 'subzero.yaml'), 'agents: [unclosed');
    expect(() => loadAgentFile(root)).toThrow(/malformed/);
  });

  it('reads the agent file again on each call', () => {
    const root = project(VALID);
    expect(getAgent(root, 'a').thinking).toBe('high');
    writeFileSync(path.join(root, '.agents', 'subzero.yaml'), `skills:\n  alpha: ./skills/alpha\n${TIERS.replaceAll('high', 'low')}agents:\n${VALID}${GENERAL}${FALLBACK}`);
    expect(getAgent(root, 'a').thinking).toBe('low');
    writeFileSync(path.join(root, '.agents', 'subzero.yaml'), `skills:\n  alpha: ./skills/alpha\n${MEDIUM_TIERS}agents:\n${VALID}${GENERAL}${FALLBACK}`);
    expect(configuredTierNames(root)).toEqual(['default', 'small', 'medium', 'large']);
  });

  it('gives every tier that names a model its limit, and no limit to a model with no entry (R17)', () => {
    const tiers = `models:
  tiers:
    default: { host: pi, model: r9700/Qwen3.8, thinking: high }
    medium: { host: pi, model: r9700/Qwen3.8, thinking: high }
    small: { host: pi, model: r9700/Qwen3.8, thinking: low }
    other: { host: pi, model: r9700/Other, thinking: high }
    cloud: { host: pi, model: anthropic/claude, thinking: high }
`;
    const agents =
      VALID +
      VALID.replace('  a:', '  b:').replace('skills', 'tier: small\n    skills') +
      VALID.replace('  a:', '  c:').replace('skills', 'tier: cloud\n    skills') +
      VALID.replace('  a:', '  d:').replace('skills', 'tier: other\n    skills');
    const root = project(agents, '', withLimits(tiers, 'r9700/Qwen3.8: 1'));
    expect(getAgent(root, 'a')).toMatchObject({ model: 'r9700/Qwen3.8', parallel: 1 });
    expect(getAgent(root, 'b')).toMatchObject({ model: 'r9700/Qwen3.8', parallel: 1 });
    // A limit belongs to one whole model: another model on the same endpoint is not covered.
    expect(getAgent(root, 'd')).toMatchObject({ model: 'r9700/Other', parallel: null });
    expect(getAgent(root, 'c')).toMatchObject({ model: 'anthropic/claude', parallel: null });
  });

  it('rejects a limit for a model that no tier or override uses, naming the model (R18)', () => {
    const root = project(VALID, '', withLimits(TIERS, 'local/gone: 1'));
    expect(() => loadAgentFile(root)).toThrow(/model "local\/gone": no tier or tier override uses it/);
  });

  it('accepts a limit for a model that only a tier, or only an override, uses', () => {
    const onlyTier = project(VALID, '', withLimits(TIERS, 'local/m: 2'));
    expect(getAgent(onlyTier, 'a').parallel).toBe(2);
    const override = VALID.replace('skills', 'tiers:\n      medium: { model: gpu/x }\n    skills');
    const viaOverride = project(override, '', withLimits(TIERS, 'gpu/x: 3'));
    expect(getAgent(viaOverride, 'a')).toMatchObject({ model: 'gpu/x', parallel: 3 });
  });

  it('rejects a parallel limit that is not a positive whole number', () => {
    for (const bad of ['0', '1.5', '"two"']) {
      const root = project(VALID, '', withLimits(TIERS, `local/m: ${bad}`));
      expect(() => loadAgentFile(root)).toThrow(/model "local\/m": parallel must be a positive whole number/);
    }
  });

  it('fails an agent file that holds endpoints, naming the file and listing the models each limit covered (R19)', () => {
    const tiers = `models:
  tiers:
    default: { host: pi, model: local/a, thinking: high }
    medium: { host: pi, model: local/a, thinking: high }
    small: { host: pi, model: local/b, thinking: low }
    cloud: { host: pi, model: anthropic/claude, thinking: high }
`;
    const root = project(VALID, 'endpoints:\n  local:\n    parallel: 2\n', tiers);
    const err = (() => {
      try {
        loadAgentFile(root);
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected a throw');
    })();
    expect(err).toBeInstanceOf(LoadError);
    expect(err.message).toContain(path.join(root, '.agents', 'subzero.yaml'));
    expect(err.message).toMatch(/"endpoints:", which "models.parallel" replaced/);
    expect(err.message).toMatch(/endpoint local \(limit 2\) covered local\/a, local\/b: give each model its own limit/);
    expect(err.message).toContain('run /subzero:init in Claude Code or /subzero init in pi');
  });

  it.each([['endpoints: {}\n'], ['endpoints:\n']])('fails an agent file whose endpoints key holds no entry (%j), because the key itself is what was removed', (text) => {
    const root = project(VALID, text);
    const file = path.join(root, '.agents', 'subzero.yaml');
    expect(() => loadAgentFile(root)).toThrow(LoadError);
    expect(() => loadAgentFile(root)).toThrow(new RegExp(`"endpoints:", which "models.parallel" replaced, in ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(() => loadAgentFile(root)).toThrow(/the map is empty, so there is no limit to keep: remove the key/);
    expect(loadAgentFile(root, { allowLegacyEndpoints: true }).legacyEndpoints).toEqual([{ file, endpoint: '', parallel: null, models: [], empty: true }]);
  });

  it('reports an endpoints limit that no model uses as one to drop', () => {
    const root = project(VALID, 'endpoints:\n  gone:\n    parallel: 2\n');
    expect(() => loadAgentFile(root)).toThrow(/endpoint gone \(limit 2\): no model of this configuration uses it, so drop it/);
  });

  it('keeps the endpoints limits in the catalog when the load allows them, for guided init to repair', () => {
    const root = project(VALID, 'endpoints:\n  local:\n    parallel: 2\n');
    const catalog = loadAgentFile(root, { allowLegacyEndpoints: true });
    expect(catalog.legacyEndpoints).toEqual([{ file: path.join(root, '.agents', 'subzero.yaml'), endpoint: 'local', parallel: 2, models: ['local/m'] }]);
    expect(catalog.limits.size).toBe(0);
  });
});

describe('AgentConfig model tiers', () => {
  it('resolves general at a named tier to that tier host, model, thinking and limit', () => {
    const root = project(GENERAL, '', withLimits(MEDIUM_TIERS, 'r9700/Qwen3.8: 1'));
    expect(getAgent(root, 'general', { tier: 'medium' })).toMatchObject({
      name: 'general:medium',
      host: 'pi',
      model: 'r9700/Qwen3.8',
      thinking: 'low',
      parallel: 1,
      tools: ['read', 'write', 'bash'],
      timeout: 20,
    });
    expect(getAgent(root, 'general').name).toBe('general');
    expect(getAgent(root, undefined).name).toBe('general');
    expect(getAgent(root, 'general', { tier: 'small' })).toMatchObject({ name: 'general:small', model: 'local/s', thinking: 'off' });
  });

  it('resolves an agent at its own tier, at a named tier, and applies a tier override field by field', () => {
    const reviewer = `  reviewer:
    description: r
    tier: medium
    tiers:
      large: { model: anthropic/sonnet }
    tools: [read]
    timeout: 5
`;
    const root = project(reviewer, '', MEDIUM_TIERS);
    expect(getAgent(root, 'reviewer')).toMatchObject({ name: 'reviewer', model: 'r9700/Qwen3.8', thinking: 'low', host: 'pi' });
    expect(getAgent(root, 'reviewer', { tier: 'large' })).toMatchObject({
      name: 'reviewer:large',
      host: 'claude',
      model: 'anthropic/sonnet',
      thinking: 'max',
    });
    expect(getAgent(root, 'reviewer', { tier: 'small' }).model).toBe('local/s');
  });

  it('fails the load, naming the entry, on an override or own tier that is not configured', () => {
    const badOverride = VALID.replace('skills', 'tiers:\n      huge: { model: x/y }\n    skills');
    expect(() => loadAgentFile(project(badOverride))).toThrow(/agent "a".*huge/);
    expect(() => loadAgentFile(project(VALID.replace('skills', 'tier: huge\n    skills')))).toThrow(/agent "a".*huge/);
    const badField = VALID.replace('skills', 'tiers:\n      default: { timeout: 3 }\n    skills');
    expect(() => loadAgentFile(project(badField))).toThrow(/agent "a".*default.*timeout/);
  });

  it('requires host, model and thinking in every tier, naming it', () => {
    for (const medium of ['{ model: local/m, thinking: high }', '{ host: pi, thinking: high }', '{ host: pi, model: local/m }']) {
      const tiers = `models:\n  tiers:\n    default: { host: pi, model: local/m, thinking: high }\n    medium: ${medium}\n`;
      expect(() => loadAgentFile(project(VALID, '', tiers))).toThrow(/tier "medium"/);
    }
  });

  it('lists routable tiers only while agents holds general, with the host and model each runs', () => {
    const root = project(GENERAL, '', MEDIUM_TIERS);
    expect(routableTiers(root, ['pi'])).toEqual([
      { tier: 'default', host: 'pi', model: 'r9700/Qwen3.8', thinking: 'high' },
      { tier: 'small', host: 'pi', model: 'local/s', thinking: 'off' },
      { tier: 'medium', host: 'pi', model: 'r9700/Qwen3.8', thinking: 'low' },
    ]);
    // With no supported hosts given, no host is checked.
    expect(routableTiers(root).map((t) => t.tier)).toEqual(['default', 'small', 'medium', 'large']);
    expect(configuredTierNames(root)).toEqual(['default', 'small', 'medium', 'large']);
  });

  it('judges a routable tier by the host after the general override', () => {
    const general = GENERAL + '    tiers:\n      large: { host: pi }\n      small: { host: claude }\n';
    const root = project(general, '', MEDIUM_TIERS);
    expect(routableTiers(root, ['pi']).map((t) => t.tier)).toEqual(['default', 'medium', 'large']);
  });

  it('loads a tier whose host has no registered driver, and resolving it raises the tier error', () => {
    const root = project(GENERAL, '', MEDIUM_TIERS);
    try {
      getAgent(root, 'general', { tier: 'large', supportedHosts: ['pi'] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TierError);
      const tierError = err as TierError;
      expect(tierError.tier).toBe('large');
      expect(tierError.configured).toEqual(['default', 'small', 'medium', 'large']);
      expect(tierError.host).toBe('claude');
      expect(tierError.supportedHosts).toEqual(['pi']);
      expect(tierError.message).toMatch(/large.*claude.*pi.*default, small, medium, large/s);
    }
    // No supported hosts given: nothing is checked.
    expect(getAgent(root, 'general', { tier: 'large' }).host).toBe('claude');
  });

  it('raises the tier error for an unconfigured requested tier, naming the configured tiers', () => {
    const root = project(GENERAL, '', MEDIUM_TIERS);
    try {
      getAgent(root, 'general', { tier: 'huge', supportedHosts: ['pi'] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TierError);
      expect((err as TierError).host).toBeUndefined();
      expect((err as Error).message).toMatch(/huge.*default, small, medium, large/);
    }
  });

  it('raises the tier error for a host that comes from an override, without failing the load', () => {
    const agent = VALID.replace('skills', 'tiers:\n      medium: { host: codex }\n    skills');
    const root = project(agent);
    expect(loadAgentFile(root).entries.has('a')).toBe(true);
    expect(() => getAgent(root, 'a', { supportedHosts: ['pi'] })).toThrow(/codex.*pi/);
  });

  it('keeps the fallback tools and the general tools apart, at every tier', () => {
    const root = project(GENERAL + FALLBACK, '', MEDIUM_TIERS);
    expect(getAgent(root, 'fallback', { tier: 'medium' }).tools).toEqual(['read']);
    expect(getAgent(root, 'general', { tier: 'medium' }).tools).toEqual(['read', 'write', 'bash']);
    expect(loadAgentFile(root).entries.has('fallback')).toBe(true);
  });

  it('rejects a description on general or fallback, naming it, while a reviewer keeps its description', () => {
    expect(() => loadAgentFile(project(GENERAL + '    description: x\n'))).toThrow(/^general: .*description/);
    expect(() => loadAgentFile(project(FALLBACK + '    description: x\n'))).toThrow(/^fallback: .*description/);
    const root = project(GENERAL + VALID.replace('  a:', '  reviewer:'));
    expect(getAgent(root, 'reviewer').description).toBe('d');
    expect(getAgent(root, 'general').description).toBeUndefined();
  });

  it('requires a description on every other agent', () => {
    expect(() => loadAgentFile(project(VALID.replace('    description: d\n', '')))).toThrow(/agent "a": description/);
  });

  it('reads the routing settings back as given, and on by default', () => {
    expect(getRouting(project(VALID))).toEqual({ hook: true, genericAgents: undefined });
    const root = makeProject(`skills:\n  alpha: ./skills/alpha\n${TIERS}routing:\n  hook: false\n  generic_agents: [general-purpose, helper]\nagents:\n${VALID}${GENERAL}${FALLBACK}`);
    expect(getRouting(root)).toEqual({ hook: false, genericAgents: ['general-purpose', 'helper'] });
    expect(() => loadAgentFile(makeProject(`skills:\n  alpha: ./skills/alpha\n${TIERS}routing:\n  hook: nope\nagents:\n${VALID}`))).toThrow(/routing/);
  });
});

const SPEC: StarterSpec = {
  host: 'pi',
  model: 'r9700/Qwen3.8',
  thinking: 'medium',
  timeout: 1200,
  generalTools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
  fallbackTools: ['read', 'grep', 'find', 'ls'],
};

function agentFileOf(root: string): string {
  return path.join(root, '.agents', 'subzero.yaml');
}

/** Every original line is still there, in order. */
function keepsLines(before: string, after: string): void {
  const rest = after.split('\n');
  let from = 0;
  for (const line of before.split('\n')) {
    const at = rest.indexOf(line, from);
    expect(at, `line lost or moved: ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(from);
    from = at + 1;
  }
}

describe('AgentConfig starter entries', () => {
  it('adds starter entries to empty and flow-style maps while retaining existing entries', () => {
    for (const text of [
      '# keep\nmodels: { tiers: {} }\nagents: {}\n# end\n',
      '# keep\nmodels:\n  tiers:\nagents:\n# end\n',
      '# keep\nmodels: { tiers: { small: { host: pi, model: local/s, thinking: low } } }\nagents: { helper: { description: h, tools: [read], timeout: 5 } }\n# end\n',
      '# keep\nmodels: { tiers: { small: { host: pi, model: local/s, thinking: low }, } }\nagents: { helper: { description: h, tools: [read], timeout: 5 }, }\n# end\n',
      '# keep\nmodels:\n  tiers: { small: { host: pi, model: local/s, thinking: low } # existing\n  }\nagents: { helper: { description: h, tools: [read], timeout: 5 } # existing\n}\n# end\n',
      '# keep\nmodels: { tiers: {\n  small: { host: pi, model: local/s, thinking: low } } }\nagents: {\n  helper: { description: h, tools: [read], timeout: 5 } }\n# end\n',
    ]) {
      const root = makeProject(text);
      expect(addStarterEntries(root, SPEC).added).toEqual(['medium', 'general', 'fallback']);
      const updated = readFileSync(agentFileOf(root), 'utf8');
      expect(updated).toContain('# keep\n');
      expect(updated).toContain('# end\n');
      expect(getAgent(root, undefined).model).toBe(SPEC.model);
      expect(getAgent(root, 'fallback').tools).toEqual(SPEC.fallbackTools);
      if (text.includes('helper')) expect(getAgent(root, 'helper').description).toBe('h');
    }
  });
  it('adds medium without editing an already complete flow-style agents map', () => {
    const text = 'agents: { general: { tools: [read], timeout: 5 }, fallback: { tools: [read], timeout: 5 } }\n';
    const root = makeProject(text);
    expect(addStarterEntries(root, SPEC)).toEqual({ added: ['medium'], present: ['general', 'fallback'] });
    expect(readFileSync(agentFileOf(root), 'utf8')).toContain(text);
    expect(getAgent(root, 'general').model).toBe(SPEC.model);
  });
  it('creates a missing file with the medium tier, general and a read-only fallback that load', () => {
    const root = tempDir();
    const result = addStarterEntries(root, SPEC);
    expect(result).toEqual({ added: ['medium', 'general', 'fallback'], present: [] });
    expect(getAgent(root, 'general')).toMatchObject({ host: 'pi', model: 'r9700/Qwen3.8', thinking: 'medium', timeout: 1200, tools: SPEC.generalTools, skills: [] });
    expect(getAgent(root, 'fallback')).toMatchObject({ tools: SPEC.fallbackTools, timeout: 1200, skills: [] });
    expect(getAgent(root, 'general').description).toBeUndefined();
  });

  it('changes nothing when run again', () => {
    const root = tempDir();
    addStarterEntries(root, SPEC);
    const before = readFileSync(agentFileOf(root), 'utf8');
    expect(addStarterEntries(root, SPEC)).toEqual({ added: [], present: ['medium', 'general', 'fallback'] });
    expect(readFileSync(agentFileOf(root), 'utf8')).toBe(before);
  });

  it('adds only what is missing and keeps every existing line, comments included', () => {
    const text = `# my agents
skills:
  alpha: ./skills/alpha   # the alpha skill

models:
  tiers:
    medium: { host: pi, model: local/m, thinking: low }   # cheap one

agents:
  # the general one
  general:
    tools: [read]
    timeout: 5
`;
    const root = makeProject(text);
    expect(addStarterEntries(root, { ...SPEC, model: 'other/model' })).toEqual({ added: ['fallback'], present: ['medium', 'general'] });
    const after = readFileSync(agentFileOf(root), 'utf8');
    keepsLines(text.trimEnd(), after);
    expect(getAgent(root, 'general')).toMatchObject({ model: 'local/m', timeout: 5, tools: ['read'] });
    expect(getAgent(root, 'fallback').tools).toEqual(SPEC.fallbackTools);
  });

  it('adds the medium tier alone to a file that holds agents and no medium tier', () => {
    const text = `skills:
  alpha: ./skills/alpha
agents:
  general:
    tools: [read, write]
    timeout: 5
  reviewer:
    description: r
    tools: [read]
    timeout: 6
`;
    const root = makeProject(text);
    expect(addStarterEntries(root, { ...SPEC, thinking: 'low' })).toEqual({ added: ['medium', 'fallback'], present: ['general'] });
    keepsLines(text.trimEnd(), readFileSync(agentFileOf(root), 'utf8'));
    expect(getAgent(root, 'reviewer')).toMatchObject({ model: 'r9700/Qwen3.8', thinking: 'low' });
  });

  it('splices into a file with no trailing newline, a models map without tiers, and no agents map', () => {
    const text = 'skills:\n  alpha: ./skills/alpha\nmodels:\n  other: 1\n# tail comment';
    const root = makeProject(text);
    expect(addStarterEntries(root, SPEC).added).toEqual(['medium', 'general', 'fallback']);
    const after = readFileSync(agentFileOf(root), 'utf8');
    keepsLines(text, after);
    expect(getAgent(root, 'fallback')).toMatchObject({ model: 'r9700/Qwen3.8', tools: SPEC.fallbackTools });
  });

  it('writes a small readable file when it creates one', () => {
    const root = tempDir();
    addStarterEntries(root, SPEC);
    expect(readFileSync(agentFileOf(root), 'utf8')).toBe(`models:
  tiers:
    medium: { host: pi, model: r9700/Qwen3.8, thinking: medium }
agents:
  general:
    tools: [ read, bash, edit, write, grep, find, ls ]
    timeout: 1200
  fallback:
    tools: [ read, grep, find, ls ]
    timeout: 1200
`);
  });

  it('refuses naming both hosts, and writes nothing, when medium is on another host', () => {
    const text = `models:\n  tiers:\n    medium: { host: claude, model: anthropic/x, thinking: low }\nagents:\n${GENERAL}`;
    const root = makeProject(text);
    expect(() => addStarterEntries(root, SPEC)).toThrow(StarterHostConflictError);
    expect(() => addStarterEntries(root, SPEC)).toThrow(/claude.*pi|pi.*claude/);
    expect(readFileSync(agentFileOf(root), 'utf8')).toBe(text);
  });

  it('refuses with the load error and writes nothing when the file does not load for another reason', () => {
    const bad = `${TIERS}agents:\n  a:\n    description: d\n    tools: [read]\n`;
    const root = makeProject(bad);
    expect(() => addStarterEntries(root, SPEC)).toThrow(LoadError);
    expect(() => addStarterEntries(root, SPEC)).toThrow(/agent "a": timeout/);
    expect(readFileSync(agentFileOf(root), 'utf8')).toBe(bad);

    const malformed = makeProject('agents: [unclosed');
    expect(() => addStarterEntries(malformed, SPEC)).toThrow(/malformed/);
    expect(readFileSync(agentFileOf(malformed), 'utf8')).toBe('agents: [unclosed');
  });
});

describe('AgentConfig global file', () => {
  afterEach(() => vi.unstubAllEnvs());

  const GLOBAL_TIERS = `models:
  parallel:
    local/s: 2
  tiers:
    small: { host: pi, model: local/s, thinking: off }
    medium: { host: pi, model: r9700/Qwen3.8, thinking: low }
    large: { host: claude, model: anthropic/opus, thinking: max }
`;
  const STARTER = (host: string) => (host === 'pi' ? { general: ['read', 'write', 'bash'], fallback: ['read', 'grep'] } : undefined);

  /** Writes the global file and points SUBZERO_GLOBAL_CONFIG at it. */
  function withGlobal(text: string): string {
    const file = path.join(tempDir('subzero-global-'), 'global.yaml');
    writeFileSync(file, text);
    vi.stubEnv('SUBZERO_GLOBAL_CONFIG', file);
    return file;
  }

  /** A project root with a project file holding text, or with no file at all. */
  const projectWith = (text: string | null) => (text === null ? tempDir('subzero-bare-') : makeProject(text));
  const load = (root: string) => loadAgentFile(root, { starterAgents: STARTER });
  const projectFile = (root: string) => path.join(root, '.agents', 'subzero.yaml');
  const errorOf = (run: () => unknown): Error => {
    try {
      run();
    } catch (err) {
      return err as Error;
    }
    throw new Error('expected a throw');
  };

  it('merges by name: the project medium replaces the global one whole, the rest is inherited (AE1)', () => {
    withGlobal(GLOBAL_TIERS);
    const root = projectWith(
      `models:\n  parallel:\n    local/s: 5\n  tiers:\n    medium: { host: pi, model: local/p, thinking: high }\nagents:\n${GENERAL}${FALLBACK}`,
    );
    const catalog = load(root);
    expect(catalog.tiers.get('medium')).toEqual({ host: 'pi', model: 'local/p', thinking: 'high' });
    expect(catalog.tiers.get('small')).toEqual({ host: 'pi', model: 'local/s', thinking: 'off' });
    expect(catalog.tiers.get('large')).toEqual({ host: 'claude', model: 'anthropic/opus', thinking: 'max' });
    expect(catalog.limits.get('local/s')).toBe(5);
  });

  it('is on with only a global medium tier, filling general and fallback from the provider (AE2)', () => {
    withGlobal(GLOBAL_TIERS);
    const root = projectWith(null);
    const catalog = load(root);
    expect(catalog.agentFile).toBe(projectFile(root));
    expect(catalog.entries.get('general')).toMatchObject({ tools: ['read', 'write', 'bash'], timeout: 1200, skills: [] });
    expect(catalog.entries.get('fallback')).toMatchObject({ tools: ['read', 'grep'], timeout: 1200, skills: [] });
    expect(catalog.entries.get('general')!.description).toBeUndefined();
    expect(resolveAgent(catalog, undefined)).toMatchObject({ host: 'pi', model: 'r9700/Qwen3.8', thinking: 'low', tools: ['read', 'write', 'bash'] });
  });

  it('is off with no medium tier in either file and no project file (AE3)', () => {
    withGlobal('models:\n  tiers:\n    small: { host: pi, model: local/s, thinking: off }\n');
    const err = errorOf(() => load(projectWith(null)));
    expect(err).toBeInstanceOf(MissingAgentFileError);
    expect(err).not.toBeInstanceOf(ProjectDisabledError);
  });

  it('is off with enabled: false, before the global file is read (AE4)', () => {
    const disabled = projectWith('enabled: false\n');
    withGlobal(GLOBAL_TIERS);
    expect(() => load(disabled)).toThrow(ProjectDisabledError);
    expect(() => load(disabled)).toThrow(MissingAgentFileError);
    withGlobal('models: [unclosed');
    expect(() => load(disabled)).toThrow(ProjectDisabledError);
    vi.stubEnv('SUBZERO_GLOBAL_CONFIG', path.join(tempDir(), 'missing.yaml'));
    expect(() => load(disabled)).toThrow(ProjectDisabledError);
    expect(() => buildCatalog(GLOBAL_TIERS, 'enabled: false\n', { agentFile: projectFile(disabled) })).toThrow(ProjectDisabledError);
  });

  it('keeps a project file with no medium anywhere on the existing load error, not the off error', () => {
    withGlobal('models:\n  tiers:\n    small: { host: pi, model: local/s, thinking: off }\n');
    const err = errorOf(() => load(projectWith(`models:\n  tiers:\n    large: { host: pi, model: local/l, thinking: high }\nagents:\n${GENERAL}${FALLBACK}`)));
    expect(err).toBeInstanceOf(LoadError);
    expect(err).not.toBeInstanceOf(MissingAgentFileError);
    expect(err.message).toMatch(/the medium tier is required/);
  });

  it('refuses an agents, skills, enabled or unknown key in the global file, naming the file and the key (AE5)', () => {
    const root = projectWith(null);
    for (const key of ['agents', 'skills', 'enabled', 'colour']) {
      const file = withGlobal(`${GLOBAL_TIERS}${key}: {}\n`);
      const err = errorOf(() => load(root));
      expect(err).toBeInstanceOf(LoadError);
      expect(err.message).toContain(file);
      expect(err.message).toContain(`"${key}"`);
    }
    const file = withGlobal('models:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n  extra: 1\n');
    const err = errorOf(() => load(root));
    expect(err.message).toContain(file);
    expect(err.message).toContain('"models.extra"');
  });

  it('refuses a models key other than tiers and parallel in the global file, and a non-number limit', () => {
    const file = withGlobal(GLOBAL_TIERS.replace('    local/s: 2', '    local/s: { max: 2 }'));
    const err = errorOf(() => load(projectWith(null)));
    expect(err).toBeInstanceOf(LoadError);
    expect(err.message).toMatch(/model "local\/s": parallel must be a positive whole number/);
    expect(err.message).toContain(file);
    withGlobal(GLOBAL_TIERS);
    const root = projectWith(`models:\n  parallel:\n    local/s: 3\nagents:\n${GENERAL}${FALLBACK}`);
    expect(load(root).limits.get('local/s')).toBe(3);
  });

  it('fails a global file that holds endpoints, listing only the models of its own tiers (R19)', () => {
    const file = withGlobal(`${GLOBAL_TIERS}endpoints:\n  local:\n    parallel: 2\n  r9700:\n    parallel: 1\n`);
    const root = projectWith(`models:\n  tiers:\n    mine: { host: pi, model: local/project-only, thinking: low }\nagents:\n${GENERAL}${FALLBACK}`);
    const err = errorOf(() => load(root));
    expect(err).toBeInstanceOf(LoadError);
    expect(err.message).toContain(file);
    expect(err.message).toContain('the global file holds "endpoints:"');
    expect(err.message).toMatch(/endpoint local \(limit 2\) covered local\/s:/);
    expect(err.message).not.toContain('local/project-only');
    expect(err.message).toMatch(/endpoint r9700 \(limit 1\) covered r9700\/Qwen3.8:/);
  });

  it('loads a file that is both the project file and the global file once, as the global layer only', () => {
    const root = tempDir('subzero-home-');
    const shared = projectFile(root);
    mkdirSync(path.dirname(shared));
    writeFileSync(shared, GLOBAL_TIERS);
    vi.stubEnv('SUBZERO_GLOBAL_CONFIG', shared);
    const catalog = load(root);
    expect(catalog.tiers.get('medium')).toEqual({ host: 'pi', model: 'r9700/Qwen3.8', thinking: 'low' });
    expect(catalog.limits.get('local/s')).toBe(2);
    expect(catalog.entries.get('general')).toMatchObject({ timeout: 1200, skills: [] });
    // Reached through a link, it is still the same file.
    const link = path.join(tempDir('subzero-link-'), 'global.yaml');
    symlinkSync(shared, link);
    vi.stubEnv('SUBZERO_GLOBAL_CONFIG', link);
    expect(load(root).tiers.size).toBe(3);
    // A limit no model uses is dropped as an inherited one, where a project file's own would be an error.
    writeFileSync(shared, GLOBAL_TIERS.replace('    local/s: 2', '    local/s: 2\n    unused/model: 1'));
    expect(load(root).limits.has('unused/model')).toBe(false);
    // Agents in that one file are refused as the global layer refuses them, not read as a project layer.
    writeFileSync(shared, `${GLOBAL_TIERS}agents:\n${GENERAL}${FALLBACK}`);
    expect(errorOf(() => load(root)).message).toMatch(/the global file holds only models.tiers, models.parallel, routing and hosts, not "agents"/);
  });

  it('refuses to add starter entries to a project file that is the global file, writing nothing', () => {
    const root = tempDir('subzero-home-');
    const shared = projectFile(root);
    mkdirSync(path.dirname(shared));
    writeFileSync(shared, GLOBAL_TIERS);
    vi.stubEnv('SUBZERO_GLOBAL_CONFIG', shared);
    const spec: StarterSpec = { host: 'pi', model: 'local/new', thinking: 'low', timeout: 30, generalTools: ['read'], fallbackTools: ['read'] };
    const err = errorOf(() => addStarterEntries(root, spec));
    expect(err).toBeInstanceOf(LoadError);
    expect(err.message).toContain(shared);
    expect(err.message).toMatch(/this project's file is the global file \(.*\); run guided init with the every-project choice, or open the tool in a project folder/);
    expect(readFileSync(shared, 'utf8')).toBe(GLOBAL_TIERS);
    // The same refusal when the file does not exist yet.
    const bare = tempDir('subzero-home-');
    vi.stubEnv('SUBZERO_GLOBAL_CONFIG', projectFile(bare));
    expect(() => addStarterEntries(bare, spec)).toThrow(/is the global file/);
    expect(existsSync(projectFile(bare))).toBe(false);
  });

  it('raises a load error naming the project file for an enabled that is not a boolean', () => {
    withGlobal(GLOBAL_TIERS);
    for (const bad of ['"false"', '0']) {
      const root = projectWith(`enabled: ${bad}\n`);
      const err = errorOf(() => load(root));
      expect(err).toBeInstanceOf(LoadError);
      expect(err.message).toMatch(/enabled must be true or false/);
      expect(err.message).toContain(projectFile(root));
    }
  });

  it('refuses a removal entry in the global file, naming the file', () => {
    const file = withGlobal(GLOBAL_TIERS.replace('    small: { host: pi, model: local/s, thinking: off }', '    small:'));
    const err = errorOf(() => load(projectWith(null)));
    expect(err.message).toContain(file);
    expect(err.message).toContain('"small"');
    withGlobal(GLOBAL_TIERS.replace('    local/s: 2', '    local/s:'));
    expect(errorOf(() => load(projectWith(null))).message).toContain('"local/s"');
  });

  it('removes an inherited tier with an empty entry, so an agent that names it fails', () => {
    withGlobal(GLOBAL_TIERS);
    const removed = 'models:\n  tiers:\n    large:\n';
    expect([...load(projectWith(`${removed}agents:\n${GENERAL}${FALLBACK}`)).tiers.keys()]).toEqual(['small', 'medium']);
    const dependent = projectWith(`${removed}agents:\n${VALID.replace('skills: [alpha]', 'tier: large')}${GENERAL}${FALLBACK}`);
    const err = errorOf(() => load(dependent));
    expect(err.message).toMatch(/agent "a": tier "large" is not configured/);
    expect(err.message).toContain(projectFile(dependent));
  });

  it('removes an inherited limit with an empty entry', () => {
    withGlobal(GLOBAL_TIERS);
    expect(load(projectWith(`models:\n  parallel:\n    local/s:\nagents:\n${GENERAL}${FALLBACK}`)).limits.has('local/s')).toBe(false);
  });

  it('lets a project general agent replace the built-in one and keeps the other built-in', () => {
    withGlobal(GLOBAL_TIERS);
    const own = load(projectWith('agents:\n  general:\n    tools: [read]\n    timeout: 33\n'));
    expect(own.entries.get('general')).toMatchObject({ tools: ['read'], timeout: 33 });
    expect(own.entries.get('fallback')).toMatchObject({ tools: ['read', 'grep'], timeout: 1200 });
    expect([...load(projectWith(`skills:\n  alpha: ./skills/alpha\nagents:\n${VALID}`)).entries.keys()].sort()).toEqual(['a', 'fallback', 'general']);
  });

  it('merges routing by key: a project value replaces the global one, unnamed keys are inherited', () => {
    withGlobal(`${GLOBAL_TIERS}routing:\n  hook: true\n  generic_agents: [general-purpose]\n`);
    expect(load(projectWith('routing:\n  hook: false\n')).routing).toEqual({ hook: false, genericAgents: ['general-purpose'] });
    expect(load(projectWith(null)).routing).toEqual({ hook: true, genericAgents: ['general-purpose'] });
    expect(load(projectWith('routing:\n  generic_agents: [other]\n')).routing).toEqual({ hook: true, genericAgents: ['other'] });
  });

  it('drops an inherited limit no merged model uses, but a project-written one still errors', () => {
    withGlobal(GLOBAL_TIERS);
    const moved = 'models:\n  tiers:\n    small: { host: pi, model: far/s, thinking: off }\n    medium: { host: pi, model: far/m, thinking: low }\n';
    expect(load(projectWith(`${moved}agents:\n${GENERAL}${FALLBACK}`)).limits.has('local/s')).toBe(false);
    const own = projectWith(`${moved.replace('models:\n', 'models:\n  parallel:\n    local/s: 1\n')}agents:\n${GENERAL}${FALLBACK}`);
    const err = errorOf(() => load(own));
    expect(err.message).toMatch(/model "local\/s": no tier or tier override uses it/);
    expect(err.message).toContain(projectFile(own));
  });

  it('checks a project agent tier against the merged tiers, naming the project file', () => {
    withGlobal(GLOBAL_TIERS);
    expect(load(projectWith(`agents:\n${VALID.replace('skills: [alpha]', 'tier: small')}`)).entries.get('a')!.tier).toBe('small');
    const none = projectWith(`agents:\n${VALID.replace('skills: [alpha]', 'tier: huge')}`);
    const err = errorOf(() => load(none));
    expect(err.message).toMatch(/agent "a": tier "huge" is not configured/);
    expect(err.message).toContain(projectFile(none));
  });

  it('names the global file for its malformed YAML and the project file for its own', () => {
    const global = withGlobal('models: [unclosed');
    expect(errorOf(() => load(projectWith(null))).message).toMatch(new RegExp(`malformed: ${global}`));
    withGlobal(GLOBAL_TIERS);
    const root = projectWith('agents: [unclosed');
    expect(errorOf(() => load(root)).message).toMatch(new RegExp(`malformed: ${projectFile(root)}`));
  });

  it('names the global file when it cannot be read', () => {
    const dir = tempDir('subzero-global-dir-');
    vi.stubEnv('SUBZERO_GLOBAL_CONFIG', dir);
    expect(errorOf(() => load(projectWith(null))).message).toMatch(new RegExp(`unreadable.*${dir}`));
  });

  it('fails every project that is on when the global file is broken', () => {
    const global = withGlobal('models: [unclosed');
    expect(errorOf(() => load(projectWith(`${MEDIUM_TIERS}agents:\n${GENERAL}${FALLBACK}`))).message).toContain(global);
  });

  it('finds the global file at SUBZERO_GLOBAL_CONFIG, else in the home folder; empty counts as unset', () => {
    const file = withGlobal(GLOBAL_TIERS);
    expect(globalFile()).toBe(file);
    vi.stubEnv('SUBZERO_GLOBAL_CONFIG', '');
    const home = path.join(os.homedir(), '.agents', 'subzero.yaml');
    expect(globalFile()).toBe(home);
    expect(globalFile({ SUBZERO_GLOBAL_CONFIG: '/x/y.yaml' })).toBe('/x/y.yaml');
    expect(globalFile({})).toBe(home);
  });

  describe('child host options (hosts)', () => {
    beforeEach(() => {
      vi.spyOn(os, 'homedir').mockReturnValue(tempDir('subzero-home-'));
      vi.stubEnv('SUBZERO_GLOBAL_CONFIG', '');
    });
    afterEach(() => vi.restoreAllMocks());

    /** Writes the global file at its default place, ~/.agents/subzero.yaml of a fresh home folder, and uses it. */
    function withDefaultGlobal(text: string): string {
      const file = path.join(os.homedir(), '.agents', 'subzero.yaml');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      return file;
    }

    const HOSTS = `hosts:\n  pi:\n    extensions:\n      - ~/.pi/ext/index.ts\n`;
    const BARE = `models:\n  tiers:\n    medium: { host: pi, model: local/p, thinking: high }\nagents:\n${GENERAL}${FALLBACK}`;

    it('is empty when no file holds hosts', () => {
      expect(load(projectWith(BARE)).childHostOptions).toEqual({});
      withDefaultGlobal(GLOBAL_TIERS);
      expect(load(projectWith(null)).childHostOptions).toEqual({});
      expect(load(projectWith(BARE)).childHostOptions).toEqual({});
    });

    it('carries each section of the global file as written, for the driver of its host to read', () => {
      withDefaultGlobal(`${GLOBAL_TIERS}hosts:\n  pi:\n    extensions: [~/a.ts, /b.ts]\n    other: 1\n  claude:\n    flag: true\n  idle:\n`);
      expect(load(projectWith(null)).childHostOptions).toEqual({
        pi: { extensions: ['~/a.ts', '/b.ts'], other: 1 },
        claude: { flag: true },
      });
      expect(load(projectWith(BARE)).childHostOptions.pi).toEqual({ extensions: ['~/a.ts', '/b.ts'], other: 1 });
    });

    it('reads no section from a project file and refuses a hosts key there, naming that file', () => {
      withDefaultGlobal(GLOBAL_TIERS);
      for (const text of [`${HOSTS}${BARE}`, `hosts: {}\n${BARE}`, `hosts:\n${BARE}`]) {
        const root = projectWith(text);
        const err = errorOf(() => load(root));
        expect(err).toBeInstanceOf(LoadError);
        expect(err.message).toContain(projectFile(root));
        expect(err.message).toMatch(/child host options are allowed in the global file only/);
      }
    });

    it('refuses a hosts key in a project file with no global file at all', () => {
      const root = projectWith(`${HOSTS}${BARE}`);
      expect(errorOf(() => parseCatalog(readFileSync(projectFile(root), 'utf8'), projectFile(root))).message).toContain(projectFile(root));
    });

    it('reads hosts from whichever file is the global file, the environment being trusted', () => {
      withGlobal(`${GLOBAL_TIERS}${HOSTS}`);
      expect(load(projectWith(null)).childHostOptions.pi?.extensions).toEqual(['~/.pi/ext/index.ts']);
      withDefaultGlobal(`${GLOBAL_TIERS}${HOSTS}`);
      expect(load(projectWith(null)).childHostOptions.pi?.extensions).toEqual(['~/.pi/ext/index.ts']);
    });

    it('refuses a hosts value that is not a map of maps, naming the global file and the host', () => {
      const shapes: Record<string, [string, RegExp]> = {
        'a list': [`${GLOBAL_TIERS}hosts: [pi]\n`, /hosts: must be a map/],
        'a scalar': [`${GLOBAL_TIERS}hosts: 5\n`, /hosts: must be a map/],
        'a section that is a list': [`${GLOBAL_TIERS}hosts:\n  pi: [a]\n`, /hosts\.pi: must be a map/],
        'a section that is a scalar': [`${GLOBAL_TIERS}hosts:\n  pi: yes\n`, /hosts\.pi: must be a map/],
      };
      for (const [name, [text, pattern]] of Object.entries(shapes)) {
        const file = withDefaultGlobal(text);
        const err = errorOf(() => load(projectWith(null)));
        expect(err, name).toBeInstanceOf(LoadError);
        expect(err.message, name).toContain(file);
        expect(err.message, name).toMatch(pattern);
      }
    });

    it('names hosts among the keys the global file holds', () => {
      withDefaultGlobal(`${GLOBAL_TIERS}agents: {}\n`);
      expect(errorOf(() => load(projectWith(null))).message).toMatch(/models.tiers, models.parallel, routing and hosts, not "agents"/);
      withDefaultGlobal(`${GLOBAL_TIERS}pi:\n  extensions: []\n`);
      expect(errorOf(() => load(projectWith(null))).message).toMatch(/not "pi"/);
    });

    it('reads the options of one host for a project root without needing a medium tier, general or fallback', () => {
      withDefaultGlobal(`hosts:\n  pi:\n    extensions:\n      - /x/ext.ts\n`);
      expect(loadChildHostOptions(tempDir('subzero-bare-'), 'pi')).toEqual({ extensions: ['/x/ext.ts'] });
      expect(loadChildHostOptions(projectWith('enabled: false\n'), 'pi')).toEqual({ extensions: ['/x/ext.ts'] });
      expect(loadChildHostOptions(tempDir('subzero-bare-'), 'claude')).toEqual({});
      withDefaultGlobal(`hosts: 5\n`);
      expect(() => loadChildHostOptions(tempDir('subzero-bare-'), 'pi')).toThrow(LoadError);
      vi.stubEnv('SUBZERO_GLOBAL_CONFIG', '/nowhere/x.yaml');
      expect(loadChildHostOptions(tempDir('subzero-bare-'), 'pi')).toEqual({});
    });
  });

  it('treats a missing global file as no layer', () => {
    expect(load(projectWith(`${MEDIUM_TIERS}agents:\n${GENERAL}${FALLBACK}`)).tiers.size).toBe(4);
    expect(() => load(projectWith(null))).toThrow(MissingAgentFileError);
  });

  it('fails naming the host when the child driver offers no starter tools', () => {
    withGlobal('models:\n  tiers:\n    medium: { host: claude, model: anthropic/x, thinking: low }\n');
    expect(() => load(projectWith(null))).toThrow(/"claude".*no starter tools/);
  });

  it('keeps the required-entry errors when no provider is given', () => {
    withGlobal(GLOBAL_TIERS);
    expect(() => loadAgentFile(projectWith(null))).toThrow(/the general agent is required/);
    expect(() => loadAgentFile(projectWith(`agents:\n${GENERAL}`))).toThrow(/the fallback agent is required/);
  });

  it('lets the lookup functions fill the built-ins with a placeholder, so they never fail for a missing agent', () => {
    withGlobal(GLOBAL_TIERS);
    const root = projectWith(null);
    expect(configuredTierNames(root)).toEqual(['small', 'medium', 'large']);
    expect(routableTiers(root).map((t) => t.tier)).toEqual(['small', 'medium', 'large']);
    expect(getRouting(root)).toEqual({ hook: true });
    expect(listAgentNames(root)).toEqual(['general', 'fallback']);
    expect(listAgentNames(projectWith(`skills:\n  alpha: ./skills/alpha\nagents:\n${VALID}`)).sort()).toEqual(['a', 'fallback', 'general']);
  });

  it('builds a catalog from text with no file on disk', () => {
    const agentFile = '/nowhere/.agents/subzero.yaml';
    const catalog = buildCatalog(GLOBAL_TIERS, null, { agentFile, globalFile: '/nowhere/global.yaml', starterAgents: STARTER });
    expect(catalog.agentFile).toBe(agentFile);
    expect(catalog.tiers.size).toBe(3);
    const noMedium = 'models:\n  tiers:\n    small: { host: pi, model: a/b, thinking: off }\n';
    expect(() => buildCatalog(noMedium, null, { agentFile })).toThrow(MissingAgentFileError);
  });
});

describe('AgentConfig project root', () => {
  it('prefers SUBZERO_PROJECT_DIR, resolving symbolic links', async () => {
    const real = tempDir();
    const link = path.join(tempDir(), 'link');
    symlinkSync(real, link);
    const other = tempDir();
    expect(await resolveProjectRoot({ env: { SUBZERO_PROJECT_DIR: link }, roots: () => [other], cwd: other })).toBe(real);
  });

  it('treats an empty SUBZERO_PROJECT_DIR as unset and takes the first reported root', async () => {
    const first = tempDir();
    const second = tempDir();
    const root = await resolveProjectRoot({ env: { SUBZERO_PROJECT_DIR: '' }, roots: () => [pathToFileURL(first).href, second] });
    expect(root).toBe(first);
  });

  it('falls back to the command line working directory', async () => {
    const cwd = tempDir();
    expect(await resolveProjectRoot({ env: {}, cwd })).toBe(cwd);
  });

  it('returns the unresolved root error naming SUBZERO_PROJECT_DIR when no source gives one', async () => {
    const root = await resolveProjectRoot({ env: {}, roots: () => [] });
    expect(root).toBeInstanceOf(UnresolvedRootError);
    expect((root as Error).message).toMatch(/SUBZERO_PROJECT_DIR/);
  });
});
