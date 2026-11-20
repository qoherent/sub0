// @sigil implements design/agent-config.sigil AgentConfig
//
// Loads .agents/subzero.yaml under a project root that the caller hands over, layered over
// the global file ~/.agents/subzero.yaml, resolves an agent entry at one model tier into
// an agent definition, writes the starter entries for `subzero init`, and resolves that
// project root for DelegationService. Nothing here is cached: every call reads both files
// again. AgentConfig names no host: the supported hosts and the starter tools of a host
// come from the caller, and none given means no host check and no built-in agents.
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMap, parse as parseYaml, parseDocument, stringify as stringifyYaml, type Document } from 'yaml';
import { z } from 'zod';
import type { ChildHostOptions, StarterTools } from '../core/types.js';

export const AGENT_FILE = path.join('.agents', 'subzero.yaml');

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly unknown[]).includes(value);
}

export const DEFAULT_TIER = 'medium';
export const GENERAL_AGENT = 'general';
export const FALLBACK_AGENT = 'fallback';

export interface SkillRef {
  name: string;
  /** Absolute path, resolved against the directory of the agent file. May not exist. */
  folder: string;
}

/** What runs a child: one entry of `models.tiers`. */
export interface ModelTier {
  host: string;
  model: string;
  thinking: ThinkingLevel;
}

/** One agent entry of `agents:`, before it is resolved at a tier. */
export interface AgentEntry {
  name: string;
  /** Absent on `general` and `fallback`. */
  description?: string;
  skills: SkillRef[];
  tools: string[];
  /** Seconds from spawn to settlement; time spent Pending does not count. */
  timeout: number;
  /** The entry's own tier, when it names one. */
  tier?: string;
  /** Per-tier overrides of host, model and thinking, for this agent only. */
  overrides: Map<string, Partial<ModelTier>>;
}

/** One agent entry resolved at one model tier. */
export interface AgentDefinition {
  /** The entry's name, or `<entry>:<tier>` when the request named a tier. */
  name: string;
  /** Absent on `general` and `fallback`. */
  description?: string;
  host: string;
  model: string;
  thinking: ThinkingLevel;
  skills: SkillRef[];
  tools: string[];
  /** Seconds from spawn to settlement; time spent Pending does not count. */
  timeout: number;
  /** The part of the model before its first slash. */
  endpoint: string;
  /** Most child runs one process runs at once on the endpoint, or null for no limit. */
  parallel: number | null;
}

export interface RoutingSettings {
  /** On unless the agent file sets it to false. */
  hook: boolean;
  /** Agent types the hook treats as generic; undefined means the hook's own list. */
  genericAgents?: string[];
}

export interface AgentCatalog {
  agentFile: string;
  entries: Map<string, AgentEntry>;
  tiers: Map<string, ModelTier>;
  routing: RoutingSettings;
  limits: Map<string, number>;
  /**
   * The child host options of the global file, by child host: the maps under `hosts`, opaque to
   * the config. Only the driver of that host reads its entry and checks it.
   */
  childHostOptions: Record<string, ChildHostOptions>;
}

/** What the callers that check hosts pass in; none means no host is checked. */
export interface ResolveOptions {
  supportedHosts?: string[];
  /** The model tier the request names. */
  tier?: string;
}

export interface RoutableTier extends ModelTier {
  tier: string;
}

/** How a load error tells the user to set up the agent file, in either parent. */
const RUN_INIT = '; run /subzero:init in Claude Code or /subzero init in pi';

export class LoadError extends Error {
  readonly code: string = 'load_error';
  constructor(message: string) {
    super(message);
    this.name = 'LoadError';
  }
}

export class MissingAgentFileError extends LoadError {
  constructor(agentFile: string) {
    super(`agent file is missing: ${agentFile}${RUN_INIT}`);
    this.name = 'MissingAgentFileError';
  }
}

/** The project's agent file says `enabled: false`: off, as when the file is missing. */
export class ProjectDisabledError extends MissingAgentFileError {
  constructor(agentFile: string) {
    super(agentFile);
    this.message = `subzero is switched off for this project by enabled: false in ${agentFile}`;
    this.name = 'ProjectDisabledError';
  }
}

/** The one load error that `init` repairs by adding the medium tier. */
export class MissingDefaultTierError extends LoadError {
  constructor() {
    super(`the medium tier is required in models.tiers${RUN_INIT}`);
    this.name = 'MissingDefaultTierError';
  }
}

export class UnknownAgentError extends Error {
  readonly code = 'unknown_agent';
  constructor(
    /** Undefined when the request named no agent. */
    readonly agent: string | undefined,
    readonly configured: string[],
  ) {
    const list = configured.length > 0 ? configured.join(', ') : '(none)';
    super(
      agent === undefined
        ? `no agent was named and no general agent is configured; configured agents: ${list}`
        : `unknown agent "${agent}"; configured agents: ${list}`,
    );
    this.name = 'UnknownAgentError';
  }
}

/** A request resolved to a tier that is not configured, or whose host has no child driver. */
export class TierError extends Error {
  readonly code = 'unknown_tier';
  constructor(
    readonly tier: string,
    readonly configured: string[],
    /** Set when the host is the cause. */
    readonly host?: string,
    readonly supportedHosts?: string[],
  ) {
    const list = configured.length > 0 ? configured.join(', ') : '(none)';
    super(
      host === undefined
        ? `unknown tier "${tier}"; configured tiers: ${list}`
        : `tier "${tier}" runs on the host "${host}", which has no registered child driver; supported hosts: ${
            (supportedHosts ?? []).length === 0 ? '(none)' : supportedHosts!.join(', ')
          }; configured tiers: ${list}`,
    );
    this.name = 'TierError';
  }
}

/** `init` found a medium tier on another host than the one it was given. */
export class StarterHostConflictError extends Error {
  readonly code = 'starter_host_conflict';
  constructor(
    readonly existingHost: string,
    readonly givenHost: string,
  ) {
    super(
      `the medium tier of the agent file is on the host "${existingHost}", not "${givenHost}"; ` +
        'nothing was written. Edit the medium tier, or run init with that host.',
    );
    this.name = 'StarterHostConflictError';
  }
}

export class UnresolvedRootError extends Error {
  readonly code = 'unresolved_root';
  constructor(detail?: string) {
    super(
      `subzero could not resolve the project root${detail ? ` (${detail})` : ''}. ` +
        'Set SUBZERO_PROJECT_DIR to the absolute path of the project.',
    );
    this.name = 'UnresolvedRootError';
  }
}

export function modelEndpoint(model: string): string {
  const slash = model.indexOf('/');
  return slash === -1 ? model : model.slice(0, slash);
}

const TIER_KEYS = ['host', 'model', 'thinking'] as const;
const AGENT_KEYS = ['description', 'skills', 'tools', 'timeout', 'tier', 'tiers'];
const ROUTING_KEYS = ['hook', 'generic_agents'];

const agentSchema = z.object({
  description: z.string().min(1, 'needs a description').optional(),
  skills: z.array(z.string().min(1)).default([]),
  tools: z.array(z.string().min(1)).min(1, 'needs at least one tool'),
  timeout: z.number().positive(),
  tier: z.string().min(1).optional(),
});

const tierFieldSchemas = {
  host: z.string().min(1, 'must be a non-empty string'),
  model: z.string().min(1, 'must be a non-empty string'),
  thinking: z.enum(THINKING_LEVELS),
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The default place of the global file: ~/.agents/subzero.yaml. */
export function defaultGlobalFile(): string {
  return path.join(os.homedir(), '.agents', 'subzero.yaml');
}

/** The global file: SUBZERO_GLOBAL_CONFIG when set and not empty, else the default place. */
export function globalFile(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.SUBZERO_GLOBAL_CONFIG;
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : defaultGlobalFile();
}

/**
 * Whether two paths name one file: by real path when both exist, else by resolved path.
 * In a project rooted at the home folder, the project file is the global file.
 */
export function isSameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/** Why a project-scope write is refused when the project file is the global file. */
export const PROJECT_IS_GLOBAL = "this project's file is the global file; run guided init with the every-project choice, or open the tool in a project folder";

/** The starter tools of a child host, or undefined when its driver offers none. */
export type StarterAgents = (host: string) => StarterTools | undefined;

/** For callers with no kernel: fills the built-in agents with a tool list that only passes validation. */
export const PLACEHOLDER_STARTER_AGENTS: StarterAgents = () => ({ general: ['read'], fallback: ['read'] });

/** Seconds of a built-in `general` or `fallback` agent. */
export const BUILT_IN_TIMEOUT = 1200;

export interface LoadOptions {
  /** Fills each missing `general` and `fallback` agent; none given means they are required entries. */
  starterAgents?: StarterAgents;
}

/** Read both files, layer the agent file over the global file and validate the merge. */
export function loadCatalog(projectRoot: string, options: LoadOptions = {}): AgentCatalog {
  const agentFile = path.join(projectRoot, AGENT_FILE);
  const global = globalFile();
  // A project rooted at the home folder: the one file is the global layer, and the project has no file of its own.
  const projectText = isSameFile(agentFile, global) ? null : readTextOrNull(agentFile);
  return build(() => readGlobalText(global), projectText, { ...options, agentFile, globalFile: global });
}

/**
 * The child host options for one child host, read with the lenient rules of guided setup: a
 * missing medium tier, general or fallback is no error, and a project that is switched off still
 * has the global file's options. A refusal in either file is a load error.
 */
export function loadChildHostOptions(projectRoot: string, host: string): ChildHostOptions {
  const agentFile = path.join(projectRoot, AGENT_FILE);
  const global = globalFile();
  const projectText = isSameFile(agentFile, global) ? null : readTextOrNull(agentFile);
  const globalText = readGlobalText(global);
  const options = { agentFile, globalFile: global, allowMissingStarter: true, allowUnusedLimits: true };
  try {
    return buildCatalog(globalText, projectText, options).childHostOptions[host] ?? {};
  } catch (err) {
    if (!(err instanceof ProjectDisabledError)) throw err;
    return buildCatalog(globalText, null, options).childHostOptions[host] ?? {};
  }
}

/** Read and validate the agent file. One invalid entry fails the whole load. */
export function loadAgentFile(projectRoot: string, options: LoadOptions = {}): AgentCatalog {
  return loadCatalog(projectRoot, options);
}

/** The agent file's text; a missing file raises MissingAgentFileError. */
export function readAgentText(agentFile: string): string {
  try {
    return readFileSync(agentFile, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new MissingAgentFileError(agentFile);
    throw new LoadError(`agent file is unreadable: ${agentFile} (${code ?? String(err)})`);
  }
}

/** The agent file's text, or null when there is no file. */
export function readTextOrNull(agentFile: string): string | null {
  try {
    return readAgentText(agentFile);
  } catch (err) {
    if (err instanceof MissingAgentFileError) return null;
    throw err;
  }
}

/** The global file's text, or null when there is none. */
export function readGlobalText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new LoadError(`global file is unreadable: ${file} (${code ?? String(err)})`);
  }
}

export interface ParseOptions {
  /** Load a file without the medium tier, general or fallback (what init repairs). */
  allowMissingStarter?: boolean;
  /** Load a file whose endpoint limit no model belongs to (what guided init drops). */
  allowUnusedLimits?: boolean;
}

export interface BuildOptions extends ParseOptions, LoadOptions {
  /** The project's agent file, which names it in errors and is the base of its skill folders. */
  agentFile: string;
  /** Names the global file in errors; the resolved global file when absent. */
  globalFile?: string;
}

/**
 * Validate the text of a global file and a project agent file as one configuration,
 * with the load rules delegation uses. A null text is a file that does not exist.
 */
export function buildCatalog(globalText: string | null, projectText: string | null, options: BuildOptions): AgentCatalog {
  return build(() => globalText, projectText, options);
}

/** Validate agent file text on its own, as a project with no global file. */
export function parseCatalog(text: string, agentFile: string, options: ParseOptions = {}): AgentCatalog {
  return build(() => null, text, { ...options, agentFile });
}

/** What one file holds, before the two are merged. A null tier or limit removes the inherited one. */
interface Layer {
  enabled: boolean;
  tiers: Map<string, ModelTier | null>;
  limits: Map<string, number | null>;
  routing: Partial<RoutingSettings>;
  skillFolders: Map<string, string>;
  agents: Record<string, unknown>;
  /** The global file's child host options, resolved; always empty in a project layer. */
  childHostOptions: Record<string, ChildHostOptions>;
}

const GLOBAL_LAYER_KEYS = ['models', 'endpoints', 'routing', 'hosts'];
const GLOBAL_KEYS_TEXT = 'models.tiers, endpoints, routing and hosts';

/** Run a step on one file's content; a load error that does not name the file gets it. */
function inFile<T>(file: string, step: () => T): T {
  try {
    return step();
  } catch (err) {
    if (err instanceof LoadError && !err.message.includes(file)) throw new LoadError(`${err.message} in ${file}`);
    throw err;
  }
}

function build(readGlobal: () => string | null, projectText: string | null, options: BuildOptions): AgentCatalog {
  const { agentFile } = options;
  const project = projectText === null ? null : inFile(agentFile, () => parseLayer(projectText, agentFile, 'project', options));
  if (project !== null && !project.enabled) throw new ProjectDisabledError(agentFile);
  const globalPath = options.globalFile ?? globalFile();
  const globalText = readGlobal();
  const global = globalText === null ? null : inFile(globalPath, () => parseLayer(globalText, globalPath, 'global', options));

  const tiers = new Map<string, ModelTier>();
  const limits = new Map<string, number>();
  const inherited = new Set<string>();
  for (const layer of [global, project]) {
    if (layer === null) continue;
    for (const [name, tier] of layer.tiers) {
      if (tier === null) tiers.delete(name);
      else tiers.set(name, tier);
    }
    for (const [endpoint, parallel] of layer.limits) {
      if (parallel === null) limits.delete(endpoint);
      else limits.set(endpoint, parallel);
      if (layer === global) inherited.add(endpoint);
      else inherited.delete(endpoint);
    }
  }
  const routing = { ...global?.routing, ...project?.routing };

  const entries = new Map<string, AgentEntry>();
  inFile(agentFile, () => {
    for (const [name, raw] of Object.entries(project?.agents ?? {})) {
      entries.set(name, validateAgent(name, raw, project!.skillFolders, tiers));
    }
  });

  const used = new Set<string>();
  for (const tier of tiers.values()) used.add(modelEndpoint(tier.model));
  for (const entry of entries.values()) {
    for (const override of entry.overrides.values()) {
      if (override.model !== undefined) used.add(modelEndpoint(override.model));
    }
  }
  for (const endpoint of [...limits.keys()]) {
    if (used.has(endpoint)) continue;
    if (inherited.has(endpoint)) limits.delete(endpoint);
    else if (options.allowUnusedLimits !== true) {
      throw new LoadError(`endpoint "${endpoint}": no model of a tier or of a tier override belongs to it in ${agentFile}`);
    }
  }

  const medium = tiers.get(DEFAULT_TIER);
  if (options.allowMissingStarter !== true && medium === undefined) {
    throw project === null ? new MissingAgentFileError(agentFile) : new MissingDefaultTierError();
  }
  if (medium !== undefined && options.starterAgents !== undefined) fillBuiltInAgents(entries, medium.host, options.starterAgents);
  if (options.allowMissingStarter !== true) {
    if (!entries.has(GENERAL_AGENT)) throw new LoadError(`the general agent is required${RUN_INIT}`);
    if (!entries.has(FALLBACK_AGENT)) throw new LoadError(`the fallback agent is required${RUN_INIT}`);
  }

  return {
    agentFile,
    entries,
    tiers,
    routing: { hook: routing.hook ?? true, ...(routing.genericAgents !== undefined ? { genericAgents: routing.genericAgents } : {}) },
    limits,
    childHostOptions: global?.childHostOptions ?? {},
  };
}

/** Add each of `general` and `fallback` that the project does not define, from the starter tools of the medium host. */
function fillBuiltInAgents(entries: Map<string, AgentEntry>, host: string, starterAgents: StarterAgents): void {
  const missing = [GENERAL_AGENT, FALLBACK_AGENT].filter((name) => !entries.has(name));
  if (missing.length === 0) return;
  const tools = starterAgents(host);
  if (tools === undefined) {
    throw new LoadError(`the child driver of the host "${host}" offers no starter tools, so the built-in ${missing.join(' and ')} agent cannot be filled`);
  }
  for (const name of missing) {
    entries.set(name, { name, skills: [], tools: name === GENERAL_AGENT ? tools.general : tools.fallback, timeout: BUILT_IN_TIMEOUT, overrides: new Map() });
  }
}

/** The per-file step: syntax, field rules, and the keys this kind of file may hold. */
function parseLayer(text: string, file: string, kind: 'global' | 'project', options: ParseOptions): Layer {
  const global = kind === 'global';
  const allowMissingStarter = options.allowMissingStarter === true;
  const malformed = (detail: string) => new LoadError(`${global ? 'global' : 'agent'} file is malformed: ${file}: ${detail}`);
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw malformed((err as Error).message);
  }
  const doc: unknown = parsed === null ? {} : parsed;
  if (!isRecord(doc)) throw malformed('expected a map');
  if (global) {
    for (const key of Object.keys(doc)) {
      if (!GLOBAL_LAYER_KEYS.includes(key)) {
        throw new LoadError(`the global file holds only ${GLOBAL_KEYS_TEXT}, not "${key}": ${file}`);
      }
    }
  }
  if (!global && 'hosts' in doc) {
    throw new LoadError(`the project file holds a "hosts" key, but child host options are allowed in the global file only (a repo must not load code into your children): ${file}`);
  }
  if (doc.enabled !== undefined && typeof doc.enabled !== 'boolean') throw new LoadError('enabled must be true or false');
  const agentsMap = doc.agents ?? {};
  if (!isRecord(agentsMap)) throw malformed('expected an "agents" map');
  const skillsMap = doc.skills ?? {};
  const endpointsMap = doc.endpoints ?? {};
  if (!isRecord(skillsMap)) throw malformed('"skills" must be a map');
  if (!isRecord(endpointsMap)) throw malformed('"endpoints" must be a map');
  if (doc.models !== undefined && !(allowMissingStarter && doc.models === null) && !isRecord(doc.models)) throw malformed('"models" must be a map');
  const modelsMap = (doc.models ?? {}) as Record<string, unknown>;
  if (global) {
    for (const key of Object.keys(modelsMap)) {
      if (key !== 'tiers') throw new LoadError(`the global file holds only ${GLOBAL_KEYS_TEXT}, not "models.${key}": ${file}`);
    }
  }
  if (modelsMap.tiers !== undefined && !(allowMissingStarter && modelsMap.tiers === null) && !isRecord(modelsMap.tiers)) throw malformed('"models.tiers" must be a map');

  const baseDir = path.dirname(file);
  const skillFolders = new Map<string, string>();
  for (const [name, value] of Object.entries(skillsMap)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new LoadError(`skill "${name}" must map to a folder path`);
    }
    skillFolders.set(name, path.resolve(baseDir, value));
  }

  const removal = (what: string) => new LoadError(`${what}: a removal entry is only accepted in the agent file`);
  const limits = new Map<string, number | null>();
  for (const [endpoint, entry] of Object.entries(endpointsMap)) {
    if (entry === null) {
      if (global) throw removal(`endpoint "${endpoint}"`);
      limits.set(endpoint, null);
      continue;
    }
    if (global && isRecord(entry)) {
      for (const key of Object.keys(entry)) {
        if (key !== 'parallel') throw new LoadError(`the global file holds only ${GLOBAL_KEYS_TEXT}, not "endpoints.${endpoint}.${key}": ${file}`);
      }
    }
    const parallel = isRecord(entry) ? entry.parallel : undefined;
    if (typeof parallel !== 'number' || !Number.isInteger(parallel) || parallel < 1) {
      throw new LoadError(`endpoint "${endpoint}": parallel must be a positive whole number`);
    }
    limits.set(endpoint, parallel);
  }

  const tiers = new Map<string, ModelTier | null>();
  for (const [name, raw] of Object.entries((modelsMap.tiers ?? {}) as Record<string, unknown>)) {
    if (raw === null) {
      if (global) throw removal(`tier "${name}"`);
      tiers.set(name, null);
    } else {
      tiers.set(name, validateTier(name, raw));
    }
  }

  return {
    enabled: doc.enabled !== false,
    tiers,
    limits,
    routing: validateRouting(doc.routing),
    skillFolders,
    agents: agentsMap,
    childHostOptions: global ? validateChildHostOptions(doc, file) : {},
  };
}

function validateTier(name: string, raw: unknown): ModelTier {
  if (!isRecord(raw)) throw new LoadError(`tier "${name}": must be a map of host, model and thinking`);
  for (const key of TIER_KEYS) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') {
      throw new LoadError(`tier "${name}": ${key} is required`);
    }
  }
  for (const key of Object.keys(raw)) {
    if (!(TIER_KEYS as readonly string[]).includes(key)) throw new LoadError(`tier "${name}": unknown key "${key}"`);
  }
  return {
    host: checkField(`tier "${name}"`, 'host', raw.host) as string,
    model: checkField(`tier "${name}"`, 'model', raw.model) as string,
    thinking: checkField(`tier "${name}"`, 'thinking', raw.thinking) as ThinkingLevel,
  };
}

function checkField(label: string, key: (typeof TIER_KEYS)[number], value: unknown): unknown {
  const parsed = tierFieldSchemas[key].safeParse(value);
  if (!parsed.success) throw new LoadError(`${label}: ${key}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  return parsed.data;
}

/** `general` and `fallback` are named bare in errors, any other entry as `agent "<name>"`. */
function agentLabel(name: string): string {
  return name === GENERAL_AGENT || name === FALLBACK_AGENT ? name : `agent "${name}"`;
}

function validateAgent(
  name: string,
  raw: unknown,
  skillFolders: Map<string, string>,
  tiers: Map<string, ModelTier>,
): AgentEntry {
  const label = agentLabel(name);
  const reserved = name === GENERAL_AGENT || name === FALLBACK_AGENT;
  if (!isRecord(raw)) throw new LoadError(`${label}: must be a map`);
  for (const key of TIER_KEYS) {
    if (raw[key] !== undefined) {
      throw new LoadError(`${label}: ${key} cannot be set on an agent; host, model and thinking belong to a tier in models.tiers`);
    }
  }
  for (const key of Object.keys(raw)) {
    if (!AGENT_KEYS.includes(key)) throw new LoadError(`${label}: unknown key "${key}"`);
  }
  if (reserved && raw.description !== undefined) {
    throw new LoadError(`${label}: a description is not allowed; ${name} is never chosen by its description`);
  }
  if (!reserved && (raw.description === undefined || raw.description === null || raw.description === '')) {
    throw new LoadError(`${label}: description is required`);
  }
  if (raw.timeout === undefined || raw.timeout === null) {
    throw new LoadError(`${label}: timeout is required (seconds)`);
  }
  if (typeof raw.timeout !== 'number' || !(raw.timeout > 0)) {
    throw new LoadError(`${label}: timeout must be a positive number of seconds`);
  }

  const parsed = agentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || 'entry';
    throw new LoadError(`${label}: ${where}: ${issue?.message ?? 'invalid'}`);
  }
  const def = parsed.data;

  if (def.tier !== undefined && !tiers.has(def.tier)) {
    throw new LoadError(`${label}: tier "${def.tier}" is not configured in models.tiers`);
  }

  const overrides = new Map<string, Partial<ModelTier>>();
  if (raw.tiers !== undefined) {
    if (!isRecord(raw.tiers)) throw new LoadError(`${label}: tiers must be a map of tier name to overrides`);
    for (const [tier, override] of Object.entries(raw.tiers)) {
      const where = `${label}: tiers.${tier}`;
      if (!tiers.has(tier)) throw new LoadError(`${where}: tier "${tier}" is not configured in models.tiers`);
      if (!isRecord(override)) throw new LoadError(`${where}: must be a map of host, model and thinking`);
      const fields: Partial<ModelTier> = {};
      for (const [key, value] of Object.entries(override)) {
        if (!(TIER_KEYS as readonly string[]).includes(key)) {
          throw new LoadError(`${where}: ${key} cannot be overridden; only host, model and thinking can`);
        }
        (fields as Record<string, unknown>)[key] = checkField(where, key as (typeof TIER_KEYS)[number], value);
      }
      overrides.set(tier, fields);
    }
  }

  const skills: SkillRef[] = def.skills.map((skill) => {
    const folder = skillFolders.get(skill);
    if (folder === undefined) {
      throw new LoadError(`${label}: skill "${skill}" is not in the skills map`);
    }
    return { name: skill, folder };
  });

  return {
    name,
    ...(def.description !== undefined ? { description: def.description } : {}),
    skills,
    tools: def.tools,
    timeout: def.timeout,
    ...(def.tier !== undefined ? { tier: def.tier } : {}),
    overrides,
  };
}

/**
 * The child host options of the global file: the map `hosts`, from a child host name to that
 * host's options. AgentConfig reads only the shape, a map of maps; the driver of each host owns
 * what is inside its section and checks it when it starts. Only the global file may hold them
 * (the project file is refused), because they can name code that runs in every child. The
 * process environment, `SUBZERO_GLOBAL_CONFIG` included, is trusted.
 */
function validateChildHostOptions(doc: Record<string, unknown>, file: string): Record<string, ChildHostOptions> {
  if (doc.hosts === undefined || doc.hosts === null) return {};
  if (!isRecord(doc.hosts)) throw new LoadError(`hosts: must be a map from a child host to its options: ${file}`);
  const options: Record<string, ChildHostOptions> = {};
  for (const [host, section] of Object.entries(doc.hosts)) {
    if (section === null) continue;
    if (!isRecord(section)) throw new LoadError(`hosts.${host}: must be a map of options: ${file}`);
    options[host] = section;
  }
  return options;
}

function validateRouting(raw: unknown): Partial<RoutingSettings> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new LoadError('routing: must be a map');
  for (const key of Object.keys(raw)) {
    if (!ROUTING_KEYS.includes(key)) throw new LoadError(`routing: unknown key "${key}"`);
  }
  if (raw.hook !== undefined && typeof raw.hook !== 'boolean') throw new LoadError('routing: hook must be true or false');
  const list = raw.generic_agents;
  if (list !== undefined && !(Array.isArray(list) && list.every((v) => typeof v === 'string' && v !== ''))) {
    throw new LoadError('routing: generic_agents must be a list of agent type names');
  }
  return { ...(raw.hook !== undefined ? { hook: raw.hook } : {}), ...(list !== undefined ? { genericAgents: list as string[] } : {}) };
}

/** Resolve one agent entry at a tier: the one named, else its own, else the default. */
export function resolveAgent(catalog: AgentCatalog, name: string | undefined, options: ResolveOptions = {}): AgentDefinition {
  const entryName = name ?? GENERAL_AGENT;
  const entry = catalog.entries.get(entryName);
  if (entry === undefined) throw new UnknownAgentError(name, [...catalog.entries.keys()]);

  const tierName = options.tier ?? entry.tier ?? DEFAULT_TIER;
  const configured = [...catalog.tiers.keys()];
  const base = catalog.tiers.get(tierName);
  if (base === undefined) throw new TierError(tierName, configured);
  const resolved: ModelTier = { ...base, ...entry.overrides.get(tierName) };
  const supported = options.supportedHosts;
  if (supported !== undefined && !supported.includes(resolved.host)) {
    throw new TierError(tierName, configured, resolved.host, supported);
  }

  const endpoint = modelEndpoint(resolved.model);
  return {
    name: options.tier !== undefined ? `${entryName}:${options.tier}` : entryName,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    host: resolved.host,
    model: resolved.model,
    thinking: resolved.thinking,
    skills: entry.skills,
    tools: entry.tools,
    timeout: entry.timeout,
    endpoint,
    parallel: catalog.limits.get(endpoint) ?? null,
  };
}

/** Look up one agent definition, reading the agent file again. No name means `general`. */
export function getAgent(projectRoot: string, name: string | undefined, options: ResolveOptions = {}): AgentDefinition {
  return resolveAgent(loadAgentFile(projectRoot), name, options);
}

/** Loaders that have no kernel fill the built-in agents with a placeholder, so a missing agent never fails them. */
const lookup = (projectRoot: string): AgentCatalog => loadCatalog(projectRoot, { starterAgents: PLACEHOLDER_STARTER_AGENTS });

export function listAgentNames(projectRoot: string): string[] {
  return [...lookup(projectRoot).entries.keys()];
}

/** Every configured model tier name, routable or not. */
export function configuredTierNames(projectRoot: string): string[] {
  return [...lookup(projectRoot).tiers.keys()];
}

/**
 * The tiers the general agent can run, with the host and model each runs. There are
 * none without a general entry. With no supported hosts given, no host is checked.
 */
export function routableTiers(projectRoot: string, supportedHosts?: string[]): RoutableTier[] {
  const catalog = lookup(projectRoot);
  const general = catalog.entries.get(GENERAL_AGENT);
  if (general === undefined) return [];
  const out: RoutableTier[] = [];
  for (const [tier, base] of catalog.tiers) {
    const resolved: ModelTier = { ...base, ...general.overrides.get(tier) };
    if (supportedHosts === undefined || supportedHosts.includes(resolved.host)) out.push({ tier, ...resolved });
  }
  return out;
}

/** The hook switch and generic agent list as the agent file gives them. */
export function getRouting(projectRoot: string): RoutingSettings {
  return lookup(projectRoot).routing;
}

export interface StarterSpec {
  host: string;
  model: string;
  thinking: ThinkingLevel;
  /** Seconds, for both entries. */
  timeout: number;
  generalTools: string[];
  fallbackTools: string[];
}

export type StarterEntry = 'medium' | 'general' | 'fallback';

export interface StarterResult {
  added: StarterEntry[];
  present: StarterEntry[];
}

/**
 * Add the medium tier, `general` and `fallback`, each only when the agent file lacks
 * it, with no skills and every existing line untouched. Writes nothing on any refusal.
 */
export function addStarterEntries(projectRoot: string, spec: StarterSpec): StarterResult {
  const agentFile = path.join(projectRoot, AGENT_FILE);
  if (isSameFile(agentFile, globalFile())) throw new LoadError(PROJECT_IS_GLOBAL);
  const text = readTextOrNull(agentFile);

  // Parsed as the layer it is, so a file guided init wrote (a lone tier, a null removal) is never refused by a single-file rule.
  const global = globalFile();
  const globalText = readGlobalText(global);
  if (text !== null) buildCatalog(globalText, text, { agentFile, globalFile: global, allowMissingStarter: true });

  const original = text ?? '';
  const doc: Document = parseDocument(original);
  const existingHost = doc.getIn(['models', 'tiers', DEFAULT_TIER, 'host']);
  if (typeof existingHost === 'string' && existingHost !== spec.host) {
    throw new StarterHostConflictError(existingHost, spec.host);
  }

  const result: StarterResult = { added: [], present: [] };
  const note = (entry: StarterEntry, has: boolean) => (has ? result.present : result.added).push(entry);
  const hasDefault = doc.hasIn(['models', 'tiers', DEFAULT_TIER]);
  const hasGeneral = doc.hasIn(['agents', GENERAL_AGENT]);
  const hasFallback = doc.hasIn(['agents', FALLBACK_AGENT]);
  note('medium', hasDefault);
  note('general', hasGeneral);
  note('fallback', hasFallback);
  if (result.added.length === 0) return result;

  const splicer = createSplicer(original);
  if (!hasDefault) spliceTiers(splicer, { [DEFAULT_TIER]: { host: spec.host, model: spec.model, thinking: spec.thinking } });
  if (!hasGeneral || !hasFallback) {
    const agents: Record<string, StarterAgent> = {};
    if (!hasGeneral) agents[GENERAL_AGENT] = { tools: spec.generalTools, timeout: spec.timeout };
    if (!hasFallback) agents[FALLBACK_AGENT] = { tools: spec.fallbackTools, timeout: spec.timeout };
    spliceAgents(splicer, agents);
  }
  const next = splicer.result();
  buildCatalog(globalText, next, { agentFile, globalFile: global }); // entries that do not load are never written
  mkdirSync(path.dirname(agentFile), { recursive: true });
  writeFileSync(agentFile, next);
  return result;
}

/** One YAML value rendered on one line, in flow style. */
export function flowYaml(value: unknown): string {
  return stringifyYaml(value, { collectionStyle: 'flow', lineWidth: 0 }).trimEnd();
}

/**
 * Text edits planned against one parse of the agent file. Existing text is never
 * re-rendered: new entries go inline into a flow-style or empty map, after the last
 * entry of a block map, or to the end of the file.
 */
export interface Splicer {
  readonly original: string;
  readonly doc: Document;
  /** Add entries inline to the flow-style or empty value at keys; false when there is none. */
  insertInline(keys: string[], entries: Record<string, unknown>): boolean;
  /** Where to add lines to the block map at keys, and their indent; undefined when it is missing. */
  mapAt(keys: string[]): { end: number; indent: string } | undefined;
  /** Insert lines at an offset of the original, starting a new line when needed. */
  insert(at: number, body: string): void;
  /** Lines to add at the end of the file, after a blank line. */
  append(body: string): void;
  /** The original with every planned edit applied. */
  result(): string;
}

export function createSplicer(original: string): Splicer {
  const doc: Document = parseDocument(original);
  const inserts: { at: number; text: string }[] = [];
  let appended = '';
  return {
    original,
    doc,
    mapAt(keys) {
      const node = doc.getIn(keys, true);
      if (node === undefined || node === null) return undefined;
      if (!isMap(node) || node.flow === true || node.items.length === 0 || node.range === null || node.range === undefined) {
        throw new LoadError(`agent file: ${keys.join('.')} must be a block-style map for init to add entries to it`);
      }
      const first = (node.items[0]!.key as { range: [number, number, number] }).range[0];
      return { end: node.range[1], indent: ' '.repeat(first - (original.lastIndexOf('\n', first - 1) + 1)) };
    },
    insert(at, body) {
      // Mid-line (a last entry with no value ends before its newline): start on the next line, whatever the rest of this one holds.
      const nl = at > 0 && original[at - 1] !== '\n' ? original.indexOf('\n', at) : -2;
      if (nl >= 0) inserts.push({ at: nl + 1, text: body });
      else inserts.push({ at, text: (nl === -1 ? '\n' : '') + body });
    },
    insertInline(keys, entries) {
      const node = doc.getIn(keys, true);
      if (node === undefined || node === null) return false;
      const range = (node as { range?: [number, number, number] | null }).range;
      if (range === undefined || range === null) return false;
      const rendered = flowYaml(entries);
      if (isMap(node) && node.flow === true) {
        const contents = rendered.slice(1, -1).trim();
        const source = original.slice(range[0], range[1]);
        if (source.includes('\n')) {
          const last = node.items.at(-1)?.value as { range?: [number, number, number] } | undefined;
          if (last?.range !== undefined) {
            const afterLast = original.slice(last.range[1], range[1] - 1).split('#', 1)[0]!;
            if (!afterLast.includes(',')) inserts.push({ at: last.range[1], text: ',' });
          }
          const close = range[1] - 1;
          const lineStart = original.lastIndexOf('\n', close - 1) + 1;
          const indent = original.slice(lineStart, close).match(/^\s*/)?.[0] ?? '';
          inserts.push({ at: close, text: `  ${contents}\n${indent}` });
          return true;
        }
        const trailingComma = original.slice(range[0], range[1] - 1).trimEnd().endsWith(',');
        inserts.push({ at: range[1] - 1, text: `${node.items.length && !trailingComma ? ', ' : ' '}${contents} ` });
        return true;
      }
      if (typeof node === 'object' && 'value' in node && node.value === null) {
        inserts.push({ at: range[0], text: ` ${rendered}` });
        return true;
      }
      return false;
    },
    append(body) {
      appended += body;
    },
    result() {
      let next = original;
      for (const { at, text: body } of [...inserts].sort((x, y) => y.at - x.at)) next = next.slice(0, at) + body + next.slice(at);
      if (appended !== '') {
        if (next !== '' && !next.endsWith('\n')) next += '\n';
        next += (next === '' ? '' : '\n') + appended;
      }
      return next;
    },
  };
}

/** A map key or a scalar as it is written in the agent file. */
export function yamlKey(key: string | number): string {
  return flowYaml([key]).slice(2, -2);
}

/** Plan new tiers into models.tiers, creating models or tiers when missing. A null tier is a removal entry. */
export function spliceTiers(s: Splicer, tiers: Record<string, ModelTier | null>): void {
  if (Object.keys(tiers).length === 0) return;
  const lines = (indent: string) =>
    Object.entries(tiers)
      .map(([name, tier]) =>
        tier === null ? `${indent}${yamlKey(name)}:\n` : `${indent}${yamlKey(name)}: ${flowYaml({ host: tier.host, model: tier.model, thinking: tier.thinking })}\n`,
      )
      .join('');
  if (s.insertInline(['models', 'tiers'], tiers)) return;
  if (!s.doc.hasIn(['models', 'tiers']) && s.insertInline(['models'], { tiers })) return;
  const tiersAt = s.mapAt(['models', 'tiers']);
  const models = tiersAt === undefined ? s.mapAt(['models']) : undefined;
  if (tiersAt !== undefined) s.insert(tiersAt.end, lines(tiersAt.indent));
  else if (models !== undefined) s.insert(models.end, `${models.indent}tiers:\n${lines(`${models.indent}  `)}`);
  else s.append(`models:\n  tiers:\n${lines('    ')}`);
}

export interface StarterAgent {
  tools: string[];
  /** Seconds. */
  timeout: number;
}

/** Plan new agent entries (no skills, no description) into agents, creating it when missing. */
export function spliceAgents(s: Splicer, agents: Record<string, StarterAgent>): void {
  if (Object.keys(agents).length === 0) return;
  if (s.insertInline(['agents'], agents)) return;
  const agentsAt = s.mapAt(['agents']);
  const indent = agentsAt?.indent ?? '  ';
  const body = Object.entries(agents)
    .map(([name, a]) => `${indent}${yamlKey(name)}:\n${indent}  tools: ${flowYaml(a.tools)}\n${indent}  timeout: ${a.timeout}\n`)
    .join('');
  if (agentsAt !== undefined) s.insert(agentsAt.end, body);
  else if (s.doc.has('agents')) throw new LoadError('agent file: agents must be a map for init to add entries to it');
  else s.append(`agents:\n${body}`);
}

export interface RootSources {
  env?: NodeJS.ProcessEnv;
  /** Roots the parent adapter reports, as file URIs or absolute paths. */
  roots?: () => Promise<string[]> | string[];
  /** Working directory of a command line process. The server never passes one. */
  cwd?: string;
}

/**
 * Resolve the project root from SUBZERO_PROJECT_DIR, then the first reported root,
 * then the command line working directory. Returns an UnresolvedRootError instead
 * of throwing so that the caller can keep trying on later calls.
 */
export async function resolveProjectRoot(sources: RootSources): Promise<string | UnresolvedRootError> {
  const fromEnv = sources.env?.SUBZERO_PROJECT_DIR;
  if (fromEnv !== undefined && fromEnv !== '') {
    return canonicalDir(fromEnv, 'SUBZERO_PROJECT_DIR');
  }

  if (sources.roots) {
    let reported: string[] = [];
    try {
      reported = await sources.roots();
    } catch {
      reported = [];
    }
    const first = reported[0];
    if (first !== undefined) {
      const dir = first.startsWith('file:') ? fileURLToPath(first) : first;
      return canonicalDir(dir, 'the first root reported by the parent');
    }
  }

  if (sources.cwd !== undefined) return canonicalDir(sources.cwd, 'the working directory');
  return new UnresolvedRootError('SUBZERO_PROJECT_DIR is unset and the parent reported no root');
}

function canonicalDir(dir: string, source: string): string | UnresolvedRootError {
  if (!path.isAbsolute(dir)) return new UnresolvedRootError(`${source} is not absolute: ${dir}`);
  try {
    const real = realpathSync(dir);
    if (!statSync(real).isDirectory()) return new UnresolvedRootError(`${source} is not a directory: ${dir}`);
    return real;
  } catch {
    return new UnresolvedRootError(`${source} does not exist: ${dir}`);
  }
}
