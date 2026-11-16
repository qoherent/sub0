import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { THINKING_LEVELS, loadAgentFile, resolveAgent } from '../../src/config/agent-config.js';
import { tempDir } from '../helpers.js';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const read = (file: string) => (existsSync(path.join(REPO, file)) ? readFileSync(path.join(REPO, file), 'utf8') : '');
const flat = (text: string) => text.replace(/\s+/g, ' ');

const DOC_RAW = read('docs/configuration.md');
const DOC = flat(DOC_RAW);
const README = flat(read('README.md'));

/** A project whose agent file is the given text. */
function projectWith(yaml: string): string {
  const root = tempDir('subzero-configdoc-');
  mkdirSync(path.join(root, '.agents'), { recursive: true });
  writeFileSync(path.join(root, '.agents', 'subzero.yaml'), yaml);
  return root;
}

/** The first yaml code block after a heading. */
function yamlAfter(heading: string): string {
  const start = DOC_RAW.indexOf(heading);
  const open = DOC_RAW.indexOf('```yaml\n', start);
  const close = DOC_RAW.indexOf('\n```', open);
  return start === -1 || open === -1 ? '' : DOC_RAW.slice(open + 8, close + 1);
}

const MINIMAL = `
models:
  tiers:
    medium: { host: pi, model: local/x, thinking: low }
agents:
  general: { tools: [read], timeout: 5 }
  fallback: { tools: [read], timeout: 5 }
`;

describe('docs/configuration.md', () => {
  it('exists and the README links to it', () => {
    expect(DOC_RAW).not.toBe('');
    expect(README).toMatch(/\]\((\.\/)?docs\/configuration\.md\)/);
  });

  it('has a complete example that loads and resolves as the page says', () => {
    const root = projectWith(yamlAfter('## A complete example'));
    const catalog = loadAgentFile(root);
    expect([...catalog.tiers.keys()]).toEqual(['small', 'medium']);
    expect([...catalog.entries.keys()]).toEqual(['general', 'fallback', 'file-facts']);
    expect(catalog.limits.get('local')).toBe(1);
    expect(catalog.routing).toEqual({ hook: true, genericAgents: ['general-purpose', 'claude'] });
    // The agent's own tier is medium, with its thinking overridden to high.
    const facts = resolveAgent(catalog, 'file-facts');
    expect(facts).toMatchObject({ model: 'local/qwen3-coder-30b', thinking: 'high', timeout: 120 });
    // General on a named tier runs that tier, recorded as general:medium.
    expect(resolveAgent(catalog, undefined, { tier: 'medium' })).toMatchObject({ name: 'general:medium', thinking: 'medium' });
    expect(resolveAgent(catalog, undefined)).toMatchObject({ name: 'general', thinking: 'medium' });
  });

  it('lists the thinking levels the loader accepts', () => {
    for (const level of THINKING_LEVELS) expect(DOC).toContain(`\`${level}\``);
  });

  it('names every key of a tier, an agent, and the routing block', () => {
    for (const key of ['host', 'model', 'thinking', 'description', 'tools', 'timeout', 'skills', 'tier', 'tiers', 'hook', 'generic_agents', 'parallel']) {
      expect(DOC, key).toContain(`\`${key}\``);
    }
  });

  describe('Not supported yet', () => {
    it('top-level keys that the loader does not read are ignored, not rejected', () => {
      const root = projectWith(`version: 1\ndefaults: { timeout: 99 }\nbogus: true\n${MINIMAL}  a:\n    description: d\n    tools: [read]\n    timeout: 5\n`);
      expect(() => loadAgentFile(root)).not.toThrow();
      expect(DOC).toMatch(/Unknown top-level keys are ignored, not rejected/);
    });

    it('defaults.timeout does not give an agent a timeout', () => {
      const root = projectWith(`defaults: { timeout: 99 }\n${MINIMAL}  a:\n    description: d\n    tools: [read]\n`);
      expect(() => loadAgentFile(root)).toThrow(/timeout is required/);
    });

    it.each(['instructions', 'permissions', 'delegates', 'expose', 'result', 'output', 'process', 'record', 'retention', 'workspace'])(
      'the agent field %s is an unknown-key error',
      (key) => {
        const root = projectWith(`${MINIMAL}  a:\n    description: d\n    tools: [read]\n    timeout: 5\n    ${key}: x\n`);
        expect(() => loadAgentFile(root)).toThrow(new RegExp(`unknown key "${key}"`));
        expect(DOC).toContain(`\`${key}\``);
      },
    );

    it('an endpoint entry holds only parallel: base_url is not read as a field', () => {
      const root = projectWith(`endpoints:\n  local: { base_url: http://x }\n${MINIMAL}`);
      expect(() => loadAgentFile(root)).toThrow(/parallel must be a positive whole number/);
    });
  });

  describe('Errors you may see', () => {
    const cases: [string, string][] = [
      ['agent file is malformed', 'agents: [\n'],
      ['the medium tier is required in models.tiers', 'agents:\n  general:\n    tools: [read]\n    timeout: 5\n'],
      ['description is required', `${MINIMAL}  a:\n    tools: [read]\n    timeout: 5\n`],
      ['model cannot be set on an agent', `${MINIMAL}  a:\n    description: d\n    tools: [read]\n    timeout: 5\n    model: x/y\n`],
      ['unknown key "color"', `${MINIMAL}  a:\n    description: d\n    tools: [read]\n    timeout: 5\n    color: red\n`],
      ['timeout is required (seconds)', `${MINIMAL}  a:\n    description: d\n    tools: [read]\n`],
      ['skill "nope" is not in the skills map', `${MINIMAL}  a:\n    description: d\n    tools: [read]\n    timeout: 5\n    skills: [nope]\n`],
      ['no model of a tier', `endpoints:\n  zzz: { parallel: 1 }\n${MINIMAL}`],
    ];
    it.each(cases)('the message "%s" is what the loader says', (fragment, yaml) => {
      expect(() => loadAgentFile(projectWith(yaml))).toThrow(fragment);
      // The table quotes the start of each message, with the agent name left as a placeholder.
      const quoted = fragment.replace('"nope"', '"<name>"').replace('"color"', '"<key>"').replace(/^model |^description /, '');
      expect(DOC, fragment).toContain(quoted.split(' ').slice(0, 3).join(' '));
    });

    it('a missing file reads "agent file is missing" and names init in both parents', () => {
      expect(() => loadAgentFile(tempDir('subzero-configdoc-'))).toThrow(/agent file is missing.*\/subzero:init in Claude Code or \/subzero init in pi/);
      expect(DOC).toMatch(/`agent file is missing` \|[^|]*`\/subzero:init` in Claude Code or `\/subzero init` in pi/);
    });

    it('an unknown agent and an unknown tier read as the table says', () => {
      const catalog = loadAgentFile(projectWith(`${MINIMAL}  a:\n    description: d\n    tools: [read]\n    timeout: 5\n`));
      expect(() => resolveAgent(catalog, 'nope')).toThrow(/unknown agent "nope"/);
      expect(() => resolveAgent(catalog, 'a', { tier: 'huge' })).toThrow(/unknown tier "huge"/);
      expect(() => resolveAgent(catalog, 'a', { supportedHosts: ['codex'] })).toThrow(/runs on the host "pi"/);
    });
  });

  it('presents guided init in both parents first, then the quick path, and names the config commands', () => {
    const start = DOC.indexOf('## Writing the file with `init`');
    const init = DOC.slice(start, DOC.indexOf('## Environment variables'));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(init).toMatch(/guided setup: `\/subzero:init` in Claude Code, or `\/subzero init` in pi/);
    expect(init.indexOf('/subzero:init <model>')).toBeGreaterThan(init.indexOf('guided setup'));
    expect(init).toMatch(/only after you confirm/);
    for (const command of ['models', 'show', 'check', 'preview', 'apply']) expect(init).toContain(`\`${command}\``);
    expect(init).toContain('`subzero config`');
    expect(init).toMatch(/add `small` or `large` afterwards, run guided init/i);
  });

  it('links only to files that exist, and carries no dash pileups or banned words', () => {
    for (const link of [...DOC_RAW.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!)) {
      if (/^[a-z]+:/i.test(link) || link.startsWith('#')) continue;
      expect(existsSync(path.resolve(REPO, 'docs', link.split('#')[0]!)), `links to ${link}`).toBe(true);
    }
    expect(DOC_RAW).not.toContain('—');
    expect(DOC_RAW).not.toMatch(/\b(seamless(ly)?|powerful|robust|leverage|supercharge|effortless(ly)?|cutting-edge)\b/i);
  });
});
