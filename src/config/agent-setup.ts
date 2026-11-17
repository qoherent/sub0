// @sigil implements design/agent-config.sigil AgentConfig (guided setup editor)
//
// Reads the tiers, endpoint limits and tier dependents of .agents/subzero.yaml for
// guided init, previews a change set to them, and applies a previewed change set.
// Edits splice the existing text, so every line a change does not touch keeps its
// bytes. A preview is bound to its apply by a fingerprint over the file text and the
// change set; the result is validated with the load rules delegation uses and
// written atomically, because running delegations re-read the file on every call.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMap, isScalar, type Document, type Pair } from 'yaml';
import {
  AGENT_FILE,
  createSplicer,
  DEFAULT_TIER,
  FALLBACK_AGENT,
  flowYaml,
  GENERAL_AGENT,
  isRecord,
  isThinkingLevel,
  LoadError,
  modelEndpoint,
  parseCatalog,
  readTextOrNull,
  spliceAgents,
  spliceTiers,
  THINKING_LEVELS,
  yamlKey,
  type AgentCatalog,
  type ModelTier,
  type Splicer,
  type StarterAgent,
  type StarterEntry,
  type ThinkingLevel,
} from './agent-config.js';
import { TIER_WORDS } from './tier-words.js';

/** Seconds given to `general` and `fallback` when setup adds them. */
export const DEFAULT_SETUP_TIMEOUT = 1200;

/** What setup needs from the caller to write tiers and the starter agents. */
export interface SetupStarterSpec {
  /** The host every tier the change set sets runs on. */
  host: string;
  /** Seconds for an added `general` or `fallback`; DEFAULT_SETUP_TIMEOUT when absent. */
  timeout?: number;
  generalTools: string[];
  fallbackTools: string[];
}

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
  /** Agents that name this tier through `tier:` or a `tiers.<t>` override, in file order. */
  dependents: string[];
  /** True when the caller named a host and the tier runs on another one. */
  otherHost: boolean;
  /** Whether the caller's model list holds the model; null when no list was given. */
  listed: boolean | null;
}

export interface LimitState {
  endpoint: string;
  parallel: number;
  /** Tiers whose model belongs to the endpoint. */
  tiers: string[];
  /** No tier uses the endpoint, an agent override model does: the limit is kept and not asked about. */
  overrideOnly: boolean;
  /** No model belongs to the endpoint: setup drops the limit. */
  unused: boolean;
}

export interface SetupSnapshot {
  agentFile: string;
  /** sha256 of the file text; null when there is no file. */
  fileFingerprint: string | null;
  tiers: TierState[];
  limits: LimitState[];
  /** Endpoints that only agent override models use. */
  overrideOnlyEndpoints: string[];
  missingStarter: StarterEntry[];
}

export type SetupState =
  | ({ status: 'ok' | 'no-file' } & SetupSnapshot)
  /** The file fails to load only for what setup repairs: a missing starter entry or an unused limit. */
  | ({ status: 'repairable'; problem: string } & SetupSnapshot)
  /** Any other load error, unchanged; the user fixes the file by hand. */
  | { status: 'refused'; agentFile: string; error: string };

export interface SetupStateOptions {
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
  agentFile: string;
  fileExists: boolean;
  /** The normalized change set the fingerprint covers. */
  changes: Change[];
  refusals: Refusal[];
  /** Endpoints whose limit is removed because no model uses them after the change. */
  droppedLimits: string[];
  /** Starter entries the write adds. */
  addedStarter: StarterEntry[];
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

function agentFileOf(projectRoot: string): string {
  return path.join(projectRoot, AGENT_FILE);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

type Loaded =
  | { status: 'no-file'; catalog: null }
  | { status: 'ok'; catalog: AgentCatalog }
  | { status: 'repairable'; catalog: AgentCatalog; problem: string }
  | { status: 'refused'; error: LoadError };

function classify(agentFile: string, text: string | null): Loaded {
  if (text === null) return { status: 'no-file', catalog: null };
  try {
    return { status: 'ok', catalog: parseCatalog(text, agentFile) };
  } catch (strict) {
    if (!(strict instanceof LoadError)) throw strict;
    try {
      const catalog = parseCatalog(text, agentFile, { allowMissingStarter: true, allowUnusedLimits: true });
      return { status: 'repairable', catalog, problem: strict.message };
    } catch (lenient) {
      if (!(lenient instanceof LoadError)) throw lenient;
      return { status: 'refused', error: lenient };
    }
  }
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

function missingStarterOf(catalog: AgentCatalog): StarterEntry[] {
  const out: StarterEntry[] = [];
  if (!catalog.tiers.has(DEFAULT_TIER)) out.push('medium');
  if (!catalog.entries.has(GENERAL_AGENT)) out.push('general');
  if (!catalog.entries.has(FALLBACK_AGENT)) out.push('fallback');
  return out;
}

/**
 * The tiers, limits and tier dependents of the agent file, or "no file". A file that
 * fails to load is classified as repairable (setup fixes it) or refused (it is not).
 */
export function readSetupState(projectRoot: string, options: SetupStateOptions = {}): SetupState {
  const agentFile = agentFileOf(projectRoot);
  let text: string | null;
  try {
    text = readTextOrNull(agentFile);
  } catch (err) {
    if (err instanceof LoadError) return { status: 'refused', agentFile, error: err.message };
    throw err;
  }
  const loaded = classify(agentFile, text);
  if (loaded.status === 'refused') return { status: 'refused', agentFile, error: loaded.error.message };
  const catalog = loaded.catalog ?? emptyCatalog(agentFile);
  const listed = options.listedModels === undefined ? null : new Set(options.listedModels);

  const tiers: TierState[] = [...catalog.tiers].map(([tier, t]) => ({
    tier,
    host: t.host,
    model: t.model,
    thinking: t.thinking,
    endpoint: modelEndpoint(t.model),
    dependents: dependentsOf(catalog, tier),
    otherHost: options.host !== undefined && t.host !== options.host,
    listed: listed === null ? null : listed.has(t.model),
  }));
  const byOverride = overrideEndpoints(catalog);
  const tierEndpoints = new Set(tiers.map((t) => t.endpoint));
  const limits: LimitState[] = [...catalog.limits].map(([endpoint, parallel]) => {
    const using = tiers.filter((t) => t.endpoint === endpoint).map((t) => t.tier);
    const overrideOnly = using.length === 0 && byOverride.has(endpoint);
    return { endpoint, parallel, tiers: using, overrideOnly, unused: using.length === 0 && !overrideOnly };
  });
  const snapshot: SetupSnapshot = {
    agentFile,
    fileFingerprint: text === null ? null : sha256(text),
    tiers,
    limits,
    overrideOnlyEndpoints: [...byOverride].filter((e) => !tierEndpoints.has(e)),
    missingStarter: missingStarterOf(catalog),
  };
  if (loaded.status === 'repairable') return { status: 'repairable', problem: loaded.problem, ...snapshot };
  return { status: loaded.status, ...snapshot };
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

/** Preview a change set against the agent file as it is now. Writes nothing. */
export function previewChanges(projectRoot: string, changes: readonly Change[], starter: SetupStarterSpec): SetupPreview {
  const agentFile = agentFileOf(projectRoot);
  const normalized = normalizeChangeSet(changes);
  return plan(agentFile, readTextOrNull(agentFile), normalized, starter);
}

/**
 * Write a previewed change set. Refuses when the file or the change set differs from
 * the preview the fingerprint came from, or the change set holds a refused change.
 * Writes nothing when there is nothing to change.
 */
export function applyChanges(
  projectRoot: string,
  changes: readonly Change[],
  fingerprint: string,
  starter: SetupStarterSpec,
): SetupApplyResult {
  const agentFile = agentFileOf(projectRoot);
  const normalized = normalizeChangeSet(changes);
  const preview = plan(agentFile, readTextOrNull(agentFile), normalized, starter);
  if (preview.fingerprint !== fingerprint) throw new SetupConflictError();
  if (preview.refusals.length > 0) throw new SetupRefusedError(preview.refusals);
  if (preview.invalid !== undefined) throw new LoadError(preview.invalid);
  if (preview.nothingToChange) return { ...preview, written: false };
  try {
    writeAtomic(agentFile, preview.text);
  } catch (err) {
    if (isErrnoException(err)) throw new SetupWriteError(path.relative(projectRoot, agentFile), err);
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

function plan(agentFile: string, text: string | null, changes: Change[], starter: SetupStarterSpec): SetupPreview {
  const loaded = classify(agentFile, text);
  if (loaded.status === 'refused') throw loaded.error;
  const catalog = loaded.catalog ?? emptyCatalog(agentFile);
  const timeout = starter.timeout ?? DEFAULT_SETUP_TIMEOUT;

  const refusals: Refusal[] = [];
  const summary: string[] = [];
  const finalTiers = new Map(catalog.tiers);
  const setTiers = new Map<string, ModelTier>();
  const unsetTiers: string[] = [];
  for (const change of changes) {
    if (change.op === 'setTier') {
      const tier: ModelTier = { host: starter.host, model: change.model, thinking: change.thinking };
      const before = catalog.tiers.get(change.tier);
      if (before !== undefined && sameTier(before, tier)) continue;
      summary.push(
        before === undefined
          ? `add tier ${change.tier}: ${describeTier(tier)}`
          : `tier ${change.tier}: ${describeTier(before)} -> ${describeTier(tier)}`,
      );
      setTiers.set(change.tier, tier);
      finalTiers.set(change.tier, tier);
    } else if (change.op === 'unsetTier') {
      const agents = dependentsOf(catalog, change.tier);
      if (change.tier === DEFAULT_TIER) {
        refusals.push({ change, message: 'the medium tier cannot be removed: every agent without its own tier runs on it' });
      } else if (!catalog.tiers.has(change.tier)) {
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
  const noMediumTier = !finalTiers.has(DEFAULT_TIER);
  if (noMediumTier) refusals.push({ change: null, message: 'the medium tier is required: choose a model for it' });

  const used = overrideEndpoints(catalog);
  for (const t of finalTiers.values()) used.add(modelEndpoint(t.model));
  const finalLimits = new Map(catalog.limits);
  const setLimits = new Map<string, number>();
  const removedLimits: string[] = [];
  for (const change of changes) {
    if (change.op === 'setLimit') {
      if (!used.has(change.endpoint)) {
        refusals.push({
          change,
          message: `endpoint "${change.endpoint}": no model of a tier or of a tier override belongs to it, so it cannot have a limit`,
        });
        continue;
      }
      const before = catalog.limits.get(change.endpoint);
      if (before === change.parallel) continue;
      summary.push(
        before === undefined
          ? `endpoint ${change.endpoint}: parallel limit ${change.parallel}`
          : `endpoint ${change.endpoint}: parallel limit ${before} -> ${change.parallel}`,
      );
      setLimits.set(change.endpoint, change.parallel);
      finalLimits.set(change.endpoint, change.parallel);
    } else if (change.op === 'clearLimit' && catalog.limits.has(change.endpoint)) {
      summary.push(`endpoint ${change.endpoint}: remove the parallel limit`);
      removedLimits.push(change.endpoint);
      finalLimits.delete(change.endpoint);
    }
  }
  const droppedLimits: string[] = [];
  for (const endpoint of catalog.limits.keys()) {
    if (finalLimits.has(endpoint) && !used.has(endpoint)) {
      summary.push(`endpoint ${endpoint}: remove the parallel limit, no model uses it any more`);
      droppedLimits.push(endpoint);
      removedLimits.push(endpoint);
      finalLimits.delete(endpoint);
    }
  }

  const addedStarter: StarterEntry[] = [];
  if (!catalog.tiers.has(DEFAULT_TIER) && finalTiers.has(DEFAULT_TIER)) addedStarter.push('medium');
  const starterAgents: Record<string, StarterAgent> = {};
  if (!catalog.entries.has(GENERAL_AGENT)) {
    addedStarter.push('general');
    starterAgents[GENERAL_AGENT] = { tools: starter.generalTools, timeout };
    summary.push(`add the general agent (${timeout} seconds)`);
  }
  if (!catalog.entries.has(FALLBACK_AGENT)) {
    addedStarter.push('fallback');
    starterAgents[FALLBACK_AGENT] = { tools: starter.fallbackTools, timeout };
    summary.push(`add the fallback agent (${timeout} seconds)`);
  }

  // Pass 1 edits the original in place: replace tier fields and limits, remove entries.
  const original = text ?? '';
  const first = createSplicer(original);
  const edits: Edit[] = [];
  for (const [name, tier] of setTiers) if (catalog.tiers.has(name)) edits.push(...replaceTier(first.doc, name, tier));
  edits.push(...deleteEntries(first, ['models', 'tiers'], unsetTiers));
  const keptLimits = [...catalog.limits.keys()].filter((e) => !removedLimits.includes(e));
  if (removedLimits.length > 0) {
    // A map left with no entry goes whole; new limits then create it again.
    edits.push(...(keptLimits.length === 0 ? deleteEntries(first, [], ['endpoints']) : deleteEntries(first, ['endpoints'], removedLimits)));
  }
  for (const [endpoint, parallel] of setLimits) {
    if (keptLimits.includes(endpoint)) edits.push(replaceScalar(first.doc, ['endpoints', endpoint, 'parallel'], parallel));
  }
  // Pass 2 adds new entries to the edited text.
  const second = edits.length === 0 ? first : createSplicer(applyEdits(original, edits));
  spliceTiers(second, Object.fromEntries([...setTiers].filter(([name]) => !catalog.tiers.has(name))));
  spliceAgents(second, starterAgents);
  spliceLimits(second, Object.fromEntries([...setLimits].filter(([e]) => !keptLimits.includes(e))));
  const next = second.result();

  let invalid: string | undefined;
  if (!noMediumTier) {
    try {
      const result = parseCatalog(next, agentFile);
      const tiersMatch = result.tiers.size === finalTiers.size && [...finalTiers].every(([n, t]) => {
        const got = result.tiers.get(n);
        return got !== undefined && sameTier(got, t);
      });
      const limitsMatch = result.limits.size === finalLimits.size && [...finalLimits].every(([e, n]) => result.limits.get(e) === n);
      if (!tiersMatch || !limitsMatch) invalid = 'the edited agent file does not hold the previewed tiers and limits; edit it by hand';
    } catch (err) {
      if (!(err instanceof LoadError)) throw err;
      invalid = err.message;
    }
  }

  const fingerprint = sha256(
    JSON.stringify({
      file: text,
      changes,
      starter: { host: starter.host, timeout, generalTools: starter.generalTools, fallbackTools: starter.fallbackTools },
    }),
  );
  return {
    agentFile,
    fileExists: text !== null,
    changes,
    refusals,
    droppedLimits,
    addedStarter,
    text: next,
    diff: unifiedDiff(text, next),
    summary,
    nothingToChange: text !== null && next === text,
    ...(invalid !== undefined ? { invalid } : {}),
    fingerprint,
  };
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
function spliceLimits(s: Splicer, limits: Record<string, number>): void {
  if (Object.keys(limits).length === 0) return;
  const entries = Object.fromEntries(Object.entries(limits).map(([e, n]) => [e, { parallel: n }]));
  if (s.insertInline(['endpoints'], entries)) return;
  const at = s.mapAt(['endpoints']);
  const lines = (indent: string) =>
    Object.entries(limits)
      .map(([e, n]) => `${indent}${yamlKey(e)}:\n${indent}  parallel: ${n}\n`)
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
function unifiedDiff(before: string | null, after: string, context = 2): string {
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
  const out = [`--- ${before === null ? '/dev/null' : AGENT_FILE}`, `+++ ${AGENT_FILE}`];
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
 * Write the agent file through a temp file next to it, created exclusively so an
 * existing path or symlink is never followed, then renamed into place. The temp
 * file is removed on any failure; the original is untouched until the rename.
 */
function writeAtomic(file: string, text: string): void {
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
