// @sigil implements design/agent-config.sigil AgentConfig (guided setup editor)
//
// Reads the tiers, model limits and tier dependents of the layered agent files for
// guided init, previews a change set to one of them, and applies a previewed change
// set. The scope picks the file: the project's .agents/subzero.yaml or the global
// file. Edits splice the existing text, so every line a change does not touch keeps
// its bytes, and setup never adds an agent. A preview is bound to its apply by a
// fingerprint over the layers' text, the change set and the scope; the result is
// validated with the load rules delegation uses and written atomically, because
// running delegations re-read the files on every call. A file that still holds the old
// `endpoints:` map is repaired by a preview of its scope: the map goes and each model
// it covered gets a limit of its own, pre-filled with the old value.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMap, isScalar, parse as parseYaml, type Document, type Pair } from 'yaml';
import {
  AGENT_FILE,
  BUILT_IN_TIMEOUT,
  buildCatalog,
  createSplicer,
  DEFAULT_TIER,
  flowYaml,
  globalFile,
  isRecord,
  isSameFile,
  isThinkingLevel,
  LoadError,
  PLACEHOLDER_STARTER_AGENTS,
  projectIsGlobal,
  ProjectDisabledError,
  readGlobalText,
  readTextOrNull,
  spliceTiers,
  THINKING_LEVELS,
  yamlKey,
  type AgentCatalog,
  type ModelTier,
  type Splicer,
  type ThinkingLevel,
} from './agent-config.js';
import { TIER_WORDS } from './tier-words.js';

/** Seconds given to `general` and `fallback` when `init <model>` adds them. */
export const DEFAULT_SETUP_TIMEOUT = BUILT_IN_TIMEOUT;

/** What setup needs from the caller to write tiers: the host every tier the change set sets runs on. */
export interface SetupStarterSpec {
  host: string;
}

/** The file a change writes: the project's agent file, or the global file every project reads. */
export type SetupScope = 'global' | 'project';

export type Change =
  | { op: 'setTier'; tier: string; model: string; thinking: ThinkingLevel }
  | { op: 'unsetTier'; tier: string }
  | { op: 'setLimit'; model: string; parallel: number }
  | { op: 'clearLimit'; model: string };

/** A change set that cannot be previewed at all: a malformed change, or two changes to one tier or model. */
export class ChangeSetError extends Error {
  readonly code = 'invalid_change_set';
  constructor(message: string) {
    super(message);
    this.name = 'ChangeSetError';
  }
}

/** The agent file or the change set differs from what was previewed. */
export class SetupConflictError extends Error {
  readonly code = 'stale_preview';
  constructor() {
    super('the agent file or the change set changed since the preview; nothing was written. Preview again.');
    this.name = 'SetupConflictError';
  }
}

/** Apply was given a change set that still holds a refused change. */
export class SetupRefusedError extends Error {
  readonly code = 'refused_change';
  constructor(readonly refusals: Refusal[]) {
    super(`nothing was written: ${refusals.map((r) => r.message).join('; ')}`);
    this.name = 'SetupRefusedError';
  }
}

/** The agent file could not be written: the file system refused the write; the original is untouched. */
export class SetupWriteError extends Error {
  readonly code = 'write_failed';
  constructor(
    file: string,
    readonly cause: NodeJS.ErrnoException,
  ) {
    super(`could not write ${file}: ${cause.code} (${errnoReason(cause)})`);
    this.name = 'SetupWriteError';
  }
}

/** A failure the operating system reported for a file system call, as opposed to a programming error. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string' && typeof (err as NodeJS.ErrnoException).syscall === 'string';
}

/** The short reason of a Node fs error, e.g. "permission denied" from "EACCES: permission denied, open '…'". */
function errnoReason(err: NodeJS.ErrnoException): string {
  const match = /^[A-Z0-9_]+: ([^,]+)/.exec(err.message);
  return match ? match[1]!.trim() : `${err.syscall} failed`;
}

export interface TierState {
  tier: string;
  host: string;
  model: string;
  thinking: ThinkingLevel;
  /** The file the tier comes from. */
  source: SetupScope;
  /** Agents of this project that name this tier through `tier:` or a `tiers.<t>` override, in file order. */
  dependents: string[];
  /** True when the caller named a host and the tier runs on another one. */
  otherHost: boolean;
  /** Whether the caller's model list holds the model; null when no list was given. */
  listed: boolean | null;
  /** The global file's own value of this tier, present only when this project overrides a tier that file also holds. */
  global?: ModelTier;
}

export interface LimitState {
  /** The full model id the limit belongs to. */
  model: string;
  parallel: number;
  /** The file the limit comes from. */
  source: SetupScope;
  /** Tiers that name the model. */
  tiers: string[];
  /** No tier names the model, an agent override does: the limit is kept and not asked about. */
  overrideOnly: boolean;
  /** No tier and no override names the model: setup drops the limit. */
  unused: boolean;
  /** The global file's own limit of this model, present only when this project overrides a limit that file also holds. */
  global?: { parallel: number };
}

/** One limit of an old `endpoints:` map that a file still holds, with the models it covered. */
export interface EndpointState {
  endpoint: string;
  /** The old limit; null when the entry has none. */
  parallel: number | null;
  /** The file that holds the map. */
  file: string;
  /** Which scope writes that file. */
  scope: SetupScope;
  /** The models the old limit covered: the merged configuration's for the agent file, the global file's own tiers' for the global file. */
  models: string[];
}

/** The tier and model names this project's agent file names, as an override or a removal of the global file's. */
export interface Overridden {
  tiers: string[];
  limits: string[];
}

export interface SetupSnapshot {
  /** The file the scope edits. */
  agentFile: string;
  scope: SetupScope;
  /** sha256 of that file's text; null when there is no file. */
  fileFingerprint: string | null;
  /** The project scope lists the merged tiers, the global scope the global file's. */
  tiers: TierState[];
  limits: LimitState[];
  /** Models that only agent overrides name. */
  overrideOnlyModels: string[];
  /** Each `endpoints:` entry either file still holds, global file first; empty when none does. */
  endpoints: EndpointState[];
  /** The tiers and limits of the global file that this project's agent file overrides or removes. */
  overridden: Overridden;
}

export type SetupState =
  | ({ status: 'ok' | 'no-file' } & SetupSnapshot)
  /** The file of the scope fails to load only for what setup repairs: an `endpoints:` map or a limit no model uses. */
  | ({ status: 'repairable'; problem: string } & SetupSnapshot)
  /** The other scope's file holds `endpoints:`: setup repairs it first, in a step of its own, before the chosen scope. */
  | ({ status: 'repair-other-first'; problem: string; repairFirst: { scope: SetupScope; file: string } } & SetupSnapshot)
  /** Any other load error, unchanged; the user fixes the file by hand. */
  | { status: 'refused'; agentFile: string; error: string };

export interface SetupStateOptions {
  /** The file to read the tiers of; the project's by default. */
  scope?: SetupScope;
  /** The host setup writes tiers for; a tier on another host is marked otherHost. */
  host?: string;
  /** The models the host lists; a tier on another model is marked listed: false. */
  listedModels?: Iterable<string>;
}

export interface Refusal {
  /** The refused change, or null for a refusal of the change set as a whole. */
  change: Change | null;
  message: string;
  /** The agents that make the change break the file. */
  agents?: string[];
}

export interface SetupPreview {
  /** The file the write goes to: the project's agent file, or the global file. */
  agentFile: string;
  scope: SetupScope;
  fileExists: boolean;
  /** The normalized change set the fingerprint covers. */
  changes: Change[];
  refusals: Refusal[];
  /** Models whose limit is removed because no tier or override uses them after the change. */
  droppedLimits: string[];
  /** Limits a repair pre-fills from the old `endpoints:` values, for the models the change set leaves alone. */
  prefilled: PrefilledLimit[];
  /** The `endpoints:` entries this preview removes from the file; empty when the file holds none. */
  repairs: EndpointState[];
  /** For a global-scope preview, what this project's agent file overrides: the change does not apply here. */
  overridden: Overridden;
  /** The file text after the write; the refused changes are left out. */
  text: string;
  /** A unified diff of the file; empty when nothing changes. */
  diff: string;
  /** One line per change the write makes. */
  summary: string[];
  nothingToChange: boolean;
  /** The load error the result would raise, when it would not load. */
  invalid?: string;
  /** Hand back to applyChanges to write exactly this preview. */
  fingerprint: string;
}

export interface PrefilledLimit {
  model: string;
  parallel: number;
  /** The old endpoint whose limit gave the value. */
  endpoint: string;
}

export interface SetupApplyResult extends SetupPreview {
  written: boolean;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The two files' text, as they are now. */
interface Layers {
  agentFile: string;
  globalPath: string;
  globalText: string | null;
  projectText: string | null;
}

function readLayers(projectRoot: string): Layers {
  const agentFile = path.join(projectRoot, AGENT_FILE);
  const globalPath = globalFile();
  // A project rooted at the home folder: the one file is the global layer, and the project has no file of its own.
  const projectText = isSameFile(agentFile, globalPath) ? null : readTextOrNull(agentFile);
  return { agentFile, globalPath, globalText: readGlobalText(globalPath), projectText };
}

const targetPath = (l: Layers, scope: SetupScope) => (scope === 'global' ? l.globalPath : l.agentFile);
const targetText = (l: Layers, scope: SetupScope) => (scope === 'global' ? l.globalText : l.projectText);

/**
 * Load text as the layers it is; a missing medium tier, general or fallback is not a problem setup repairs.
 * An `endpoints:` map is read and reported in the catalog unless `legacy` is false, which makes it the load error.
 */
function catalogOf(l: Layers, global: string | null, project: string | null, lenient: boolean, legacy = true): AgentCatalog {
  return buildCatalog(global, project, {
    agentFile: l.agentFile,
    globalFile: l.globalPath,
    allowMissingStarter: true,
    ...(lenient ? { allowUnusedLimits: true } : {}),
    ...(legacy ? { allowLegacyEndpoints: true } : {}),
  });
}

/** Load text with the rules delegation uses: a null tiers or models map, an unused own limit, an `endpoints:` map and a missing medium tier are errors. */
function strictCatalogOf(l: Layers, global: string | null, project: string | null): AgentCatalog {
  return buildCatalog(global, project, { agentFile: l.agentFile, globalFile: l.globalPath, starterAgents: PLACEHOLDER_STARTER_AGENTS });
}

/** Whether the files as they are now load with the rules delegation uses. A project with no file has nothing to be broken already. */
function loadsStrictly(l: Layers): boolean {
  if (l.projectText === null) return true;
  try {
    strictCatalogOf(l, l.globalText, l.projectText);
    return true;
  } catch (err) {
    if (err instanceof LoadError) return false;
    throw err;
  }
}

/** What one file names, before merging: a tier or limit with a value, or a removal entry. */
interface Named {
  tiers: Map<string, boolean>;
  /** The models.parallel entries by full model id; null is a removal entry. */
  limits: Map<string, number | null>;
}

function namedIn(text: string | null): Named {
  const out: Named = { tiers: new Map(), limits: new Map() };
  let doc: unknown;
  try {
    doc = text === null ? null : parseYaml(text);
  } catch {
    return out;
  }
  if (!isRecord(doc)) return out;
  const tiers = isRecord(doc.models) && isRecord(doc.models.tiers) ? doc.models.tiers : {};
  for (const [name, raw] of Object.entries(tiers)) out.tiers.set(name, raw !== null);
  const parallel = isRecord(doc.models) && isRecord(doc.models.parallel) ? doc.models.parallel : {};
  for (const [model, raw] of Object.entries(parallel)) out.limits.set(model, typeof raw === 'number' ? raw : null);
  return out;
}

/** The parallel limits a file sets as numbers, leaving out removal entries. */
function numericLimits(text: string | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const [model, parallel] of namedIn(text).limits) if (parallel !== null) out.set(model, parallel);
  return out;
}

/** What setup sees of the layers at one scope. */
interface View {
  /** The tiers the scope lists: the merged ones for the project, the global file's for global. */
  tiers: Map<string, ModelTier>;
  /** The limits the scope lists, before any that no model uses is dropped. */
  limits: Map<string, number>;
  /** This project's merged catalog; null when the project has no file or is switched off. */
  project: AgentCatalog | null;
  /** What the project file names, empty when the project does not read the global file. */
  projectNamed: Named;
  /** The load error setup repairs, when there is one. */
  problem?: string;
}

/** Load the layers at a scope with the text given. A load error is the file's, for the caller to refuse. */
function viewOf(l: Layers, scope: SetupScope, global: string | null, project: string | null): View {
  if (scope === 'project') {
    let problem: string | undefined;
    let catalog: AgentCatalog;
    try {
      catalog = catalogOf(l, global, project, false);
    } catch (strict) {
      if (!(strict instanceof LoadError)) throw strict;
      catalog = catalogOf(l, global, project, true);
      problem = strict.message;
    }
    return { tiers: catalog.tiers, limits: catalog.limits, project: catalog, projectNamed: namedIn(project), ...(problem !== undefined ? { problem } : {}) };
  }
  const own = catalogOf(l, global, null, false);
  const limits = numericLimits(global);
  let merged: AgentCatalog | null = null;
  if (project !== null) {
    try {
      merged = catalogOf(l, global, project, true);
    } catch (err) {
      if (!(err instanceof ProjectDisabledError)) throw err;
    }
  }
  return { tiers: own.tiers, limits, project: merged, projectNamed: merged === null ? namedIn(null) : namedIn(project) };
}

function emptyCatalog(agentFile: string): AgentCatalog {
  return { agentFile, entries: new Map(), tiers: new Map(), routing: { hook: true }, limits: new Map(), legacyEndpoints: [], childHostOptions: {} };
}

function dependentsOf(catalog: AgentCatalog, tier: string): string[] {
  return [...catalog.entries.values()].filter((e) => e.tier === tier || e.overrides.has(tier)).map((e) => e.name);
}

function overrideModels(catalog: AgentCatalog): Set<string> {
  const out = new Set<string>();
  for (const entry of catalog.entries.values()) {
    for (const override of entry.overrides.values()) if (override.model !== undefined) out.add(override.model);
  }
  return out;
}

/** Models that this project names beyond the tiers the scope lists: agent overrides, and its own tiers when editing the global file. */
function extraModels(view: View, scope: SetupScope): Set<string> {
  if (view.project === null) return new Set();
  const out = overrideModels(view.project);
  if (scope === 'global') {
    for (const [name, tier] of view.project.tiers) if (view.projectNamed.tiers.get(name) === true) out.add(tier.model);
  }
  return out;
}

/** The tiers and limits of the global file that the project file names. */
function overriddenIn(global: Named, project: Named): Overridden {
  return {
    tiers: [...global.tiers.keys()].filter((t) => project.tiers.has(t)),
    limits: [...global.limits.keys()].filter((m) => project.limits.has(m)),
  };
}

/** The `endpoints:` entries both files still hold, global file first, with the scope that writes each file. */
function legacyOf(l: Layers): EndpointState[] {
  let catalog: AgentCatalog;
  try {
    catalog = catalogOf(l, l.globalText, l.projectText, true);
  } catch (err) {
    if (!(err instanceof ProjectDisabledError)) throw err;
    catalog = catalogOf(l, l.globalText, null, true);
  }
  return catalog.legacyEndpoints.map((e) => ({
    endpoint: e.endpoint,
    parallel: e.parallel,
    file: e.file,
    scope: e.file === l.globalPath ? 'global' : 'project',
    models: e.models,
  }));
}

const otherScope = (scope: SetupScope): SetupScope => (scope === 'global' ? 'project' : 'global');
const endpointsKeyText = (e: EndpointState) => `${e.endpoint} (${e.parallel === null ? 'no limit' : `limit ${e.parallel}`}) covers ${e.models.length === 0 ? 'no model' : e.models.join(', ')}`;

/**
 * The tiers, limits and tier dependents at a scope, or "no file". A file that fails to
 * load is classified as repairable (setup fixes it) or refused (it is not).
 */
export function readSetupState(projectRoot: string, options: SetupStateOptions = {}): SetupState {
  const scope = options.scope ?? 'project';
  let layers: Layers;
  try {
    layers = readLayers(projectRoot);
  } catch (err) {
    if (err instanceof LoadError) return { status: 'refused', agentFile: path.join(projectRoot, AGENT_FILE), error: err.message };
    throw err;
  }
  const agentFile = targetPath(layers, scope);
  const text = targetText(layers, scope);
  let view: View;
  try {
    view = viewOf(layers, scope, layers.globalText, layers.projectText);
  } catch (err) {
    if (err instanceof LoadError) return { status: 'refused', agentFile, error: err.message };
    throw err;
  }
  const listed = options.listedModels === undefined ? null : new Set(options.listedModels);
  const globalNamed = namedIn(layers.globalText);
  const project = view.project ?? emptyCatalog(layers.agentFile);
  const fromProject = (own: boolean) => (scope === 'project' && own ? 'project' : 'global');
  // What the global file holds itself, to tell where this project overrides it; the global scope lists those values already.
  const globalTiers = scope === 'project' && layers.globalText !== null ? catalogOf(layers, layers.globalText, null, false).tiers : new Map<string, ModelTier>();
  const globalLimits = scope === 'project' ? numericLimits(layers.globalText) : new Map<string, number>();

  const tiers: TierState[] = [...view.tiers].map(([tier, t]) => {
    const own = view.projectNamed.tiers.get(tier) === true;
    const global = scope === 'project' && own ? globalTiers.get(tier) : undefined;
    return {
      tier,
      host: t.host,
      model: t.model,
      thinking: t.thinking,
      source: fromProject(own),
      dependents: dependentsOf(project, tier),
      otherHost: options.host !== undefined && t.host !== options.host,
      listed: listed === null ? null : listed.has(t.model),
      ...(global !== undefined ? { global: { host: global.host, model: global.model, thinking: global.thinking } } : {}),
    };
  });
  const byOverride = extraModels(view, scope);
  const tierModels = new Set(tiers.map((t) => t.model));
  const limits: LimitState[] = [...view.limits].map(([model, parallel]) => {
    const using = tiers.filter((t) => t.model === model).map((t) => t.tier);
    const overrideOnly = using.length === 0 && byOverride.has(model);
    const own = typeof view.projectNamed.limits.get(model) === 'number';
    const global = scope === 'project' && own ? globalLimits.get(model) : undefined;
    return {
      model,
      parallel,
      source: fromProject(own),
      tiers: using,
      overrideOnly,
      unused: using.length === 0 && !overrideOnly,
      ...(global !== undefined ? { global: { parallel: global } } : {}),
    };
  });
  const unused = limits.find((l) => l.unused);
  const problem =
    view.problem ?? (unused === undefined ? undefined : `model "${unused.model}": no tier or tier override uses it, so it cannot have a parallel limit in ${agentFile}`);
  const endpoints = legacyOf(layers);
  const snapshot: SetupSnapshot = {
    agentFile,
    scope,
    fileFingerprint: text === null ? null : sha256(text),
    tiers,
    limits,
    overrideOnlyModels: [...byOverride].filter((m) => !tierModels.has(m)),
    overridden: overriddenIn(globalNamed, view.projectNamed),
    endpoints,
  };
  const elsewhere = endpoints.filter((e) => e.scope !== scope);
  if (elsewhere.length > 0) {
    const file = elsewhere[0]!.file;
    const what = elsewhere.map(endpointsKeyText).join('; ');
    return {
      status: 'repair-other-first',
      problem: `${file} holds "endpoints:", which "models.parallel" replaced (${what}): repair it first, in a step of its own`,
      repairFirst: { scope: otherScope(scope), file },
      ...snapshot,
    };
  }
  const own = endpoints.filter((e) => e.scope === scope);
  if (own.length > 0) {
    return {
      status: 'repairable',
      problem: `${agentFile} holds "endpoints:", which "models.parallel" replaced (${own.map(endpointsKeyText).join('; ')}): setup removes it and gives each model a limit, pre-filled with the old value`,
      ...snapshot,
    };
  }
  if (problem !== undefined) return { status: 'repairable', problem, ...snapshot };
  return { status: text === null ? 'no-file' : 'ok', ...snapshot };
}

function nonEmpty(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/.test(value)) {
    throw new ChangeSetError(`${what} must be a non-empty one-line string`);
  }
  return value;
}

function tierRank(tier: string): number {
  const at = TIER_WORDS.findIndex((w) => w.tier === tier);
  return at === -1 ? TIER_WORDS.length : at;
}

/**
 * Validate a change set and put it in its canonical order: tiers small, medium, large,
 * then the rest by name, then limits by model. Two changes to one tier or one
 * model are rejected, as is a limit that is not a positive whole number.
 */
export function normalizeChangeSet(changes: readonly Change[]): Change[] {
  if (!Array.isArray(changes)) throw new ChangeSetError('a change set must be a list of changes');
  const seen = new Set<string>();
  const out: Change[] = [];
  const once = (key: string, label: string) => {
    if (seen.has(key)) throw new ChangeSetError(`${label} is changed twice in one change set`);
    seen.add(key);
  };
  for (const raw of changes as unknown[]) {
    if (!isRecord(raw)) throw new ChangeSetError('each change must be an object');
    switch (raw.op) {
      case 'setTier': {
        const tier = nonEmpty(raw.tier, 'a tier name');
        const model = nonEmpty(raw.model, `the model of tier "${tier}"`);
        if (!isThinkingLevel(raw.thinking)) {
          throw new ChangeSetError(`tier "${tier}": thinking must be one of ${THINKING_LEVELS.join(', ')}`);
        }
        once(`tier:${tier}`, `tier "${tier}"`);
        out.push({ op: 'setTier', tier, model, thinking: raw.thinking });
        break;
      }
      case 'unsetTier': {
        const tier = nonEmpty(raw.tier, 'a tier name');
        once(`tier:${tier}`, `tier "${tier}"`);
        out.push({ op: 'unsetTier', tier });
        break;
      }
      case 'setLimit': {
        const model = nonEmpty(raw.model, 'a model name');
        const parallel = raw.parallel;
        if (typeof parallel !== 'number' || !Number.isSafeInteger(parallel) || parallel < 1) {
          throw new ChangeSetError(`model "${model}": parallel must be a positive whole number`);
        }
        once(`model:${model}`, `model "${model}"`);
        out.push({ op: 'setLimit', model, parallel });
        break;
      }
      case 'clearLimit': {
        const model = nonEmpty(raw.model, 'a model name');
        once(`model:${model}`, `model "${model}"`);
        out.push({ op: 'clearLimit', model });
        break;
      }
      default:
        throw new ChangeSetError(`unknown change "${String(raw.op)}"; expected setTier, unsetTier, setLimit or clearLimit`);
    }
  }
  const key = (c: Change): [number, number, string] =>
    'tier' in c ? [0, tierRank(c.tier), c.tier] : [1, 0, c.model];
  return out.sort((x, y) => {
    const [a, b] = [key(x), key(y)];
    return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
  });
}

/** Preview a change set against the file of the scope as it is now. Writes nothing. */
export function previewChanges(projectRoot: string, changes: readonly Change[], starter: SetupStarterSpec, scope: SetupScope = 'project'): SetupPreview {
  return plan(readLayers(projectRoot), scope, normalizeChangeSet(changes), starter);
}

/**
 * Write a previewed change set. Refuses when the files or the change set differ from
 * the preview the fingerprint came from, or the change set holds a refused change.
 * Writes nothing when there is nothing to change.
 */
export function applyChanges(
  projectRoot: string,
  changes: readonly Change[],
  fingerprint: string,
  starter: SetupStarterSpec,
  scope: SetupScope = 'project',
): SetupApplyResult {
  const preview = plan(readLayers(projectRoot), scope, normalizeChangeSet(changes), starter);
  if (preview.fingerprint !== fingerprint) throw new SetupConflictError();
  if (preview.refusals.length > 0) throw new SetupRefusedError(preview.refusals);
  if (preview.invalid !== undefined) throw new LoadError(preview.invalid);
  if (preview.nothingToChange) return { ...preview, written: false };
  try {
    writeAtomic(preview.agentFile, preview.text);
  } catch (err) {
    if (isErrnoException(err)) throw new SetupWriteError(scope === 'global' ? preview.agentFile : path.relative(projectRoot, preview.agentFile), err);
    throw err;
  }
  return { ...preview, written: true };
}

function describeTier(t: ModelTier): string {
  return `${t.host} ${t.model} (thinking ${t.thinking})`;
}

function sameTier(a: ModelTier, b: ModelTier): boolean {
  return a.host === b.host && a.model === b.model && a.thinking === b.thinking;
}

function plan(l: Layers, scope: SetupScope, changes: Change[], starter: SetupStarterSpec): SetupPreview {
  const agentFile = targetPath(l, scope);
  const text = targetText(l, scope);
  if (scope === 'project' && isSameFile(l.agentFile, l.globalPath)) {
    // Writing the project file would put project-only keys into the global file.
    return {
      agentFile,
      scope,
      fileExists: l.globalText !== null,
      changes,
      refusals: [{ change: null, message: projectIsGlobal(l.globalPath) }],
      droppedLimits: [],
      prefilled: [],
      repairs: [],
      overridden: { tiers: [], limits: [] },
      text: l.globalText ?? '',
      diff: '',
      summary: [],
      nothingToChange: true,
      fingerprint: sha256(JSON.stringify({ file: l.globalText, changes, scope, host: starter.host, shared: true })),
    };
  }
  const other = scope === 'global' ? l.projectText : l.globalText;
  const view = viewOf(l, scope, l.globalText, l.projectText);
  const own = namedIn(text);
  // The project scope inherits the global file's entries, and writes a removal entry for one it removes.
  const inherited = scope === 'project' ? namedIn(l.globalText) : namedIn(null);
  const inheritsTier = (tier: string) => inherited.tiers.get(tier) === true;
  const inheritsLimit = (model: string) => typeof inherited.limits.get(model) === 'number';
  const hasLimit = (model: string) => typeof own.limits.get(model) === 'number';
  // A file that holds `endpoints:` is repaired by this preview: the map goes and its models get limits of their own.
  const repairs = legacyOf(l).filter((e) => e.file === agentFile);
  const repairing = repairs.length > 0;
  const changesTiers = changes.some((c) => 'tier' in c);

  const refusals: Refusal[] = [];
  const summary: string[] = [];
  const finalTiers = new Map(view.tiers);
  const setTiers = new Map<string, ModelTier>();
  const unsetTiers: string[] = [];
  for (const change of changes) {
    if (change.op === 'setTier') {
      const tier: ModelTier = { host: starter.host, model: change.model, thinking: change.thinking };
      const before = view.tiers.get(change.tier);
      if (before !== undefined && sameTier(before, tier)) continue;
      summary.push(
        before === undefined
          ? `add tier ${change.tier}: ${describeTier(tier)}`
          : `tier ${change.tier}: ${describeTier(before)} -> ${describeTier(tier)}`,
      );
      setTiers.set(change.tier, tier);
      finalTiers.set(change.tier, tier);
    } else if (change.op === 'unsetTier') {
      // Removing a global tier leaves a project that defines or removes the tier itself as it is.
      const keptByProject = scope === 'global' && view.projectNamed.tiers.has(change.tier);
      const agents = keptByProject || view.project === null ? [] : dependentsOf(view.project, change.tier);
      if (change.tier === DEFAULT_TIER) {
        refusals.push({ change, message: 'the medium tier cannot be removed: every agent without its own tier runs on it' });
      } else if (!view.tiers.has(change.tier)) {
        refusals.push({ change, message: `tier "${change.tier}" is not configured, so it cannot be removed` });
      } else if (agents.length > 0) {
        refusals.push({
          change,
          agents,
          message: `tier "${change.tier}" cannot be removed: ${agents.join(', ')} ${agents.length === 1 ? 'uses' : 'use'} it through tier: or tiers.${change.tier}`,
        });
      } else {
        summary.push(`remove tier ${change.tier}`);
        unsetTiers.push(change.tier);
        finalTiers.delete(change.tier);
      }
    }
  }
  // The project scope counts the inherited medium tier; the global scope the project's own. A repair that sets no tier leaves a missing medium tier to the next step.
  const noMediumTier = !finalTiers.has(DEFAULT_TIER) && !(scope === 'global' && view.projectNamed.tiers.get(DEFAULT_TIER) === true);
  const mediumPending = noMediumTier && repairing && !changesTiers;
  if (noMediumTier && !mediumPending) refusals.push({ change: null, message: 'the medium tier is required: choose a model for it' });

  // Every limit either file holds, whether or not a tier or override uses its model now: a tier that moves onto the model makes an inherited limit count.
  const allLimits = new Map<string, number>();
  for (const [model, parallel] of [...(scope === 'project' ? inherited.limits : []), ...own.limits]) {
    if (parallel === null) allLimits.delete(model);
    else allLimits.set(model, parallel);
  }
  const used = extraModels(view, scope);
  for (const t of finalTiers.values()) used.add(t.model);
  // The old limit of an `endpoints:` entry goes to each model it covered that the change set leaves alone and the file has no limit of its own for; one model several entries cover keeps the smallest.
  const prefilled = new Map<string, PrefilledLimit>();
  const named = new Set(changes.flatMap((c) => (c.op === 'setLimit' || c.op === 'clearLimit' ? [c.model] : [])));
  for (const entry of repairs) {
    if (entry.parallel === null) continue;
    for (const model of entry.models) {
      const before = prefilled.get(model);
      if (named.has(model) || hasLimit(model) || !used.has(model) || (before !== undefined && before.parallel <= entry.parallel)) continue;
      prefilled.set(model, { model, parallel: entry.parallel, endpoint: entry.endpoint });
    }
  }
  const limitChanges: Change[] = [...changes, ...[...prefilled.values()].map((p): Change => ({ op: 'setLimit', model: p.model, parallel: p.parallel }))];
  const finalLimits = new Map(allLimits);
  const setLimits = new Map<string, number>();
  const clearedLimits: string[] = [];
  const droppedLimits: string[] = [];
  for (const change of limitChanges) {
    if (change.op === 'setLimit') {
      if (!used.has(change.model)) {
        refusals.push({
          change,
          message: `model "${change.model}": no tier or tier override uses it, so it cannot have a parallel limit`,
        });
        continue;
      }
      const before = allLimits.get(change.model);
      if (before === change.parallel) continue;
      const from = prefilled.get(change.model);
      const why = from === undefined ? '' : ` (the old limit of endpoint ${from.endpoint})`;
      summary.push(
        before === undefined
          ? `model ${change.model}: parallel limit ${change.parallel}${why}`
          : `model ${change.model}: parallel limit ${before} -> ${change.parallel}${why}`,
      );
      setLimits.set(change.model, change.parallel);
      finalLimits.set(change.model, change.parallel);
    } else if (change.op === 'clearLimit' && allLimits.has(change.model)) {
      summary.push(`model ${change.model}: remove the parallel limit`);
      clearedLimits.push(change.model);
      finalLimits.delete(change.model);
    }
  }
  for (const model of allLimits.keys()) {
    if (!finalLimits.has(model) || used.has(model)) continue;
    finalLimits.delete(model);
    // A limit only the global file holds is ignored where no model uses it, so the project file has nothing to remove.
    if (typeof own.limits.get(model) !== 'number') continue;
    summary.push(`model ${model}: remove the parallel limit, no tier or override uses it any more`);
    droppedLimits.push(model);
  }
  for (const entry of repairs) summary.push(`remove endpoints.${entry.endpoint}${entry.parallel === null ? '' : ` (limit ${entry.parallel})`}, which models.parallel replaced`);

  // Pass 1 edits the original in place: replace tier fields and limits, remove entries.
  const hasTier = (name: string) => own.tiers.get(name) === true;
  const original = text ?? '';
  const first = createSplicer(original);
  const edits: Edit[] = [];
  for (const [name, tier] of setTiers) if (hasTier(name)) edits.push(...replaceTier(first.doc, name, tier));
  // An entry the file holds is deleted when removed, or when a removal entry gives way to a value; the project scope then writes a removal entry for an inherited tier.
  const goneTiers = [...unsetTiers.filter((t) => own.tiers.has(t)), ...[...setTiers.keys()].filter((t) => own.tiers.get(t) === false)];
  const goneLimits = [...clearedLimits, ...droppedLimits, ...[...setLimits.keys()].filter((m) => own.limits.has(m) && !hasLimit(m))].filter((m) => own.limits.has(m));
  // A whole-file flow map keeps its sections: a section created again would land after its closing brace, and an emptied flow map is a valid empty map.
  const blockRoot = isMap(first.doc.contents) && first.doc.contents.flow !== true;
  // A tiers or parallel map left with no entry would be an empty value, which the loader rejects: it goes whole, and an emptied models with it. New entries then create them again.
  const tiersGoneAll = blockRoot && goneTiers.length > 0 && [...own.tiers.keys()].every((t) => goneTiers.includes(t));
  const limitsGoneAll = blockRoot && goneLimits.length > 0 && [...own.limits.keys()].every((m) => goneLimits.includes(m));
  const emptied = [...(tiersGoneAll ? ['tiers'] : []), ...(limitsGoneAll ? ['parallel'] : [])];
  const modelsNode = first.doc.get('models', true);
  const wholeModels = emptied.length > 0 && isMap(modelsNode) && modelsNode.items.length === emptied.length;
  if (wholeModels) edits.push(...deleteEntries(first, [], ['models']));
  else {
    edits.push(...deleteEntries(first, ['models'], emptied));
    if (!tiersGoneAll) edits.push(...deleteEntries(first, ['models', 'tiers'], goneTiers));
    if (!limitsGoneAll) edits.push(...deleteEntries(first, ['models', 'parallel'], goneLimits));
  }
  for (const [model, parallel] of setLimits) {
    if (hasLimit(model)) edits.push(replaceScalar(first.doc, ['models', 'parallel', model], parallel));
  }
  // The old map goes with the comment lines attached to it.
  if (repairing) edits.push(...deleteEntries(first, [], ['endpoints']));
  // Pass 2 adds new entries to the edited text.
  const second = edits.length === 0 ? first : createSplicer(applyEdits(original, edits));
  const newTiers: Record<string, ModelTier | null> = Object.fromEntries([...setTiers].filter(([name]) => !hasTier(name)));
  for (const tier of unsetTiers) if (scope === 'project' && inheritsTier(tier)) newTiers[tier] = null;
  const newLimits: Record<string, number | null> = Object.fromEntries([...setLimits].filter(([m]) => !hasLimit(m)));
  for (const model of clearedLimits) if (scope === 'project' && inheritsLimit(model)) newLimits[model] = null;
  spliceModels(second, newTiers, newLimits);
  const next = second.result();

  let invalid: string | undefined;
  if (!noMediumTier || mediumPending) {
    // A file that loads with delegation's rules now must still load with them: setup does not write what stops delegation. A file already broken stays checked as before.
    // A repair of a file with `endpoints:` leaves the other file's map, a missing medium tier and an unused limit to the next step.
    const strictBefore = loadsStrictly(l);
    const legacy = repairing;
    try {
      if (scope === 'project') {
        const result = catalogOf(l, l.globalText, next, false, legacy);
        if (!sameTiers(result.tiers, finalTiers) || !sameLimits(result.limits, finalLimits)) invalid = MISMATCH;
        if (invalid === undefined && strictBefore) strictCatalogOf(l, l.globalText, next);
      } else {
        const result = catalogOf(l, next, null, false, legacy);
        if (!sameTiers(result.tiers, finalTiers) || !sameLimits(numericLimits(next), finalLimits)) invalid = MISMATCH;
        // The change must leave this project loading, with its own limits counted as delegation counts them.
        if (invalid === undefined && view.project !== null) {
          if (strictBefore) strictCatalogOf(l, next, l.projectText);
          else catalogOf(l, next, l.projectText, true, legacy);
        }
      }
    } catch (err) {
      if (!(err instanceof LoadError)) throw err;
      invalid = err.message;
    }
  }

  const overridden: Overridden = { tiers: [], limits: [] };
  if (scope === 'global') {
    const named = view.projectNamed;
    overridden.tiers = [...setTiers.keys(), ...unsetTiers].filter((t) => named.tiers.has(t));
    overridden.limits = [...setLimits.keys(), ...clearedLimits].filter((m) => named.limits.has(m));
  }

  const fingerprint = sha256(JSON.stringify({ file: text, other, changes, scope, host: starter.host }));
  return {
    agentFile,
    scope,
    fileExists: text !== null,
    changes,
    refusals,
    droppedLimits,
    prefilled: [...prefilled.values()].filter((p) => setLimits.get(p.model) === p.parallel),
    repairs,
    overridden,
    text: next,
    diff: next === original ? '' : unifiedDiff(text, next, scope === 'global' ? agentFile : AGENT_FILE),
    summary,
    nothingToChange: next === original,
    ...(invalid !== undefined ? { invalid } : {}),
    fingerprint,
  };
}

const MISMATCH = 'the edited agent file does not hold the previewed tiers and limits; edit it by hand';

function sameTiers(got: Map<string, ModelTier>, want: Map<string, ModelTier>): boolean {
  return got.size === want.size && [...want].every(([n, t]) => {
    const tier = got.get(n);
    return tier !== undefined && sameTier(tier, t);
  });
}

function sameLimits(got: Map<string, number>, want: Map<string, number>): boolean {
  return got.size === want.size && [...want].every(([m, n]) => got.get(m) === n);
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

type Range = [number, number, number];

function rangeOf(node: unknown): Range | undefined {
  const range = (node as { range?: Range | null } | null | undefined)?.range;
  return range ?? undefined;
}

function applyEdits(text: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let next = text;
  let limit = Infinity;
  for (const edit of sorted) {
    if (edit.end > limit) throw new Error('internal: overlapping edits to the agent file');
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
    limit = edit.start;
  }
  return next;
}

function replaceScalar(doc: Document, keys: string[], value: string | number): Edit {
  const node = doc.getIn(keys, true);
  const range = rangeOf(node);
  if (!isScalar(node) || range === undefined) throw new LoadError(`agent file: ${keys.join('.')} is not a plain value setup can edit`);
  return { start: range[0], end: range[1], text: yamlKey(value) };
}

/** Replace the fields of a tier that change, keeping the rest of its text. */
function replaceTier(doc: Document, name: string, tier: ModelTier): Edit[] {
  const node = doc.getIn(['models', 'tiers', name], true);
  if (isMap(node)) {
    const edits: Edit[] = [];
    let whole = false;
    for (const field of ['host', 'model', 'thinking'] as const) {
      const pair = node.items.find((p) => isScalar(p.key) && p.key.value === field);
      if (pair === undefined || !isScalar(pair.value) || rangeOf(pair.value) === undefined) {
        whole = true;
        break;
      }
      if (pair.value.value !== tier[field]) edits.push(replaceScalar(doc, ['models', 'tiers', name, field], tier[field]));
    }
    if (!whole) return edits;
  }
  const range = rangeOf(node);
  if (range === undefined) throw new LoadError(`agent file: tier "${name}" is not a value setup can edit`);
  return [{ start: range[0], end: range[1], text: flowYaml({ host: tier.host, model: tier.model, thinking: tier.thinking }) }];
}

function lineEnd(text: string, from: number): number {
  const nl = text.indexOf('\n', from);
  return nl === -1 ? text.length : nl + 1;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Remove entries of one map. In a block map each entry's lines go, with the comment
 * lines directly above it at its indent. In a flow map each run of adjacent removed
 * entries goes as one range with one separating comma, so the edits never overlap.
 */
function deleteEntries(s: Splicer, mapKeys: string[], keys: string[]): Edit[] {
  if (keys.length === 0) return [];
  const text = s.original;
  const map = mapKeys.length === 0 ? s.doc.contents : s.doc.getIn(mapKeys, true);
  if (!isMap(map)) throw new LoadError(`agent file: ${mapKeys.join('.') || 'the document'} must be a map for setup to remove "${keys[0]}"`);
  const items = map.items as Pair[];
  const removed = new Map<number, string>();
  for (const key of keys) {
    const at = items.findIndex((p) => isScalar(p.key) && p.key.value === key);
    if (at === -1 || rangeOf(items[at]!.key) === undefined) throw new LoadError(`agent file: "${key}" was not found where setup expected it`);
    removed.set(at, key);
  }
  const keyStart = (pair: Pair) => rangeOf(pair.key)![0];
  const valueEnd = (pair: Pair) => rangeOf(pair.value)?.[1] ?? rangeOf(pair.key)![1];

  if (map.flow !== true) return [...removed].map(([at, key]) => deleteBlockEntry(text, keyStart(items[at]!), key));

  // A flow map that loses every entry becomes `{}` in one edit: nothing inside it (newlines, comments, a trailing comma) can leave stray punctuation, and the bytes around it stay.
  const mapRange = rangeOf(map);
  if (removed.size === items.length && mapRange !== undefined) return [{ start: mapRange[0], end: mapRange[1], text: '{}' }];

  const edits: Edit[] = [];
  for (let first = 0; first < items.length; first++) {
    if (!removed.has(first)) continue;
    let last = first;
    while (removed.has(last + 1)) last++;
    const next = items[last + 1];
    const prev = items[first - 1];
    if (next !== undefined) edits.push({ start: keyStart(items[first]!), end: keyStart(next), text: '' });
    else if (prev !== undefined) edits.push({ start: valueEnd(prev), end: valueEnd(items[last]!), text: '' });
    else {
      let end = valueEnd(items[last]!);
      while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
      if (text[end] === ',') end++;
      edits.push({ start: keyStart(items[first]!), end, text: '' });
    }
    first = last;
  }
  return edits;
}

/** The range of one block-map entry starting at keyStart: its lines and attached comments. */
function deleteBlockEntry(text: string, keyStart: number, key: string): Edit {
  const lineStart = text.lastIndexOf('\n', keyStart - 1) + 1;
  if (text.slice(lineStart, keyStart).trim() !== '') {
    throw new LoadError(`agent file: "${key}" does not start its own line, so setup cannot remove it`);
  }
  const indent = keyStart - lineStart;
  let end = lineEnd(text, lineStart);
  for (let cursor = end; cursor < text.length; ) {
    const next = lineEnd(text, cursor);
    const line = text.slice(cursor, next).replace(/\r?\n$/, '');
    if (line.trim() !== '') {
      if (indentOf(line) <= indent) break;
      end = next;
    }
    cursor = next;
  }
  let start = lineStart;
  while (start > 0) {
    const prevStart = text.lastIndexOf('\n', start - 2) + 1;
    const line = text.slice(prevStart, start - 1).replace(/\r$/, '');
    if (!line.trimStart().startsWith('#') || indentOf(line) !== indent) break;
    start = prevStart;
  }
  // Between two blank lines, take one with the entry so no double blank is left.
  const blankBefore = start === 0 || text.slice(text.lastIndexOf('\n', start - 2) + 1, start).trim() === '';
  const after = lineEnd(text, end);
  if (blankBefore && end < text.length && text.slice(end, after).trim() === '') end = after;
  return { start, end, text: '' };
}

/**
 * Plan new tiers into models.tiers and new limits into models.parallel, creating models and either map when
 * missing. When models.tiers and models.parallel are both new they are created in one edit, so the
 * text never gets two `models` keys or two inserts at one spot.
 */
function spliceModels(s: Splicer, tiers: Record<string, ModelTier | null>, limits: Record<string, number | null>): void {
  if (Object.keys(limits).length === 0) return spliceTiers(s, tiers);
  const limitLines = (indent: string) =>
    Object.entries(limits)
      .map(([m, n]) => `${indent}${yamlKey(m)}:${n === null ? '' : ` ${n}`}\n`)
      .join('');
  const tierLines = (indent: string) =>
    Object.entries(tiers)
      .map(([name, tier]) => `${indent}${yamlKey(name)}:${tier === null ? '' : ` ${flowYaml({ host: tier.host, model: tier.model, thinking: tier.thinking })}`}\n`)
      .join('');
  const bothNew = Object.keys(tiers).length > 0 && !s.doc.hasIn(['models', 'tiers']) && !s.doc.hasIn(['models', 'parallel']);
  if (!bothNew) {
    // New tiers go after the last tier and a new parallel map to the end of models: one spot when tiers is the last key, so one edit, because two edits at one spot would nest the second under the first.
    if (Object.keys(tiers).length > 0 && s.doc.hasIn(['models', 'tiers']) && !s.doc.hasIn(['models', 'parallel'])) {
      const blockAt = (keys: string[]) => {
        const node = s.doc.getIn(keys, true);
        return isMap(node) && node.flow !== true && node.items.length > 0 ? s.mapAt(keys) : undefined;
      };
      const tiersAt = blockAt(['models', 'tiers']);
      const models = blockAt(['models']);
      if (tiersAt !== undefined && models !== undefined && tiersAt.end === models.end) {
        s.insert(tiersAt.end, `${tierLines(tiersAt.indent)}${models.indent}parallel:\n${limitLines(`${models.indent}  `)}`);
        return;
      }
    }
    spliceTiers(s, tiers);
    if (s.insertInline(['models', 'parallel'], limits)) return;
    if (!s.doc.hasIn(['models', 'parallel']) && s.insertInline(['models'], { parallel: limits })) return;
    const at = s.mapAt(['models', 'parallel']);
    const models = at === undefined ? s.mapAt(['models']) : undefined;
    if (at !== undefined) s.insert(at.end, limitLines(at.indent));
    else if (models !== undefined) s.insert(models.end, `${models.indent}parallel:\n${limitLines(`${models.indent}  `)}`);
    else if (s.doc.has('models')) throw new LoadError('agent file: models must be a map for setup to add a limit to it');
    else s.append(`models:\n  parallel:\n${limitLines('    ')}`);
    return;
  }
  if (s.insertInline(['models'], { tiers, parallel: limits })) return;
  const models = s.mapAt(['models']);
  if (models !== undefined) s.insert(models.end, `${models.indent}tiers:\n${tierLines(`${models.indent}  `)}${models.indent}parallel:\n${limitLines(`${models.indent}  `)}`);
  else s.append(`models:\n  tiers:\n${tierLines('    ')}  parallel:\n${limitLines('    ')}`);
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/** A unified diff with two lines of context; empty when the texts are equal. */
function unifiedDiff(before: string | null, after: string, label: string, context = 2): string {
  if (before === after) return '';
  const a = splitLines(before ?? '');
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: { op: ' ' | '-' | '+'; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ op: ' ', line: a[i++]! });
      j++;
    } else if (j >= m || (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) ops.push({ op: '-', line: a[i++]! });
    else ops.push({ op: '+', line: b[j++]! });
  }

  const hunks: [number, number][] = [];
  ops.forEach((o, k) => {
    if (o.op === ' ') return;
    const from = Math.max(0, k - context);
    const to = Math.min(ops.length, k + context + 1);
    const last = hunks.at(-1);
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  });
  const out = [`--- ${before === null ? '/dev/null' : label}`, `+++ ${label}`];
  for (const [from, to] of hunks) {
    const preceding = ops.slice(0, from);
    const hunk = ops.slice(from, to);
    const aStart = preceding.filter((o) => o.op !== '+').length;
    const bStart = preceding.filter((o) => o.op !== '-').length;
    const aLen = hunk.filter((o) => o.op !== '+').length;
    const bLen = hunk.filter((o) => o.op !== '-').length;
    out.push(`@@ -${aLen === 0 ? aStart : aStart + 1},${aLen} +${bLen === 0 ? bStart : bStart + 1},${bLen} @@`);
    for (const o of hunk) out.push(`${o.op}${o.line}`);
  }
  return out.join('\n') + '\n';
}

/**
 * Write the agent file (the real file behind a link) through a temp file next to it, created exclusively so an
 * existing path or symlink is never followed, then renamed into place. The temp
 * file is removed on any failure; the original is untouched until the rename.
 */
function writeAtomic(requested: string, text: string): void {
  // An existing file may be a link (a dotfiles repo): the temp file goes next to the real file, and the rename replaces it, not the link.
  let file = requested;
  try {
    file = realpathSync(requested);
  } catch {
    // A new file is created where it is asked for.
  }
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
  let mode = 0o644;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    // A new file gets the default mode.
  }
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(tmp, 'wx', mode);
    created = true;
    fchmodSync(fd, mode);
    writeFileSync(fd, text);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed or never usable; the unlink below still runs.
      }
    }
    if (created) {
      try {
        unlinkSync(tmp);
      } catch {
        // Nothing more to clean up.
      }
    }
    throw err;
  }
}
