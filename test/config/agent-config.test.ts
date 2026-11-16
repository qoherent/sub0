import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  addStarterEntries,
  configuredTierNames,
  getAgent,
  getRouting,
  LoadError,
  loadAgentFile,
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
    expect(() => loadAgentFile(makeProject(`${MEDIUM_TIERS}agents:\n${GENERAL}`))).toThrow(`the fallback agent is required${init}`);
  });
  it('loads a valid agent on the default tier with absolute skill folders', () => {
    const root = project(VALID);
    const agent = getAgent(root, 'a');
    expect(agent).toMatchObject({ name: 'a', host: 'pi', model: 'local/m', thinking: 'high', endpoint: 'local', parallel: null });
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

  it('gives definitions on one endpoint its parallel limit, and none without an entry', () => {
    const tiers = `models:
  tiers:
    default: { host: pi, model: r9700/Qwen3.8, thinking: high }
    medium: { host: pi, model: r9700/Qwen3.8, thinking: high }
    small: { host: pi, model: r9700/Qwen3.8-small, thinking: high }
    cloud: { host: pi, model: anthropic/claude, thinking: high }
`;
    const agents = VALID + VALID.replace('  a:', '  b:') .replace('skills', 'tier: small\n    skills') + VALID.replace('  a:', '  c:').replace('skills', 'tier: cloud\n    skills');
    const root = project(agents, 'endpoints:\n  r9700:\n    parallel: 1\n', tiers);
    expect(getAgent(root, 'a')).toMatchObject({ endpoint: 'r9700', parallel: 1 });
    expect(getAgent(root, 'b')).toMatchObject({ endpoint: 'r9700', parallel: 1 });
    expect(getAgent(root, 'c')).toMatchObject({ endpoint: 'anthropic', parallel: null });
  });

  it('rejects an endpoint entry that no model of a tier or override belongs to, naming it', () => {
    const root = project(VALID, 'endpoints:\n  r9770:\n    parallel: 1\n');
    expect(() => loadAgentFile(root)).toThrow(/endpoint "r9770"/);
  });

  it('accepts an endpoint entry that only a tier model, or only an override model, belongs to', () => {
    const onlyTier = project(VALID, 'endpoints:\n  local:\n    parallel: 2\n');
    expect(getAgent(onlyTier, 'a').parallel).toBe(2);
    const override = VALID.replace('skills', 'tiers:\n      medium: { model: gpu/x }\n    skills');
    const viaOverride = project(override, 'endpoints:\n  gpu:\n    parallel: 3\n');
    expect(getAgent(viaOverride, 'a')).toMatchObject({ endpoint: 'gpu', parallel: 3 });
  });

  it('rejects a parallel limit that is not a positive whole number', () => {
    for (const bad of ['0', '1.5', '"two"']) {
      const root = project(VALID, `endpoints:\n  local:\n    parallel: ${bad}\n`);
      expect(() => loadAgentFile(root)).toThrow(/endpoint "local": parallel/);
    }
  });
});

describe('AgentConfig model tiers', () => {
  it('resolves general at a named tier to that tier host, model, thinking, endpoint and limit', () => {
    const root = project(GENERAL, 'endpoints:\n  r9700:\n    parallel: 1\n', MEDIUM_TIERS);
    expect(getAgent(root, 'general', { tier: 'medium' })).toMatchObject({
      name: 'general:medium',
      host: 'pi',
      model: 'r9700/Qwen3.8',
      thinking: 'low',
      endpoint: 'r9700',
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
