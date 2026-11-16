import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoadError, loadAgentFile } from '../../src/config/agent-config.js';
import {
  applyChanges,
  ChangeSetError,
  normalizeChangeSet,
  previewChanges,
  readSetupState,
  SetupConflictError,
  SetupRefusedError,
  type Change,
  type SetupStarterSpec,
} from '../../src/config/agent-setup.js';
import { makeProject, tempDir } from '../helpers.js';

// Test seams: a fixed random suffix for the temp file name, and a failing write or rename.
const seam = vi.hoisted(() => ({ random: undefined as string | undefined, fail: undefined as 'write' | 'rename' | undefined }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (size: number) => (seam.random !== undefined ? Buffer.from(seam.random, 'hex') : actual.randomBytes(size)),
  };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (seam.fail === 'write' && typeof args[0] === 'number') {
        actual.writeFileSync(args[0], 'part');
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return actual.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (seam.fail === 'rename') throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      return actual.renameSync(...args);
    },
  };
});

afterEach(() => {
  seam.random = undefined;
  seam.fail = undefined;
});

const STARTER: SetupStarterSpec = {
  host: 'pi',
  generalTools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
  fallbackTools: ['read', 'grep', 'find', 'ls'],
};

const fileOf = (root: string) => path.join(root, '.agents', 'subzero.yaml');
const read = (root: string) => readFileSync(fileOf(root), 'utf8');
const otherFiles = (root: string) => readdirSync(path.join(root, '.agents')).filter((f) => f !== 'subzero.yaml' && f !== 'skills');

const AGENTS = `agents:
  general:
    tools: [read, bash]
    timeout: 60
  fallback:
    tools: [read]
    timeout: 60
`;

/** A hand-written file: comments, skills, routing, endpoints and a named agent. */
const HAND_WRITTEN = `# Project agents. Edit with care.
skills:
  facts: ./skills/alpha   # the facts skill

routing:
  hook: true
  generic_agents: [Explore]

endpoints:
  # the GPU box
  local:
    parallel: 1

models:
  tiers:
    # everyday work
    medium: { host: pi, model: local/qwen3-coder-30b, thinking: high }   # keep me
    small: { host: pi, model: local/qwen3-4b, thinking: low }

agents:
  # the general one
  general:
    tools: [read, bash]
    timeout: 60
  fallback:
    tools: [read]
    timeout: 60
  file-facts:
    description: Reads facts out of files
    tier: small
    skills: [facts]
    tools: [read]
    timeout: 30
`;

describe('AgentSetup change sets', () => {
  it('rejects a limit of 0, -1, 1.5 or two', () => {
    for (const parallel of [0, -1, 1.5, 'two', Number.NaN]) {
      expect(() => normalizeChangeSet([{ op: 'setLimit', endpoint: 'local', parallel: parallel as number }])).toThrow(ChangeSetError);
      expect(() => previewChanges(tempDir(), [{ op: 'setLimit', endpoint: 'local', parallel: parallel as number }], STARTER)).toThrow(
        /parallel|positive whole number/,
      );
    }
    expect(normalizeChangeSet([{ op: 'setLimit', endpoint: 'local', parallel: 3 }])).toEqual([{ op: 'setLimit', endpoint: 'local', parallel: 3 }]);
  });

  it('rejects an unknown thinking level, an empty model or name, an unknown op and two changes to one tier or endpoint', () => {
    const bad: unknown[] = [
      [{ op: 'setTier', tier: 'medium', model: 'local/m', thinking: 'extreme' }],
      [{ op: 'setTier', tier: 'medium', model: '', thinking: 'low' }],
      [{ op: 'setTier', tier: '', model: 'local/m', thinking: 'low' }],
      [{ op: 'rename', tier: 'medium' }],
      [{ op: 'setTier', tier: 'small', model: 'local/m', thinking: 'low' }, { op: 'unsetTier', tier: 'small' }],
      [{ op: 'setLimit', endpoint: 'local', parallel: 1 }, { op: 'clearLimit', endpoint: 'local' }],
    ];
    for (const changes of bad) expect(() => normalizeChangeSet(changes as Change[])).toThrow(ChangeSetError);
  });

  it('normalizes the order of a change set, so the same changes give the same fingerprint', () => {
    const root = makeProject(HAND_WRITTEN);
    const a: Change[] = [
      { op: 'setLimit', endpoint: 'local', parallel: 2 },
      { op: 'setTier', tier: 'medium', model: 'local/x', thinking: 'low' },
    ];
    expect(previewChanges(root, a, STARTER).fingerprint).toBe(previewChanges(root, [...a].reverse(), STARTER).fingerprint);
    expect(previewChanges(root, a, STARTER).fingerprint).not.toBe(previewChanges(root, a.slice(1), STARTER).fingerprint);
  });
});

describe('AgentSetup state', () => {
  it('reports no file, with every starter entry missing', () => {
    const state = readSetupState(tempDir(), { host: 'pi' });
    expect(state.status).toBe('no-file');
    if (state.status === 'refused') throw new Error('unexpected');
    expect(state.fileFingerprint).toBeNull();
    expect(state.tiers).toEqual([]);
    expect(state.limits).toEqual([]);
    expect(state.missingStarter).toEqual(['medium', 'general', 'fallback']);
  });

  it('lists tiers, limits and the agents that depend on each tier through tier: or tiers.<t>', () => {
    const text = HAND_WRITTEN.replace(
      '    timeout: 60\n  fallback:',
      '    timeout: 60\n    tiers:\n      small: { thinking: off }\n  fallback:',
    );
    const state = readSetupState(makeProject(text), { host: 'pi' });
    if (state.status !== 'ok') throw new Error(`unexpected ${state.status}`);
    expect(state.fileFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(state.tiers).toEqual([
      { tier: 'medium', host: 'pi', model: 'local/qwen3-coder-30b', thinking: 'high', endpoint: 'local', dependents: [], otherHost: false, listed: null },
      { tier: 'small', host: 'pi', model: 'local/qwen3-4b', thinking: 'low', endpoint: 'local', dependents: ['general', 'file-facts'], otherHost: false, listed: null },
    ]);
    expect(state.limits).toEqual([{ endpoint: 'local', parallel: 1, tiers: ['medium', 'small'], overrideOnly: false, unused: false }]);
    expect(state.overrideOnlyEndpoints).toEqual([]);
    expect(state.missingStarter).toEqual([]);
  });

  it('marks an endpoint that only an override model uses, and keeps its limit through a change', () => {
    const text = `endpoints:
  local:
    parallel: 2
  cloud:
    parallel: 4
models:
  tiers:
    medium: { host: pi, model: local/m, thinking: high }
${AGENTS}  reviewer:
    description: r
    tiers:
      medium: { model: cloud/reviewer }
    tools: [read]
    timeout: 5
`;
    const root = makeProject(text);
    const state = readSetupState(root, { host: 'pi' });
    if (state.status !== 'ok') throw new Error(`unexpected ${state.status}`);
    expect(state.overrideOnlyEndpoints).toEqual(['cloud']);
    expect(state.limits).toContainEqual({ endpoint: 'cloud', parallel: 4, tiers: [], overrideOnly: true, unused: false });

    const preview = previewChanges(root, [{ op: 'setTier', tier: 'medium', model: 'google/g', thinking: 'low' }], STARTER);
    expect(preview.droppedLimits).toEqual(['local']);
    expect(loadAgentFile(makeProject(preview.text)).limits).toEqual(new Map([['cloud', 4]]));
  });

  it('reports medium on another host and a model the caller marks as not listed, and keeps them when untouched', () => {
    const text = `models:
  tiers:
    medium: { host: claude, model: anthropic/opus, thinking: max }
    small: { host: pi, model: local/gone, thinking: low }
${AGENTS}`;
    const root = makeProject(text);
    const state = readSetupState(root, { host: 'pi', listedModels: ['local/here', 'google/g'] });
    if (state.status !== 'ok') throw new Error(`unexpected ${state.status}`);
    expect(state.tiers.find((t) => t.tier === 'medium')).toMatchObject({ host: 'claude', model: 'anthropic/opus', otherHost: true, listed: false });
    expect(state.tiers.find((t) => t.tier === 'small')).toMatchObject({ model: 'local/gone', otherHost: false, listed: false });

    const changes: Change[] = [{ op: 'setTier', tier: 'large', model: 'google/g', thinking: 'high' }];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.refusals).toEqual([]);
    expect(preview.text).toContain('    medium: { host: claude, model: anthropic/opus, thinking: max }\n');
    expect(preview.text).toContain('    small: { host: pi, model: local/gone, thinking: low }\n');
    applyChanges(root, changes, preview.fingerprint, STARTER);
    const catalog = loadAgentFile(root);
    expect(catalog.tiers.get('medium')).toEqual({ host: 'claude', model: 'anthropic/opus', thinking: 'max' });
    expect(catalog.tiers.get('large')).toEqual({ host: 'pi', model: 'google/g', thinking: 'high' });
  });

  it('classifies a missing starter entry and an unused limit as repairable', () => {
    const noFallback = readSetupState(makeProject(`models:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\nagents:\n  general:\n    tools: [read]\n    timeout: 5\n`), {});
    expect(noFallback).toMatchObject({ status: 'repairable', missingStarter: ['fallback'] });
    if (noFallback.status !== 'repairable') throw new Error('unexpected');
    expect(noFallback.problem).toMatch(/fallback agent is required/);

    const unused = readSetupState(
      makeProject(`endpoints:\n  old:\n    parallel: 1\nmodels:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n${AGENTS}`),
      {},
    );
    expect(unused).toMatchObject({ status: 'repairable', missingStarter: [] });
    if (unused.status !== 'repairable') throw new Error('unexpected');
    expect(unused.limits).toEqual([{ endpoint: 'old', parallel: 1, tiers: [], overrideOnly: false, unused: true }]);
  });

  it('refuses a YAML syntax error, an unknown key and an agent naming a missing tier with the parser message, writing nothing', () => {
    const texts = [
      'models: [unclosed',
      `models:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n${AGENTS}  helper:\n    description: h\n    tools: [read]\n    timeout: 5\n    colour: red\n`,
      `models:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n${AGENTS}  helper:\n    description: h\n    tier: tiny\n    tools: [read]\n    timeout: 5\n`,
    ];
    for (const text of texts) {
      const root = makeProject(text);
      let parserMessage = '';
      try {
        loadAgentFile(root);
      } catch (err) {
        parserMessage = (err as Error).message;
      }
      expect(parserMessage).not.toBe('');
      const state = readSetupState(root, {});
      expect(state).toEqual({ status: 'refused', agentFile: fileOf(root), error: parserMessage });
      const changes: Change[] = [{ op: 'setTier', tier: 'medium', model: 'local/x', thinking: 'low' }];
      expect(() => previewChanges(root, changes, STARTER)).toThrow(LoadError);
      expect(() => previewChanges(root, changes, STARTER)).toThrow(parserMessage);
      expect(() => applyChanges(root, changes, 'whatever', STARTER)).toThrow(parserMessage);
      expect(read(root)).toBe(text);
      expect(otherFiles(root)).toEqual([]);
    }
  });
});

describe('AgentSetup preview and apply', () => {
  it('creates a missing file with the chosen tiers, a limit, general and fallback at 1200 seconds, and it loads', () => {
    const root = tempDir();
    const changes: Change[] = [
      { op: 'setTier', tier: 'medium', model: 'local/qwen3-coder-30b', thinking: 'medium' },
      { op: 'setTier', tier: 'small', model: 'local/qwen3-4b', thinking: 'off' },
      { op: 'setLimit', endpoint: 'local', parallel: 2 },
    ];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview).toMatchObject({ fileExists: false, refusals: [], droppedLimits: [], nothingToChange: false });
    expect(preview.addedStarter).toEqual(['medium', 'general', 'fallback']);
    expect(preview.diff).toContain('+++ .agents/subzero.yaml');
    expect(preview.diff).toContain('+    medium: { host: pi, model: local/qwen3-coder-30b, thinking: medium }');
    expect(existsSync(fileOf(root))).toBe(false);

    const result = applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(result.written).toBe(true);
    expect(read(root)).toBe(preview.text);
    const catalog = loadAgentFile(root);
    expect(catalog.tiers).toEqual(
      new Map([
        ['medium', { host: 'pi', model: 'local/qwen3-coder-30b', thinking: 'medium' }],
        ['small', { host: 'pi', model: 'local/qwen3-4b', thinking: 'off' }],
      ]),
    );
    expect(catalog.limits).toEqual(new Map([['local', 2]]));
    expect(catalog.entries.get('general')).toMatchObject({ tools: STARTER.generalTools, timeout: 1200, skills: [] });
    expect(catalog.entries.get('fallback')).toMatchObject({ tools: STARTER.fallbackTools, timeout: 1200, skills: [] });
    expect(otherFiles(root)).toEqual([]);
  });

  it('refuses a new file without a medium tier', () => {
    const preview = previewChanges(tempDir(), [{ op: 'setTier', tier: 'small', model: 'local/s', thinking: 'low' }], STARTER);
    expect(preview.refusals).toEqual([{ change: null, message: expect.stringMatching(/medium tier is required/) }]);
  });

  it('covers AE5: changing the medium model changes only that line, every other byte kept', () => {
    const root = makeProject(HAND_WRITTEN);
    const changes: Change[] = [{ op: 'setTier', tier: 'medium', model: 'local/qwen3-coder-next', thinking: 'high' }];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.refusals).toEqual([]);
    applyChanges(root, changes, preview.fingerprint, STARTER);
    const before = HAND_WRITTEN.split('\n');
    const after = read(root).split('\n');
    expect(after).toHaveLength(before.length);
    const changed = before.flatMap((line, i) => (line === after[i] ? [] : [[line, after[i]]]));
    expect(changed).toEqual([
      [
        '    medium: { host: pi, model: local/qwen3-coder-30b, thinking: high }   # keep me',
        '    medium: { host: pi, model: local/qwen3-coder-next, thinking: high }   # keep me',
      ],
    ]);
    expect(preview.diff).toContain('-    medium: { host: pi, model: local/qwen3-coder-30b, thinking: high }   # keep me');
    expect(preview.diff).toContain('+    medium: { host: pi, model: local/qwen3-coder-next, thinking: high }   # keep me');
    expect(preview.diff).not.toContain('file-facts');
  });

  it('edits a block-style tier field by field, keeping its comments, and renders a model id with a colon', () => {
    const text = `models:
  tiers:
    medium:
      host: pi        # host
      model: local/m  # model
      thinking: low
${AGENTS}`;
    const root = makeProject(text);
    const changes: Change[] = [{ op: 'setTier', tier: 'medium', model: 'ollama/qwen2.5-coder:7b', thinking: 'high' }];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.text).toBe(text.replace('model: local/m  # model', 'model: ollama/qwen2.5-coder:7b  # model').replace('thinking: low', 'thinking: high'));
    applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(loadAgentFile(root).tiers.get('medium')).toEqual({ host: 'pi', model: 'ollama/qwen2.5-coder:7b', thinking: 'high' });
  });

  it('covers AE4: unsetting a tier a named agent uses is refused naming it, the rest previews, and apply writes nothing', () => {
    const root = makeProject(HAND_WRITTEN);
    const changes: Change[] = [
      { op: 'unsetTier', tier: 'small' },
      { op: 'setTier', tier: 'medium', model: 'local/other', thinking: 'low' },
      { op: 'setLimit', endpoint: 'local', parallel: 3 },
    ];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.refusals).toHaveLength(1);
    expect(preview.refusals[0]).toMatchObject({ change: { op: 'unsetTier', tier: 'small' }, agents: ['file-facts'] });
    expect(preview.refusals[0]!.message).toMatch(/file-facts/);
    expect(preview.text).toContain('small: { host: pi, model: local/qwen3-4b, thinking: low }');
    expect(preview.text).toContain('medium: { host: pi, model: local/other, thinking: low }');
    expect(preview.text).toContain('    parallel: 3\n');
    expect(() => applyChanges(root, changes, preview.fingerprint, STARTER)).toThrow(SetupRefusedError);
    expect(() => applyChanges(root, changes, preview.fingerprint, STARTER)).toThrow(/file-facts/);
    expect(read(root)).toBe(HAND_WRITTEN);
    expect(otherFiles(root)).toEqual([]);

    const rest = changes.slice(1);
    const again = previewChanges(root, rest, STARTER);
    expect(again.refusals).toEqual([]);
    expect(applyChanges(root, rest, again.fingerprint, STARTER).written).toBe(true);
    expect(loadAgentFile(root).limits.get('local')).toBe(3);
  });

  it('names every agent on a tier, through tier: and through a tiers.<t> override', () => {
    const text = HAND_WRITTEN + `  reviewer:\n    description: r\n    tiers:\n      small: { model: local/r }\n    tools: [read]\n    timeout: 5\n`;
    const preview = previewChanges(makeProject(text), [{ op: 'unsetTier', tier: 'small' }], STARTER);
    expect(preview.refusals).toEqual([{ change: { op: 'unsetTier', tier: 'small' }, agents: ['file-facts', 'reviewer'], message: expect.stringMatching(/file-facts.*reviewer/) }]);
  });

  it('refuses unsetting medium, unsetting an unknown tier, and a limit on an endpoint no model uses', () => {
    const preview = previewChanges(
      makeProject(HAND_WRITTEN),
      [
        { op: 'unsetTier', tier: 'medium' },
        { op: 'unsetTier', tier: 'huge' },
        { op: 'setLimit', endpoint: 'nowhere', parallel: 1 },
      ],
      STARTER,
    );
    expect(preview.refusals.map((r) => r.change)).toEqual([
      { op: 'unsetTier', tier: 'medium' },
      { op: 'unsetTier', tier: 'huge' },
      { op: 'setLimit', endpoint: 'nowhere', parallel: 1 },
    ]);
    expect(preview.refusals[0]!.message).toMatch(/medium tier cannot be removed/);
    expect(preview.refusals[1]!.message).toMatch(/"huge" is not configured/);
    expect(preview.nothingToChange).toBe(true);
  });

  it('removes an unused tier with the comment lines attached to it', () => {
    const text = `models:
  tiers:
    medium: { host: pi, model: local/m, thinking: low }
    # a big one
    large:
      host: pi
      model: cloud/l
      thinking: high

    tiny: { host: pi, model: local/t, thinking: off }
${AGENTS}`;
    const root = makeProject(text);
    const changes: Change[] = [{ op: 'unsetTier', tier: 'large' }];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.text).toBe(text.replace('    # a big one\n    large:\n      host: pi\n      model: cloud/l\n      thinking: high\n', ''));
    expect(applyChanges(root, changes, preview.fingerprint, STARTER).written).toBe(true);
    expect([...loadAgentFile(root).tiers.keys()]).toEqual(['medium', 'tiny']);
  });

  it('adds and removes tiers in a flow-style tiers map', () => {
    const text = `models: { tiers: { medium: { host: pi, model: local/m, thinking: low }, small: { host: pi, model: local/s, thinking: low } } }\n${AGENTS}`;
    const root = makeProject(text);
    const changes: Change[] = [
      { op: 'unsetTier', tier: 'small' },
      { op: 'setTier', tier: 'large', model: 'cloud/l', thinking: 'high' },
    ];
    const preview = previewChanges(root, changes, STARTER);
    applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(loadAgentFile(root).tiers).toEqual(
      new Map([
        ['medium', { host: 'pi', model: 'local/m', thinking: 'low' }],
        ['large', { host: 'pi', model: 'cloud/l', thinking: 'high' }],
      ]),
    );
    expect(read(root)).toContain(AGENTS);
  });

  it('covers AE3: moving medium off the only tier on local drops endpoints.local, listed by preview and apply', () => {
    const text = `endpoints:
  local:
    parallel: 1
  google:
    parallel: 2
models:
  tiers:
    medium: { host: pi, model: local/qwen, thinking: high }
    large: { host: pi, model: google/gemini-3.1-pro-preview, thinking: high }
${AGENTS}`;
    const root = makeProject(text);
    const changes: Change[] = [{ op: 'setTier', tier: 'medium', model: 'google/gemini-3-flash', thinking: 'low' }];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.droppedLimits).toEqual(['local']);
    expect(preview.summary.join('\n')).toMatch(/local/);
    expect(preview.text).not.toContain('local:');
    const result = applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(result.droppedLimits).toEqual(['local']);
    expect(loadAgentFile(root).limits).toEqual(new Map([['google', 2]]));
  });

  it('drops an unused limit in a repairable file', () => {
    const root = makeProject(`endpoints:\n  old:\n    parallel: 1\nmodels:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n${AGENTS}`);
    const preview = previewChanges(root, [], STARTER);
    expect(preview).toMatchObject({ droppedLimits: ['old'], nothingToChange: false, refusals: [] });
    applyChanges(root, [], preview.fingerprint, STARTER);
    expect(read(root)).toBe(`models:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n${AGENTS}`);
  });

  it('removes the endpoints map, with its attached comment, when the only limit is cleared', () => {
    const root = makeProject(HAND_WRITTEN);
    const changes: Change[] = [{ op: 'clearLimit', endpoint: 'local' }];
    const preview = previewChanges(root, changes, STARTER);
    applyChanges(root, changes, preview.fingerprint, STARTER);
    // The blank line after the map goes with it, so no double blank line is left.
    expect(read(root)).toBe(HAND_WRITTEN.replace('endpoints:\n  # the GPU box\n  local:\n    parallel: 1\n\n', ''));
    expect(loadAgentFile(root).limits.size).toBe(0);
  });

  it('clears one limit of several, keeping the others, and treats clearing an absent limit as no change', () => {
    const text = `endpoints:\n  local:\n    parallel: 1\n  google: { parallel: 2 }\nmodels:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n    large: { host: pi, model: google/g, thinking: low }\n${AGENTS}`;
    const root = makeProject(text);
    const preview = previewChanges(root, [{ op: 'clearLimit', endpoint: 'google' }, { op: 'clearLimit', endpoint: 'other' }], STARTER);
    expect(preview.refusals).toEqual([]);
    expect(preview.text).toBe(text.replace('  google: { parallel: 2 }\n', ''));
  });

  it('adds a limit to an existing endpoints map and creates the map when there is none', () => {
    const text = `endpoints:\n  local:\n    parallel: 1\nmodels:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n    large: { host: pi, model: google/g, thinking: low }\n${AGENTS}`;
    const root = makeProject(text);
    const changes: Change[] = [{ op: 'setLimit', endpoint: 'google', parallel: 5 }];
    applyChanges(root, changes, previewChanges(root, changes, STARTER).fingerprint, STARTER);
    expect(loadAgentFile(root).limits).toEqual(new Map([['local', 1], ['google', 5]]));

    const bare = makeProject(`models:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n${AGENTS}`);
    const set: Change[] = [{ op: 'setLimit', endpoint: 'local', parallel: 2 }];
    applyChanges(bare, set, previewChanges(bare, set, STARTER).fingerprint, STARTER);
    expect(loadAgentFile(bare).limits).toEqual(new Map([['local', 2]]));
  });

  it('replaces the only limit with a limit on another endpoint', () => {
    const text = `endpoints:   # limits\n  local:\n    parallel: 1\nmodels:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n    large: { host: pi, model: google/g, thinking: low }\n${AGENTS}`;
    const root = makeProject(text);
    const changes: Change[] = [
      { op: 'clearLimit', endpoint: 'local' },
      { op: 'setLimit', endpoint: 'google', parallel: 2 },
    ];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.invalid).toBeUndefined();
    applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(loadAgentFile(root).limits).toEqual(new Map([['google', 2]]));
  });

  it('repairs a file without a medium tier when the change set sets one, and refuses it when not', () => {
    const text = `# kept\nagents:\n  general:\n    tools: [read]\n    timeout: 5\n`;
    const root = makeProject(text);
    const state = readSetupState(root, {});
    expect(state).toMatchObject({ status: 'repairable', missingStarter: ['medium', 'fallback'] });
    expect(previewChanges(root, [], STARTER).refusals).toEqual([{ change: null, message: expect.stringMatching(/medium tier is required/) }]);
    const changes: Change[] = [{ op: 'setTier', tier: 'medium', model: 'local/m', thinking: 'low' }];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.addedStarter).toEqual(['medium', 'fallback']);
    applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(read(root).startsWith(text)).toBe(true);
    expect(loadAgentFile(root).tiers.get('medium')).toEqual({ host: 'pi', model: 'local/m', thinking: 'low' });
  });

  it('previews a file missing fallback as an update that adds it', () => {
    const text = `# mine\nmodels:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\nagents:\n  general:\n    tools: [read]\n    timeout: 5\n`;
    const root = makeProject(text);
    const preview = previewChanges(root, [], STARTER);
    expect(preview).toMatchObject({ addedStarter: ['fallback'], nothingToChange: false, refusals: [] });
    expect(preview.text.startsWith(text)).toBe(true);
    applyChanges(root, [], preview.fingerprint, STARTER);
    expect(loadAgentFile(root).entries.get('fallback')).toMatchObject({ tools: STARTER.fallbackTools, timeout: 1200 });
  });

  it('reports nothing to change for an empty change set and leaves the modification time alone', () => {
    const root = makeProject(HAND_WRITTEN);
    const past = new Date('2020-01-01T00:00:00Z');
    utimesSync(fileOf(root), past, past);
    const preview = previewChanges(root, [], STARTER);
    expect(preview).toMatchObject({ nothingToChange: true, refusals: [], droppedLimits: [], addedStarter: [], diff: '' });
    expect(applyChanges(root, [], preview.fingerprint, STARTER).written).toBe(false);
    expect(statSync(fileOf(root)).mtimeMs).toBe(past.getTime());

    const same: Change[] = [{ op: 'setTier', tier: 'medium', model: 'local/qwen3-coder-30b', thinking: 'high' }];
    expect(previewChanges(root, same, STARTER).nothingToChange).toBe(true);
  });

  it('refuses apply when the file was edited, created or deleted since the preview, or the change set differs', () => {
    const changes: Change[] = [{ op: 'setTier', tier: 'medium', model: 'local/new', thinking: 'low' }];

    const edited = makeProject(HAND_WRITTEN);
    const fp = previewChanges(edited, changes, STARTER).fingerprint;
    writeFileSync(fileOf(edited), HAND_WRITTEN + '# touched\n');
    expect(() => applyChanges(edited, changes, fp, STARTER)).toThrow(SetupConflictError);
    expect(read(edited)).toBe(HAND_WRITTEN + '# touched\n');

    const created = tempDir();
    const fpNone = previewChanges(created, changes, STARTER).fingerprint;
    makeProjectAt(created, HAND_WRITTEN);
    expect(() => applyChanges(created, changes, fpNone, STARTER)).toThrow(SetupConflictError);
    expect(read(created)).toBe(HAND_WRITTEN);

    const deleted = makeProject(HAND_WRITTEN);
    const fpDel = previewChanges(deleted, changes, STARTER).fingerprint;
    unlinkSync(fileOf(deleted));
    expect(() => applyChanges(deleted, changes, fpDel, STARTER)).toThrow(SetupConflictError);
    expect(existsSync(fileOf(deleted))).toBe(false);

    const other = makeProject(HAND_WRITTEN);
    const fpOther = previewChanges(other, changes, STARTER).fingerprint;
    expect(() => applyChanges(other, [{ ...changes[0]!, thinking: 'high' } as Change], fpOther, STARTER)).toThrow(/preview again/i);
    expect(read(other)).toBe(HAND_WRITTEN);
  });

  it('leaves the original file intact and no temp file behind when the write or the rename fails', () => {
    for (const fail of ['write', 'rename'] as const) {
      const root = makeProject(HAND_WRITTEN);
      const changes: Change[] = [{ op: 'setTier', tier: 'medium', model: 'local/new', thinking: 'low' }];
      const preview = previewChanges(root, changes, STARTER);
      seam.fail = fail;
      expect(() => applyChanges(root, changes, preview.fingerprint, STARTER)).toThrow(fail === 'write' ? /ENOSPC/ : /EIO/);
      seam.fail = undefined;
      expect(read(root)).toBe(HAND_WRITTEN);
      expect(lstatSync(fileOf(root)).isFile()).toBe(true);
      expect(otherFiles(root)).toEqual([]);
    }
  });

  it('never follows a symlink sitting at the temp file name', () => {
    const root = makeProject(HAND_WRITTEN);
    const outside = path.join(tempDir(), 'target.txt');
    writeFileSync(outside, 'outside\n');
    seam.random = '00112233445566778899aabb';
    const changes: Change[] = [{ op: 'setTier', tier: 'medium', model: 'local/new', thinking: 'low' }];
    const preview = previewChanges(root, changes, STARTER);
    // The temp name is .subzero.yaml.<pid>.<random>.tmp next to the agent file.
    const trap = path.join(root, '.agents', `.subzero.yaml.${process.pid}.${seam.random}.tmp`);
    symlinkSync(outside, trap);
    expect(() => applyChanges(root, changes, preview.fingerprint, STARTER)).toThrow(/EEXIST/);
    expect(readFileSync(outside, 'utf8')).toBe('outside\n');
    expect(read(root)).toBe(HAND_WRITTEN);
    expect(lstatSync(fileOf(root)).isFile()).toBe(true);
    expect(lstatSync(trap).isSymbolicLink()).toBe(true);

    seam.random = undefined;
    applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(lstatSync(fileOf(root)).isFile()).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('outside\n');
  });
});

/** Put an agent file, and the skill folders it names, under an existing root. */
function makeProjectAt(root: string, text: string): void {
  cpSync(path.join(makeProject(text), '.agents'), path.join(root, '.agents'), { recursive: true });
}
