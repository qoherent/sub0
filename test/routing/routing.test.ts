import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DELEGATE_TOOL,
  aliasTier,
  buildRoutingText,
  isGenericSpawn,
  routingContext,
  wordTiers,
} from '../../src/routing/routing.js';
import { routableTiers } from '../../src/config/agent-config.js';
import { GLOBAL_MEDIUM_YAML, tempDir, useGlobalConfig } from '../helpers.js';

function project(yaml?: string): string {
  const root = tempDir();
  if (yaml !== undefined) {
    mkdirSync(path.join(root, '.agents'), { recursive: true });
    writeFileSync(path.join(root, '.agents', 'subzero.yaml'), yaml);
  }
  return root;
}

const tier = (name: string, model: string) => `    ${name}: { host: pi, model: ${model}, thinking: low }\n`;
const GENERAL = 'agents:\n  general:\n    tools: [read, bash]\n    timeout: 60\n  fallback:\n    tools: [read]\n    timeout: 60\n';
const config = (...names: string[]) =>
  `models:\n  tiers:\n${tier('default', 'local/d')}${names.map((n) => tier(n, `local/${n}`)).join('')}${GENERAL}`;

describe('alias table', () => {
  it('maps a missing model to large, haiku to small, sonnet to medium, and neither opus nor fable', () => {
    expect(aliasTier(undefined)).toBe('large');
    expect(aliasTier('haiku')).toBe('small');
    expect(aliasTier('sonnet')).toBe('medium');
    expect(aliasTier('opus')).toBeUndefined();
    expect(aliasTier('fable')).toBeUndefined();
    expect(aliasTier('something-else')).toBeUndefined();
  });
});

describe('generic spawn test', () => {
  it('treats an absent subagent_type, general-purpose and claude as generic, and names as specialists', () => {
    expect(isGenericSpawn({})).toBe(true);
    expect(isGenericSpawn({ subagent_type: 'general-purpose' })).toBe(true);
    expect(isGenericSpawn({ subagent_type: 'claude' })).toBe(true);
    expect(isGenericSpawn({ subagent_type: 'Explore' })).toBe(false);
    expect(isGenericSpawn({ subagent_type: 'fork' })).toBe(false);
  });

  it('lets the routing settings replace the generic list', () => {
    expect(isGenericSpawn({ subagent_type: 'general-purpose' }, ['worker'])).toBe(false);
    expect(isGenericSpawn({ subagent_type: 'worker' }, ['worker'])).toBe(true);
    expect(isGenericSpawn({}, ['worker'])).toBe(true);
  });
});

describe('routing text', () => {
  const textFor = (root: string) => buildRoutingText(wordTiers(routableTiers(root)));

  it('omits the await choreography when task mode is on', () => {
    const text = buildRoutingText(wordTiers(routableTiers(project(config('medium')))), true);
    expect(text).toMatch(/completed tasks deliver their results/i);
    expect(text).not.toMatch(/wait: false|timeout_s: 600/);
    expect(text).toMatch(/one message/);
    expect(text).toMatch(/every completion notice/);
    expect(text).toMatch(/await reply[^\n]*not show[^\n]*tasks/i);
  });

  it('uses mode-neutral instructions when no readiness marker is known', () => {
    const text = buildRoutingText(wordTiers(routableTiers(project(config('medium')))), null);
    expect(text).toMatch(/if it returns a task id, collect it/i);
    expect(text).not.toMatch(/wait: false|timeout_s: 600/);
    expect(text).toMatch(/one message/);
  });

  it('AE1: with only medium configured, sends mid-tier to delegate and keeps the other tier words on Claude', () => {
    const text = textFor(project(config('medium')));
    expect(text).toMatch(/mid-tier[^\n]*medium[^\n]*tier: "medium"/);
    expect(text).toContain('local/medium');
    expect(text).toMatch(/cheapest capable[^\n]*stay[^\n]*Claude/i);
    expect(text).toMatch(/session model[^\n]*stay[^\n]*Claude/i);
    expect(text).not.toContain('tier: "small"');
    expect(text).not.toContain('tier: "large"');
  });

  it('names the full tool id, the wait false then await batch pattern and the launch-equals-start rule', () => {
    const text = textFor(project(config('medium')));
    expect(DELEGATE_TOOL).toBe('mcp__plugin_subzero_subzero__delegate');
    expect(text).toContain('mcp__plugin_subzero_subzero__delegate');
    expect(text).toMatch(/wait: false/);
    expect(text).toMatch(/one message/);
    expect(text).toMatch(/await[^\n]*tasks[^\n]*timeout_s: 600/);
    expect(text).toMatch(/until (every|all)/);
    expect(text).toMatch(/launch time[^\n]*`started` time/);
    expect(text).toMatch(/queued[^\n]*not (been )?launched/);
  });

  it('tells Claude to read a task whose result an await reply does not show with the tasks tool before using it', () => {
    const text = textFor(project(config('medium')));
    expect(text).toMatch(/result[^\n]*await reply[^\n]*not show[^\n]*mcp__plugin_subzero_subzero__tasks[^\n]*before/);
    expect(text).not.toMatch(/\bcut\b/);
  });

  it('keeps fork and worktree spawns on the Agent tool', () => {
    expect(textFor(project(config('medium')))).toMatch(/fork[^\n]*worktree[^\n]*(stay|stays)[^\n]*Agent tool/i);
  });

  it('tells Claude to pass back only when delegate is refused with no task, and to keep a returned task id', () => {
    const text = textFor(project(config('medium')));
    expect(text).toMatch(/refused or[^\n]*tool error[^\n]*no task/);
    expect(text).toMatch(/description[^\n]*begins? with `passback`/);
    expect(text).toMatch(/task id[^\n]*stays with subzero[^\n]*even if[^\n]*fails/);
  });

  it('stays under 3,000 characters with all three tiers', () => {
    const text = textFor(project(config('small', 'medium', 'large')));
    expect(text.length).toBeLessThan(3000);
    for (const t of ['small', 'medium', 'large']) expect(text).toContain(`tier: "${t}"`);
  });

  it('ignores tiers that carry no tier word', () => {
    const tiers = wordTiers(routableTiers(project(config('medium', 'cloud'))));
    expect(tiers.map((t) => t.tier)).toEqual(['medium']);
  });
});

describe('routingContext', () => {
  it('returns nothing with no project root', () => {
    expect(routingContext(undefined)).toBeUndefined();
  });

  it('returns nothing when the agent file is missing', () => {
    expect(routingContext(project())).toBeUndefined();
  });

  it('keeps the repair command in the SessionStart warning for a file that still holds endpoints:', () => {
    const warning = routingContext(project(`endpoints:\n  local:\n    parallel: 1\n${config('medium')}`));
    expect(warning).toMatch(/routing is off/);
    expect(warning).toContain('endpoints');
    expect(warning).toContain('init');
  });

  it('warns when the medium tier is missing from a file that exists', () => {
    expect(routingContext(project('endpoints: {}\n'))).toMatch(/routing is off/);
    expect(routingContext(project(config()))).toMatch(/medium/);
    expect(routingContext(project(`models:\n  tiers:\n${tier('default', 'local/d')}`))).toMatch(/medium/);
  });

  it('routes a project with a medium tier and no general entry, because the built-in general fills it', () => {
    const helper = 'agents:\n  helper:\n    description: x\n    tools: [read]\n    timeout: 5\n';
    expect(routingContext(project(`models:\n  tiers:\n${tier('medium', 'local/m')}${helper}`))).toContain('tier: "medium"');
  });

  it('covers AE2: a global medium and no project file returns the routing text with the global tiers', () => {
    useGlobalConfig(`models:\n  tiers:\n${tier('medium', 'local/gm')}${tier('large', 'local/gl')}`);
    const text = routingContext(project());
    expect(text).toContain('tier: "medium"');
    expect(text).toContain('model local/gm');
    expect(text).toContain('model local/gl');
  });

  it('warns that routing is off, naming the utility, when the deny lock utility is missing', () => {
    const routed = project(`models:\n  tiers:\n${tier('medium', 'local/m')}`);
    const text = routingContext(routed, false, () => false);
    expect(text).toMatch(/^subzero routing is off: the (lockf|flock) utility is not installed/);
    expect(text).not.toContain(DELEGATE_TOOL);
    expect(routingContext(routed, false, () => true)).toContain('tier: "medium"');
  });

  it('adds nothing for a project that is off, even when the deny lock utility is missing', () => {
    expect(routingContext(project(), false, () => false)).toBeUndefined();
  });

  it('returns nothing with no project file and no global medium', () => {
    useGlobalConfig(`models:\n  tiers:\n${tier('large', 'local/gl')}`);
    expect(routingContext(project())).toBeUndefined();
  });

  it('covers AE4: enabled false returns nothing, with a global medium and with a broken global file', () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    expect(routingContext(project('enabled: false\n'))).toBeUndefined();
    const global = useGlobalConfig('agents: [oops\n');
    expect(routingContext(project('enabled: false\n'))).toBeUndefined();
    expect(routingContext(project(config('medium')))).toContain(global);
  });

  it('warns naming the global file when it is broken, and the project file when that one is', () => {
    const global = useGlobalConfig('agents: [oops\n');
    const text = routingContext(project());
    expect(text).toMatch(/routing is off/);
    expect(text).toContain(global);
    expect(text).not.toContain('\n');
    const forbidden = useGlobalConfig('agents:\n  general:\n    tools: [read]\n    timeout: 5\n');
    expect(routingContext(project(config('medium')))).toContain(forbidden);
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const named = routingContext(project('agents: [oops\n'));
    expect(named).toContain('.agents/subzero.yaml');
    expect(named).not.toContain('global');
  });

  it('returns a one-line warning for a file that exists and fails to load', () => {
    const text = routingContext(project('agents: [oops\n'));
    expect(text).toBeDefined();
    expect(text).not.toContain('\n');
    expect(text).toMatch(/subzero/i);
    expect(text).toMatch(/routing is off/i);
  });

  it('returns the routing text when a routable tier word exists', () => {
    expect(routingContext(project(config('medium')))).toContain('tier: "medium"');
  });
});
