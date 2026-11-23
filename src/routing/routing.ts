// @sigil implements design/claude-routing-hooks.sigil ClaudeRoutingHooks
//
// The routing logic the hook processes share: the alias table, the generic-spawn
// test, the routing text and the deny decision. It reaches the core only through
// AgentConfig and imports no child driver or server. Entry scripts stay thin; the
// logic is importable.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AGENT_FILE, globalFile, getRouting, MissingAgentFileError, routableTiers, type RoutableTier } from '../config/agent-config.js';
import { TIER_WORDS } from '../config/tier-words.js';
import { liveReadinessMarkers } from '../mcp/parent-session.js';
import { lockAvailable, lockProgram, withDenyLock } from './deny-lock.js';

/** The delegate tool as Claude Code names it for the plugin. */
export const DELEGATE_TOOL = 'mcp__plugin_subzero_subzero__delegate';
const AWAIT_TOOL = 'mcp__plugin_subzero_subzero__await';
const TASKS_TOOL = 'mcp__plugin_subzero_subzero__tasks';
/** The longest wait the await tool honours. */
const AWAIT_SECONDS = 600;
/** The description prefix that marks a pass-back (KTD17). */
export const PASSBACK_WORD = 'passback';

/** The model tier a spawn's model alias maps to; opus and fable map to none (KTD6). */
export function aliasTier(model: string | undefined): string | undefined {
  if (model === undefined) return 'large';
  if (model === 'haiku') return 'small';
  if (model === 'sonnet') return 'medium';
  return undefined;
}

export const DEFAULT_GENERIC_AGENTS: readonly string[] = ['general-purpose', 'claude'];

/** The fields of an Agent spawn that the hooks look at. */
export interface AgentSpawn {
  subagent_type?: string;
  model?: string;
  description?: string;
  prompt?: string;
  isolation?: string;
}

/** A spawn is generic when it names no agent type or one on the generic list. */
export function isGenericSpawn(spawn: AgentSpawn, genericAgents?: readonly string[]): boolean {
  const type = spawn.subagent_type;
  if (type === undefined || type === '') return true;
  return (genericAgents ?? DEFAULT_GENERIC_AGENTS).includes(type);
}

/** Keep the routable tiers that a tier word maps to, in tier-word order. */
export function wordTiers(tiers: RoutableTier[]): RoutableTier[] {
  return TIER_WORDS.flatMap(({ tier }) => tiers.filter((t) => t.tier === tier));
}

/** The text SessionStart adds to Claude's context for these routable, tier-word tiers. */
export function buildRoutingText(tiers: RoutableTier[], taskMode: boolean | null = false): string {
  const routed = new Map(tiers.map((t) => [t.tier, t]));
  const lines = [
    'subzero routing is on for this project.',
    `Some subagent work runs on other models through the ${DELEGATE_TOOL} tool instead of the Agent tool.`,
    'Compound-engineering names a model by tier word; delegate accepts these phrases or tier names:',
  ];
  for (const { tier, phrase } of TIER_WORDS) {
    const t = routed.get(tier);
    lines.push(
      t !== undefined
        ? `- ${phrase} (${tier}): ${DELEGATE_TOOL} with tier: "${tier}" (model ${t.model}, host ${t.host}).`
        : `- ${phrase} (${tier}): not configured here, stays on Claude with the Agent tool.`,
    );
  }
  lines.push(
    'Pass the subagent prompt unchanged as brief. A subagent spawn that asks for a fork or for worktree isolation stays on the Agent tool and is never sent to subzero.',
    taskMode === true
      ? `Dispatch every routed subagent with ${DELEGATE_TOOL}(tier, brief) in one message; completed tasks deliver their results. Use results returned directly, and wait for every completion notice from background tasks before using their results together.`
      : taskMode === null
      ? `Dispatch every routed subagent with ${DELEGATE_TOOL}(tier, brief) in one message. If it returns a task id, collect it with ${AWAIT_TOOL}; wait for every task before using their results together.`
      : `Dispatch every routed subagent with ${DELEGATE_TOOL}(tier, brief, wait: false) in one message. Then call ${AWAIT_TOOL} with tasks (every task id) and timeout_s: ${AWAIT_SECONDS}, and repeat it until every task is done.`,
    `A task whose result an await reply does not show must be read with ${TASKS_TOOL}(task) before it is used.`,
    'In a non-interactive or unidentified session, delegate waits and returns the result even when asked not to wait.',
    'A queued task has not launched yet: no child is running and it starts when its model has room. A task\'s launch time is its `started` time; the time it waited does not count.',
    `If ${DELEGATE_TOOL} is refused or returns a tool error and made no task, pass that subagent back: call Agent with the same prompt and a short description that begins with \`${PASSBACK_WORD}\`. Once a task id came back the work stays with subzero, even if its result fails; never pass it back.`,
  );
  return lines.join('\n');
}

/** One line telling Claude that routing is off because a config file does not load; `file` is the one the error names. */
export function buildWarning(detail: string, file: string = AGENT_FILE): string {
  const flat = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
  return `subzero routing is off: the config file ${file} does not load (${flat}). Every subagent runs on Claude until it is fixed.`;
}

/** One line telling Claude that routing is off because the deny lock's utility is missing. */
export function buildLockWarning(program: string = lockProgram()): string {
  return `subzero routing is off: the ${program} utility is not installed, and the routing hook needs it to coordinate sessions. Every subagent runs on Claude until ${program} is installed.`;
}

/**
 * What SessionStart adds to Claude's context for a project, or undefined for nothing.
 * A project that is off (no medium tier in the merged config, or enabled: false), no
 * project root, no routable tier word and any error other than a load error all add
 * nothing (R13, R18). A project that would route, on a machine without the deny lock's
 * utility, gets the lock warning instead of the routing text, because the hook then
 * allows every spawn through.
 */
export function routingContext(
  projectRoot: string | undefined,
  taskMode: boolean | null = false,
  lockReady: () => boolean = lockAvailable,
): string | undefined {
  if (projectRoot === undefined) return undefined;
  try {
    const tiers = wordTiers(routableTiers(projectRoot));
    if (tiers.length === 0) return undefined;
    return lockReady() ? buildRoutingText(tiers, taskMode) : buildLockWarning();
  } catch (err) {
    if (err instanceof MissingAgentFileError) return undefined;
    if ((err as { code?: unknown }).code === 'load_error') {
      const message = (err as Error).message;
      const global = globalFile();
      return buildWarning(message, message.includes(global) ? global : AGENT_FILE);
    }
    return undefined;
  }
}

/** The fields of a PreToolUse Agent input the decision looks at. */
export type SpawnInput = AgentSpawn;

export interface HookContext {
  projectRoot: string;
  dataDir: string;
  /** The parent session id the hook input carries. */
  sessionId: string;
  /** The hook's ancestor pids; the real process tree when left out. */
  ancestors?: () => Set<number>;
  now?: () => number;
}

export type HookDecision = { decision: 'allow' } | { decision: 'deny'; tier: string; reason: string };

const ALLOW: HookDecision = { decision: 'allow' };
/** A deny memory folder not written for this long is deleted. */
const DENY_MEMORY_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_ANCESTORS = 64;

/**
 * The pids of this process's ancestors, from its parent up to but excluding init.
 * Throws when the process table cannot be read, which the decision treats as allow.
 */
export function ancestorPids(pid: number = process.pid): Set<number> {
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  const parents = new Map<number, number>();
  for (const line of table.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child !== undefined && parent !== undefined && Number.isInteger(child) && Number.isInteger(parent)) parents.set(child, parent);
  }
  if (!parents.has(pid)) throw new Error('the process table does not list this process');
  const out = new Set<number>();
  let at = parents.get(pid);
  while (at !== undefined && at > 1 && !out.has(at) && out.size < MAX_ANCESTORS) {
    out.add(at);
    at = parents.get(at);
  }
  return out;
}

const promptHash = (prompt: string): string => createHash('sha256').update(prompt).digest('hex');

function denyRoot(dataDir: string): string {
  return path.join(dataDir, 'sessions', 'deny');
}

function denyFolder(dataDir: string, sessionId: string): string {
  return path.join(denyRoot(dataDir), createHash('sha256').update(sessionId).digest('hex').slice(0, 32));
}

/** The tier the deny memory kept for a prompt in a session, or undefined. */
function rememberedTier(dataDir: string, sessionId: string, hash: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(path.join(denyFolder(dataDir, sessionId), hash), 'utf8')) as { tier?: unknown };
    return typeof value.tier === 'string' ? value.tier : undefined;
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return undefined;
    throw err; // an unreadable store means allow
  }
}

/**
 * Record a denied prompt as its own create-only entry. No entry is read or replaced,
 * so hook processes of one concurrent batch cannot lose each other's entries. Session
 * folders not written for seven days are deleted, except the one being written.
 */
function remember(dataDir: string, sessionId: string, hash: string, tier: string): void {
  const folder = denyFolder(dataDir, sessionId);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path.join(folder, hash), JSON.stringify({ tier }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'EEXIST') throw err;
  }
}

function sweepDenyMemory(dataDir: string, now: number, keep: string): void {
  const root = denyRoot(dataDir);
  let names: string[];
  try { names = readdirSync(root); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
  for (const name of names) {
      // A resumed session's folder can be old by mtime; the write below must not lose it.
      if (name === keep) continue;
      try {
        const folder = path.join(root, name);
        if (now - statSync(folder).mtimeMs <= DENY_MEMORY_TTL_MS) continue;
        const checked = withDenyLock(dataDir, name, () => {
          try {
            if (now - statSync(folder).mtimeMs > DENY_MEMORY_TTL_MS) rmSync(folder, { recursive: true, force: true });
          } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
          return true;
        });
        if (!checked) throw new Error('could not lock deny memory for cleanup');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
}

/** The deny reason Claude sees (KTD8, KTD17). */
export function buildDenyReason(tier: string, prompt: string, taskMode: boolean | null = false): string {
  return [
    taskMode === true
      ? `Send this subagent to subzero instead of the Agent tool: call ${DELEGATE_TOOL} with tier: "${tier}" and brief set to this Agent call's prompt unchanged.`
      : taskMode === null
      ? `Send this subagent to subzero instead of the Agent tool: call ${DELEGATE_TOOL} with tier: "${tier}" and brief set to this Agent call's prompt unchanged. If it returns a task id, collect it with the await tool.`
      : `Send this subagent to subzero instead of the Agent tool: call ${DELEGATE_TOOL} with tier: "${tier}", brief set to this Agent call's prompt unchanged, and wait: false, then collect it with the await tool.`,
    'This is a routing rule, not an error; do not call Agent again for this subagent and do not change its model.',
    `Only if ${DELEGATE_TOOL} is refused or returns a tool error and made no task, call Agent again with the prompt unchanged and a short description that begins with \`${PASSBACK_WORD}\`. Once a task id came back the work stays with subzero, even if its result fails.`,
    `brief:\n${prompt}`,
  ].join('\n');
}

function isPassback(description: string | undefined): boolean {
  return description !== undefined && /^passback\b/.test(description.trimStart());
}

function matchingMarker(ctx: HookContext) {
  const markers = liveReadinessMarkers(ctx.dataDir, ctx.projectRoot);
  if (markers.length === 0) return undefined;
  const ancestors = (ctx.ancestors ?? ancestorPids)();
  return markers.find((m) => ancestors.has(m.ppid));
}

/**
 * Decide one Agent spawn (the flowchart of the plan): deny only a generic spawn the
 * alias table maps to a routable tier, or a prompt the deny memory holds toward a tier
 * that is still routable. Any error, missing input or unreadable store allows (R18).
 */
export function decideAgentSpawn(spawn: SpawnInput, ctx: HookContext): HookDecision {
  try {
    if (typeof spawn !== 'object' || spawn === null || Array.isArray(spawn)) return ALLOW;
    for (const key of ['prompt', 'description', 'subagent_type', 'model', 'isolation'] as const) {
      if (spawn[key] !== undefined && typeof spawn[key] !== 'string') return ALLOW;
    }
    const prompt = spawn.prompt;
    if (typeof prompt !== 'string' || prompt === '' || ctx.sessionId.trim() === '') return ALLOW;
    if (!getRouting(ctx.projectRoot).hook) return ALLOW;
    // The hook has no Kernel: every configured tier that a tier word maps to is routable.
    const routable = new Set(wordTiers(routableTiers(ctx.projectRoot)).map((t) => t.tier));
    if (routable.size === 0) return ALLOW;
    const marker = matchingMarker(ctx);
    if (!marker) return ALLOW;
    // A fork is an agent type; any non-empty isolation (worktree, remote, unknown) allows,
    // because subzero can honor no isolated spawn.
    if (spawn.subagent_type === 'fork') return ALLOW;
    if (typeof spawn.isolation === 'string' && spawn.isolation !== '') return ALLOW;

    const sessionKey = path.basename(denyFolder(ctx.dataDir, ctx.sessionId));
    // Cleanup runs before recording a denial: an error must not leave memory
    // for a spawn that was allowed through.
    sweepDenyMemory(ctx.dataDir, (ctx.now ?? Date.now)(), sessionKey);
    return withDenyLock(ctx.dataDir, sessionKey, (): HookDecision => {
      const hash = promptHash(prompt);
      const kept = rememberedTier(ctx.dataDir, ctx.sessionId, hash);
      if (kept !== undefined && isPassback(spawn.description)) return ALLOW;
      if (kept !== undefined && routable.has(kept)) return { decision: 'deny', tier: kept, reason: buildDenyReason(kept, prompt, marker.taskMode) };

      if (!isGenericSpawn(spawn, getRouting(ctx.projectRoot).genericAgents)) return ALLOW;
      const tier = aliasTier(spawn.model);
      if (tier === undefined || !routable.has(tier)) return ALLOW;
      remember(ctx.dataDir, ctx.sessionId, hash, tier);
      return { decision: 'deny', tier, reason: buildDenyReason(tier, prompt, marker.taskMode) };
    }) ?? ALLOW;
  } catch {
    return ALLOW;
  }
}
