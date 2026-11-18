// @sigil implements design/agent-config.sigil AgentConfig (guided setup editor)
//
// Reads the tiers, endpoint limits and tier dependents of the layered agent files for
// guided init, previews a change set to one of them, and applies a previewed change
// set. The scope picks the file: the project's .agents/subzero.yaml or the general
// file. Edits splice the existing text, so every line a change does not touch keeps
// its bytes, and setup never adds an agent. A preview is bound to its apply by a
// fingerprint over the layers' text, the change set and the scope; the result is
// validated with the load rules delegation uses and written atomically, because
// running delegations re-read the files on every call.
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
  generalFile,
  isRecord,
  isSameFile,
  isThinkingLevel,
  LoadError,
  modelEndpoint,
  PROJECT_IS_GENERAL,
  ProjectDisabledError,
  readGeneralText,
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

/** The file a change writes: the project's agent file, or the general file every project reads. */
export type SetupScope = 'general' | 'project';

export type Change =
  | { op: 'setTier'; tier: string; model: string; thinking: ThinkingLevel }
  | { op: 'unsetTier'; tier: string }
  | { op: 'setLimit'; endpoint: string; parallel: number }
  | { op: 'clearLimit'; endpoint: string };

/** A change set that cannot be previewed at all: a malformed change, or two changes to one tier or endpoint. */
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
  endpoint: string;
  /** The file the tier comes from. */
  source: SetupScope;
  /** Agents of this project that name this tier through `tier:` or a `tiers.<t>` override, in file order. */
  dependents: string[];
  /** True when the caller named a host and the tier runs on another one. */
  otherHost: boolean;
  /** Whether the caller's model list holds the model; null when no list was given. */
  listed: boolean | null;
}

export interface LimitState {
  endpoint: string;
  parallel: number;
  /** The file the limit comes from. */
  source: SetupScope;
  /** Tiers whose model belongs to the endpoint. */
  tiers: string[];
  /** No tier uses the endpoint, an agent override model does: the limit is kept and not asked about. */
  overrideOnly: boolean;
  /** No model belongs to the endpoint: setup drops the limit. */
  unused: boolean;
}

/** The tier and endpoint names this project's agent file names, as an override or a removal of the general file's. */
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
  /** The project scope lists the merged tiers, the general scope the general file's. */
  tiers: TierState[];
  limits: LimitState[];
  /** Endpoints that only agent override models use. */
  overrideOnlyEndpoints: string[];
  /** The tiers and limits of the general file that this project's agent file overrides or removes. */
  overridden: Overridden;
}

export type SetupState =
  | ({ status: 'ok' | 'no-file' } & SetupSnapshot)
  /** The file fails to load only for what setup repairs: a limit no model uses. */
  | ({ status: 'repairable'; problem: string } & SetupSnapshot)
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
  /** The file the write goes to: the project's agent file, or the general file. */
  agentFile: string;
  scope: SetupScope;
  fileExists: boolean;
  /** The normalized change set the fingerprint covers. */
  changes: Change[];
  refusals: Refusal[];
  /** Endpoints whose limit is removed because no model uses them after the change. */
  droppedLimits: string[];
  /** For a general-scope preview, what this project's agent file overrides: the change does not apply here. */
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

export interface SetupApplyResult extends SetupPreview {
  written: boolean;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The two files' text, as they are now. */
interface Layers {
  agentFile: string;
  generalPath: string;
  generalText: string | null;
  projectText: string | null;
}

function readLayers(projectRoot: string): Layers {
  const agentFile = path.join(projectRoot, AGENT_FILE);
  const generalPath = generalFile();
  // A project rooted at the home folder: the one file is the general layer, and the project has no file of its own.
  const projectText = isSameFile(agentFile, generalPath) ? null : readTextOrNull(agentFile);
  return { agentFile, generalPath, generalText: readGeneralText(generalPath), projectText };
}

const targetPath = (l: Layers, scope: SetupScope) => (scope === 'general' ? l.generalPath : l.agentFile);
const targetText = (l: Layers, scope: SetupScope) => (scope === 'general' ? l.generalText : l.projectText);

/** Load text as the layers it is; a missing medium tier, general or fallback is not a problem setup repairs. */
function catalogOf(l: Layers, general: string | null, project: string | null, lenient: boolean): AgentCatalog {
  return buildCatalog(general, project, {
    agentFile: l.agentFile,
    generalFile: l.generalPath,
    allowMissingStarter: true,
    ...(lenient ? { allowUnusedLimits: true } : {}),
  });
}

/** What one file names, before merging: a tier or limit with a value, or a removal entry. */
interface Named {
  tiers: Map<string, boolean>;
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
  const endpoints = isRecord(doc.endpoints) ? doc.endpoints : {};
  for (const [endpoint, raw] of Object.entries(endpoints)) {
    out.limits.set(endpoint, isRecord(raw) && typeof raw.parallel === 'number' ? raw.parallel : null);
  }
  return out;
}

/** The parallel limits a file sets as numbers, leaving out removal entries. */
function numericLimits(text: string | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const [endpoint, parallel] of namedIn(text).limits) if (parallel !== null) out.set(endpoint, parallel);
  return out;
}

/** What setup sees of the layers at one scope. */
interface View {
  /** The tiers the scope lists: the merged ones for the project, the general file's for general. */
  tiers: Map<string, ModelTier>;
  /** The limits the scope lists, before any that no model uses is dropped. */
  limits: Map<string, number>;
  /** This project's merged catalog; null when the project has no file or is switched off. */
  project: AgentCatalog | null;
  /** What the project file names, empty when the project does not read the general file. */
  projectNamed: Named;
  /** The load error setup repairs, when there is one. */
  problem?: string;
}

/** Load the layers at a scope with the text given. A load error is the file's, for the caller to refuse. */
function viewOf(l: Layers, scope: SetupScope, general: string | null, project: string | null): View {
  if (scope === 'project') {
    let problem: string | undefined;
    let catalog: AgentCatalog;
    try {
      catalog = catalogOf(l, general, project, false);
    } catch (strict) {
      if (!(strict instanceof LoadError)) throw strict;
      catalog = catalogOf(l, general, project, true);
      problem = strict.message;
    }
    return { tiers: catalog.tiers, limits: catalog.limits, project: catalog, projectNamed: namedIn(project), ...(problem !== undefined ? { problem } : {}) };
  }
  const own = catalogOf(l, general, null, false);
  const limits = numericLimits(general);
  let merged: AgentCatalog | null = null;
  if (project !== null) {
    try {
      merged = catalogOf(l, general, project, true);
    } catch (err) {
      if (!(err instanceof ProjectDisabledError)) throw err;
    }
  }
  return { tiers: own.tiers, limits, project: merged, projectNamed: merged === null ? namedIn(null) : namedIn(project) };
}

function emptyCatalog(agentFile: string): AgentCatalog {
  return { agentFile, entries: new Map(), tiers: new Map(), routing: { hook: true }, limits: new Map() };
}

function dependentsOf(catalog: AgentCatalog, tier: string): string[] {
  return [...catalog.entries.values()].filter((e) => e.tier === tier || e.overrides.has(tier)).map((e) => e.name);
}

function overrideEndpoints(catalog: AgentCatalog): Set<string> {
  const out = new Set<string>();
  for (const entry of catalog.entries.values()) {
    for (const override of entry.overrides.values()) if (override.model !== undefined) out.add(modelEndpoint(override.model));
  }
  return out;
}

/** Endpoints that this project's models use beyond the tiers the scope lists: agent overrides, and its own tiers when editing the general file. */
function extraEndpoints(view: View, scope: SetupScope): Set<string> {
  if (view.project === null) return new Set();
  const out = overrideEndpoints(view.project);
  if (scope === 'general') {
    for (const [name, tier] of view.project.tiers) if (view.projectNamed.tiers.get(name) === true) out.add(modelEndpoint(tier.model));
  }
  return out;
}

/** The tiers and limits of the general file that the project file names. */
function overriddenIn(general: Named, project: Named): Overridden {
  return {
    tiers: [...general.tiers.keys()].filter((t) => project.tiers.has(t)),
    limits: [...general.limits.keys()].filter((e) => project.limits.has(e)),
  };
}

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
    view = viewOf(layers, scope, layers.generalText, layers.projectText);
  } catch (err) {
    if (err instanceof LoadError) return { status: 'refused', agentFile, error: err.message };
    throw err;
  }
  const listed = options.listedModels === undefined ? null : new Set(options.listedModels);
  const generalNamed = namedIn(layers.generalText);
  const project = view.project ?? emptyCatalog(layers.agentFile);
  const fromProject = (own: boolean) => (scope === 'project' && own ? 'project' : 'general');

  const tiers: TierState[] = [...view.tiers].map(([tier, t]) => ({
    tier,
    host: t.host,
    model: t.model,
    thinking: t.thinking,
    endpoint: modelEndpoint(t.model),
    source: fromProject(view.projectNamed.tiers.get(tier) === true),
    dependents: dependentsOf(project, tier),
    otherHost: options.host !== undefined && t.host !== options.host,
    listed: listed === null ? null : listed.has(t.model),
  }));
  const byOverride = extraEndpoints(view, scope);
  const tierEndpoints = new Set(tiers.map((t) => t.endpoint));
  const limits: LimitState[] = [...view.limits].map(([endpoint, parallel]) => {
    const using = tiers.filter((t) => t.endpoint === endpoint).map((t) => t.tier);
    const overrideOnly = using.length === 0 && byOverride.has(endpoint);
    const own = typeof view.projectNamed.limits.get(endpoint) === 'number';
    return { endpoint, parallel, source: fromProject(own), tiers: using, overrideOnly, unused: using.length === 0 && !overrideOnly };
  });
  const unused = limits.find((l) => l.unused);
  const problem = view.problem ?? (unused === undefined ? undefined : `endpoint "${unused.endpoint}": no model of a tier or of a tier override belongs to it in ${agentFile}`);
  const snapshot: SetupSnapshot = {
    agentFile,
    scope,
    fileFingerprint: text === null ? null : sha256(text),
    tiers,
    limits,
    overrideOnlyEndpoints: [...byOverride].filter((e) => !tierEndpoints.has(e)),
    overridden: overriddenIn(generalNamed, view.projectNamed),
  };
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
 * then the rest by name, then limits by endpoint. Two changes to one tier or one
 * endpoint are rejected, as is a limit that is not a positive whole number.
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
        const endpoint = nonEmpty(raw.endpoint, 'an endpoint name');
        const parallel = raw.parallel;
        if (typeof parallel !== 'number' || !Number.isSafeInteger(parallel) || parallel < 1) {
          throw new ChangeSetError(`endpoint "${endpoint}": parallel must be a positive whole number`);
        }
        once(`endpoint:${endpoint}`, `endpoint "${endpoint}"`);
        out.push({ op: 'setLimit', endpoint, parallel });
        break;
      }
      case 'clearLimit': {
        const endpoint = nonEmpty(raw.endpoint, 'an endpoint name');
        once(`endpoint:${endpoint}`, `endpoint "${endpoint}"`);
        out.push({ op: 'clearLimit', endpoint });
        break;
      }
      default:
        throw new ChangeSetError(`unknown change "${String(raw.op)}"; expected setTier, unsetTier, setLimit or clearLimit`);
    }
  }
  const key = (c: Change): [number, number, string] =>
    'tier' in c ? [0, tierRank(c.tier), c.tier] : [1, 0, c.endpoint];
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
    if (isErrnoException(err)) throw new SetupWriteError(scope === 'general' ? preview.agentFile : path.relative(projectRoot, preview.agentFile), err);
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
  if (scope === 'project' && isSameFile(l.agentFile, l.generalPath)) {
    // Writing the project file would put project-only keys into the general file.
    return {
      agentFile,
      scope,
      fileExists: l.generalText !== null,
      changes,
      refusals: [{ change: null, message: PROJECT_IS_GENERAL }],
      droppedLimits: [],
      overridden: { tiers: [], limits: [] },
      text: l.generalText ?? '',
      diff: '',
      summary: [],
      nothingToChange: true,
      fingerprint: sha256(JSON.stringify({ file: l.generalText, changes, scope, host: starter.host, shared: true })),
    };
  }
  const other = scope === 'general' ? l.projectText : l.generalText;
  const view = viewOf(l, scope, l.generalText, l.projectText);
  const own = namedIn(text);
  // The project scope inherits the general file's entries, and writes a removal entry for one it removes.
  const inherited = scope === 'project' ? namedIn(l.generalText) : namedIn(null);
  const inheritsTier = (tier: string) => inherited.tiers.get(tier) === true;
  const inheritsLimit = (endpoint: string) => typeof inherited.limits.get(endpoint) === 'number';

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
      // Removing a general tier leaves a project that defines or removes the tier itself as it is.
      const keptByProject = scope === 'general' && view.projectNamed.tiers.has(change.tier);
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
  // The project scope counts the inherited medium tier; the general scope the project's own.
  const noMediumTier = !finalTiers.has(DEFAULT_TIER) && !(scope === 'general' && view.projectNamed.tiers.get(DEFAULT_TIER) === true);
  if (noMediumTier) refusals.push({ change: null, message: 'the medium tier is required: choose a model for it' });

  // Every limit either file holds, whether or not a model uses it now: a tier that moves onto its endpoint makes an inherited limit count.
  const allLimits = new Map<string, number>();
  for (const [endpoint, parallel] of [...(scope === 'project' ? inherited.limits : []), ...own.limits]) {
    if (parallel === null) allLimits.delete(endpoint);
    else allLimits.set(endpoint, parallel);
  }
  const used = extraEndpoints(view, scope);
  for (const t of finalTiers.values()) used.add(modelEndpoint(t.model));
  const finalLimits = new Map(allLimits);
  const setLimits = new Map<string, number>();
  const clearedLimits: string[] = [];
  const droppedLimits: string[] = [];
  for (const change of changes) {
    if (change.op === 'setLimit') {
      if (!used.has(change.endpoint)) {
        refusals.push({
          change,
          message: `endpoint "${change.endpoint}": no model of a tier or of a tier override belongs to it, so it cannot have a limit`,
        });
        continue;
      }
      const before = allLimits.get(change.endpoint);
      if (before === change.parallel) continue;
      summary.push(
        before === undefined
          ? `endpoint ${change.endpoint}: parallel limit ${change.parallel}`
          : `endpoint ${change.endpoint}: parallel limit ${before} -> ${change.parallel}`,
      );
      setLimits.set(change.endpoint, change.parallel);
      finalLimits.set(change.endpoint, change.parallel);
    } else if (change.op === 'clearLimit' && allLimits.has(change.endpoint)) {
      summary.push(`endpoint ${change.endpoint}: remove the parallel limit`);
      clearedLimits.push(change.endpoint);
      finalLimits.delete(change.endpoint);
    }
  }
  for (const endpoint of allLimits.keys()) {
    if (!finalLimits.has(endpoint) || used.has(endpoint)) continue;
    finalLimits.delete(endpoint);
    // A limit only the general file holds is ignored where no model uses it, so the project file has nothing to remove.
    if (typeof own.limits.get(endpoint) !== 'number') continue;
    summary.push(`endpoint ${endpoint}: remove the parallel limit, no model uses it any more`);
    droppedLimits.push(endpoint);
  }

  // Pass 1 edits the original in place: replace tier fields and limits, remove entries.
  const hasTier = (name: string) => own.tiers.get(name) === true;
  const hasLimit = (endpoint: string) => typeof own.limits.get(endpoint) === 'number';
  const original = text ?? '';
  const first = createSplicer(original);
  const edits: Edit[] = [];
  for (const [name, tier] of setTiers) if (hasTier(name)) edits.push(...replaceTier(first.doc, name, tier));
  // An entry the file holds is deleted when removed, or when a removal entry gives way to a value; the project scope then writes a removal entry for an inherited tier.
  const goneTiers = [...unsetTiers.filter((t) => own.tiers.has(t)), ...[...setTiers.keys()].filter((t) => own.tiers.get(t) === false)];
  edits.push(...deleteEntries(first, ['models', 'tiers'], goneTiers));
  const goneLimits = [...clearedLimits, ...droppedLimits, ...[...setLimits.keys()].filter((e) => own.limits.has(e) && !hasLimit(e))].filter((e) => own.limits.has(e));
  const keptLimits = [...own.limits.keys()].filter((e) => !goneLimits.includes(e));
  if (goneLimits.length > 0) {
    // A map left with no entry goes whole; new limits then create it again.
    edits.push(...(keptLimits.length === 0 ? deleteEntries(first, [], ['endpoints']) : deleteEntries(first, ['endpoints'], goneLimits)));
  }
  for (const [endpoint, parallel] of setLimits) {
    if (hasLimit(endpoint)) edits.push(replaceScalar(first.doc, ['endpoints', endpoint, 'parallel'], parallel));
  }
  // Pass 2 adds new entries to the edited text.
  const second = edits.length === 0 ? first : createSplicer(applyEdits(original, edits));
  const newTiers: Record<string, ModelTier | null> = Object.fromEntries([...setTiers].filter(([name]) => !hasTier(name)));
  for (const tier of unsetTiers) if (scope === 'project' && inheritsTier(tier)) newTiers[tier] = null;
  spliceTiers(second, newTiers);
  const newLimits: Record<string, number | null> = Object.fromEntries([...setLimits].filter(([e]) => !hasLimit(e)));
  for (const endpoint of clearedLimits) if (scope === 'project' && inheritsLimit(endpoint)) newLimits[endpoint] = null;
  spliceLimits(second, newLimits);
  const next = second.result();

  let invalid: string | undefined;
  if (!noMediumTier) {
    try {
      if (scope === 'project') {
        const result = catalogOf(l, l.generalText, next, false);
        if (!sameTiers(result.tiers, finalTiers) || !sameLimits(result.limits, finalLimits)) invalid = MISMATCH;
      } else {
        const result = catalogOf(l, next, null, false);
        if (!sameTiers(result.tiers, finalTiers) || !sameLimits(numericLimits(next), finalLimits)) invalid = MISMATCH;
        // The change must leave this project loading.
        if (invalid === undefined && view.project !== null) catalogOf(l, next, l.projectText, true);
      }
    } catch (err) {
      if (!(err instanceof LoadError)) throw err;
      invalid = err.message;
    }
  }

  const overridden: Overridden = { tiers: [], limits: [] };
  if (scope === 'general') {
    const named = view.projectNamed;
    overridden.tiers = [...setTiers.keys(), ...unsetTiers].filter((t) => named.tiers.has(t));
    overridden.limits = [...setLimits.keys(), ...clearedLimits].filter((e) => named.limits.has(e));
  }

  const fingerprint = sha256(JSON.stringify({ file: text, other, changes, scope, host: starter.host }));
  return {
    agentFile,
    scope,
    fileExists: text !== null,
    changes,
    refusals,
    droppedLimits,
    overridden,
    text: next,
    diff: next === original ? '' : unifiedDiff(text, next, scope === 'general' ? agentFile : AGENT_FILE),
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
  return got.size === want.size && [...want].every(([e, n]) => got.get(e) === n);
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

/** Plan new limits into endpoints, creating it when missing. */
function spliceLimits(s: Splicer, limits: Record<string, number | null>): void {
  if (Object.keys(limits).length === 0) return;
  const entries = Object.fromEntries(Object.entries(limits).map(([e, n]) => [e, n === null ? null : { parallel: n }]));
  if (s.insertInline(['endpoints'], entries)) return;
  const at = s.mapAt(['endpoints']);
  const lines = (indent: string) =>
    Object.entries(limits)
      .map(([e, n]) => (n === null ? `${indent}${yamlKey(e)}:\n` : `${indent}${yamlKey(e)}:\n${indent}  parallel: ${n}\n`))
      .join('');
  if (at !== undefined) s.insert(at.end, lines(at.indent));
  else if (s.doc.has('endpoints')) throw new LoadError('agent file: endpoints must be a map for setup to add a limit to it');
  else s.append(`endpoints:\n${lines('  ')}`);
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
