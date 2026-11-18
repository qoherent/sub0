import { cpSync, existsSync, mkdirSync, lstatSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { addStarterEntries, LoadError, loadCatalog, PLACEHOLDER_STARTER_AGENTS } from '../../src/config/agent-config.js';
import {
  applyChanges,
  ChangeSetError,
  normalizeChangeSet,
  previewChanges,
  readSetupState,
  SetupConflictError,
  SetupRefusedError,
  SetupWriteError,
  type Change,
  type SetupStarterSpec,
} from '../../src/config/agent-setup.js';
import { GENERAL_MEDIUM_YAML, makeProject, tempDir, useGeneralConfig } from '../helpers.js';

/** Loads a project as the hooks do: the built-in general and fallback fill what the file leaves out. */
const loadAgentFile = (root: string) => loadCatalog(root, { starterAgents: PLACEHOLDER_STARTER_AGENTS });

// Test seams: a fixed random suffix for the temp file name, and a failing write or rename
// (an fs error as Node raises it) or a write that hits a programming error.
const seam = vi.hoisted(() => ({ random: undefined as string | undefined, fail: undefined as 'write' | 'rename' | 'bug' | undefined }));
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
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' });
      }
      if (seam.fail === 'bug' && typeof args[0] === 'number') throw new TypeError('not a fs error');
      return actual.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (seam.fail === 'rename') throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO', syscall: 'rename' });
      return actual.renameSync(...args);
    },
  };
});

afterEach(() => {
  seam.random = undefined;
  seam.fail = undefined;
});

const STARTER: SetupStarterSpec = { host: 'pi' };

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
  it('reports no file and no tiers when neither layer exists', () => {
    const state = readSetupState(tempDir(), { host: 'pi' });
    expect(state.status).toBe('no-file');
    if (state.status === 'refused') throw new Error('unexpected');
    expect(state.fileFingerprint).toBeNull();
    expect(state.tiers).toEqual([]);
    expect(state.limits).toEqual([]);
    expect(state).not.toHaveProperty('missingStarter');
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
      { tier: 'medium', host: 'pi', model: 'local/qwen3-coder-30b', thinking: 'high', endpoint: 'local', dependents: [], otherHost: false, listed: null, source: 'project' },
      { tier: 'small', host: 'pi', model: 'local/qwen3-4b', thinking: 'low', endpoint: 'local', dependents: ['general', 'file-facts'], otherHost: false, listed: null, source: 'project' },
    ]);
    expect(state.limits).toEqual([{ endpoint: 'local', parallel: 1, tiers: ['medium', 'small'], overrideOnly: false, unused: false, source: 'project' }]);
    expect(state.overrideOnlyEndpoints).toEqual([]);
    expect(state.overridden).toEqual({ tiers: [], limits: [] });
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
    expect(state.limits).toContainEqual({ endpoint: 'cloud', parallel: 4, tiers: [], overrideOnly: true, unused: false, source: 'project' });

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

  it('loads a file with no general or fallback as ok: they are no longer repairable', () => {
    const noFallback = readSetupState(makeProject(`models:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\nagents:\n  general:\n    tools: [read]\n    timeout: 5\n`), {});
    expect(noFallback).toMatchObject({ status: 'ok' });
    const noAgents = readSetupState(makeProject(`models:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n`), {});
    expect(noAgents).toMatchObject({ status: 'ok' });
    const noMedium = readSetupState(makeProject(`# kept\nagents:\n  general:\n    tools: [read]\n    timeout: 5\n`), {});
    expect(noMedium).toMatchObject({ status: 'ok', tiers: [] });
  });

  it('classifies an own limit that no model uses as repairable', () => {
    const unused = readSetupState(
      makeProject(`endpoints:\n  old:\n    parallel: 1\nmodels:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n${AGENTS}`),
      {},
    );
    expect(unused).toMatchObject({ status: 'repairable' });
    if (unused.status !== 'repairable') throw new Error('unexpected');
    expect(unused.limits).toEqual([{ endpoint: 'old', parallel: 1, tiers: [], overrideOnly: false, unused: true, source: 'project' }]);
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
  it('creates a missing file with the chosen tiers and a limit only: no agents, and it loads', () => {
    const root = tempDir();
    const changes: Change[] = [
      { op: 'setTier', tier: 'medium', model: 'local/qwen3-coder-30b', thinking: 'medium' },
      { op: 'setTier', tier: 'small', model: 'local/qwen3-4b', thinking: 'off' },
      { op: 'setLimit', endpoint: 'local', parallel: 2 },
    ];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview).toMatchObject({ fileExists: false, refusals: [], droppedLimits: [], nothingToChange: false });
    expect(preview).not.toHaveProperty('addedStarter');
    expect(preview.text).not.toContain('agents');
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

  describe('removing several entries of one flow-style map', () => {
    const M = 'medium: { host: pi, model: local/m, thinking: low }';
    const S = 'small: { host: pi, model: local/s, thinking: low }';
    const T = 'tiny: { host: pi, model: local/t, thinking: off }';
    const L = 'large: { host: pi, model: local/l, thinking: high }';
    const unset = (...tiers: string[]): Change[] => tiers.map((tier) => ({ op: 'unsetTier', tier }));

    it.each([
      ['the last two (medium, small, large; unset small and large)', `{ ${M}, ${S}, ${L} }`, unset('small', 'large'), `{ ${M} }`, ['medium']],
      ['a middle and the last entry', `{ ${M}, ${S}, ${T}, ${L} }`, unset('small', 'large'), `{ ${M}, ${T} }`, ['medium', 'tiny']],
      ['two adjacent entries before the last', `{ ${M}, ${S}, ${T}, ${L} }`, unset('small', 'tiny'), `{ ${M}, ${L} }`, ['medium', 'large']],
      ['every entry but the first', `{ ${M}, ${S}, ${T}, ${L} }`, unset('small', 'tiny', 'large'), `{ ${M} }`, ['medium']],
      ['the entries around medium', `{ ${S}, ${M}, ${L} }`, unset('small', 'large'), `{ ${M} }`, ['medium']],
      ['the last two of a multi-line map', `{\n      ${M},\n      ${S},\n      ${L}\n    }`, unset('small', 'large'), `{\n      ${M}\n    }`, ['medium']],
    ])('removes %s', (_name, tiers, changes, kept, names) => {
      const text = `models:\n  tiers: ${tiers}\n${AGENTS}`;
      const root = makeProject(text);
      const preview = previewChanges(root, changes, STARTER);
      expect(preview.refusals).toEqual([]);
      expect(preview.invalid).toBeUndefined();
      expect(preview.text).toBe(`models:\n  tiers: ${kept}\n${AGENTS}`);
      expect(applyChanges(root, changes, preview.fingerprint, STARTER).written).toBe(true);
      expect([...loadAgentFile(root).tiers.keys()]).toEqual(names);
    });

    it.each([
      ['a cleared limit and the orphaned limit after it', [{ op: 'clearLimit', endpoint: 'google' }], '{ local: { parallel: 1 }, cloud: { parallel: 4 } }', ['local', 'cloud']],
      ['the orphaned limit and a cleared last limit', [{ op: 'clearLimit', endpoint: 'cloud' }], '{ local: { parallel: 1 }, google: { parallel: 2 } }', ['local', 'google']],
      ['three limits after the first', [{ op: 'clearLimit', endpoint: 'google' }, { op: 'clearLimit', endpoint: 'cloud' }], '{ local: { parallel: 1 } }', ['local']],
    ] as [string, Change[], string, string[]][])('removes %s from a flow-style endpoints map', (_name, changes, kept, endpoints) => {
      const tiers = `models:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n    small: { host: pi, model: google/g, thinking: low }\n    large: { host: pi, model: cloud/c, thinking: high }\n`;
      const text = `endpoints: { local: { parallel: 1 }, google: { parallel: 2 }, old: { parallel: 3 }, cloud: { parallel: 4 } }\n${tiers}${AGENTS}`;
      const root = makeProject(text);
      const preview = previewChanges(root, changes, STARTER);
      expect(preview.refusals).toEqual([]);
      expect(preview.droppedLimits).toEqual(['old']);
      expect(preview.invalid).toBeUndefined();
      expect(preview.text).toBe(`endpoints: ${kept}\n${tiers}${AGENTS}`);
      expect(applyChanges(root, changes, preview.fingerprint, STARTER).written).toBe(true);
      expect([...loadAgentFile(root).limits.keys()]).toEqual(endpoints);
    });

    it('still removes adjacent entries of a block-style map line by line', () => {
      const text = `models:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n\n    # small\n    small: { host: pi, model: local/s, thinking: low }\n\n    large:\n      host: pi\n      model: local/l\n      thinking: high\n${AGENTS}`;
      const root = makeProject(text);
      const changes = unset('small', 'large');
      const preview = previewChanges(root, changes, STARTER);
      expect(preview.text).toBe(`models:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n\n${AGENTS}`);
      expect(applyChanges(root, changes, preview.fingerprint, STARTER).written).toBe(true);
      expect([...loadAgentFile(root).tiers.keys()]).toEqual(['medium']);
    });
  });

  it('covers AE3:moving medium off the only tier on local drops endpoints.local, listed by preview and apply', () => {
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

  it('adds a medium tier to a file without one and adds no agent; without one the change set is refused', () => {
    const text = `# kept\nagents:\n  general:\n    tools: [read]\n    timeout: 5\n`;
    const root = makeProject(text);
    expect(readSetupState(root, {})).toMatchObject({ status: 'ok' });
    expect(previewChanges(root, [], STARTER).refusals).toEqual([{ change: null, message: expect.stringMatching(/medium tier is required/) }]);
    const changes: Change[] = [{ op: 'setTier', tier: 'medium', model: 'local/m', thinking: 'low' }];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.refusals).toEqual([]);
    applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(read(root).startsWith(text)).toBe(true);
    expect(read(root)).not.toContain('fallback');
    expect(loadAgentFile(root).tiers.get('medium')).toEqual({ host: 'pi', model: 'local/m', thinking: 'low' });
  });

  it('previews a file with no fallback as nothing to change: no agent is added', () => {
    const text = `# mine\nmodels:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\nagents:\n  general:\n    tools: [read]\n    timeout: 5\n`;
    const preview = previewChanges(makeProject(text), [], STARTER);
    expect(preview).toMatchObject({ nothingToChange: true, refusals: [], diff: '' });
    expect(preview.text).toBe(text);
  });

  it('reports nothing to change for an empty change set and leaves the modification time alone', () => {
    const root = makeProject(HAND_WRITTEN);
    const past = new Date('2020-01-01T00:00:00Z');
    utimesSync(fileOf(root), past, past);
    const preview = previewChanges(root, [], STARTER);
    expect(preview).toMatchObject({ nothingToChange: true, refusals: [], droppedLimits: [], diff: '' });
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
      let thrown: unknown;
      try {
        applyChanges(root, changes, preview.fingerprint, STARTER);
      } catch (err) {
        thrown = err;
      }
      seam.fail = undefined;
      expect(thrown).toBeInstanceOf(SetupWriteError);
      expect(thrown).toMatchObject({
        code: 'write_failed',
        message: fail === 'write' ? 'could not write .agents/subzero.yaml: ENOSPC (no space left on device)' : 'could not write .agents/subzero.yaml: EIO (i/o error)',
      });
      expect(read(root)).toBe(HAND_WRITTEN);
      expect(lstatSync(fileOf(root)).isFile()).toBe(true);
      expect(otherFiles(root)).toEqual([]);
    }
  });

  it('lets a write that fails with a programming error through as itself, still cleaning up', () => {
    const root = makeProject(HAND_WRITTEN);
    const changes: Change[] = [{ op: 'setTier', tier: 'medium', model: 'local/new', thinking: 'low' }];
    const preview = previewChanges(root, changes, STARTER);
    seam.fail = 'bug';
    expect(() => applyChanges(root, changes, preview.fingerprint, STARTER)).toThrow(TypeError);
    seam.fail = undefined;
    expect(read(root)).toBe(HAND_WRITTEN);
    expect(otherFiles(root)).toEqual([]);
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

/** Points the general file at a path that may not exist yet, until the test ends. */
function generalAt(file: string): string {
  const previous = process.env.SUBZERO_GENERAL_CONFIG;
  process.env.SUBZERO_GENERAL_CONFIG = file;
  onTestFinished(() => {
    if (previous === undefined) delete process.env.SUBZERO_GENERAL_CONFIG;
    else process.env.SUBZERO_GENERAL_CONFIG = previous;
  });
  return file;
}

const GENERAL_FULL = `endpoints:
  local:
    parallel: 2
models:
  tiers:
    medium: { host: pi, model: local/general-medium, thinking: low }
    small: { host: pi, model: local/general-small, thinking: off }
    large: { host: pi, model: cloud/general-large, thinking: high }
`;

const setMedium: Change = { op: 'setTier', tier: 'medium', model: 'local/new-medium', thinking: 'high' };

describe('AgentSetup scopes', () => {
  it('refuses a project-scope preview and apply when the project file is the general file, and still writes it at general scope', () => {
    const root = tempDir('subzero-home-');
    const shared = generalAt(fileOf(root));
    mkdirSync(path.dirname(shared));
    writeFileSync(shared, GENERAL_FULL);
    const project = previewChanges(root, [setMedium], STARTER, 'project');
    expect(project.refusals).toEqual([{ change: null, message: expect.stringMatching(/this project's file is the general file; run guided init with the every-project choice/) }]);
    expect(project.nothingToChange).toBe(true);
    expect(() => applyChanges(root, [setMedium], project.fingerprint, STARTER, 'project')).toThrow(SetupRefusedError);
    expect(readFileSync(shared, 'utf8')).toBe(GENERAL_FULL);

    const general = previewChanges(root, [setMedium], STARTER, 'general');
    expect(general.refusals).toEqual([]);
    expect(applyChanges(root, [setMedium], general.fingerprint, STARTER, 'general').written).toBe(true);
    expect(readFileSync(shared, 'utf8')).toBe(GENERAL_FULL.replace('local/general-medium, thinking: low', 'local/new-medium, thinking: high'));
  });

  it('writes through a symlinked general file, leaving the link in place and the target holding the new text', () => {
    const dir = tempDir('subzero-dotfiles-');
    const target = path.join(dir, 'real.yaml');
    writeFileSync(target, GENERAL_FULL);
    const link = generalAt(path.join(tempDir('subzero-home-'), 'subzero.yaml'));
    symlinkSync(target, link);
    const root = makeProject(HAND_WRITTEN);
    const preview = previewChanges(root, [setMedium], STARTER, 'general');
    expect(applyChanges(root, [setMedium], preview.fingerprint, STARTER, 'general').written).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(GENERAL_FULL.replace('local/general-medium, thinking: low', 'local/new-medium, thinking: high'));
    expect(readdirSync(dir)).toEqual(['real.yaml']);
    expect(readdirSync(path.dirname(link))).toEqual(['subzero.yaml']);
  });

  it('covers AE6: a general-scope change to medium lists that this project keeps its own', () => {
    useGeneralConfig(GENERAL_MEDIUM_YAML);
    const root = makeProject(HAND_WRITTEN);
    const preview = previewChanges(root, [setMedium, { op: 'setTier', tier: 'large', model: 'cloud/l', thinking: 'high' }], STARTER, 'general');
    expect(preview).toMatchObject({ scope: 'general', refusals: [], overridden: { tiers: ['medium'], limits: [] } });
    expect(previewChanges(root, [setMedium], STARTER).overridden).toEqual({ tiers: [], limits: [] });
  });

  it('reports a limit this project overrides, and none for a project that names nothing', () => {
    useGeneralConfig(GENERAL_FULL);
    const change: Change[] = [{ op: 'setLimit', endpoint: 'local', parallel: 5 }];
    expect(previewChanges(makeProject(HAND_WRITTEN), change, STARTER, 'general').overridden).toEqual({ tiers: [], limits: ['local'] });
    const bare = makeProject(`${AGENTS}`);
    expect(previewChanges(bare, [setMedium, ...change], STARTER, 'general').overridden).toEqual({ tiers: [], limits: [] });
  });

  it('creates the general file and its folder from nothing, and a second preview shows nothing to change', () => {
    const file = generalAt(path.join(tempDir(), 'home', '.agents', 'subzero.yaml'));
    const root = tempDir();
    const changes: Change[] = [setMedium, { op: 'setLimit', endpoint: 'local', parallel: 1 }];
    const preview = previewChanges(root, changes, STARTER, 'general');
    expect(preview).toMatchObject({ agentFile: file, fileExists: false, refusals: [], nothingToChange: false });
    expect(preview.diff).toContain('--- /dev/null');
    expect(preview.text).toContain('medium: { host: pi, model: local/new-medium, thinking: high }');
    expect(existsSync(path.dirname(file))).toBe(false);

    expect(applyChanges(root, changes, preview.fingerprint, STARTER, 'general').written).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(preview.text);
    expect(existsSync(fileOf(root))).toBe(false);
    expect(loadAgentFile(root).tiers.get('medium')).toEqual({ host: 'pi', model: 'local/new-medium', thinking: 'high' });
    expect(previewChanges(root, changes, STARTER, 'general')).toMatchObject({ nothingToChange: true, diff: '', fileExists: true });
  });

  it('writes the general file and leaves the project file untouched, and the other way round', () => {
    const general = useGeneralConfig(GENERAL_FULL);
    const root = makeProject(HAND_WRITTEN);
    const change: Change[] = [{ op: 'setTier', tier: 'large', model: 'cloud/other', thinking: 'low' }];

    const g = previewChanges(root, change, STARTER, 'general');
    applyChanges(root, change, g.fingerprint, STARTER, 'general');
    expect(read(root)).toBe(HAND_WRITTEN);
    expect(readFileSync(general, 'utf8')).toBe(GENERAL_FULL.replace('cloud/general-large, thinking: high', 'cloud/other, thinking: low'));

    const generalNow = readFileSync(general, 'utf8');
    const p = previewChanges(root, [setMedium], STARTER);
    applyChanges(root, [setMedium], p.fingerprint, STARTER);
    expect(readFileSync(general, 'utf8')).toBe(generalNow);
    expect(read(root)).toContain('medium: { host: pi, model: local/new-medium, thinking: high }');
  });

  it('previews a project-scope change in a project with no file and a general medium as the changed tier only', () => {
    useGeneralConfig(GENERAL_MEDIUM_YAML);
    const root = tempDir();
    const changes: Change[] = [{ op: 'setTier', tier: 'small', model: 'local/small', thinking: 'low' }];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview).toMatchObject({ fileExists: false, refusals: [] });
    expect(preview.invalid).toBeUndefined();
    expect(preview.text).toBe('models:\n  tiers:\n    small: { host: pi, model: local/small, thinking: low }\n');
    expect(preview.diff).not.toContain('agents:');
    applyChanges(root, changes, preview.fingerprint, STARTER);
    const catalog = loadAgentFile(root);
    expect([...catalog.tiers.keys()]).toEqual(['medium', 'small']);
  });

  it('is nothing to change when the project sets what it inherits', () => {
    useGeneralConfig(GENERAL_FULL);
    const same: Change = { op: 'setTier', tier: 'small', model: 'local/general-small', thinking: 'off' };
    expect(previewChanges(tempDir(), [same], STARTER)).toMatchObject({ nothingToChange: true, diff: '' });
  });

  it('writes a limit and a tier on top of a lone-tier project file with a null removal and agents that use inherited tiers', () => {
    useGeneralConfig(GENERAL_FULL);
    const text = `models:\n  tiers:\n    large:\nagents:\n  helper:\n    description: h\n    tier: small\n    tools: [read]\n    timeout: 5\n`;
    const root = makeProject(text);
    expect(readSetupState(root, { host: 'pi' })).toMatchObject({ status: 'ok' });
    const changes: Change[] = [{ op: 'setLimit', endpoint: 'local', parallel: 4 }];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.refusals).toEqual([]);
    expect(preview.invalid).toBeUndefined();
    expect(preview.text).toBe(`${text}\nendpoints:\n  local:\n    parallel: 4\n`);
    applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(loadAgentFile(root).limits).toEqual(new Map([['local', 4]]));
  });

  it('removes an inherited tier by writing a null entry, and deletes a project-only tier', () => {
    useGeneralConfig(GENERAL_FULL);
    const root = tempDir();
    const preview = previewChanges(root, [{ op: 'unsetTier', tier: 'large' }], STARTER);
    expect(preview.refusals).toEqual([]);
    expect(preview.text).toBe('models:\n  tiers:\n    large:\n');
    expect(preview.diff).toContain('+    large:\n');
    expect(preview.summary).toEqual(['remove tier large']);
    applyChanges(root, [{ op: 'unsetTier', tier: 'large' }], preview.fingerprint, STARTER);
    expect([...loadAgentFile(root).tiers.keys()]).toEqual(['medium', 'small']);

    const own = makeProject(`models:\n  tiers:\n    cloud: { host: pi, model: cloud/c, thinking: low }\n    mine: { host: pi, model: local/x, thinking: low }\n`);
    const gone = previewChanges(own, [{ op: 'unsetTier', tier: 'mine' }], STARTER);
    expect(gone.text).toBe('models:\n  tiers:\n    cloud: { host: pi, model: cloud/c, thinking: low }\n');
    expect(gone.text).not.toContain('mine');
  });

  it('writes a null entry over a project tier that overrides an inherited one, and a tier over a null entry', () => {
    useGeneralConfig(GENERAL_FULL);
    const root = makeProject(`models:\n  tiers:\n    large: { host: pi, model: cloud/own, thinking: low }\n    small:\n`);
    const unset = previewChanges(root, [{ op: 'unsetTier', tier: 'large' }], STARTER);
    expect(unset.text).toBe('models:\n  tiers:\n    small:\n    large:\n');
    const reset = previewChanges(root, [{ op: 'setTier', tier: 'small', model: 'local/back', thinking: 'low' }], STARTER);
    expect(reset.text).toBe('models:\n  tiers:\n    large: { host: pi, model: cloud/own, thinking: low }\n    small: { host: pi, model: local/back, thinking: low }\n');
    applyChanges(root, [{ op: 'setTier', tier: 'small', model: 'local/back', thinking: 'low' }], reset.fingerprint, STARTER);
    expect(loadAgentFile(root).tiers.get('small')).toEqual({ host: 'pi', model: 'local/back', thinking: 'low' });
  });

  it('removes an inherited limit by writing a null entry, and a project-only limit by deleting it', () => {
    useGeneralConfig(GENERAL_FULL);
    const root = tempDir();
    const preview = previewChanges(root, [{ op: 'clearLimit', endpoint: 'local' }], STARTER);
    expect(preview.text).toBe('endpoints:\n  local:\n');
    applyChanges(root, [{ op: 'clearLimit', endpoint: 'local' }], preview.fingerprint, STARTER);
    expect(loadAgentFile(root).limits.size).toBe(0);

    const own = makeProject(`endpoints:\n  cloud:\n    parallel: 3\nmodels:\n  tiers:\n    big: { host: pi, model: cloud/b, thinking: low }\n`);
    expect(previewChanges(own, [{ op: 'clearLimit', endpoint: 'cloud' }], STARTER).text).toBe(
      'models:\n  tiers:\n    big: { host: pi, model: cloud/b, thinking: low }\n',
    );
  });

  it('keeps an inherited limit working when a project tier moves onto its endpoint, and drops it silently when no model uses it', () => {
    useGeneralConfig(`${GENERAL_FULL}  # more\n`.replace('local/general-small', 'cloud/general-small'));
    const root = tempDir();
    // local limit is inherited but only medium uses it; the project moves medium away.
    const away = previewChanges(root, [{ op: 'setTier', tier: 'medium', model: 'cloud/m', thinking: 'low' }], STARTER);
    expect(away).toMatchObject({ refusals: [], droppedLimits: [] });
    expect(away.invalid).toBeUndefined();
    // and back onto an endpoint the general limit covers.
    const moved = makeProject(away.text);
    expect(loadAgentFile(moved).limits.size).toBe(0);
    const comeBack: Change[] = [{ op: 'setTier', tier: 'medium', model: 'local/again', thinking: 'low' }];
    const back = previewChanges(moved, comeBack, STARTER);
    expect(back.invalid).toBeUndefined();
    applyChanges(moved, comeBack, back.fingerprint, STARTER);
    expect(loadAgentFile(moved).limits).toEqual(new Map([['local', 2]]));
  });

  it('refuses a change set with no medium in either layer, and counts the inherited medium otherwise', () => {
    const small: Change = { op: 'setTier', tier: 'small', model: 'local/s', thinking: 'low' };
    expect(previewChanges(tempDir(), [small], STARTER).refusals).toEqual([{ change: null, message: expect.stringMatching(/medium tier is required/) }]);
    useGeneralConfig(GENERAL_MEDIUM_YAML);
    expect(previewChanges(tempDir(), [small], STARTER).refusals).toEqual([]);
    expect(previewChanges(tempDir(), [{ op: 'unsetTier', tier: 'medium' }], STARTER).refusals[0]!.message).toMatch(/medium tier cannot be removed/);
  });

  it('refuses a general change with no medium when the project has none, and lets one through when the project has its own', () => {
    const small: Change = { op: 'setTier', tier: 'small', model: 'local/s', thinking: 'low' };
    generalAt(path.join(tempDir(), 'subzero.yaml'));
    expect(previewChanges(tempDir(), [small], STARTER, 'general').refusals).toEqual([{ change: null, message: expect.stringMatching(/medium tier is required/) }]);
    expect(previewChanges(makeProject(HAND_WRITTEN), [small], STARTER, 'general').refusals).toEqual([]);
  });

  it('refuses apply with a fingerprint from the other scope', () => {
    useGeneralConfig(GENERAL_MEDIUM_YAML);
    const root = makeProject(HAND_WRITTEN);
    const asProject = previewChanges(root, [setMedium], STARTER).fingerprint;
    const asGeneral = previewChanges(root, [setMedium], STARTER, 'general').fingerprint;
    expect(asProject).not.toBe(asGeneral);
    expect(() => applyChanges(root, [setMedium], asProject, STARTER, 'general')).toThrow(SetupConflictError);
    expect(() => applyChanges(root, [setMedium], asGeneral, STARTER)).toThrow(SetupConflictError);
    expect(read(root)).toBe(HAND_WRITTEN);
  });

  it('refuses apply when the general file changed since a project-scope preview', () => {
    const general = useGeneralConfig(GENERAL_MEDIUM_YAML);
    const root = tempDir();
    const change: Change[] = [{ op: 'setTier', tier: 'small', model: 'local/s', thinking: 'low' }];
    const { fingerprint } = previewChanges(root, change, STARTER);
    writeFileSync(general, GENERAL_FULL);
    expect(() => applyChanges(root, change, fingerprint, STARTER)).toThrow(SetupConflictError);
  });

  it('names the general path when the file system refuses a write there, leaving the file untouched', () => {
    const general = useGeneralConfig(GENERAL_MEDIUM_YAML);
    const root = tempDir();
    const preview = previewChanges(root, [setMedium], STARTER, 'general');
    seam.fail = 'rename';
    let thrown: unknown;
    try {
      applyChanges(root, [setMedium], preview.fingerprint, STARTER, 'general');
    } catch (err) {
      thrown = err;
    }
    seam.fail = undefined;
    expect(thrown).toBeInstanceOf(SetupWriteError);
    expect(thrown).toMatchObject({ code: 'write_failed', message: `could not write ${general}: EIO (i/o error)` });
    expect(readFileSync(general, 'utf8')).toBe(GENERAL_MEDIUM_YAML);
    expect(readdirSync(path.dirname(general))).toEqual(['subzero.yaml']);
  });

  it('refuses a general-scope unset of a tier a project agent uses, and leaves the file alone', () => {
    const general = useGeneralConfig(GENERAL_FULL);
    const project = `agents:\n  helper:\n    description: h\n    tier: large\n    tools: [read]\n    timeout: 5\n  reviewer:\n    description: r\n    tiers:\n      large: { model: cloud/r }\n    tools: [read]\n    timeout: 5\n`;
    const root = makeProject(project);
    const unset: Change[] = [{ op: 'unsetTier', tier: 'large' }];
    const preview = previewChanges(root, unset, STARTER, 'general');
    expect(preview.refusals).toEqual([
      { change: unset[0], agents: ['helper', 'reviewer'], message: expect.stringMatching(/tier "large" cannot be removed: helper, reviewer use it/) },
    ]);
    expect(() => applyChanges(root, unset, preview.fingerprint, STARTER, 'general')).toThrow(SetupRefusedError);
    expect(readFileSync(general, 'utf8')).toBe(GENERAL_FULL);

    const ok = previewChanges(root, [{ op: 'setTier', tier: 'large', model: 'cloud/x', thinking: 'low' }, { op: 'unsetTier', tier: 'small' }], STARTER, 'general');
    expect(ok.refusals).toEqual([]);
    expect(ok.invalid).toBeUndefined();
  });

  it('does not refuse a general-scope unset of a tier the project defines or removes itself', () => {
    useGeneralConfig(GENERAL_FULL);
    const own = makeProject(`models:\n  tiers:\n    large: { host: pi, model: cloud/own, thinking: low }\nagents:\n  helper:\n    description: h\n    tier: large\n    tools: [read]\n    timeout: 5\n`);
    const preview = previewChanges(own, [{ op: 'unsetTier', tier: 'large' }], STARTER, 'general');
    expect(preview.refusals).toEqual([]);
    expect(preview.invalid).toBeUndefined();
    expect(preview.overridden).toEqual({ tiers: ['large'], limits: [] });
    expect(preview.text).not.toContain('large');
  });

  it('ignores a project that switches itself off, in the general scope', () => {
    useGeneralConfig(GENERAL_FULL);
    const root = makeProject('enabled: false\n');
    const preview = previewChanges(root, [{ op: 'unsetTier', tier: 'large' }], STARTER, 'general');
    expect(preview.refusals).toEqual([]);
    expect(preview.overridden).toEqual({ tiers: [], limits: [] });
    expect(readSetupState(root, { scope: 'general' })).toMatchObject({ status: 'ok' });
    expect(readSetupState(root)).toMatchObject({ status: 'refused', error: expect.stringMatching(/enabled: false/) });
  });

  it('refuses a broken general file in either scope, naming it', () => {
    const general = useGeneralConfig('agents: {}\n');
    for (const scope of ['general', 'project'] as const) {
      const state = readSetupState(tempDir(), { scope });
      expect(state).toMatchObject({ status: 'refused', error: expect.stringContaining(general) });
      expect(() => previewChanges(tempDir(), [setMedium], STARTER, scope)).toThrow(LoadError);
    }
  });

  it('refuses a general-scope change that would leave this project own limit unused, and writes nothing', () => {
    const general = useGeneralConfig(GENERAL_MEDIUM_YAML);
    const root = makeProject('endpoints:\n  local:\n    parallel: 1\n');
    expect(loadAgentFile(root).limits).toEqual(new Map([['local', 1]]));
    const move: Change[] = [{ op: 'setTier', tier: 'medium', model: 'cloud/m', thinking: 'low' }];
    const preview = previewChanges(root, move, STARTER, 'general');
    expect(preview.invalid).toMatch(/endpoint "local": no model of a tier or of a tier override belongs to it/);
    expect(preview.invalid).toContain(fileOf(root));
    expect(() => applyChanges(root, move, preview.fingerprint, STARTER, 'general')).toThrow(LoadError);
    expect(readFileSync(general, 'utf8')).toBe(GENERAL_MEDIUM_YAML);
    expect(read(root)).toBe('endpoints:\n  local:\n    parallel: 1\n');
    expect(loadAgentFile(root).limits).toEqual(new Map([['local', 1]]));
  });

  it('does not newly refuse a general-scope change for a project that already had an unused own limit', () => {
    const general = useGeneralConfig(GENERAL_MEDIUM_YAML);
    const text = 'endpoints:\n  cloud:\n    parallel: 1\n';
    const root = makeProject(text);
    expect(() => loadAgentFile(root)).toThrow(LoadError);
    const change: Change[] = [{ op: 'setTier', tier: 'medium', model: 'local/new-medium', thinking: 'high' }];
    const preview = previewChanges(root, change, STARTER, 'general');
    expect(preview.invalid).toBeUndefined();
    expect(preview.refusals).toEqual([]);
    expect(applyChanges(root, change, preview.fingerprint, STARTER, 'general').written).toBe(true);
    expect(readFileSync(general, 'utf8')).toContain('local/new-medium');
    expect(read(root)).toBe(text);
  });

  it('removes the whole tiers section, and an empty models, when the last block-style tier of a project that inherits medium goes', () => {
    useGeneralConfig(GENERAL_MEDIUM_YAML);
    const tail = 'routing:\n  hook: true\n';
    const root = makeProject(`${tail}models:\n  tiers:\n    small:\n      host: pi\n      model: local/s\n      thinking: low\n`);
    const unset: Change[] = [{ op: 'unsetTier', tier: 'small' }];
    const preview = previewChanges(root, unset, STARTER);
    expect(preview.refusals).toEqual([]);
    expect(preview.invalid).toBeUndefined();
    expect(preview.text).toBe(tail);
    applyChanges(root, unset, preview.fingerprint, STARTER);
    expect([...loadAgentFile(root).tiers.keys()]).toEqual(['medium']);
    expect(previewChanges(root, unset, STARTER).refusals[0]!.message).toMatch(/not configured/);

    // Another key of models stays; only the emptied tiers map goes.
    const other = makeProject(`models:\n  note: x\n  tiers:\n    small:\n      host: pi\n      model: local/s\n      thinking: low\nrouting:\n  hook: true\n`);
    expect(previewChanges(other, unset, STARTER).text).toBe('models:\n  note: x\nrouting:\n  hook: true\n');
  });

  it('keeps the tiers map when a removal entry for an inherited tier takes the place of the last own tier', () => {
    useGeneralConfig(GENERAL_FULL);
    const root = makeProject('models:\n  tiers:\n    small:\n      host: pi\n      model: local/s\n      thinking: low\n');
    const unset: Change[] = [{ op: 'unsetTier', tier: 'small' }];
    const preview = previewChanges(root, unset, STARTER);
    expect(preview.invalid).toBeUndefined();
    expect(preview.text).toBe('models:\n  tiers:\n    small:\n');
    applyChanges(root, unset, preview.fingerprint, STARTER);
    expect([...loadAgentFile(root).tiers.keys()]).toEqual(['medium', 'large']);
  });

  it('removes the whole endpoints section when the last block-style limit goes, so the file loads', () => {
    useGeneralConfig(GENERAL_MEDIUM_YAML);
    const root = makeProject('endpoints:\n  local:\n    parallel: 1\nrouting:\n  hook: true\n');
    const clear: Change[] = [{ op: 'clearLimit', endpoint: 'local' }];
    const preview = previewChanges(root, clear, STARTER);
    expect(preview.invalid).toBeUndefined();
    expect(preview.text).toBe('routing:\n  hook: true\n');
    applyChanges(root, clear, preview.fingerprint, STARTER);
    expect(loadAgentFile(root).limits.size).toBe(0);
  });

  it('still removes a last tier or limit from flow-style maps, and one of several', () => {
    useGeneralConfig(GENERAL_MEDIUM_YAML);
    const unsetSmall: Change[] = [{ op: 'unsetTier', tier: 'small' }];
    const clearLocal: Change[] = [{ op: 'clearLimit', endpoint: 'local' }];
    for (const [text, changes] of [
      ['models: { tiers: { small: { host: pi, model: local/s, thinking: low } } }\nrouting: { hook: true }\n', unsetSmall],
      ['models:\n  tiers: { small: { host: pi, model: local/s, thinking: low } }\nrouting: { hook: true }\n', unsetSmall],
      ['models:\n  tiers:\n    small: { host: pi, model: local/s, thinking: low }\nrouting: { hook: true }\n', unsetSmall],
      ['endpoints: { local: { parallel: 1 } }\nrouting: { hook: true }\n', clearLocal],
    ] as const) {
      const root = makeProject(text);
      const preview = previewChanges(root, changes, STARTER);
      expect(preview.invalid, text).toBeUndefined();
      expect(preview.text, text).toBe('routing: { hook: true }\n');
      applyChanges(root, changes, preview.fingerprint, STARTER);
      const catalog = loadAgentFile(root);
      expect([...catalog.tiers.keys()]).toEqual(['medium']);
      expect(catalog.limits.size).toBe(0);
    }
    const two = makeProject('models:\n  tiers: { small: { host: pi, model: local/s, thinking: low }, large: { host: pi, model: cloud/l, thinking: low } }\n');
    expect(previewChanges(two, unsetSmall, STARTER).text).toBe('models:\n  tiers: { large: { host: pi, model: cloud/l, thinking: low } }\n');
  });

  it('removes the whole general tiers section when the last general tier goes and the project has its own medium', () => {
    const general = useGeneralConfig('models:\n  tiers:\n    small:\n      host: pi\n      model: local/s\n      thinking: low\n');
    const root = makeProject('models:\n  tiers:\n    medium: { host: pi, model: local/own, thinking: low }\n');
    const unset: Change[] = [{ op: 'unsetTier', tier: 'small' }];
    const preview = previewChanges(root, unset, STARTER, 'general');
    expect(preview.refusals).toEqual([]);
    expect(preview.invalid).toBeUndefined();
    expect(preview.text).toBe('');
    applyChanges(root, unset, preview.fingerprint, STARTER, 'general');
    expect(readFileSync(general, 'utf8')).toBe('');
    expect([...loadAgentFile(root).tiers.keys()]).toEqual(['medium']);
  });

  it('marks each tier and limit as general or project, and names what this project overrides', () => {
    useGeneralConfig(GENERAL_FULL);
    const root = makeProject(`endpoints:\n  local:\n    parallel: 1\nmodels:\n  tiers:\n    medium: { host: pi, model: local/own, thinking: high }\n    mine: { host: pi, model: local/mine, thinking: low }\n    large:\n`);
    const state = readSetupState(root, { host: 'pi' });
    if (state.status !== 'ok') throw new Error(`unexpected ${state.status}`);
    expect(state.tiers.map((t) => [t.tier, t.source, t.model])).toEqual([
      ['medium', 'project', 'local/own'],
      ['small', 'general', 'local/general-small'],
      ['mine', 'project', 'local/mine'],
    ]);
    expect(state.limits).toEqual([
      { endpoint: 'local', parallel: 1, tiers: ['medium', 'small', 'mine'], overrideOnly: false, unused: false, source: 'project', general: { parallel: 2 } },
    ]);
    expect(state.overridden).toEqual({ tiers: ['medium', 'large'], limits: ['local'] });
    // The general file's own value rides on an overridden entry only: not on a general tier, nor on a project-only one.
    expect(state.tiers.map((t) => [t.tier, t.general])).toEqual([
      ['medium', { host: 'pi', model: 'local/general-medium', thinking: 'low' }],
      ['small', undefined],
      ['mine', undefined],
    ]);
    expect(state.tiers.filter((t) => t.source === 'general').every((t) => !('general' in t))).toBe(true);

    const inheritedOnly = readSetupState(tempDir(), { host: 'pi' });
    if (inheritedOnly.status !== 'no-file') throw new Error(`unexpected ${inheritedOnly.status}`);
    expect(inheritedOnly.tiers.every((t) => t.source === 'general')).toBe(true);
    expect(inheritedOnly.limits.map((l) => l.source)).toEqual(['general']);
    expect(inheritedOnly.fileFingerprint).toBeNull();
    expect(inheritedOnly.tiers.some((t) => 'general' in t)).toBe(false);
    expect(inheritedOnly.limits.some((l) => 'general' in l)).toBe(false);
  });

  it('reads the general file in the general scope, with the dependents from this project', () => {
    const general = useGeneralConfig(GENERAL_FULL);
    const root = makeProject(`agents:\n  helper:\n    description: h\n    tier: large\n    tools: [read]\n    timeout: 5\n`);
    const state = readSetupState(root, { scope: 'general' });
    if (state.status !== 'ok') throw new Error(`unexpected ${state.status}`);
    expect(state.agentFile).toBe(general);
    expect(state.tiers.map((t) => [t.tier, t.source, t.dependents])).toEqual([
      ['medium', 'general', []],
      ['small', 'general', []],
      ['large', 'general', ['helper']],
    ]);
    expect(state.limits).toEqual([{ endpoint: 'local', parallel: 2, tiers: ['medium', 'small'], overrideOnly: false, unused: false, source: 'general' }]);
  });

  it('carries no general value in the general scope, where the listed values are the general file\'s own', () => {
    useGeneralConfig(GENERAL_FULL);
    const root = makeProject(`endpoints:\n  local:\n    parallel: 1\nmodels:\n  tiers:\n    medium: { host: pi, model: local/own, thinking: high }\n`);
    const state = readSetupState(root, { scope: 'general' });
    if (state.status !== 'ok') throw new Error(`unexpected ${state.status}`);
    expect(state.tiers.find((t) => t.tier === 'medium')).toMatchObject({ model: 'local/general-medium', source: 'general' });
    expect(state.tiers.some((t) => 'general' in t)).toBe(false);
    expect(state.limits.some((l) => 'general' in l)).toBe(false);
  });

  it('carries the general value of an overridden tier that the general file holds, and omits it for a tier only this project holds', () => {
    useGeneralConfig(GENERAL_FULL);
    const root = makeProject(`models:\n  tiers:\n    small: { host: pi, model: cloud/own-small, thinking: low }\n    extra: { host: pi, model: cloud/e, thinking: low }\n`);
    const state = readSetupState(root, { host: 'pi' });
    if (state.status !== 'ok') throw new Error(`unexpected ${state.status}`);
    expect(state.tiers.find((t) => t.tier === 'small')).toMatchObject({ model: 'cloud/own-small', source: 'project', general: { host: 'pi', model: 'local/general-small', thinking: 'off' } });
    expect(state.tiers.find((t) => t.tier === 'extra')).not.toHaveProperty('general');
    expect(state.tiers.find((t) => t.tier === 'medium')).not.toHaveProperty('general');
  });
});

describe('addStarterEntries on top of layered files', () => {
  it('parses a file guided init wrote (a lone tier, a null removal) as layers and adds the starter entries', () => {
    useGeneralConfig(GENERAL_FULL);
    const text = `models:\n  tiers:\n    large:\nagents:\n  helper:\n    description: h\n    tier: small\n    tools: [read]\n    timeout: 5\n`;
    const root = makeProject(text);
    const result = addStarterEntries(root, { host: 'pi', model: 'local/m', thinking: 'low', timeout: 100, generalTools: ['read'], fallbackTools: ['read'] });
    expect(result.added).toEqual(['medium', 'general', 'fallback']);
    expect(read(root).startsWith(text.slice(0, text.indexOf('agents:')))).toBe(true);
    expect(loadCatalog(root).entries.has('fallback')).toBe(true);
  });
});
