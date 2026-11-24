import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/cli.js';
import { loadCatalog, PLACEHOLDER_STARTER_AGENTS, resolveAgent } from '../../src/config/agent-config.js';
import { DEFAULT_YAML, FAKE_PI_COMMAND, GLOBAL_MEDIUM_YAML, fakePiEnv, makeProject, piKernel, tempDir, useGlobalConfig } from '../helpers.js';

const piModel = (provider: string, id: string) => ({
  id,
  name: id,
  api: 'openai-completions',
  provider,
  baseUrl: 'http://localhost:8080/v1',
  reasoning: true,
  input: ['text'],
  contextWindow: 131072,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

const agentFile = (root: string) => path.join(root, '.agents', 'subzero.yaml');

function cli(root: string, scenario: Record<string, unknown> = {}) {
  const fake = fakePiEnv(scenario);
  const out: string[] = [];
  const err: string[] = [];
  const { kernel } = piKernel({ piCommand: FAKE_PI_COMMAND, env: fake.env, piAgentDir: tempDir(), killWaitMs: 300, log: () => {} });
  const run = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    return runCli(argv, { out: (t) => out.push(t), err: (t) => err.push(t) }, {
      env: { SUBZERO_PROJECT_DIR: root },
      warn: () => {},
      interactive: false,
      kernel,
    });
  };
  /** The one JSON document the last command printed. */
  const json = () => {
    expect(out).toHaveLength(1);
    return JSON.parse(out[0]!);
  };
  return { run, out, err, json, fake };
}

describe('subzero config', () => {
  it('models prints JSON listing the host models', async () => {
    const { run, json } = cli(tempDir(), { models: [piModel('local', 'qwen'), piModel('ollama', 'qwen2.5-coder:7b')] });
    expect(await run('config', 'models')).toBe(0);
    const doc = json();
    expect(doc).toMatchObject({ ok: true, host: 'pi' });
    expect(doc.models.map((m: { name: string }) => m.name)).toEqual(['local/qwen', 'ollama/qwen2.5-coder:7b']);
  });

  it('show on a project with no file prints the no-file state and its fingerprint field', async () => {
    const root = tempDir();
    const { run, json } = cli(root);
    expect(await run('config', 'show')).toBe(0);
    const doc = json();
    expect(doc).toMatchObject({ ok: true, host: 'pi', state: { status: 'no-file', fileFingerprint: null } });
    expect(typeof doc.largeWarning).toBe('string');
    expect(existsSync(agentFile(root))).toBe(false);
  });

  it('show on an existing file lists its tiers', async () => {
    const { run, json } = cli(makeProject());
    expect(await run('config', 'show')).toBe(0);
    const doc = json();
    expect(doc.state.status).toBe('ok');
    expect(doc.state.fileFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.state.tiers.map((t: { tier: string }) => t.tier)).toContain('medium');
  });

  describe('with a global file', () => {
    const global = (root: string) => cli(root);
    const MEDIUM = ['--tier', 'medium=local/everywhere:low'];

    it('show prints each tier and limit with its source and the tiers this project overrides', async () => {
      useGlobalConfig(GLOBAL_MEDIUM_YAML.replace('medium: {', 'large: { host: pi, model: cloud/l, thinking: high }\n    medium: {'));
      const { run, json } = global(makeProject());
      expect(await run('config', 'show')).toBe(0);
      const doc = json();
      expect(doc.state.tiers.map((t: { tier: string; source: string }) => [t.tier, t.source])).toEqual([
        ['large', 'global'],
        ['medium', 'project'],
        ['small', 'project'],
        ['cloud', 'project'],
      ]);
      expect(doc.state.limits).toEqual([expect.objectContaining({ model: 'local/qwen', source: 'project' })]);
      expect(doc.state.overridden).toEqual({ tiers: ['medium'], limits: [] });
    });

    it('show prints the global file\'s own value of an overridden tier and limit as `global`', async () => {
      useGlobalConfig(GLOBAL_MEDIUM_YAML.replace('models:\n', 'models:\n  parallel:\n    local/qwen: 3\n'));
      const { run, json } = global(makeProject());
      expect(await run('config', 'show')).toBe(0);
      const doc = json();
      const byTier = (name: string) => doc.state.tiers.find((t: { tier: string }) => t.tier === name);
      expect(byTier('medium')).toMatchObject({ source: 'project', global: { host: 'pi', model: 'local/global-medium', thinking: 'low' } });
      expect(byTier('small')).not.toHaveProperty('global');
      expect(doc.state.limits).toEqual([expect.objectContaining({ model: 'local/qwen', source: 'project', global: { parallel: 3 } })]);
    });

    it('preview --scope global prints the overridden list for a project that overrides the tier', async () => {
      const file = useGlobalConfig(GLOBAL_MEDIUM_YAML);
      const { run, json } = global(makeProject());
      expect(await run('config', 'preview', '--scope', 'global', ...MEDIUM)).toBe(0);
      const doc = json();
      expect(doc).toMatchObject({ ok: true, scope: 'global', agentFile: file, overridden: { tiers: ['medium'], limits: [] }, refusals: [] });
      expect(doc.diff).toMatch(/\+.*local\/everywhere/);
      expect(readFileSync(file, 'utf8')).toBe(GLOBAL_MEDIUM_YAML);
    });

    it('apply --scope global writes the global file, creating it and its folder, and exits 0', async () => {
      const file = path.join(tempDir(), 'home', '.agents', 'subzero.yaml');
      useGlobalConfig('');
      process.env.SUBZERO_GLOBAL_CONFIG = file;
      const root = makeProject();
      const { run, json } = global(root);
      expect(await run('config', 'preview', '--scope', 'global', ...MEDIUM)).toBe(0);
      const { fingerprint } = json();
      expect(await run('config', 'apply', '--scope', 'global', '--expect', fingerprint, ...MEDIUM)).toBe(0);
      expect(json()).toMatchObject({ ok: true, written: true, scope: 'global' });
      expect(readFileSync(file, 'utf8')).toBe('models:\n  tiers:\n    medium: { host: pi, model: local/everywhere, thinking: low }\n');
      expect(readFileSync(agentFile(root), 'utf8')).toBe(DEFAULT_YAML);
    });

    it('apply --scope global with a project-scope fingerprint prints stale_preview and exits 1', async () => {
      const file = useGlobalConfig(GLOBAL_MEDIUM_YAML);
      const { run, json } = global(makeProject());
      expect(await run('config', 'preview', ...MEDIUM)).toBe(0);
      const { fingerprint } = json();
      expect(await run('config', 'apply', '--scope', 'global', '--expect', fingerprint, ...MEDIUM)).toBe(1);
      expect(json()).toMatchObject({ ok: false, code: 'stale_preview' });
      expect(readFileSync(file, 'utf8')).toBe(GLOBAL_MEDIUM_YAML);
    });

    it('--scope project is the default and writes the project file with the changed tier only', async () => {
      useGlobalConfig(GLOBAL_MEDIUM_YAML);
      const root = tempDir();
      const { run, json } = global(root);
      const flags = ['--tier', 'small=local/s:low'];
      expect(await run('config', 'preview', '--scope', 'project', ...flags)).toBe(0);
      const { fingerprint } = json();
      expect(await run('config', 'apply', '--expect', fingerprint, ...flags)).toBe(0);
      expect(json()).toMatchObject({ ok: true, scope: 'project', overridden: { tiers: [], limits: [] } });
      expect(readFileSync(agentFile(root), 'utf8')).toBe('models:\n  tiers:\n    small: { host: pi, model: local/s, thinking: low }\n');
    });
  });

  it('check runs each model and prints a result per model, splitting thinking at the last colon', async () => {
    const root = makeProject();
    const { run, json, fake } = cli(root, { unknownModels: ['nowhere/missing'] });
    expect(await run('config', 'check', 'ollama/qwen2.5-coder:7b:off', 'nowhere/missing:low')).toBe(0);
    const doc = json();
    expect(doc.ok).toBe(true);
    expect(doc.results).toEqual([
      { model: 'ollama/qwen2.5-coder:7b', thinking: 'off', ok: true },
      expect.objectContaining({ model: 'nowhere/missing', thinking: 'low', ok: false, kind: 'unknown_model' }),
    ]);
    const starts = fake.log().filter((l) => l.argv !== undefined);
    expect(starts[0].argv[starts[0].argv.indexOf('--model') + 1]).toBe('ollama/qwen2.5-coder:7b');
  });

  it('preview prints the diff, summary and fingerprint without touching the file', async () => {
    const root = tempDir();
    const { run, json } = cli(root);
    expect(await run('config', 'preview', '--tier', 'medium=local/q:medium', '--limit', 'local/q=1')).toBe(0);
    const doc = json();
    expect(doc).toMatchObject({ ok: true, fileExists: false, nothingToChange: false, refusals: [] });
    expect(doc.fingerprint).toEqual(expect.any(String));
    expect(doc.diff).toMatch(/\+.*local\/q/);
    expect(doc.summary.length).toBeGreaterThan(0);
    expect(doc.changes).toEqual([
      { op: 'setTier', tier: 'medium', model: 'local/q', thinking: 'medium' },
      { op: 'setLimit', model: 'local/q', parallel: 1 },
    ]);
    expect(doc.text).toBeUndefined();
    expect(existsSync(agentFile(root))).toBe(false);
  });

  it('parses a tier model with a colon in it, splitting thinking at the last colon', async () => {
    const { run, json } = cli(tempDir());
    expect(await run('config', 'preview', '--tier', 'medium=ollama/qwen2.5-coder:7b:off')).toBe(0);
    expect(json().changes).toEqual([{ op: 'setTier', tier: 'medium', model: 'ollama/qwen2.5-coder:7b', thinking: 'off' }]);
  });

  it('carries --unset and --no-limit into the change set', async () => {
    const { run, json } = cli(makeProject());
    expect(await run('config', 'preview', '--unset', 'cloud', '--no-limit', 'local/qwen')).toBe(0);
    expect(json().changes).toEqual([
      { op: 'unsetTier', tier: 'cloud' },
      { op: 'clearLimit', model: 'local/qwen' },
    ]);
  });

  it('parses a limit model id containing a colon, splitting the limit at the last equals sign', async () => {
    const { run, json } = cli(tempDir());
    expect(await run('config', 'preview', '--tier', 'medium=local/qwen-coder:30b:medium', '--limit', 'local/qwen-coder:30b=2', '--no-limit', 'local/other:7b')).toBe(0);
    const doc = json();
    expect(doc.changes).toEqual([
      { op: 'setTier', tier: 'medium', model: 'local/qwen-coder:30b', thinking: 'medium' },
      { op: 'clearLimit', model: 'local/other:7b' },
      { op: 'setLimit', model: 'local/qwen-coder:30b', parallel: 2 },
    ]);
    expect(doc.refusals).toEqual([]);
    expect(doc.diff).toMatch(/\+    local\/qwen-coder:30b: 2/);
  });

  it('refuses a --limit with no model or no number as a usage error', async () => {
    for (const bad of ['=2', 'local/q', 'local/q=', 'local/q=two', 'local/q=0']) {
      const { run } = cli(tempDir());
      expect(await run('config', 'preview', '--limit', bad)).toBe(2);
    }
  });

  it('apply with the previewed flags and fingerprint writes the file', async () => {
    const root = tempDir();
    const { run, json } = cli(root);
    const flags = ['--tier', 'medium=local/q:medium', '--limit', 'local/q=1'];
    expect(await run('config', 'preview', ...flags)).toBe(0);
    const { fingerprint, diff } = json();
    expect(await run('config', 'apply', '--expect', fingerprint, ...flags)).toBe(0);
    const doc = json();
    expect(doc).toMatchObject({ ok: true, written: true, diff });
    expect(doc.text).toBeUndefined();
    expect(resolveAgent(loadCatalog(root, { starterAgents: PLACEHOLDER_STARTER_AGENTS }), 'general')).toMatchObject({ host: 'pi', model: 'local/q', thinking: 'medium' });
    expect(readFileSync(agentFile(root), 'utf8')).toMatch(/local\/q: 1/);
  });

  it('apply with a stale fingerprint exits 1, prints the reason and leaves the file unchanged', async () => {
    const root = makeProject();
    const { run, json } = cli(root);
    const flags = ['--tier', 'small=local/q:low'];
    expect(await run('config', 'preview', ...flags)).toBe(0);
    const { fingerprint } = json();
    const moved = `${DEFAULT_YAML}# edited after the preview\n`;
    writeFileSync(agentFile(root), moved);
    expect(await run('config', 'apply', '--expect', fingerprint, ...flags)).toBe(1);
    expect(json()).toMatchObject({ ok: false, code: 'stale_preview', message: expect.stringMatching(/Preview again/) });
    expect(readFileSync(agentFile(root), 'utf8')).toBe(moved);
  });

  it('apply with flags that differ from the previewed ones exits 1 and leaves the file unchanged', async () => {
    const root = makeProject();
    const { run, json } = cli(root);
    expect(await run('config', 'preview', '--tier', 'small=local/q:low')).toBe(0);
    const { fingerprint } = json();
    expect(await run('config', 'apply', '--expect', fingerprint, '--tier', 'small=local/q:high')).toBe(1);
    expect(json()).toMatchObject({ ok: false, code: 'stale_preview' });
    expect(readFileSync(agentFile(root), 'utf8')).toBe(DEFAULT_YAML);
  });

  it('apply of a change set holding a refused change exits 1 with the refusals', async () => {
    const root = makeProject();
    const { run, json } = cli(root);
    expect(await run('config', 'preview', '--unset', 'medium')).toBe(0);
    const preview = json();
    expect(preview.refusals).toHaveLength(1);
    expect(await run('config', 'apply', '--expect', preview.fingerprint, '--unset', 'medium')).toBe(1);
    const doc = json();
    expect(doc).toMatchObject({ ok: false, code: 'refused_change', message: expect.stringMatching(/medium/) });
    expect(doc.refusals).toEqual(preview.refusals);
    expect(readFileSync(agentFile(root), 'utf8')).toBe(DEFAULT_YAML);
  });

  describe('when the agent file cannot be written', () => {
    const locked: string[] = [];
    afterEach(() => {
      for (const dir of locked.splice(0)) chmodSync(dir, 0o755);
    });

    it.skipIf(process.getuid?.() === 0)('apply into a read-only .agents exits 1 with a write_failed refusal and leaves no temp file', async () => {
      const root = makeProject();
      const dir = path.dirname(agentFile(root));
      const { run, json } = cli(root);
      const flags = ['--tier', 'small=local/q:low'];
      expect(await run('config', 'preview', ...flags)).toBe(0);
      const { fingerprint } = json();
      const before = readdirSync(dir);
      chmodSync(dir, 0o500);
      locked.push(dir);
      expect(await run('config', 'apply', '--expect', fingerprint, ...flags)).toBe(1);
      expect(json()).toMatchObject({
        ok: false,
        code: 'write_failed',
        message: expect.stringMatching(/^could not write \.agents\/subzero\.yaml: EACCES/),
      });
      expect(readFileSync(agentFile(root), 'utf8')).toBe(DEFAULT_YAML);
      expect(readdirSync(dir)).toEqual(before);
    });
  });

  it('prints a load error as JSON and exits 1', async () => {
    const text = `models:\n  tiers:\n    medium: { host: pi, model: a/b, thinking: low }\nagents:\n  a:\n    description: d\n    tools: [read]\n`;
    const root = makeProject(text);
    const { run, json } = cli(root);
    expect(await run('config', 'preview', '--tier', 'small=a/b:low')).toBe(1);
    expect(json()).toMatchObject({ ok: false, code: 'load_error', message: expect.stringMatching(/agent "a": timeout/) });
    expect(readFileSync(agentFile(root), 'utf8')).toBe(text);
  });

  it('prints a service error as JSON and exits 1', async () => {
    const { run, json } = cli(tempDir());
    expect(await run('config', 'models', '--host', 'claude')).toBe(1);
    expect(json()).toMatchObject({ ok: false, code: 'unsupported_host', message: expect.stringContaining('pi') });
  });

  it('prints a change set changing one tier twice as JSON and exits 1', async () => {
    const { run, json } = cli(tempDir());
    expect(await run('config', 'preview', '--tier', 'small=a/b:low', '--unset', 'small')).toBe(1);
    expect(json()).toMatchObject({ ok: false, code: 'invalid_change_set' });
  });

  it.each([
    [['preview', '--tier', 'small=local/q:turbo']],
    [['preview', '--tier', 'small=local/q']],
    [['preview', '--tier', 'small=local/q:']],
    [['preview', '--tier', 'small']],
    [['preview', '--tier', '=local/q:low']],
    [['preview', '--tier', 'small=:low']],
    [['preview', '--limit', 'local=0']],
    [['preview', '--limit', 'local=1.5']],
    [['preview', '--limit', 'local']],
    [['preview', '--unset', '']],
    [['preview', '--bogus', 'x']],
    [['preview', 'stray']],
    [['preview', '--scope', 'other']],
    [['preview', '--scope', 'GLOBAL']],
    [['preview', '--scope']],
    [['apply', '--scope', 'other', '--expect', 'x']],
    [['show', '--scope', 'global']],
    [['apply', '--tier', 'small=local/q:low']],
    [['check']],
    [['check', 'local/qwen']],
    [['check', 'local/qwen:loud']],
    [['models', 'extra']],
    [['nonsense']],
    [[]],
  ])('config %j is a usage error with exit 2 and nothing on stdout', async (args) => {
    const root = makeProject();
    const { run, out, err } = cli(root);
    expect(await run('config', ...args)).toBe(2);
    expect(out).toEqual([]);
    expect(err.join('\n')).not.toBe('');
    expect(readFileSync(agentFile(root), 'utf8')).toBe(DEFAULT_YAML);
  });

  it('names the bad flag in the usage error', async () => {
    const { run, err } = cli(tempDir());
    expect(await run('config', 'preview', '--tier', 'small=local/q:turbo')).toBe(2);
    expect(err.join('\n')).toMatch(/turbo/);
    expect(await run('config', 'preview', '--limit', 'local=0')).toBe(2);
    expect(err.join('\n')).toMatch(/local=0/);
  });
});
