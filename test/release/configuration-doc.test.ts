import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_TIMEOUT,
  LoadError,
  MissingAgentFileError,
  ProjectDisabledError,
  THINKING_LEVELS,
  generalFile,
  loadAgentFile,
  loadCatalog,
  resolveAgent,
} from '../../src/config/agent-config.js';
import { tempDir, useGeneralConfig } from '../helpers.js';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const read = (file: string) => (existsSync(path.join(REPO, file)) ? readFileSync(path.join(REPO, file), 'utf8') : '');
const flat = (text: string) => text.replace(/\s+/g, ' ');

const DOC_RAW = read('docs/configuration.md');
const DOC = flat(DOC_RAW);
const README = flat(read('README.md'));
const CHANGELOG = flat(read('CHANGELOG.md'));
const STARTER = () => ({ general: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'], fallback: ['read', 'grep', 'find', 'ls'] });

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

/** The README's section with that title. */
function sectionRaw(title: string): string {
  const text = read('README.md');
  const start = text.indexOf(`## ${title}\n`);
  const end = text.indexOf('\n## ', start + 1);
  return start === -1 ? '' : text.slice(start, end === -1 ? undefined : end);
}

/** The text of one `## ` section of the page, from its heading to the next one. */
function sectionOfDoc(heading: string): string {
  const start = DOC_RAW.indexOf(`## ${heading}`);
  const end = DOC_RAW.indexOf('\n## ', start + 1);
  return start === -1 ? '' : DOC_RAW.slice(start, end === -1 ? undefined : end);
}

/** The yaml code blocks of a section, in order. */
function yamlBlocks(heading: string): string[] {
  return [...sectionOfDoc(heading).matchAll(/```yaml\n([\s\S]*?)\n```/g)].map((match) => match[1]! + '\n');
}

const GENERAL_SECTION = 'The general file: one setup for every project';

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

  describe('the general file', () => {
    const [generalYaml, projectYaml, disabledYaml] = yamlBlocks(GENERAL_SECTION);

    it('has an example pair that merges as the page says', () => {
      useGeneralConfig(generalYaml!);
      const catalog = loadCatalog(projectWith(projectYaml!), { starterAgents: STARTER });
      // The project's medium replaces model and thinking together, and its `small:` removes the inherited tier.
      expect([...catalog.tiers.keys()]).toEqual(['medium']);
      expect(catalog.tiers.get('medium')).toEqual({ host: 'pi', model: 'local/qwen3-coder-30b', thinking: 'high' });
      // The limit of local is inherited, and the routing key too.
      expect(catalog.limits.get('local')).toBe(1);
      expect(catalog.routing.hook).toBe(true);
      // Built-in agents fill general and fallback: 1200 seconds, no skills, the host's starter tools.
      expect(BUILT_IN_TIMEOUT).toBe(1200);
      expect(DOC).toContain('the timeout is 1200 seconds');
      expect(catalog.entries.get('general')).toMatchObject({ timeout: 1200, skills: [], tools: STARTER().general });
      expect(catalog.entries.get('fallback')).toMatchObject({ timeout: 1200, skills: [], tools: STARTER().fallback });
    });

    it('turns subzero on with no project file, and a project agent replaces the built-in one', () => {
      useGeneralConfig(generalYaml!);
      const bare = tempDir('subzero-configdoc-');
      expect([...loadCatalog(bare, { starterAgents: STARTER }).entries.keys()]).toEqual(['general', 'fallback']);
      const own = projectWith('agents:\n  general: { tools: [read], timeout: 9 }\n');
      expect(loadCatalog(own, { starterAgents: STARTER }).entries.get('general')).toMatchObject({ timeout: 9, tools: ['read'] });
      expect(DOC).toMatch(/has a `medium` tier \| none \| On, with the built-in agents/);
    });

    it('is off with no medium tier in the general file and no project file', () => {
      useGeneralConfig('routing:\n  hook: false\n');
      expect(() => loadCatalog(tempDir('subzero-configdoc-'), { starterAgents: STARTER })).toThrow(MissingAgentFileError);
      expect(DOC).toMatch(/no `medium` tier \| none \| Off, as before/);
    });

    it('is switched off by enabled: false before the general file is read', () => {
      expect(disabledYaml).toBe('enabled: false\n');
      useGeneralConfig('this is: [not valid\n');
      expect(() => loadCatalog(projectWith(disabledYaml!), { starterAgents: STARTER })).toThrow(ProjectDisabledError);
      expect(DOC).toMatch(/The general file is not read/);
      // Without it, the broken general file fails the project, and the error names that file.
      const path_ = useGeneralConfig('this is: [not valid\n');
      expect(() => loadCatalog(projectWith(projectYaml!), { starterAgents: STARTER })).toThrow(`general file is malformed: ${path_}`);
      // A project file with no medium tier anywhere is still a load error.
      useGeneralConfig('routing:\n  hook: true\n');
      expect(() => loadCatalog(projectWith('endpoints: {}\n'), { starterAgents: STARTER })).toThrow(LoadError);
    });

    it('holds only models.tiers, endpoints and routing, and an error names the file and the key', () => {
      for (const key of ['models.tiers', 'endpoints', 'routing']) expect(sectionOfDoc(GENERAL_SECTION)).toContain(key.split('.')[0]);
      const file = useGeneralConfig('agents:\n  a: { tools: [read], timeout: 5 }\n');
      expect(() => loadCatalog(projectWith(MINIMAL), { starterAgents: STARTER })).toThrow(`not "agents": ${file}`);
      for (const [yaml, fragment] of [
        ['skills: {}\n', '"skills"'],
        ['enabled: true\n', '"enabled"'],
        ['version: 1\n', '"version"'],
        ['models:\n  other: 1\n', '"models.other"'],
      ] as const) {
        const where = useGeneralConfig(yaml);
        expect(() => loadCatalog(projectWith(MINIMAL), { starterAgents: STARTER })).toThrow(`${fragment}: ${where}`);
      }
      expect(DOC).toMatch(/Any other key, such as `agents`, `skills` or `enabled`, is a load error that names the file and the key/);
    });

    it('merges limits by endpoint, ignores an inherited limit nothing uses, and keeps an own unused limit an error', () => {
      useGeneralConfig('models:\n  tiers:\n    medium: { host: pi, model: local/x, thinking: low }\nendpoints:\n  local: { parallel: 2 }\n');
      const moved = projectWith('models:\n  tiers:\n    medium: { host: pi, model: other/y, thinking: low }\n');
      expect(loadCatalog(moved, { starterAgents: STARTER }).limits.size).toBe(0);
      const removed = projectWith('endpoints:\n  local:\n');
      expect(loadCatalog(removed, { starterAgents: STARTER }).limits.size).toBe(0);
      const own = projectWith('models:\n  tiers:\n    medium: { host: pi, model: other/y, thinking: low }\nendpoints:\n  local: { parallel: 1 }\n');
      expect(() => loadCatalog(own, { starterAgents: STARTER })).toThrow(/no model of a tier/);
      // The removal entry is refused in the general file.
      useGeneralConfig('models:\n  tiers:\n    large:\n');
      expect(() => loadCatalog(moved, { starterAgents: STARTER })).toThrow(/removal entry is only accepted in the agent file/);
      expect(DOC).toMatch(/Only the project file accepts this; in the general file it is an error/);
      expect(DOC).toMatch(/`large:` under `models.tiers`, or `local:` under `endpoints`/);
    });

    it('fails delegation, naming the host, when the child driver has no starter tools', () => {
      useGeneralConfig(generalYaml!);
      expect(() => loadCatalog(tempDir('subzero-configdoc-'), { starterAgents: () => undefined })).toThrow(/host "pi" offers no starter tools/);
      expect(DOC).toContain('`offers no starter tools`');
    });

    it('names the environment variable, and the loader reads it as a full path with empty as unset', () => {
      expect(DOC).toMatch(/\| `SUBZERO_GENERAL_CONFIG` \| The full path of the general file[^|]*empty value counts as unset/);
      expect(generalFile({ SUBZERO_GENERAL_CONFIG: '/x/general.yaml' })).toBe('/x/general.yaml');
      expect(generalFile({ SUBZERO_GENERAL_CONFIG: '' })).toBe(generalFile({}));
      expect(generalFile({})).toMatch(/\.agents[\\/]subzero\.yaml$/);
      expect(DOC).toContain('`~/.agents/subzero.yaml`');
    });

    it('documents the behavior change, the opt-out and the session-start caveat', () => {
      const text = flat(sectionOfDoc(GENERAL_SECTION));
      expect(text).toMatch(/turns subzero on in every project, with or without a project file/);
      expect(text).toMatch(/`enabled: false`/);
      expect(text).toMatch(/start a new session for the routing text/);
      expect(text).toMatch(/In pi the tier text refreshes at once after a guided write/);
      expect(text).toMatch(/the config file/);
    });
  });

  it('lists the thinking levels the loader accepts', () => {
    for (const level of THINKING_LEVELS) expect(DOC).toContain(`\`${level}\``);
  });

  it('names every key of a tier, an agent, and the routing block', () => {
    for (const key of ['host', 'model', 'thinking', 'description', 'tools', 'timeout', 'skills', 'tier', 'tiers', 'hook', 'generic_agents', 'parallel', 'enabled']) {
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

    it('lists only the personal override file and skill-shipped agents as unsupported layering', () => {
      const notSupported = flat(sectionOfDoc('Not supported yet'));
      expect(notSupported).toMatch(/A personal override file and skill-shipped agents/);
      expect(notSupported).toContain('.agents/subzero.local.yaml');
      expect(notSupported).not.toMatch(/no user file/i);
      expect(notSupported).not.toMatch(/no `enabled: false`/i);
    });

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
    // The scope choice, the source marks, and what init writes.
    expect(init).toMatch(/asks first whether the models are for every project or only this one/);
    expect(init).toMatch(/creates it when it is missing/);
    expect(init).toMatch(/reads out what this project keeps its own/);
    expect(init).toMatch(/tiers and limits only, never agents/);
    expect(init).toMatch(/`--scope general\|project` \(default `project`\), and apply must repeat the preview's scope/);
    expect(init).toMatch(/`config show` marks each tier and limit as coming from the general file or from the project/);
    expect(init).toMatch(/`init <model>` is unchanged by the general file. It writes the project file/);
    expect(init).toMatch(/add `small` or `large` afterwards, run guided init/i);
  });

  it('tells the README and the CHANGELOG about the one-time setup and the behavior change', () => {
    const setup = flat(sectionRaw('Set up a model'));
    expect(setup).toMatch(/whether the models are for every project or only this one/);
    expect(setup).toContain('~/.agents/subzero.yaml');
    expect(setup).toMatch(/`enabled: false`/);
    expect(README).toMatch(/general file has a `medium` tier, subzero is on in every project/);
    expect(CHANGELOG).toContain('SUBZERO_GENERAL_CONFIG');
    expect(CHANGELOG).toMatch(/Behavior change: a general file with a `medium` tier turns subzero on in every project/);
    expect(CHANGELOG).toContain('`enabled: false`');
    expect(CHANGELOG).toContain('--scope general|project');
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
