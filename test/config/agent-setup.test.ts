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
import { GLOBAL_MEDIUM_YAML, makeProject, tempDir, useGlobalConfig } from '../helpers.js';

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

/** A hand-written file: comments, skills, routing, a model limit and a named agent. */
const HAND_WRITTEN = `# Project agents. Edit with care.
skills:
  facts: ./skills/alpha   # the facts skill

routing:
  hook: true
  generic_agents: [Explore]

models:
  parallel:
    # the GPU box
    local/qwen3-4b: 1
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
      expect(() => normalizeChangeSet([{ op: 'setLimit', model: 'local/qwen', parallel: parallel as number }])).toThrow(ChangeSetError);
      expect(() => previewChanges(tempDir(), [{ op: 'setLimit', model: 'local/qwen', parallel: parallel as number }], STARTER)).toThrow(
        /parallel|positive whole number/,
      );
    }
    expect(normalizeChangeSet([{ op: 'setLimit', model: 'local/qwen', parallel: 3 }])).toEqual([{ op: 'setLimit', model: 'local/qwen', parallel: 3 }]);
  });

  it('rejects an unknown thinking level, an empty model or name, an unknown op and two changes to one tier or model', () => {
    const bad: unknown[] = [
      [{ op: 'setTier', tier: 'medium', model: 'local/m', thinking: 'extreme' }],
      [{ op: 'setTier', tier: 'medium', model: '', thinking: 'low' }],
      [{ op: 'setTier', tier: '', model: 'local/m', thinking: 'low' }],
      [{ op: 'rename', tier: 'medium' }],
      [{ op: 'setTier', tier: 'small', model: 'local/m', thinking: 'low' }, { op: 'unsetTier', tier: 'small' }],
      [{ op: 'setLimit', model: 'local/qwen', parallel: 1 }, { op: 'clearLimit', model: 'local/qwen' }],
    ];
    for (const changes of bad) expect(() => normalizeChangeSet(changes as Change[])).toThrow(ChangeSetError);
  });

  it('normalizes the order of a change set, so the same changes give the same fingerprint', () => {
    const root = makeProject(HAND_WRITTEN);
    const a: Change[] = [
      { op: 'setLimit', model: 'local/qwen', parallel: 2 },
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
      { tier: 'medium', host: 'pi', model: 'local/qwen3-coder-30b', thinking: 'high', dependents: [], otherHost: false, listed: null, source: 'project' },
      { tier: 'small', host: 'pi', model: 'local/qwen3-4b', thinking: 'low', dependents: ['general', 'file-facts'], otherHost: false, listed: null, source: 'project' },
    ]);
    expect(state.limits).toEqual([{ model: 'local/qwen3-4b', parallel: 1, tiers: ['small'], overrideOnly: false, unused: false, source: 'project' }]);
    expect(state.overrideOnlyModels).toEqual([]);
    expect(state.endpoints).toEqual([]);
    expect(state.overridden).toEqual({ tiers: [], limits: [] });
  });

  it('marks a model that only an override names, and keeps its limit through a change', () => {
    const text = `models:
  parallel:
    local/m: 2
    cloud/reviewer: 4
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
    expect(state.overrideOnlyModels).toEqual(['cloud/reviewer']);
    expect(state.limits).toContainEqual({ model: 'cloud/reviewer', parallel: 4, tiers: [], overrideOnly: true, unused: false, source: 'project' });

    const preview = previewChanges(root, [{ op: 'setTier', tier: 'medium', model: 'google/g', thinking: 'low' }], STARTER);
    expect(preview.droppedLimits).toEqual(['local/m']);
    expect(loadAgentFile(makeProject(preview.text)).limits).toEqual(new Map([['cloud/reviewer', 4]]));
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
      makeProject(`models:\n  parallel:\n    old/m: 1\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n${AGENTS}`),
      {},
    );
    expect(unused).toMatchObject({ status: 'repairable' });
    if (unused.status !== 'repairable') throw new Error('unexpected');
    expect(unused.limits).toEqual([{ model: 'old/m', parallel: 1, tiers: [], overrideOnly: false, unused: true, source: 'project' }]);
    expect(unused.problem).toMatch(/model "old\/m": no tier or tier override uses it/);
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
      { op: 'setLimit', model: 'local/qwen3-coder-30b', parallel: 2 },
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
    expect(catalog.limits).toEqual(new Map([['local/qwen3-coder-30b', 2]]));
    expect(preview.text).toContain('  parallel:\n    local/qwen3-coder-30b: 2\n');
    expect(preview.text).not.toContain('endpoints');
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
      { op: 'setLimit', model: 'local/qwen3-4b', parallel: 3 },
    ];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.refusals).toHaveLength(1);
    expect(preview.refusals[0]).toMatchObject({ change: { op: 'unsetTier', tier: 'small' }, agents: ['file-facts'] });
    expect(preview.refusals[0]!.message).toMatch(/file-facts/);
    expect(preview.text).toContain('small: { host: pi, model: local/qwen3-4b, thinking: low }');
    expect(preview.text).toContain('medium: { host: pi, model: local/other, thinking: low }');
    expect(preview.text).toContain('    local/qwen3-4b: 3\n');
    expect(() => applyChanges(root, changes, preview.fingerprint, STARTER)).toThrow(SetupRefusedError);
    expect(() => applyChanges(root, changes, preview.fingerprint, STARTER)).toThrow(/file-facts/);
    expect(read(root)).toBe(HAND_WRITTEN);
    expect(otherFiles(root)).toEqual([]);

    const rest = changes.slice(1);
    const again = previewChanges(root, rest, STARTER);
    expect(again.refusals).toEqual([]);
    expect(applyChanges(root, rest, again.fingerprint, STARTER).written).toBe(true);
    expect(loadAgentFile(root).limits.get('local/qwen3-4b')).toBe(3);
  });

  it('names every agent on a tier, through tier: and through a tiers.<t> override', () => {
    const text = HAND_WRITTEN + `  reviewer:\n    description: r\n    tiers:\n      small: { model: local/r }\n    tools: [read]\n    timeout: 5\n`;
    const preview = previewChanges(makeProject(text), [{ op: 'unsetTier', tier: 'small' }], STARTER);
    expect(preview.refusals).toEqual([{ change: { op: 'unsetTier', tier: 'small' }, agents: ['file-facts', 'reviewer'], message: expect.stringMatching(/file-facts.*reviewer/) }]);
  });

  it('refuses unsetting medium, unsetting an unknown tier, and a limit on a model no tier uses', () => {
    const preview = previewChanges(
      makeProject(HAND_WRITTEN),
      [
        { op: 'unsetTier', tier: 'medium' },
        { op: 'unsetTier', tier: 'huge' },
        { op: 'setLimit', model: 'nowhere', parallel: 1 },
      ],
      STARTER,
    );
    expect(preview.refusals.map((r) => r.change)).toEqual([
      { op: 'unsetTier', tier: 'medium' },
      { op: 'unsetTier', tier: 'huge' },
      { op: 'setLimit', model: 'nowhere', parallel: 1 },
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
      ['a cleared limit and the orphaned limit after it', [{ op: 'clearLimit', model: 'google/g' }], '{ local/m: 1, cloud/c: 4 }', ['local/m', 'cloud/c']],
      ['the orphaned limit and a cleared last limit', [{ op: 'clearLimit', model: 'cloud/c' }], '{ local/m: 1, google/g: 2 }', ['local/m', 'google/g']],
      ['three limits after the first', [{ op: 'clearLimit', model: 'google/g' }, { op: 'clearLimit', model: 'cloud/c' }], '{ local/m: 1 }', ['local/m']],
    ] as [string, Change[], string, string[]][])('removes %s from a flow-style models.parallel map', (_name, changes, kept, models) => {
      const tiers = `    medium: { host: pi, model: local/m, thinking: low }\n    small: { host: pi, model: google/g, thinking: low }\n    large: { host: pi, model: cloud/c, thinking: high }\n`;
      const text = `models:\n  parallel: { local/m: 1, google/g: 2, old/x: 3, cloud/c: 4 }\n  tiers:\n${tiers}${AGENTS}`;
      const root = makeProject(text);
      const preview = previewChanges(root, changes, STARTER);
      expect(preview.refusals).toEqual([]);
      expect(preview.droppedLimits).toEqual(['old/x']);
      expect(preview.invalid).toBeUndefined();
      expect(preview.text).toBe(`models:\n  parallel: ${kept}\n  tiers:\n${tiers}${AGENTS}`);
      expect(applyChanges(root, changes, preview.fingerprint, STARTER).written).toBe(true);
      expect([...loadAgentFile(root).limits.keys()]).toEqual(models);
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

  it('covers AE3: moving medium off the only tier on a model drops its limit, listed by preview and apply', () => {
    const text = `models:
  parallel:
    local/qwen: 1
    google/gemini-3.1-pro-preview: 2
  tiers:
    medium: { host: pi, model: local/qwen, thinking: high }
    large: { host: pi, model: google/gemini-3.1-pro-preview, thinking: high }
${AGENTS}`;
    const root = makeProject(text);
    const changes: Change[] = [{ op: 'setTier', tier: 'medium', model: 'google/gemini-3-flash', thinking: 'low' }];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.droppedLimits).toEqual(['local/qwen']);
    expect(preview.summary.join('\n')).toMatch(/local\/qwen/);
    expect(preview.text).not.toContain('local/qwen:');
    const result = applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(result.droppedLimits).toEqual(['local/qwen']);
    expect(loadAgentFile(root).limits).toEqual(new Map([['google/gemini-3.1-pro-preview', 2]]));
  });

  it('keeps the limit of a model that another tier still names when one tier moves away', () => {
    const text = `models:\n  parallel:\n    local/qwen: 1\n  tiers:\n    medium: { host: pi, model: local/qwen, thinking: high }\n    small: { host: pi, model: local/qwen, thinking: low }\n${AGENTS}`;
    const root = makeProject(text);
    const preview = previewChanges(root, [{ op: 'setTier', tier: 'small', model: 'google/g', thinking: 'low' }], STARTER);
    expect(preview.droppedLimits).toEqual([]);
    expect(preview.invalid).toBeUndefined();
  });

  it('drops an unused limit in a repairable file', () => {
    const root = makeProject(`models:\n  parallel:\n    old/m: 1\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n${AGENTS}`);
    const preview = previewChanges(root, [], STARTER);
    expect(preview).toMatchObject({ droppedLimits: ['old/m'], nothingToChange: false, refusals: [] });
    applyChanges(root, [], preview.fingerprint, STARTER);
    expect(read(root)).toBe(`models:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n${AGENTS}`);
  });

  it('removes the parallel map, with its attached comment, when the only limit is cleared', () => {
    const root = makeProject(HAND_WRITTEN);
    const changes: Change[] = [{ op: 'clearLimit', model: 'local/qwen3-4b' }];
    const preview = previewChanges(root, changes, STARTER);
    applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(read(root)).toBe(HAND_WRITTEN.replace('  parallel:\n    # the GPU box\n    local/qwen3-4b: 1\n', ''));
    expect(loadAgentFile(root).limits.size).toBe(0);
  });

  it('clears one limit of several, keeping the others, and treats clearing an absent limit as no change', () => {
    const text = `models:\n  parallel:\n    local/m: 1\n    google/g: 2\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n    large: { host: pi, model: google/g, thinking: low }\n${AGENTS}`;
    const root = makeProject(text);
    const preview = previewChanges(root, [{ op: 'clearLimit', model: 'google/g' }, { op: 'clearLimit', model: 'other' }], STARTER);
    expect(preview.refusals).toEqual([]);
    expect(preview.text).toBe(text.replace('    google/g: 2\n', ''));
  });

  it('adds a limit to an existing models.parallel map and creates the map when there is none, next to the tiers or alone', () => {
    const text = `models:\n  parallel:\n    local/m: 1\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n    large: { host: pi, model: google/g, thinking: low }\n${AGENTS}`;
    const root = makeProject(text);
    const changes: Change[] = [{ op: 'setLimit', model: 'google/g', parallel: 5 }];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.text).toBe(text.replace('    local/m: 1\n', '    local/m: 1\n    google/g: 5\n'));
    applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(loadAgentFile(root).limits).toEqual(new Map([['local/m', 1], ['google/g', 5]]));

    const bare = makeProject(`models:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n${AGENTS}`);
    const set: Change[] = [{ op: 'setLimit', model: 'local/m', parallel: 2 }];
    const created = previewChanges(bare, set, STARTER);
    expect(created.text).toBe(`models:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n  parallel:\n    local/m: 2\n${AGENTS}`);
    applyChanges(bare, set, created.fingerprint, STARTER);
    expect(loadAgentFile(bare).limits).toEqual(new Map([['local/m', 2]]));

    // A file with no models section gets one holding the tiers and the limit together, never two models keys.
    const none = makeProject(AGENTS);
    const both: Change[] = [
      { op: 'setTier', tier: 'medium', model: 'local/m', thinking: 'low' },
      { op: 'setLimit', model: 'local/m', parallel: 2 },
    ];
    const whole = previewChanges(none, both, STARTER);
    expect(whole.text).toBe(`${AGENTS}\nmodels:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n  parallel:\n    local/m: 2\n`);
    applyChanges(none, both, whole.fingerprint, STARTER);
    expect(loadAgentFile(none).limits).toEqual(new Map([['local/m', 2]]));
  });

  it('writes a model id with a colon and a slash as a limit key and reads it back', () => {
    const root = makeProject(`models:\n  tiers:\n    medium: { host: pi, model: local/qwen-coder:30b, thinking: low }\n${AGENTS}`);
    const changes: Change[] = [{ op: 'setLimit', model: 'local/qwen-coder:30b', parallel: 2 }];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.invalid).toBeUndefined();
    applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(loadAgentFile(root).limits).toEqual(new Map([['local/qwen-coder:30b', 2]]));
  });

  it('replaces the only limit with a limit on another model', () => {
    const text = `models:\n  parallel:   # limits\n    local/m: 1\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n    large: { host: pi, model: google/g, thinking: low }\n${AGENTS}`;
    const root = makeProject(text);
    const changes: Change[] = [
      { op: 'clearLimit', model: 'local/m' },
      { op: 'setLimit', model: 'google/g', parallel: 2 },
    ];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.invalid).toBeUndefined();
    applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(loadAgentFile(root).limits).toEqual(new Map([['google/g', 2]]));
    expect(read(root)).not.toContain('# limits');
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

/** Points the global file at a path that may not exist yet, until the test ends. */
function globalAt(file: string): string {
  const previous = process.env.SUBZERO_GLOBAL_CONFIG;
  process.env.SUBZERO_GLOBAL_CONFIG = file;
  onTestFinished(() => {
    if (previous === undefined) delete process.env.SUBZERO_GLOBAL_CONFIG;
    else process.env.SUBZERO_GLOBAL_CONFIG = previous;
  });
  return file;
}

const GLOBAL_FULL = `models:
  parallel:
    local/global-small: 2
  tiers:
    medium: { host: pi, model: local/global-medium, thinking: low }
    small: { host: pi, model: local/global-small, thinking: off }
    large: { host: pi, model: cloud/global-large, thinking: high }
`;

const setMedium: Change = { op: 'setTier', tier: 'medium', model: 'local/new-medium', thinking: 'high' };

describe('AgentSetup scopes', () => {
  it('refuses a project-scope preview and apply when the project file is the global file, and still writes it at global scope', () => {
    const root = tempDir('subzero-home-');
    const shared = globalAt(fileOf(root));
    mkdirSync(path.dirname(shared));
    writeFileSync(shared, GLOBAL_FULL);
    const project = previewChanges(root, [setMedium], STARTER, 'project');
    expect(project.refusals).toEqual([{ change: null, message: expect.stringMatching(/this project's file is the global file; run guided init with the every-project choice/) }]);
    expect(project.nothingToChange).toBe(true);
    expect(() => applyChanges(root, [setMedium], project.fingerprint, STARTER, 'project')).toThrow(SetupRefusedError);
    expect(readFileSync(shared, 'utf8')).toBe(GLOBAL_FULL);

    const global = previewChanges(root, [setMedium], STARTER, 'global');
    expect(global.refusals).toEqual([]);
    expect(applyChanges(root, [setMedium], global.fingerprint, STARTER, 'global').written).toBe(true);
    expect(readFileSync(shared, 'utf8')).toBe(GLOBAL_FULL.replace('local/global-medium, thinking: low', 'local/new-medium, thinking: high'));
  });

  it('writes through a symlinked global file, leaving the link in place and the target holding the new text', () => {
    const dir = tempDir('subzero-dotfiles-');
    const target = path.join(dir, 'real.yaml');
    writeFileSync(target, GLOBAL_FULL);
    const link = globalAt(path.join(tempDir('subzero-home-'), 'subzero.yaml'));
    symlinkSync(target, link);
    const root = makeProject(HAND_WRITTEN);
    const preview = previewChanges(root, [setMedium], STARTER, 'global');
    expect(applyChanges(root, [setMedium], preview.fingerprint, STARTER, 'global').written).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(GLOBAL_FULL.replace('local/global-medium, thinking: low', 'local/new-medium, thinking: high'));
    expect(readdirSync(dir)).toEqual(['real.yaml']);
    expect(readdirSync(path.dirname(link))).toEqual(['subzero.yaml']);
  });

  it('covers AE6: a global-scope change to medium lists that this project keeps its own', () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const root = makeProject(HAND_WRITTEN);
    const preview = previewChanges(root, [setMedium, { op: 'setTier', tier: 'large', model: 'cloud/l', thinking: 'high' }], STARTER, 'global');
    expect(preview).toMatchObject({ scope: 'global', refusals: [], overridden: { tiers: ['medium'], limits: [] } });
    expect(previewChanges(root, [setMedium], STARTER).overridden).toEqual({ tiers: [], limits: [] });
  });

  it('reports a limit this project overrides, and none for a project that names nothing', () => {
    useGlobalConfig(GLOBAL_FULL);
    const change: Change[] = [{ op: 'setLimit', model: 'local/global-small', parallel: 5 }];
    const overriding = makeProject(HAND_WRITTEN.replace('local/qwen3-4b: 1', 'local/global-small: 1'));
    expect(previewChanges(overriding, change, STARTER, 'global').overridden).toEqual({ tiers: [], limits: ['local/global-small'] });
    const bare = makeProject(`${AGENTS}`);
    expect(previewChanges(bare, [setMedium, ...change], STARTER, 'global').overridden).toEqual({ tiers: [], limits: [] });
  });

  it('creates the global file and its folder from nothing, and a second preview shows nothing to change', () => {
    const file = globalAt(path.join(tempDir(), 'home', '.agents', 'subzero.yaml'));
    const root = tempDir();
    const changes: Change[] = [setMedium, { op: 'setLimit', model: 'local/new-medium', parallel: 1 }];
    const preview = previewChanges(root, changes, STARTER, 'global');
    expect(preview).toMatchObject({ agentFile: file, fileExists: false, refusals: [], nothingToChange: false });
    expect(preview.diff).toContain('--- /dev/null');
    expect(preview.text).toContain('medium: { host: pi, model: local/new-medium, thinking: high }');
    expect(existsSync(path.dirname(file))).toBe(false);

    expect(applyChanges(root, changes, preview.fingerprint, STARTER, 'global').written).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(preview.text);
    expect(existsSync(fileOf(root))).toBe(false);
    expect(loadAgentFile(root).tiers.get('medium')).toEqual({ host: 'pi', model: 'local/new-medium', thinking: 'high' });
    expect(previewChanges(root, changes, STARTER, 'global')).toMatchObject({ nothingToChange: true, diff: '', fileExists: true });
  });

  it('writes the global file and leaves the project file untouched, and the other way round', () => {
    const global = useGlobalConfig(GLOBAL_FULL);
    const root = makeProject(HAND_WRITTEN);
    const change: Change[] = [{ op: 'setTier', tier: 'large', model: 'cloud/other', thinking: 'low' }];

    const g = previewChanges(root, change, STARTER, 'global');
    applyChanges(root, change, g.fingerprint, STARTER, 'global');
    expect(read(root)).toBe(HAND_WRITTEN);
    expect(readFileSync(global, 'utf8')).toBe(GLOBAL_FULL.replace('cloud/global-large, thinking: high', 'cloud/other, thinking: low'));

    const globalNow = readFileSync(global, 'utf8');
    const p = previewChanges(root, [setMedium], STARTER);
    applyChanges(root, [setMedium], p.fingerprint, STARTER);
    expect(readFileSync(global, 'utf8')).toBe(globalNow);
    expect(read(root)).toContain('medium: { host: pi, model: local/new-medium, thinking: high }');
  });

  it('previews a project-scope change in a project with no file and a global medium as the changed tier only', () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
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
    useGlobalConfig(GLOBAL_FULL);
    const same: Change = { op: 'setTier', tier: 'small', model: 'local/global-small', thinking: 'off' };
    expect(previewChanges(tempDir(), [same], STARTER)).toMatchObject({ nothingToChange: true, diff: '' });
  });

  it('writes a limit and a tier on top of a lone-tier project file with a null removal and agents that use inherited tiers', () => {
    useGlobalConfig(GLOBAL_FULL);
    const text = `models:\n  tiers:\n    large:\nagents:\n  helper:\n    description: h\n    tier: small\n    tools: [read]\n    timeout: 5\n`;
    const root = makeProject(text);
    expect(readSetupState(root, { host: 'pi' })).toMatchObject({ status: 'ok' });
    const changes: Change[] = [{ op: 'setLimit', model: 'local/global-small', parallel: 4 }];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.refusals).toEqual([]);
    expect(preview.invalid).toBeUndefined();
    expect(preview.text).toBe(text.replace('    large:\n', '    large:\n  parallel:\n    local/global-small: 4\n'));
    applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(loadAgentFile(root).limits).toEqual(new Map([['local/global-small', 4]]));
  });

  it('removes an inherited tier by writing a null entry, and deletes a project-only tier', () => {
    useGlobalConfig(GLOBAL_FULL);
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
    useGlobalConfig(GLOBAL_FULL);
    const root = makeProject(`models:\n  tiers:\n    large: { host: pi, model: cloud/own, thinking: low }\n    small:\n`);
    const unset = previewChanges(root, [{ op: 'unsetTier', tier: 'large' }], STARTER);
    expect(unset.text).toBe('models:\n  tiers:\n    small:\n    large:\n');
    const reset = previewChanges(root, [{ op: 'setTier', tier: 'small', model: 'local/back', thinking: 'low' }], STARTER);
    expect(reset.text).toBe('models:\n  tiers:\n    large: { host: pi, model: cloud/own, thinking: low }\n    small: { host: pi, model: local/back, thinking: low }\n');
    applyChanges(root, [{ op: 'setTier', tier: 'small', model: 'local/back', thinking: 'low' }], reset.fingerprint, STARTER);
    expect(loadAgentFile(root).tiers.get('small')).toEqual({ host: 'pi', model: 'local/back', thinking: 'low' });
  });

  it('removes an inherited limit by writing a null entry, and a project-only limit by deleting it', () => {
    useGlobalConfig(GLOBAL_FULL);
    const root = tempDir();
    const preview = previewChanges(root, [{ op: 'clearLimit', model: 'local/global-small' }], STARTER);
    expect(preview.text).toBe('models:\n  parallel:\n    local/global-small:\n');
    applyChanges(root, [{ op: 'clearLimit', model: 'local/global-small' }], preview.fingerprint, STARTER);
    expect(loadAgentFile(root).limits.size).toBe(0);

    const own = makeProject(`models:\n  parallel:\n    cloud/b: 3\n  tiers:\n    big: { host: pi, model: cloud/b, thinking: low }\n`);
    expect(previewChanges(own, [{ op: 'clearLimit', model: 'cloud/b' }], STARTER).text).toBe(
      'models:\n  tiers:\n    big: { host: pi, model: cloud/b, thinking: low }\n',
    );
  });

  it('keeps an inherited limit working when a project tier moves onto its model, and drops it silently when no tier uses it', () => {
    useGlobalConfig(
      `models:\n  parallel:\n    local/global-medium: 2\n  tiers:\n    medium: { host: pi, model: local/global-medium, thinking: low }\n    small: { host: pi, model: cloud/global-small, thinking: off }\n`,
    );
    const root = tempDir();
    // The limit is inherited but only medium uses it; the project moves medium away.
    const away = previewChanges(root, [{ op: 'setTier', tier: 'medium', model: 'cloud/m', thinking: 'low' }], STARTER);
    expect(away).toMatchObject({ refusals: [], droppedLimits: [] });
    expect(away.invalid).toBeUndefined();
    // and back onto the model the global limit belongs to.
    const moved = makeProject(away.text);
    expect(loadAgentFile(moved).limits.size).toBe(0);
    const comeBack: Change[] = [{ op: 'setTier', tier: 'medium', model: 'local/global-medium', thinking: 'low' }];
    const back = previewChanges(moved, comeBack, STARTER);
    expect(back.invalid).toBeUndefined();
    applyChanges(moved, comeBack, back.fingerprint, STARTER);
    expect(loadAgentFile(moved).limits).toEqual(new Map([['local/global-medium', 2]]));
  });

  it('refuses a change set with no medium in either layer, and counts the inherited medium otherwise', () => {
    const small: Change = { op: 'setTier', tier: 'small', model: 'local/s', thinking: 'low' };
    expect(previewChanges(tempDir(), [small], STARTER).refusals).toEqual([{ change: null, message: expect.stringMatching(/medium tier is required/) }]);
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    expect(previewChanges(tempDir(), [small], STARTER).refusals).toEqual([]);
    expect(previewChanges(tempDir(), [{ op: 'unsetTier', tier: 'medium' }], STARTER).refusals[0]!.message).toMatch(/medium tier cannot be removed/);
  });

  it('refuses a global change with no medium when the project has none, and lets one through when the project has its own', () => {
    const small: Change = { op: 'setTier', tier: 'small', model: 'local/s', thinking: 'low' };
    globalAt(path.join(tempDir(), 'subzero.yaml'));
    expect(previewChanges(tempDir(), [small], STARTER, 'global').refusals).toEqual([{ change: null, message: expect.stringMatching(/medium tier is required/) }]);
    expect(previewChanges(makeProject(HAND_WRITTEN), [small], STARTER, 'global').refusals).toEqual([]);
  });

  it('refuses apply with a fingerprint from the other scope', () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const root = makeProject(HAND_WRITTEN);
    const asProject = previewChanges(root, [setMedium], STARTER).fingerprint;
    const asGlobal = previewChanges(root, [setMedium], STARTER, 'global').fingerprint;
    expect(asProject).not.toBe(asGlobal);
    expect(() => applyChanges(root, [setMedium], asProject, STARTER, 'global')).toThrow(SetupConflictError);
    expect(() => applyChanges(root, [setMedium], asGlobal, STARTER)).toThrow(SetupConflictError);
    expect(read(root)).toBe(HAND_WRITTEN);
  });

  it('refuses apply when the global file changed since a project-scope preview', () => {
    const global = useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const root = tempDir();
    const change: Change[] = [{ op: 'setTier', tier: 'small', model: 'local/s', thinking: 'low' }];
    const { fingerprint } = previewChanges(root, change, STARTER);
    writeFileSync(global, GLOBAL_FULL);
    expect(() => applyChanges(root, change, fingerprint, STARTER)).toThrow(SetupConflictError);
  });

  it('names the global path when the file system refuses a write there, leaving the file untouched', () => {
    const global = useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const root = tempDir();
    const preview = previewChanges(root, [setMedium], STARTER, 'global');
    seam.fail = 'rename';
    let thrown: unknown;
    try {
      applyChanges(root, [setMedium], preview.fingerprint, STARTER, 'global');
    } catch (err) {
      thrown = err;
    }
    seam.fail = undefined;
    expect(thrown).toBeInstanceOf(SetupWriteError);
    expect(thrown).toMatchObject({ code: 'write_failed', message: `could not write ${global}: EIO (i/o error)` });
    expect(readFileSync(global, 'utf8')).toBe(GLOBAL_MEDIUM_YAML);
    expect(readdirSync(path.dirname(global))).toEqual(['subzero.yaml']);
  });

  it('refuses a global-scope unset of a tier a project agent uses, and leaves the file alone', () => {
    const global = useGlobalConfig(GLOBAL_FULL);
    const project = `agents:\n  helper:\n    description: h\n    tier: large\n    tools: [read]\n    timeout: 5\n  reviewer:\n    description: r\n    tiers:\n      large: { model: cloud/r }\n    tools: [read]\n    timeout: 5\n`;
    const root = makeProject(project);
    const unset: Change[] = [{ op: 'unsetTier', tier: 'large' }];
    const preview = previewChanges(root, unset, STARTER, 'global');
    expect(preview.refusals).toEqual([
      { change: unset[0], agents: ['helper', 'reviewer'], message: expect.stringMatching(/tier "large" cannot be removed: helper, reviewer use it/) },
    ]);
    expect(() => applyChanges(root, unset, preview.fingerprint, STARTER, 'global')).toThrow(SetupRefusedError);
    expect(readFileSync(global, 'utf8')).toBe(GLOBAL_FULL);

    const ok = previewChanges(root, [{ op: 'setTier', tier: 'large', model: 'cloud/x', thinking: 'low' }, { op: 'unsetTier', tier: 'small' }], STARTER, 'global');
    expect(ok.refusals).toEqual([]);
    expect(ok.invalid).toBeUndefined();
  });

  it('does not refuse a global-scope unset of a tier the project defines or removes itself', () => {
    useGlobalConfig(GLOBAL_FULL);
    const own = makeProject(`models:\n  tiers:\n    large: { host: pi, model: cloud/own, thinking: low }\nagents:\n  helper:\n    description: h\n    tier: large\n    tools: [read]\n    timeout: 5\n`);
    const preview = previewChanges(own, [{ op: 'unsetTier', tier: 'large' }], STARTER, 'global');
    expect(preview.refusals).toEqual([]);
    expect(preview.invalid).toBeUndefined();
    expect(preview.overridden).toEqual({ tiers: ['large'], limits: [] });
    expect(preview.text).not.toContain('large');
  });

  it('ignores a project that switches itself off, in the global scope', () => {
    useGlobalConfig(GLOBAL_FULL);
    const root = makeProject('enabled: false\n');
    const preview = previewChanges(root, [{ op: 'unsetTier', tier: 'large' }], STARTER, 'global');
    expect(preview.refusals).toEqual([]);
    expect(preview.overridden).toEqual({ tiers: [], limits: [] });
    expect(readSetupState(root, { scope: 'global' })).toMatchObject({ status: 'ok' });
    expect(readSetupState(root)).toMatchObject({ status: 'refused', error: expect.stringMatching(/enabled: false/) });
  });

  it('refuses a broken global file in either scope, naming it', () => {
    const global = useGlobalConfig('agents: {}\n');
    for (const scope of ['global', 'project'] as const) {
      const state = readSetupState(tempDir(), { scope });
      expect(state).toMatchObject({ status: 'refused', error: expect.stringContaining(global) });
      expect(() => previewChanges(tempDir(), [setMedium], STARTER, scope)).toThrow(LoadError);
    }
  });

  it('refuses a global-scope change that would leave this project own limit unused, and writes nothing', () => {
    const global = useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const limitText = 'models:\n  parallel:\n    local/global-medium: 1\n';
    const root = makeProject(limitText);
    expect(loadAgentFile(root).limits).toEqual(new Map([['local/global-medium', 1]]));
    const move: Change[] = [{ op: 'setTier', tier: 'medium', model: 'cloud/m', thinking: 'low' }];
    const preview = previewChanges(root, move, STARTER, 'global');
    expect(preview.invalid).toMatch(/model "local\/global-medium": no tier or tier override uses it/);
    expect(preview.invalid).toContain(fileOf(root));
    expect(() => applyChanges(root, move, preview.fingerprint, STARTER, 'global')).toThrow(LoadError);
    expect(readFileSync(global, 'utf8')).toBe(GLOBAL_MEDIUM_YAML);
    expect(read(root)).toBe(limitText);
    expect(loadAgentFile(root).limits).toEqual(new Map([['local/global-medium', 1]]));
  });

  it('does not newly refuse a global-scope change for a project that already had an unused own limit', () => {
    const global = useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const text = 'models:\n  parallel:\n    cloud/x: 1\n';
    const root = makeProject(text);
    expect(() => loadAgentFile(root)).toThrow(LoadError);
    const change: Change[] = [{ op: 'setTier', tier: 'medium', model: 'local/new-medium', thinking: 'high' }];
    const preview = previewChanges(root, change, STARTER, 'global');
    expect(preview.invalid).toBeUndefined();
    expect(preview.refusals).toEqual([]);
    expect(applyChanges(root, change, preview.fingerprint, STARTER, 'global').written).toBe(true);
    expect(readFileSync(global, 'utf8')).toContain('local/new-medium');
    expect(read(root)).toBe(text);
  });

  it('removes the whole tiers section, and an empty models, when the last block-style tier of a project that inherits medium goes', () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
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
    useGlobalConfig(GLOBAL_FULL);
    const root = makeProject('models:\n  tiers:\n    small:\n      host: pi\n      model: local/s\n      thinking: low\n');
    const unset: Change[] = [{ op: 'unsetTier', tier: 'small' }];
    const preview = previewChanges(root, unset, STARTER);
    expect(preview.invalid).toBeUndefined();
    expect(preview.text).toBe('models:\n  tiers:\n    small:\n');
    applyChanges(root, unset, preview.fingerprint, STARTER);
    expect([...loadAgentFile(root).tiers.keys()]).toEqual(['medium', 'large']);
  });

  it('removes the whole parallel section, and an emptied models, when the last block-style limit goes, so the file loads', () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const root = makeProject('models:\n  parallel:\n    local/global-medium: 1\nrouting:\n  hook: true\n');
    const clear: Change[] = [{ op: 'clearLimit', model: 'local/global-medium' }];
    const preview = previewChanges(root, clear, STARTER);
    expect(preview.invalid).toBeUndefined();
    expect(preview.text).toBe('routing:\n  hook: true\n');
    applyChanges(root, clear, preview.fingerprint, STARTER);
    expect(loadAgentFile(root).limits.size).toBe(0);
  });

  it('still removes a last tier or limit from flow-style maps, and one of several', () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const unsetSmall: Change[] = [{ op: 'unsetTier', tier: 'small' }];
    const clearLocal: Change[] = [{ op: 'clearLimit', model: 'local/global-medium' }];
    for (const [text, changes] of [
      ['models: { tiers: { small: { host: pi, model: local/s, thinking: low } } }\nrouting: { hook: true }\n', unsetSmall],
      ['models:\n  tiers: { small: { host: pi, model: local/s, thinking: low } }\nrouting: { hook: true }\n', unsetSmall],
      ['models:\n  tiers:\n    small: { host: pi, model: local/s, thinking: low }\nrouting: { hook: true }\n', unsetSmall],
      ['models: { parallel: { local/global-medium: 1 } }\nrouting: { hook: true }\n', clearLocal],
      ['models:\n  parallel: { local/global-medium: 1 }\nrouting: { hook: true }\n', clearLocal],
      ['models:\n  parallel:\n    local/global-medium: 1\nrouting: { hook: true }\n', clearLocal],
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

  it('writes a removal entry inside a whole-file flow map when its last own tier or limit overrides an inherited one', () => {
    useGlobalConfig(GLOBAL_FULL);
    const tier = makeProject('{ models: { tiers: { small: { host: pi, model: a/b, thinking: low } } } }\n');
    const unset: Change[] = [{ op: 'unsetTier', tier: 'small' }];
    const tierPreview = previewChanges(tier, unset, STARTER);
    expect(tierPreview.invalid).toBeUndefined();
    expect(tierPreview.refusals).toEqual([]);
    expect(tierPreview.text).toMatch(/^\{.*small: null.*\}\s*$/s);
    applyChanges(tier, unset, tierPreview.fingerprint, STARTER);
    expect([...loadAgentFile(tier).tiers.keys()]).toEqual(['medium', 'large']);

    const limit = makeProject('{ models: { parallel: { local/global-small: 1 } } }\n');
    const clear: Change[] = [{ op: 'clearLimit', model: 'local/global-small' }];
    const limitPreview = previewChanges(limit, clear, STARTER);
    expect(limitPreview.invalid).toBeUndefined();
    expect(limitPreview.text).toMatch(/^\{.*local\/global-small: null.*\}\s*$/s);
    applyChanges(limit, clear, limitPreview.fingerprint, STARTER);
    expect(loadAgentFile(limit).limits.size).toBe(0);

    // A flow models or tiers inside a block file keeps working, with the removal entry written in the file.
    for (const text of ['models: { tiers: { small: { host: pi, model: a/b, thinking: low } } }\n', 'models:\n  tiers: { small: { host: pi, model: a/b, thinking: low } }\n']) {
      const root = makeProject(text);
      const preview = previewChanges(root, unset, STARTER);
      expect(preview.invalid, text).toBeUndefined();
      applyChanges(root, unset, preview.fingerprint, STARTER);
      expect([...loadAgentFile(root).tiers.keys()]).toEqual(['medium', 'large']);
    }
  });

  it('empties a retained flow map whatever its whitespace, newlines, comments and trailing commas hold', () => {
    const unsetSmall: Change[] = [{ op: 'unsetTier', tier: 'small' }];
    const clearLocal: Change[] = [{ op: 'clearLimit', model: 'local/global-medium' }];
    const clearSmall: Change[] = [{ op: 'clearLimit', model: 'local/global-small' }];
    const tinySmall = '{ host: pi, model: a/b, thinking: low }';
    const cases: { text: string; changes: Change[]; global: string; tiers: string[]; limits: number }[] = [
      // the file of the review: a trailing comma on its own line, inheriting nothing to remove
      { text: '{ models: { parallel: { local/global-medium: 1 }\n    , } }\n', changes: clearLocal, global: GLOBAL_MEDIUM_YAML, tiers: ['medium'], limits: 0 },
      { text: `{ models: { tiers: { small: ${tinySmall}\n    , } } }\n`, changes: unsetSmall, global: GLOBAL_MEDIUM_YAML, tiers: ['medium'], limits: 0 },
      // the same with an inherited entry, so a removal entry is written back inside the retained map
      { text: '{ models: { parallel: { local/global-small: 1 }\n    , } }\n', changes: clearSmall, global: GLOBAL_FULL, tiers: ['medium', 'small', 'large'], limits: 0 },
      { text: `{ models: { tiers: { small: ${tinySmall}\n    , } } }\n`, changes: unsetSmall, global: GLOBAL_FULL, tiers: ['medium', 'large'], limits: 0 },
      // a comment between entries and after the last one
      { text: `{ models: { tiers: { # note\n  small: ${tinySmall}, # more\n  } } }\n`, changes: unsetSmall, global: GLOBAL_MEDIUM_YAML, tiers: ['medium'], limits: 0 },
      { text: `models:\n  tiers: { # note\n    small: ${tinySmall}\n    , }\nrouting: { hook: true }\n`, changes: unsetSmall, global: GLOBAL_MEDIUM_YAML, tiers: ['medium'], limits: 0 },
    ];
    for (const { text, changes, global, tiers, limits } of cases) {
      useGlobalConfig(global);
      const root = makeProject(text);
      const preview = previewChanges(root, changes, STARTER);
      expect(preview.invalid, text).toBeUndefined();
      expect(preview.refusals, text).toEqual([]);
      applyChanges(root, changes, preview.fingerprint, STARTER);
      const catalog = loadAgentFile(root);
      expect([...catalog.tiers.keys()].sort(), text).toEqual([...tiers].sort());
      expect(catalog.limits.size, text).toBe(limits);
    }

    // Bytes outside the emptied container stay as they were.
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const root = makeProject(`# top\nroot: 1\nmodels: { tiers: {\n  small: ${tinySmall}\n  , } }   # keep\nrouting: { hook: true }\n`);
    expect(previewChanges(root, unsetSmall, STARTER).text).toBe('# top\nroot: 1\nrouting: { hook: true }\n');
    const kept = makeProject(`# top\nroot: 1\nmodels:\n  tiers: { # c\n    small: ${tinySmall}\n    , }   # keep\n`);
    expect(previewChanges(kept, unsetSmall, STARTER).text).toBe('# top\nroot: 1\n');
  });

  it('removes the whole global tiers section when the last global tier goes and the project has its own medium', () => {
    const global = useGlobalConfig('models:\n  tiers:\n    small:\n      host: pi\n      model: local/s\n      thinking: low\n');
    const root = makeProject('models:\n  tiers:\n    medium: { host: pi, model: local/own, thinking: low }\n');
    const unset: Change[] = [{ op: 'unsetTier', tier: 'small' }];
    const preview = previewChanges(root, unset, STARTER, 'global');
    expect(preview.refusals).toEqual([]);
    expect(preview.invalid).toBeUndefined();
    expect(preview.text).toBe('');
    applyChanges(root, unset, preview.fingerprint, STARTER, 'global');
    expect(readFileSync(global, 'utf8')).toBe('');
    expect([...loadAgentFile(root).tiers.keys()]).toEqual(['medium']);
  });

  it('marks each tier and limit as global or project, and names what this project overrides', () => {
    useGlobalConfig(GLOBAL_FULL);
    const root = makeProject(`models:\n  parallel:\n    local/global-small: 1\n  tiers:\n    medium: { host: pi, model: local/own, thinking: high }\n    mine: { host: pi, model: local/mine, thinking: low }\n    large:\n`);
    const state = readSetupState(root, { host: 'pi' });
    if (state.status !== 'ok') throw new Error(`unexpected ${state.status}`);
    expect(state.tiers.map((t) => [t.tier, t.source, t.model])).toEqual([
      ['medium', 'project', 'local/own'],
      ['small', 'global', 'local/global-small'],
      ['mine', 'project', 'local/mine'],
    ]);
    expect(state.limits).toEqual([
      { model: 'local/global-small', parallel: 1, tiers: ['small'], overrideOnly: false, unused: false, source: 'project', global: { parallel: 2 } },
    ]);
    expect(state.overridden).toEqual({ tiers: ['medium', 'large'], limits: ['local/global-small'] });
    // The global file's own value rides on an overridden entry only: not on a global tier, nor on a project-only one.
    expect(state.tiers.map((t) => [t.tier, t.global])).toEqual([
      ['medium', { host: 'pi', model: 'local/global-medium', thinking: 'low' }],
      ['small', undefined],
      ['mine', undefined],
    ]);
    expect(state.tiers.filter((t) => t.source === 'global').every((t) => !('global' in t))).toBe(true);

    const inheritedOnly = readSetupState(tempDir(), { host: 'pi' });
    if (inheritedOnly.status !== 'no-file') throw new Error(`unexpected ${inheritedOnly.status}`);
    expect(inheritedOnly.tiers.every((t) => t.source === 'global')).toBe(true);
    expect(inheritedOnly.limits.map((l) => l.source)).toEqual(['global']);
    expect(inheritedOnly.fileFingerprint).toBeNull();
    expect(inheritedOnly.tiers.some((t) => 'global' in t)).toBe(false);
    expect(inheritedOnly.limits.some((l) => 'global' in l)).toBe(false);
  });

  it('reads the global file in the global scope, with the dependents from this project', () => {
    const global = useGlobalConfig(GLOBAL_FULL);
    const root = makeProject(`agents:\n  helper:\n    description: h\n    tier: large\n    tools: [read]\n    timeout: 5\n`);
    const state = readSetupState(root, { scope: 'global' });
    if (state.status !== 'ok') throw new Error(`unexpected ${state.status}`);
    expect(state.agentFile).toBe(global);
    expect(state.tiers.map((t) => [t.tier, t.source, t.dependents])).toEqual([
      ['medium', 'global', []],
      ['small', 'global', []],
      ['large', 'global', ['helper']],
    ]);
    expect(state.limits).toEqual([{ model: 'local/global-small', parallel: 2, tiers: ['small'], overrideOnly: false, unused: false, source: 'global' }]);
  });

  it('carries no global value in the global scope, where the listed values are the global file\'s own', () => {
    useGlobalConfig(GLOBAL_FULL);
    const root = makeProject(`models:\n  parallel:\n    local/global-small: 1\n  tiers:\n    medium: { host: pi, model: local/own, thinking: high }\n`);
    const state = readSetupState(root, { scope: 'global' });
    if (state.status !== 'ok') throw new Error(`unexpected ${state.status}`);
    expect(state.tiers.find((t) => t.tier === 'medium')).toMatchObject({ model: 'local/global-medium', source: 'global' });
    expect(state.tiers.some((t) => 'global' in t)).toBe(false);
    expect(state.limits.some((l) => 'global' in l)).toBe(false);
  });

  it('carries the global value of an overridden tier that the global file holds, and omits it for a tier only this project holds', () => {
    useGlobalConfig(GLOBAL_FULL);
    const root = makeProject(`models:\n  tiers:\n    small: { host: pi, model: cloud/own-small, thinking: low }\n    extra: { host: pi, model: cloud/e, thinking: low }\n`);
    const state = readSetupState(root, { host: 'pi' });
    if (state.status !== 'ok') throw new Error(`unexpected ${state.status}`);
    expect(state.tiers.find((t) => t.tier === 'small')).toMatchObject({ model: 'cloud/own-small', source: 'project', global: { host: 'pi', model: 'local/global-small', thinking: 'off' } });
    expect(state.tiers.find((t) => t.tier === 'extra')).not.toHaveProperty('global');
    expect(state.tiers.find((t) => t.tier === 'medium')).not.toHaveProperty('global');
  });
});

describe('addStarterEntries on top of layered files', () => {
  it('parses a file guided init wrote (a lone tier, a null removal) as layers and adds the starter entries', () => {
    useGlobalConfig(GLOBAL_FULL);
    const text = `models:\n  tiers:\n    large:\nagents:\n  helper:\n    description: h\n    tier: small\n    tools: [read]\n    timeout: 5\n`;
    const root = makeProject(text);
    const result = addStarterEntries(root, { host: 'pi', model: 'local/m', thinking: 'low', timeout: 100, generalTools: ['read'], fallbackTools: ['read'] });
    expect(result.added).toEqual(['medium', 'general', 'fallback']);
    expect(read(root).startsWith(text.slice(0, text.indexOf('agents:')))).toBe(true);
    expect(loadCatalog(root).entries.has('fallback')).toBe(true);
  });
});

describe('AgentSetup repairs endpoints:', () => {
  const R9700_FILE = `# Project agents.
skills:
  facts: ./skills/alpha

endpoints:
  # the one GPU
  r9700:
    parallel: 1

models:
  tiers:
    medium: { host: pi, model: r9700/Qwen3.8, thinking: medium }
    small: { host: pi, model: r9700/Qwen-small, thinking: low }
    large: { host: pi, model: cloud/large, thinking: high }

${AGENTS}`;

  const GLOBAL_ENDPOINTS = `endpoints:
  # the box
  local:
    parallel: 3
models:
  tiers:
    medium: { host: pi, model: local/global-medium, thinking: low }
    small: { host: pi, model: local/global-small, thinking: off }
`;

  it('lists each endpoints entry with its limit, its file and its covered models, and marks the file repairable', () => {
    const root = makeProject(R9700_FILE);
    const state = readSetupState(root, { host: 'pi' });
    expect(state.status).toBe('repairable');
    if (state.status !== 'repairable') throw new Error('unexpected');
    expect(state.endpoints).toEqual([{ endpoint: 'r9700', parallel: 1, file: fileOf(root), scope: 'project', models: ['r9700/Qwen3.8', 'r9700/Qwen-small'] }]);
    expect(state.problem).toMatch(/endpoints:.*models\.parallel.*r9700 \(limit 1\) covers r9700\/Qwen3\.8, r9700\/Qwen-small/);
    expect(state.tiers.map((t) => t.model)).toEqual(['r9700/Qwen3.8', 'r9700/Qwen-small', 'cloud/large']);
  });

  it('covers R20: previews limits for both covered models pre-filled with the old value, and apply writes them and removes endpoints', () => {
    const root = makeProject(R9700_FILE);
    const preview = previewChanges(root, [], STARTER);
    expect(preview.refusals).toEqual([]);
    expect(preview.invalid).toBeUndefined();
    expect(preview.prefilled).toEqual([
      { model: 'r9700/Qwen3.8', parallel: 1, endpoint: 'r9700' },
      { model: 'r9700/Qwen-small', parallel: 1, endpoint: 'r9700' },
    ]);
    expect(preview.repairs).toEqual([{ endpoint: 'r9700', parallel: 1, file: fileOf(root), scope: 'project', models: ['r9700/Qwen3.8', 'r9700/Qwen-small'] }]);
    expect(preview.summary).toEqual([
      'model r9700/Qwen3.8: parallel limit 1 (the old limit of endpoint r9700)',
      'model r9700/Qwen-small: parallel limit 1 (the old limit of endpoint r9700)',
      'remove endpoints.r9700 (limit 1), which models.parallel replaced',
    ]);
    // The diff shows the removal, the comment line with it, and the new limits.
    expect(preview.diff).toContain('-endpoints:\n-  # the one GPU\n-  r9700:\n-    parallel: 1\n');
    expect(preview.diff).toContain('+  parallel:\n+    r9700/Qwen3.8: 1\n+    r9700/Qwen-small: 1\n');
    expect(read(root)).toBe(R9700_FILE);

    expect(applyChanges(root, [], preview.fingerprint, STARTER).written).toBe(true);
    expect(read(root)).not.toContain('endpoints');
    expect(read(root)).not.toContain('the one GPU');
    expect(read(root)).toContain('# Project agents.\nskills:\n  facts: ./skills/alpha\n');
    const catalog = loadAgentFile(root);
    expect(catalog.limits).toEqual(new Map([['r9700/Qwen3.8', 1], ['r9700/Qwen-small', 1]]));
    expect(readSetupState(root, { host: 'pi' }).status).toBe('ok');
  });

  it('lets the change set override a pre-filled limit, or clear it, and writes the rest', () => {
    const root = makeProject(R9700_FILE);
    const changes: Change[] = [
      { op: 'setLimit', model: 'r9700/Qwen3.8', parallel: 4 },
      { op: 'clearLimit', model: 'r9700/Qwen-small' },
    ];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.prefilled).toEqual([]);
    applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(loadAgentFile(root).limits).toEqual(new Map([['r9700/Qwen3.8', 4]]));
    expect(read(root)).not.toContain('endpoints');
  });

  it('drops an endpoints entry that covers no model, and one with no limit', () => {
    const text = `endpoints:\n  gone:\n    parallel: 2\n  none:\nmodels:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n${AGENTS}`;
    const root = makeProject(text);
    const state = readSetupState(root, {});
    if (state.status !== 'repairable') throw new Error('unexpected');
    expect(state.endpoints.map((e) => [e.endpoint, e.parallel, e.models])).toEqual([['gone', 2, []], ['none', null, []]]);
    const preview = previewChanges(root, [], STARTER);
    expect(preview.prefilled).toEqual([]);
    applyChanges(root, [], preview.fingerprint, STARTER);
    expect(read(root)).toBe(`models:\n  tiers:\n    medium: { host: pi, model: local/m, thinking: low }\n${AGENTS}`);
    expect(loadAgentFile(root).limits.size).toBe(0);
  });

  it('puts the pre-filled limits into an existing models.parallel map, and keeps an own limit the endpoint also covers', () => {
    const text = `endpoints:\n  r9700:\n    parallel: 1\nmodels:\n  parallel:\n    r9700/a: 3\n  tiers:\n    medium: { host: pi, model: r9700/a, thinking: low }\n    small: { host: pi, model: r9700/b, thinking: low }\n${AGENTS}`;
    const root = makeProject(text);
    const preview = previewChanges(root, [], STARTER);
    // The model that already has its own limit keeps it: the old endpoint value is pre-filled only where the change set and the file are silent.
    expect(preview.invalid).toBeUndefined();
    expect(preview.prefilled).toEqual([{ model: 'r9700/b', parallel: 1, endpoint: 'r9700' }]);
    applyChanges(root, [], preview.fingerprint, STARTER);
    expect(loadAgentFile(root).limits).toEqual(new Map([['r9700/a', 3], ['r9700/b', 1]]));
    expect(read(root)).toContain('  parallel:\n    r9700/a: 3\n    r9700/b: 1\n');
  });

  it('a global file with endpoints and the scope "only this project" offers the global repair first, and after its apply the project preview applies', () => {
    const global = useGlobalConfig(GLOBAL_ENDPOINTS);
    const root = makeProject(`models:\n  tiers:\n    large: { host: pi, model: cloud/l, thinking: high }\n${AGENTS}`);
    const state = readSetupState(root, { host: 'pi' });
    expect(state.status).toBe('repair-other-first');
    if (state.status !== 'repair-other-first') throw new Error('unexpected');
    expect(state.repairFirst).toEqual({ scope: 'global', file: global });
    expect(state.problem).toContain(global);
    expect(state.endpoints).toEqual([{ endpoint: 'local', parallel: 3, file: global, scope: 'global', models: ['local/global-medium', 'local/global-small'] }]);

    // Until the global file is repaired, a project preview is invalid: the other file would still fail to load.
    const change: Change[] = [{ op: 'setTier', tier: 'small', model: 'cloud/s', thinking: 'low' }];
    const blocked = previewChanges(root, change, STARTER);
    expect(blocked.invalid).toMatch(/global file holds "endpoints:"/);
    expect(() => applyChanges(root, change, blocked.fingerprint, STARTER)).toThrow(LoadError);

    const repair = previewChanges(root, [], STARTER, 'global');
    expect(repair.invalid).toBeUndefined();
    expect(repair.refusals).toEqual([]);
    expect(repair.agentFile).toBe(global);
    expect(repair.prefilled.map((p) => [p.model, p.parallel])).toEqual([['local/global-medium', 3], ['local/global-small', 3]]);
    expect(repair.diff).toContain('-endpoints:\n-  # the box\n-  local:\n-    parallel: 3\n');
    expect(readFileSync(global, 'utf8')).toBe(GLOBAL_ENDPOINTS);
    expect(applyChanges(root, [], repair.fingerprint, STARTER, 'global').written).toBe(true);
    expect(readFileSync(global, 'utf8')).toBe(
      'models:\n  tiers:\n    medium: { host: pi, model: local/global-medium, thinking: low }\n    small: { host: pi, model: local/global-small, thinking: off }\n  parallel:\n    local/global-medium: 3\n    local/global-small: 3\n',
    );

    expect(readSetupState(root, { host: 'pi' }).status).toBe('ok');
    const next = previewChanges(root, change, STARTER);
    expect(next.invalid).toBeUndefined();
    expect(applyChanges(root, change, next.fingerprint, STARTER).written).toBe(true);
    expect(loadAgentFile(root).tiers.get('small')?.model).toBe('cloud/s');
    expect(loadAgentFile(root).limits).toEqual(new Map([['local/global-medium', 3]]));
  });

  it('an agent file with endpoints and the scope "every project" offers the agent repair first', () => {
    const global = useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const root = makeProject(R9700_FILE);
    const state = readSetupState(root, { host: 'pi', scope: 'global' });
    expect(state.status).toBe('repair-other-first');
    if (state.status !== 'repair-other-first') throw new Error('unexpected');
    expect(state.repairFirst).toEqual({ scope: 'project', file: fileOf(root) });
    expect(state.agentFile).toBe(global);
    expect(state.endpoints.map((e) => e.scope)).toEqual(['project']);

    const repair = previewChanges(root, [], STARTER);
    expect(applyChanges(root, [], repair.fingerprint, STARTER).written).toBe(true);
    expect(readSetupState(root, { host: 'pi', scope: 'global' }).status).toBe('ok');
  });

  it('both files hold endpoints: the first repair step applies although the chosen file still holds endpoints', () => {
    const global = useGlobalConfig(GLOBAL_ENDPOINTS);
    const root = makeProject(R9700_FILE);
    const state = readSetupState(root, { host: 'pi' });
    if (state.status !== 'repair-other-first') throw new Error(`unexpected ${state.status}`);
    expect(state.endpoints.map((e) => [e.scope, e.endpoint])).toEqual([['global', 'local'], ['project', 'r9700']]);

    // Step 1: the global file, while the agent file still holds endpoints.
    const first = previewChanges(root, [], STARTER, 'global');
    expect(first.invalid).toBeUndefined();
    expect(first.refusals).toEqual([]);
    expect(applyChanges(root, [], first.fingerprint, STARTER, 'global').written).toBe(true);
    expect(readFileSync(global, 'utf8')).not.toContain('endpoints');
    expect(read(root)).toBe(R9700_FILE);

    // Step 2: the agent file, now that the global one loads.
    const state2 = readSetupState(root, { host: 'pi' });
    expect(state2.status).toBe('repairable');
    const second = previewChanges(root, [], STARTER);
    expect(second.invalid).toBeUndefined();
    expect(applyChanges(root, [], second.fingerprint, STARTER).written).toBe(true);
    expect(readSetupState(root, { host: 'pi' }).status).toBe('ok');
    expect(loadAgentFile(root).limits.get('r9700/Qwen3.8')).toBe(1);
  });

  it('a global repair tolerates a missing medium tier and an unused limit of the project, which the next step repairs', () => {
    const global = useGlobalConfig('endpoints:\n  local:\n    parallel: 2\n');
    const root = makeProject(`models:\n  parallel:\n    unused/m: 1\nendpoints:\n  other:\n    parallel: 1\n${AGENTS}`);
    const preview = previewChanges(root, [], STARTER, 'global');
    expect(preview.refusals).toEqual([]);
    expect(preview.invalid).toBeUndefined();
    expect(preview.text).toBe('');
    expect(applyChanges(root, [], preview.fingerprint, STARTER, 'global').written).toBe(true);
    expect(readFileSync(global, 'utf8')).toBe('');
  });

  it('a repair that also sets tiers keeps the medium tier rule', () => {
    const root = makeProject(`endpoints:\n  local:\n    parallel: 1\n${AGENTS}`);
    const preview = previewChanges(root, [{ op: 'setTier', tier: 'small', model: 'local/s', thinking: 'low' }], STARTER);
    expect(preview.refusals).toEqual([{ change: null, message: expect.stringMatching(/medium tier is required/) }]);
  });

  it('preview and apply of a repair write nothing until applied, and a changed file makes the preview stale', () => {
    const root = makeProject(R9700_FILE);
    const preview = previewChanges(root, [], STARTER);
    expect(read(root)).toBe(R9700_FILE);
    writeFileSync(fileOf(root), `${R9700_FILE}# edited\n`);
    expect(() => applyChanges(root, [], preview.fingerprint, STARTER)).toThrow(SetupConflictError);
  });

  it('removes a flow-style endpoints map and a whole-file flow map entry', () => {
    const text = `endpoints: { r9700: { parallel: 2 } }\nmodels:\n  tiers:\n    medium: { host: pi, model: r9700/m, thinking: low }\n${AGENTS}`;
    const root = makeProject(text);
    const preview = previewChanges(root, [], STARTER);
    expect(preview.invalid).toBeUndefined();
    applyChanges(root, [], preview.fingerprint, STARTER);
    expect(loadAgentFile(root).limits).toEqual(new Map([['r9700/m', 2]]));
    expect(read(root)).not.toContain('endpoints');
  });

  it('init <model> on a file holding endpoints refuses with the load error and repairs nothing', () => {
    const root = makeProject(R9700_FILE);
    const spec = { host: 'pi', model: 'r9700/new', thinking: 'low' as const, timeout: 100, generalTools: ['read'], fallbackTools: ['read'] };
    expect(() => addStarterEntries(root, spec)).toThrow(LoadError);
    expect(() => addStarterEntries(root, spec)).toThrow(/"endpoints:".*models\.parallel/);
    expect(read(root)).toBe(R9700_FILE);
    expect(otherFiles(root)).toEqual([]);
  });
});

describe('AgentSetup new limits next to new tiers', () => {
  const tierLine = (name: string, model: string) => `    ${name}: { host: pi, model: ${model}, thinking: low }\n`;

  it('writes a new tier and a new limit into a models map whose last key is tiers, each under its own map', () => {
    const text = `models:\n  tiers:\n${tierLine('medium', 'local/m')}${AGENTS}`;
    const root = makeProject(text);
    const changes: Change[] = [
      { op: 'setTier', tier: 'large', model: 'cloud/l', thinking: 'low' },
      { op: 'setLimit', model: 'cloud/l', parallel: 2 },
    ];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.invalid).toBeUndefined();
    expect(preview.text).toBe(`models:\n  tiers:\n${tierLine('medium', 'local/m')}${tierLine('large', 'cloud/l')}  parallel:\n    cloud/l: 2\n${AGENTS}`);
    applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(loadAgentFile(root).limits).toEqual(new Map([['cloud/l', 2]]));
  });

  it('writes a new tier and a new limit when tiers comes after parallel in models, each under its own map', () => {
    const withTiers = makeProject(`models:\n  parallel:\n    local/m: 1\n  tiers:\n${tierLine('medium', 'local/m')}${AGENTS}`);
    const changes: Change[] = [
      { op: 'setTier', tier: 'large', model: 'cloud/l', thinking: 'low' },
      { op: 'setLimit', model: 'cloud/l', parallel: 2 },
    ];
    const preview = previewChanges(withTiers, changes, STARTER);
    expect(preview.invalid).toBeUndefined();
    expect(preview.text).toBe(`models:\n  parallel:\n    local/m: 1\n    cloud/l: 2\n  tiers:\n${tierLine('medium', 'local/m')}${tierLine('large', 'cloud/l')}${AGENTS}`);
  });

  it('writes a new tier and a new limit into a flow-style models map', () => {
    const root = makeProject(`models: { tiers: { medium: { host: pi, model: local/m, thinking: low } } }\n${AGENTS}`);
    const changes: Change[] = [
      { op: 'setTier', tier: 'large', model: 'cloud/l', thinking: 'low' },
      { op: 'setLimit', model: 'cloud/l', parallel: 2 },
    ];
    const preview = previewChanges(root, changes, STARTER);
    expect(preview.invalid).toBeUndefined();
    applyChanges(root, changes, preview.fingerprint, STARTER);
    expect(loadAgentFile(root).limits).toEqual(new Map([['cloud/l', 2]]));
    expect([...loadAgentFile(root).tiers.keys()]).toEqual(['medium', 'large']);
  });
});
