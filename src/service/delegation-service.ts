// @sigil implements design/delegation-service.sigil DelegationService

import {
  FALLBACK_AGENT,
  DEFAULT_TIER,
  GENERAL_AGENT,
  loadAgentFile,
  resolveAgent,
  resolveProjectRoot,
  UnknownAgentError,
  UnresolvedRootError,
  type AgentDefinition,
  type RootSources,
} from '../config/agent-config.js';
import { Task, TaskCore } from '../core/task-core.js';
import { ENDED_STATES, type ChildHostOptions, type ChildRunState, type DomainEvent, type Result } from '../core/types.js';
import type { Kernel } from '../kernel/kernel.js';
import { TaskStore, type TaskStoreOptions, type TaskView } from '../store/task-store.js';
import { completionNotice, stopNotice } from './status-text.js';

/** The request of a front end. */
export interface Delegation {
  /** The agent entry to run; none runs `general`. */
  agent?: string;
  /** The model tier to run it on, `medium` or `tier:medium`; none runs the agent's own tier or `medium`. */
  tier?: string;
  briefText: string;
  files?: string[];
  expectedOutput?: string;
  /**
   * The size, in characters, the child's final reply should stay under, which the
   * front end knows from how it returns a result; none tells the child no size.
   */
  replyBudgetChars?: number;
  parentSessionId?: string;
}

export class EmptyBriefError extends Error {
  readonly code = 'empty_brief';
  constructor() {
    super('the brief is empty; write a self-contained brief for the child');
    this.name = 'EmptyBriefError';
  }
}

export interface DelegateOptions {
  wait: boolean;
  onTask?: (taskId: string) => void;
  onEvent?: (event: DomainEvent) => void;
  onState?: (state: ChildRunState) => void;
  /** Aborting it cancels the task. */
  signal?: AbortSignal;
}

/**
 * Queued is a view derived on each reply from the live task and the task record,
 * never a stored task status: a Pending child run of this process, with its place
 * in this process's queue of the endpoint, or a task of another process that has
 * no start time, with no place.
 */
export interface QueuedStatus {
  taskId: string;
  endpoint: string;
  /** Counted from 1 among the Pending child runs of the endpoint in this process. */
  place: number;
  /** The time the task was created. */
  enqueuedAt: string;
}

export type DelegateReply = (
  | { kind: 'result'; result: Result }
  | { kind: 'started'; taskId: string; startedAt: string }
  | ({ kind: 'queued' } & QueuedStatus)
) & {
  /** Set when the named agent is not configured and the fallback agent ran instead. */
  notice?: string;
};

export type CollectReply =
  | { kind: 'result'; result: Result }
  | { kind: 'running'; taskId: string; startedAt: string }
  | ({ kind: 'queued' } & QueuedStatus)
  | { kind: 'abandoned'; taskId: string }
  | { kind: 'other_process'; taskId: string; endpoint?: string; enqueuedAt: string; startedAt?: string }
  | { kind: 'not_found'; taskId: string };

/** A task as a listing shows it: its record, and its queue place while it is Pending in this process. */
export interface TaskListing extends TaskView {
  queuePlace?: number;
  model?: string;
  tier?: string;
}

export interface DelegationServiceOptions extends RootSources {
  /** The registry the entry point of this process filled with its child drivers. */
  kernel: Kernel;
  store?: TaskStoreOptions;
  warn?: (message: string) => void;
}

interface Connected {
  projectRoot: string;
  store: TaskStore;
  core: TaskCore;
}

/** Render the files, the expected output and the reply size after the brief text, into one brief. */
export function renderBrief(delegation: Pick<Delegation, 'briefText' | 'files' | 'expectedOutput' | 'replyBudgetChars'>): string {
  let brief = delegation.briefText;
  const files = (delegation.files ?? []).filter((f) => f !== '');
  if (files.length > 0) brief += `\n\n## Files\n\n${files.map((f) => `- ${f}`).join('\n')}`;
  if (delegation.expectedOutput !== undefined && delegation.expectedOutput.trim() !== '') {
    brief += `\n\n## Expected output\n\n${delegation.expectedOutput}`;
  }
  if (delegation.replyBudgetChars !== undefined) {
    const size = delegation.replyBudgetChars.toLocaleString('en-US');
    brief += `\n\n## Reply size\n\nKeep your final reply under ${size} characters. It is returned to the parent whole, never cut.`;
  }
  return brief;
}

/**
 * Keeps a child run Pending while its endpoint has reached its parallel limit, and
 * releases it first come first served. Counts only the Starting and Live runs of
 * this process; nothing is locked or signalled across processes.
 */
export class EndpointLimiter {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, Task[]>();
  private readonly limits = new Map<string, number | null>();

  admit(task: Task, endpoint: string, limit: number | null): void {
    this.limits.set(endpoint, limit);
    const queue = this.queues.get(endpoint) ?? [];
    this.queues.set(endpoint, queue);
    queue.push(task);
    // A cancelled Pending run leaves the queue and never starts.
    const stop = task.onStateChange((state) => {
      if (state === 'Cancelled' && queue.includes(task)) {
        queue.splice(queue.indexOf(task), 1);
        stop();
      }
    });
    this.drain(endpoint);
  }

  /** The queue place of a Pending task among the Pending runs of its endpoint, from 1; null when it is not queued here. */
  place(task: Task): number | null {
    if (task.state !== 'Pending') return null;
    const pending = (this.queues.get(task.agent.endpoint) ?? []).filter((t) => t.state === 'Pending');
    const index = pending.indexOf(task);
    return index < 0 ? null : index + 1;
  }

  activeCount(endpoint: string): number {
    return this.active.get(endpoint) ?? 0;
  }

  private drain(endpoint: string): void {
    const queue = this.queues.get(endpoint)!;
    const limit = this.limits.get(endpoint) ?? null;
    while (queue.length > 0 && (limit === null || this.activeCount(endpoint) < limit)) {
      const task = queue.shift()!;
      if (task.state !== 'Pending') continue;
      this.active.set(endpoint, this.activeCount(endpoint) + 1);
      let counted = true;
      // Whatever way the run ends, it stops being counted at once.
      const stop = task.onStateChange((state) => {
        if (counted && ENDED_STATES.has(state)) {
          counted = false;
          stop();
          this.active.set(endpoint, this.activeCount(endpoint) - 1);
          this.drain(endpoint);
        }
      });
      task.release();
    }
  }
}

export class DelegationService {
  private connected: Connected | null = null;
  private starting: Promise<Connected> | null = null;
  private readonly registry = new Map<string, Task>();
  private readonly taskTiers = new Map<string, string>();
  private readonly sessions = new Map<string, Set<string>>();
  private readonly limiter = new EndpointLimiter();
  private readonly warn: (message: string) => void;

  constructor(private readonly options: DelegationServiceOptions) {
    this.warn = options.warn ?? ((m) => process.stderr.write(`subzero: ${m}\n`));
  }

  get projectRoot(): string | undefined {
    return this.connected?.projectRoot;
  }

  /** The hosts the Kernel registry runs a child on, for front ends that hand them to AgentConfig. */
  supportedHosts(): string[] {
    return this.options.kernel.supportedHosts();
  }

  hasLiveSessionTasks(): boolean {
    return [...this.sessions.values()].some((tasks) => tasks.size > 0);
  }

  /** The task store, for front ends that read task records. Requires start(). */
  get store(): TaskStore {
    if (this.connected === null) throw new Error('the delegation service has not started');
    return this.connected.store;
  }

  /**
   * Resolve the project root and connect. Until a root resolves, every call tries
   * again and throws the unresolved root error; once it resolves it never changes.
   */
  async start(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<Connected> {
    if (this.connected !== null) return this.connected;
    if (this.starting === null) {
      this.starting = (async () => {
        const root = await resolveProjectRoot(this.options);
        if (root instanceof UnresolvedRootError) throw root;
        const store = new TaskStore(root, { warn: this.warn, ...this.options.store });
        store.sweep();
        const core = new TaskCore({ projectRoot: root, store, warn: this.warn });
        this.connected = { projectRoot: root, store, core };
        return this.connected;
      })();
      this.starting.catch(() => (this.starting = null));
    }
    return this.starting;
  }

  /**
   * Turn an agent and a brief into a task. Throws the unresolved root error,
   * EmptyBriefError, the load error, the unknown agent error or the tier error with no task made.
   */
  async delegate(delegation: Delegation, options: DelegateOptions): Promise<DelegateReply> {
    const { projectRoot, core } = await this.connect();
    if (delegation.briefText.trim() === '') throw new EmptyBriefError();
    // The host of the definition comes from its tier; the registry's hosts are the only ones that run.
    const { agent, notice, tier, childHostOptions } = this.chooseAgent(projectRoot, delegation);
    const port = this.options.kernel.childPort(agent.host);

    const task = core.start({
      agent,
      port,
      childHostOptions,
      brief: renderBrief(delegation),
      ...(delegation.parentSessionId !== undefined ? { parentSessionId: delegation.parentSessionId } : {}),
    });
    this.registry.set(task.taskId, task);
    this.taskTiers.set(task.taskId, tier);
    void task.result.then(() => this.taskTiers.delete(task.taskId));
    if (delegation.parentSessionId !== undefined) {
      const session = this.sessions.get(delegation.parentSessionId) ?? new Set<string>();
      this.sessions.set(delegation.parentSessionId, session);
      session.add(task.taskId);
      void task.result.finally(() => {
        session.delete(task.taskId);
        if (session.size === 0) this.sessions.delete(delegation.parentSessionId!);
      });
    }
    if (options.onEvent) task.onEvent(options.onEvent);
    if (options.onState) task.onStateChange(options.onState);
    if (options.signal) {
      const { signal } = options;
      const onAbort = () => void task.cancel();
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      void task.result.finally(() => signal.removeEventListener('abort', onAbort));
    }
    this.limiter.admit(task, agent.endpoint, agent.parallel);
    options.onTask?.(task.taskId);
    // Only a run the limiter kept back is reported as Pending.
    if (task.state === 'Pending') options.onState?.('Pending');

    const withNotice = <T extends DelegateReply>(reply: T): T => (notice !== undefined ? { ...reply, notice } : reply);
    if (!options.wait) return withNotice(this.liveReply(task));
    return withNotice({ kind: 'result', result: await task.result });
  }

  /**
   * The agent entry a delegation runs, resolved at its tier: the one named, `general`
   * for none or for `general`, or `fallback` for a name the agents map does not hold
   * (with a notice that says so). `general` never falls back.
   */
  private chooseAgent(
    projectRoot: string,
    delegation: Delegation,
  ): { agent: AgentDefinition; tier: string; childHostOptions: ChildHostOptions; notice?: string } {
    const catalog = loadAgentFile(projectRoot, { starterAgents: (host) => this.options.kernel.starterTools(host) });
    const supportedHosts = this.options.kernel.supportedHosts();
    const tier = delegation.tier?.trim().replace(/^tier:/, '').trim();
    const options = { supportedHosts, ...(tier !== undefined && tier !== '' ? { tier } : {}) };
    const named = delegation.agent;
    if (named === undefined || named === GENERAL_AGENT || catalog.entries.has(named)) {
      const agent = resolveAgent(catalog, named, options);
      return {
        agent,
        tier: options.tier ?? catalog.entries.get(named ?? GENERAL_AGENT)?.tier ?? DEFAULT_TIER,
        childHostOptions: catalog.childHostOptions[agent.host] ?? {},
      };
    }
    if (!catalog.entries.has(FALLBACK_AGENT)) throw new UnknownAgentError(named, [...catalog.entries.keys()]);
    const agent = resolveAgent(catalog, FALLBACK_AGENT, options);
    return {
      agent,
      tier: options.tier ?? catalog.entries.get(FALLBACK_AGENT)?.tier ?? DEFAULT_TIER,
      childHostOptions: catalog.childHostOptions[agent.host] ?? {},
      notice: `the agent "${named}" is not configured, so the ${FALLBACK_AGENT} agent ran instead; configured agents: ${[...catalog.entries.keys()].join(', ')}`,
    };
  }

  /** The reply of a live task that has no result: its start time, or its place in line while Pending. */
  private liveReply(task: Task): { kind: 'started'; taskId: string; startedAt: string } | ({ kind: 'queued' } & QueuedStatus) {
    // A task with no start time has not been released, so it is still in line.
    if (task.startedAt === null) {
      const place = this.limiter.place(task) ?? 1;
      return { kind: 'queued', taskId: task.taskId, endpoint: task.agent.endpoint, place, enqueuedAt: task.enqueuedAt };
    }
    return { kind: 'started', taskId: task.taskId, startedAt: task.startedAt };
  }

  /** Collect by task id: the live registry first, then the task record. */
  async collect(taskId: string): Promise<CollectReply> {
    const { store } = await this.connect();
    store.sweep();
    const live = this.registry.get(taskId);
    if (live !== undefined) {
      const result = live.settledResult;
      if (result !== undefined) return { kind: 'result', result };
      const reply = this.liveReply(live);
      return reply.kind === 'started' ? { kind: 'running', taskId, startedAt: reply.startedAt } : reply;
    }
    return this.fromRecord(store, taskId);
  }

  /** Wait up to timeoutMs for a live task; otherwise answer as collect does. */
  async waitFor(taskId: string, timeoutMs: number): Promise<CollectReply> {
    const first = await this.collect(taskId);
    const live = this.registry.get(taskId);
    if ((first.kind !== 'running' && first.kind !== 'queued') || live === undefined) return first;
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      live.result,
      new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs)))),
    ]);
    clearTimeout(timer);
    // Read the task again: it may have been released while this call waited.
    return result === null ? this.collect(taskId) : { kind: 'result', result };
  }

  /** Wait for a task owned by this process without a polling deadline. */
  async waitForCompletion(taskId: string): Promise<CollectReply> {
    const live = this.registry.get(taskId);
    return live === undefined ? this.collect(taskId) : { kind: 'result', result: await live.result };
  }

  async cancel(taskId: string): Promise<CollectReply> {
    const { store } = await this.connect();
    store.sweep();
    const live = this.registry.get(taskId);
    if (live !== undefined) return { kind: 'result', result: await live.cancel() };
    // A settled task returns its stored result unchanged; nothing is signalled.
    return this.fromRecord(store, taskId);
  }

  async cancelSession(parentSessionId: string | undefined): Promise<{ kind: 'unknown_session' | 'cancelled'; taskIds: string[]; count: number }> {
    if (parentSessionId === undefined || parentSessionId === '') return { kind: 'unknown_session', taskIds: [], count: 0 };
    const taskIds = [...(this.sessions.get(parentSessionId) ?? [])];
    const tasks = taskIds.map((id) => this.registry.get(id)).filter((task): task is Task => task !== undefined && task.settledResult === undefined);
    const pending = tasks.filter((task) => task.state === 'Pending');
    const live = tasks.filter((task) => task.state !== 'Pending');
    await Promise.all(pending.map((task) => task.cancel()));
    await Promise.all(live.map((task) => task.cancel()));
    return { kind: 'cancelled', taskIds: tasks.map((task) => task.taskId), count: tasks.length };
  }

  async list(parentSessionId?: string): Promise<TaskListing[]> {
    const { store } = await this.connect();
    store.sweep();
    return store.list(parentSessionId).map((view) => {
      const live = this.registry.get(view.taskId);
      const place = live !== undefined ? this.limiter.place(live) : null;
      return place !== null ? { ...view, queuePlace: place } : view;
    });
  }

  async listLiveSession(parentSessionId: string): Promise<TaskListing[]> {
    const ids = this.sessions.get(parentSessionId) ?? new Set<string>();
    return (await this.list(parentSessionId)).filter((task) => ids.has(task.taskId) && task.status === 'running').map((task) => ({
      ...task,
      model: this.registry.get(task.taskId)?.agent.model,
      tier: this.taskTiers.get(task.taskId),
    }));
  }

  async attachCommand(taskId: string): Promise<{ kind: 'command'; command: string[] } | { kind: 'error'; message: string }> {
    const { store } = await this.connect();
    store.sweep();
    const record = store.readTask(taskId);
    if (!record) return { kind: 'error', message: `no such task ${taskId}` };
    if (record.status === 'running') return { kind: 'error', message: `task ${taskId} is still running; wait until it ends before attaching` };
    const spec = record.task?.launchSpec;
    if (!spec) return { kind: 'error', message: `no launch spec was recorded for task ${taskId}` };
    const host = record.task?.agent.host ?? '(not recorded)';
    try {
      const attach = this.options.kernel.attachCommand(host);
      if (!attach) return { kind: 'error', message: `the child driver of host ${host} offers no attach command` };
      return { kind: 'command', command: attach(spec) };
    } catch (err) {
      return { kind: 'error', message: (err as Error).message };
    }
  }

  async notice(taskId: string, status: Result['status'], parentSessionId: string, collectTool: string): Promise<string> {
    if (status === 'cancelled') return stopNotice(taskId);
    return completionNotice(taskId, status, (await this.listLiveSession(parentSessionId)).filter((task) => task.taskId !== taskId), collectTool);
  }

  private fromRecord(store: TaskStore, taskId: string): CollectReply {
    const record = store.readTask(taskId);
    if (record === null) return { kind: 'not_found', taskId };
    if (record.result !== null) return { kind: 'result', result: record.result };
    if (record.status === 'abandoned') return { kind: 'abandoned', taskId };
    return {
      kind: 'other_process',
      taskId,
      ...(record.endpoint !== undefined ? { endpoint: record.endpoint } : {}),
      enqueuedAt: record.createdAt,
      ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    };
  }

  /**
   * Cancel every live child run of this process and wait for each to end. Returns
   * false when some were still live at the deadline: the entry point, which holds
   * the child drivers, then kills what is left, so no child run outlives the process.
   */
  async shutdown(deadlineMs = 8000): Promise<boolean> {
    const live = [...this.registry.values()].filter((task) => task.settledResult === undefined);
    let timer: NodeJS.Timeout | undefined;
    const ended = await Promise.race([
      Promise.all(live.map((task) => task.cancel())).then(() => true),
      new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), deadlineMs))),
    ]);
    clearTimeout(timer);
    if (!ended) for (const task of live) task.forceCancel();
    return ended;
  }
}
