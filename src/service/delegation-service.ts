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
import { Task, TaskCore, type Turn } from '../core/task-core.js';
import { ENDED_STATES, type ChildHostOptions, type ChildRunState, type DomainEvent, type Result } from '../core/types.js';
import type { Kernel } from '../kernel/kernel.js';
import { TaskStore, type StopReason, type TaskRecord, type TaskStoreOptions, type TaskView, type TurnFile } from '../store/task-store.js';
import { completionNotice, formatResult, formatStatusLine, statusFacts, stopNotice } from './status-text.js';

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
  /**
   * Aborting it ends the wait and returns the current state, and cancels nothing. The task and
   * its children keep running.
   */
  until?: AbortSignal;
  /** Also wait for turns that messages held for the task open, and return every result. */
  followOn?: boolean;
}

/**
 * Queued is a view derived on each reply from the live task and the task record,
 * never a stored task status: a Pending child run of this process, with its place
 * in this process's queue of its model, or a task of another process that has
 * no start time, with no place.
 */
export interface QueuedStatus {
  taskId: string;
  /** The full model id whose limit holds the task back. */
  model: string;
  /** Counted from 1 among the Pending child runs of the model in this process. */
  place: number;
  /** The time the task was created. */
  enqueuedAt: string;
}

/** One turn's result as a reply gives it, with the turn its held messages opened, when they opened one. */
export interface TurnResult {
  result: Result;
  /** The number of the turn that messages held for this turn opened by themselves. */
  openedTurn?: number;
}

export type DelegateReply = (
  | { kind: 'result'; result: Result; openedTurn?: number; results?: Result[] }
  | { kind: 'started'; taskId: string; startedAt: string }
  | ({ kind: 'queued' } & QueuedStatus)
) & {
  /** Set when the named agent is not configured and the fallback agent ran instead. */
  notice?: string;
  /** False when the task has no parent session id, so it cannot be continued. */
  continuable?: false;
};

/** What `continue` answers: the delivery outcome, and for a new turn its state or result. */
export type ContinueReply =
  | { kind: 'steered' | 'queued'; taskId: string; turn: number }
  | { kind: 'new_turn'; taskId: string; turn: number; replayed?: number; status: DelegateReply }
  /** `status` is the status line of the task, or the first line of its result text; none when the conversation is unknown. */
  | { kind: 'not_delivered'; taskId: string; reason: string; status?: string };

/**
 * A turn that no call opened: held messages or unread steers opened it. The sink hears when it
 * opens, so a front end can keep a wait pending, and again with its result when it settles.
 */
export type TurnNotice = {
  taskId: string;
  turn: number;
  parentSessionId?: string;
} & ({ phase: 'opened' } | { phase: 'settled'; result: Result });

export type NoticeSink = (notice: TurnNotice) => void;

export type CollectReply =
  | { kind: 'result'; result: Result; openedTurn?: number }
  /** Every uncollected turn, oldest first, then the status of the latest turn when it has not settled. */
  | { kind: 'results'; taskId: string; results: TurnResult[]; then?: CollectReply }
  /** The latest turn's result already reached the parent, so a collect for new results has none. */
  | { kind: 'delivered'; taskId: string; turn: number; status: Result['status'] }
  | { kind: 'running'; taskId: string; startedAt: string }
  | ({ kind: 'queued' } & QueuedStatus)
  | { kind: 'abandoned'; taskId: string }
  | { kind: 'other_process'; taskId: string; model?: string; enqueuedAt: string; startedAt?: string }
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
 * Keeps a child run Pending while its model has reached its parallel limit, and
 * releases it first come first served. The unit is a turn, so a continued task queues
 * like a new one. Counts only the Starting and Live runs of this process; nothing is
 * locked or signalled across processes.
 */
export class ModelLimiter {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, Turn[]>();
  private readonly limits = new Map<string, number | null>();
  private readonly models = new Map<Turn, string>();

  admit(turn: Turn, model: string, limit: number | null): void {
    this.limits.set(model, limit);
    const queue = this.queues.get(model) ?? [];
    this.queues.set(model, queue);
    queue.push(turn);
    this.models.set(turn, model);
    // A cancelled Pending run leaves the queue and never starts; the watcher goes once the run leaves Pending.
    const stop = turn.onStateChange((state) => {
      if (state === 'Pending') return;
      stop();
      if (state === 'Cancelled' && queue.includes(turn)) queue.splice(queue.indexOf(turn), 1);
    });
    this.drain(model);
  }

  /** The queue place of a Pending turn among the Pending runs of its model, from 1; null when it is not queued here. */
  place(turn: Turn): number | null {
    if (turn.state !== 'Pending') return null;
    const pending = (this.queues.get(this.models.get(turn) ?? '') ?? []).filter((t) => t.state === 'Pending');
    const index = pending.indexOf(turn);
    return index < 0 ? null : index + 1;
  }

  activeCount(model: string): number {
    return this.active.get(model) ?? 0;
  }

  private drain(model: string): void {
    const queue = this.queues.get(model)!;
    const limit = this.limits.get(model) ?? null;
    while (queue.length > 0 && (limit === null || this.activeCount(model) < limit)) {
      const turn = queue.shift()!;
      if (turn.state !== 'Pending') continue;
      this.active.set(model, this.activeCount(model) + 1);
      let counted = true;
      // Whatever way the run ends, it stops being counted at once.
      const stop = turn.onStateChange((state) => {
        if (counted && ENDED_STATES.has(state)) {
          counted = false;
          stop();
          this.models.delete(turn);
          this.active.set(model, this.activeCount(model) - 1);
          this.drain(model);
        }
      });
      turn.release();
    }
  }
}

/** A request to continue a task: the message goes to the task of the conversation that made it. */
export interface Continuation {
  taskId: string;
  message: string;
  parentSessionId?: string;
}

export interface ContinueOptions {
  /** Wait for the result of a new turn this call opens; steered and queued replies never wait. */
  wait: boolean;
  signal?: AbortSignal;
  until?: AbortSignal;
  followOn?: boolean;
  onEvent?: (event: DomainEvent) => void;
  onState?: (state: ChildRunState) => void;
}

/** Marks an in-flight continuation so a session cancel can stop it before its turn starts. */
interface Opening {
  cancelled: boolean;
}

const UNTIL = Symbol('until');

/** Resolves to UNTIL when the signal aborts, and never otherwise. */
function untilPromise(until: AbortSignal | undefined): Promise<typeof UNTIL> {
  if (until === undefined) return new Promise(() => {});
  if (until.aborted) return Promise.resolve(UNTIL);
  return new Promise((resolve) => until.addEventListener('abort', () => resolve(UNTIL), { once: true }));
}

export class DelegationService {
  private connected: Connected | null = null;
  private starting: Promise<Connected> | null = null;
  private readonly registry = new Map<string, Task>();
  private readonly taskSessions = new Map<string, string>();
  private readonly sessions = new Map<string, Set<string>>();
  private readonly opening = new Map<string, Set<Opening>>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly sinks = new Set<NoticeSink>();
  private readonly limiter = new ModelLimiter();
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
   * Register the one sink that hears of turns no call opened: a turn that held messages or unread
   * steering messages opened settles there. Returns a function that removes it.
   */
  onNotice(sink: NoticeSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
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
        const core = new TaskCore({ projectRoot: root, store, warn: this.warn, onTurnOpened: (task, turn) => this.adoptAutoTurn(task, turn) });
        this.connected = { projectRoot: root, store, core };
        return this.connected;
      })();
      this.starting.catch(() => (this.starting = null));
    }
    return this.starting;
  }

  /** Remember the task of a conversation, and forget it once its latest turn has settled. */
  private track(task: Task, turn: Turn, parentSessionId: string | undefined): void {
    this.registry.set(task.taskId, task);
    if (parentSessionId === undefined) return;
    this.taskSessions.set(task.taskId, parentSessionId);
    const session = this.sessions.get(parentSessionId) ?? new Set<string>();
    this.sessions.set(parentSessionId, session);
    session.add(task.taskId);
    void turn.result.finally(() => {
      // A newer turn keeps the task live in its session.
      if (task.latest.settledResult === undefined) return;
      session.delete(task.taskId);
      if (session.size === 0 && this.sessions.get(parentSessionId) === session) this.sessions.delete(parentSessionId);
    });
  }

  /** A turn that held messages or unread steers opened: admit it, and report it through the sink once it settles. */
  private adoptAutoTurn(task: Task, turn: Turn): void {
    const parentSessionId = this.taskSessions.get(task.taskId);
    this.track(task, turn, parentSessionId);
    this.limiter.admit(turn, task.agent.model, this.limitFor(task));
    const base = { taskId: task.taskId, turn: turn.number, ...(parentSessionId !== undefined ? { parentSessionId } : {}) };
    this.tell({ ...base, phase: 'opened' });
    void turn.result.then((result) => this.tell({ ...base, phase: 'settled', result }));
  }

  private tell(notice: TurnNotice): void {
    for (const sink of this.sinks) {
      try {
        sink(notice);
      } catch (err) {
        this.warn(`a notice sink failed: ${(err as Error).message}`);
      }
    }
  }

  /** The limit of the model of a task at its next admission: the agent file's now, else the one it was delegated with. */
  private limitFor(task: Task): number | null {
    const { projectRoot } = this.connected!;
    try {
      return loadAgentFile(projectRoot, { starterAgents: (host) => this.options.kernel.starterTools(host) }).limits.get(task.agent.model) ?? null;
    } catch {
      return task.agent.parallel;
    }
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
      tier,
      brief: renderBrief(delegation),
      ...(delegation.parentSessionId !== undefined ? { parentSessionId: delegation.parentSessionId } : {}),
    });
    const turn = task.latest;
    this.track(task, turn, delegation.parentSessionId);
    if (options.onEvent) turn.onEvent(options.onEvent);
    if (options.onState) turn.onStateChange(options.onState);
    if (options.signal) this.cancelOnAbort(task, turn, options.signal);
    this.limiter.admit(turn, agent.model, agent.parallel);
    options.onTask?.(task.taskId);
    // Only a run the limiter kept back is reported as Pending.
    if (turn.state === 'Pending') options.onState?.('Pending');

    const flags = {
      ...(notice !== undefined ? { notice } : {}),
      ...(delegation.parentSessionId === undefined ? { continuable: false as const } : {}),
    };
    const withFlags = <T extends DelegateReply>(reply: T): T => ({ ...reply, ...flags });
    if (!options.wait) return withFlags(this.liveReply(task));
    return withFlags(await this.waitTurn(task, turn, options));
  }

  /** Aborting the signal cancels the turn, and the listener goes once the turn has a result. */
  private cancelOnAbort(task: Task, turn: Turn, signal: AbortSignal): void {
    const onAbort = () => void turn.cancel();
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    void turn.result.finally(() => signal.removeEventListener('abort', onAbort));
  }

  /**
   * Wait for the result of a turn, and, when asked, for the turns that messages held for it open.
   * An `until` signal ends the wait with the current state and cancels nothing.
   */
  private async waitTurn(task: Task, first: Turn, options: { until?: AbortSignal; followOn?: boolean }): Promise<DelegateReply> {
    const results: Result[] = [];
    let turn = first;
    for (;;) {
      const outcome = await Promise.race([turn.result, untilPromise(options.until)]);
      if (outcome === UNTIL) return this.liveReply(task);
      results.push(outcome);
      this.markCollected(task.taskId, outcome);
      const next = task.latest !== turn && options.followOn === true ? task.latest : undefined;
      if (next === undefined) break;
      turn = next;
    }
    const last = results[results.length - 1]!;
    const opened = task.latest !== turn && task.latest.viaHeld ? task.latest.number : undefined;
    return {
      kind: 'result',
      result: last,
      ...(opened !== undefined ? { openedTurn: opened } : {}),
      ...(results.length > 1 ? { results } : {}),
    };
  }

  /** Every path that delivers a result to the parent marks its turn collected. */
  private markCollected(taskId: string, result: Result): void {
    this.markDelivered(taskId, result.turn ?? 1);
  }

  /** A front end that delivers a result by its own path, such as an MCP task result, marks the turn here. */
  markDelivered(taskId: string, turn: number): void {
    try {
      this.connected?.store.markCollected(taskId, turn);
    } catch (err) {
      this.warn(`could not mark turn ${turn} of ${taskId} collected: ${(err as Error).message}`);
    }
  }

  /** The path of a turn's collected marker, for a wake marker that another process creates after delivery. */
  collectedMarkerPath(taskId: string, turn: number): string | undefined {
    return this.connected?.store.collectedMarkerPath(taskId, turn);
  }

  /** The number of the latest turn of a task of this process while it has not settled; undefined otherwise. */
  runningTurn(taskId: string): number | undefined {
    const task = this.registry.get(taskId);
    return task !== undefined && task.settledResult === undefined ? task.latest.number : undefined;
  }

  /** The result of one turn of a task of this process, once it settles; undefined for a turn this process does not hold. */
  resultOfTurn(taskId: string, turn: number): Promise<Result> | undefined {
    return this.registry.get(taskId)?.turns.find((t) => t.number === turn)?.result;
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
    // A turn with no start time has not been released, so it is still in line.
    if (task.startedAt === null) {
      const place = this.limiter.place(task.latest) ?? 1;
      return { kind: 'queued', taskId: task.taskId, model: task.agent.model, place, enqueuedAt: task.enqueuedAt };
    }
    return { kind: 'started', taskId: task.taskId, startedAt: task.startedAt };
  }

  // ---- continue ------------------------------------------------------------

  /**
   * Give a task a follow-up message: held while its run has not started, steered into a live
   * run, or the prompt of a new turn when the latest turn ended. Only the task's own conversation
   * may continue it, and another process takes a task over unless its latest turn is running there.
   */
  async continue(request: Continuation, options: ContinueOptions): Promise<ContinueReply> {
    // Registered before the first await, so a session cancel that arrives while the call sweeps or
    // loads the configuration stops the turn before it starts.
    const opening: Opening = { cancelled: false };
    if (request.parentSessionId !== undefined) {
      const set = this.opening.get(request.parentSessionId) ?? new Set<Opening>();
      this.opening.set(request.parentSessionId, set);
      set.add(opening);
    }
    try {
      return await this.serial(request.taskId, () => this.continueNow(request, options, opening, false));
    } finally {
      if (request.parentSessionId !== undefined) {
        const set = this.opening.get(request.parentSessionId);
        set?.delete(opening);
        if (set?.size === 0) this.opening.delete(request.parentSessionId);
      }
    }
  }

  /** Run steps for one task one at a time, so two continuations in one tick open one turn. */
  private serial<T>(taskId: string, step: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(taskId) ?? Promise.resolve();
    const next = previous.then(step, step);
    const tail = next.catch(() => undefined);
    this.chains.set(taskId, tail);
    void tail.then(() => {
      if (this.chains.get(taskId) === tail) this.chains.delete(taskId);
    });
    return next;
  }

  private async continueNow(request: Continuation, options: ContinueOptions, opening: Opening, retried: boolean): Promise<ContinueReply> {
    const { taskId, parentSessionId } = request;
    const refuse = (reason: string, status?: string): ContinueReply => ({ kind: 'not_delivered', taskId, reason, ...(status !== undefined ? { status } : {}) });
    const { store, core } = await this.connect();
    if (opening.cancelled) return refuse('the conversation was cancelled while the message was being delivered');
    store.sweep();
    this.dropTakenOver(store);
    if (parentSessionId === undefined || parentSessionId === '') return refuse('this conversation could not be identified');
    const record = store.readTask(taskId);
    if (record === null) throw new Error(`no task ${taskId}`);
    if (record.parentSessionId === undefined) return refuse('this conversation could not be identified: the task has no conversation recorded');
    if (record.parentSessionId !== parentSessionId) return refuse('this task belongs to another conversation', this.undeliveredStatus(record));

    let task = this.registry.get(taskId);
    if (task === undefined) {
      const latest = record.turns[record.turns.length - 1];
      // Only the owner of a running turn holds its child, so a turn running in a live process is not ours to take.
      if (latest !== undefined && latest.result === undefined && record.status === 'running' && latest.owner !== null && !store.isOwner(latest.owner) && store.ownerAlive(latest.owner) === true) {
        return refuse(`its latest turn is running in another process (pid ${latest.owner.pid}); wait for its result`, this.undeliveredStatus(record));
      }
      if (record.task === null) return refuse('its task record is missing');
      let port;
      try {
        port = this.options.kernel.childPort(record.task.agent.host);
      } catch (err) {
        return refuse((err as Error).message);
      }
      task = core.load(taskId, port) ?? undefined;
      if (task === undefined) return refuse('its task record could not be loaded');
    }

    // Steering and holding use the frozen record; only a turn that opens needs the configuration.
    if (ENDED_STATES.has(task.state)) {
      try {
        const catalog = loadAgentFile(this.connected!.projectRoot, { starterAgents: (host) => this.options.kernel.starterTools(host) });
        task.setChildHostOptions(catalog.childHostOptions[task.agent.host] ?? {});
      } catch (err) {
        return refuse(`the configuration does not load, so no new turn was opened: ${(err as Error).message}`);
      }
    }
    if (opening.cancelled) return refuse('the conversation was cancelled while the message was being delivered');

    const reply = await task.followUp(request.message);
    if (reply.taken === true && !retried) {
      // Another process claimed the turn first: read the record again and decide afresh.
      this.registry.delete(taskId);
      return this.continueNow(request, options, opening, true);
    }
    switch (reply.outcome) {
      case 'not_delivered':
        return refuse(reply.taken === true ? 'another process opened the next turn first' : this.undeliveredReason(task));
      case 'steered':
      case 'queued':
        return { kind: reply.outcome, taskId, turn: task.latest.number };
      case 'new_turn': {
        const turn = reply.turn!;
        this.track(task, turn, parentSessionId);
        if (options.onEvent) turn.onEvent(options.onEvent);
        if (options.onState) turn.onStateChange(options.onState);
        if (options.signal) this.cancelOnAbort(task, turn, options.signal);
        this.limiter.admit(turn, task.agent.model, this.limitFor(task));
        if (turn.state === 'Pending') options.onState?.('Pending');
        const status: DelegateReply = options.wait ? await this.waitTurn(task, turn, options) : this.liveReply(task);
        return { kind: 'new_turn', taskId, turn: turn.number, ...(reply.replayed !== undefined ? { replayed: reply.replayed } : {}), status };
      }
    }
  }

  /** The status line of a task whose latest turn has no result, or the first line of the result text of one that settled. */
  private undeliveredStatus(record: TaskRecord): string {
    if (record.result !== null) return formatResult(record.result).split('\n')[0]!;
    if (record.status === 'abandoned') return 'abandoned: its owner process died, so it has no result';
    const live = this.registry.get(record.taskId);
    const queuePlace = live !== undefined ? this.limiter.place(live.latest) : null;
    return formatStatusLine(statusFacts({ ...record, ...(queuePlace !== null ? { queuePlace } : {}) }));
  }

  /** A task of this process whose latest turn another process now owns is read from the task record, not held here. */
  private dropTakenOver(store: TaskStore): void {
    for (const taskId of [...this.registry.keys()]) {
      const owner = store.latestTurn(taskId)?.owner;
      if (owner !== null && owner !== undefined && !store.isOwner(owner)) this.registry.delete(taskId);
    }
  }

  /** Why a message reached no child, from the state of the task. */
  private undeliveredReason(task: Task): string {
    const { state } = task;
    if (state === 'Pending' || state === 'Starting') return 'its child run has not started and the child driver cannot steer a turn, so the message cannot be held';
    if (state === 'Live') return 'its child run is stopping';
    return 'the child driver of its host cannot resume a session, or the task never started and the driver cannot steer a turn';
  }

  // ---- collect, wait, cancel ----------------------------------------------

  /**
   * Collect by task id: every turn whose result no path has delivered yet, oldest first, then the
   * status of the latest turn when it has not settled. `onlyNew` answers "delivered" for a
   * settled task whose result already reached the parent.
   */
  async collect(taskId: string, options: { onlyNew?: boolean; mark?: boolean } = {}): Promise<CollectReply> {
    const { store } = await this.connect();
    store.sweep();
    this.dropTakenOver(store);
    const live = this.registry.get(taskId);
    const record = store.readTask(taskId);
    if (record === null) return { kind: 'not_found', taskId };
    const latestTurn = record.turns[record.turns.length - 1];
    const waiting = this.latestStatus(taskId, live, record);
    const fresh = store.uncollectedTurns(taskId);
    if (fresh.length > 0) {
      const results = fresh.map((turn) => this.turnResult(record.turns, turn));
      if (options.mark !== false) for (const { result } of results) this.markCollected(taskId, result);
      if (results.length === 1 && waiting === null && results[0]!.openedTurn === undefined) return { kind: 'result', result: results[0]!.result };
      return { kind: 'results', taskId, results, ...(waiting !== null ? { then: waiting } : {}) };
    }
    if (waiting !== null) return waiting;
    if (options.onlyNew === true && latestTurn !== undefined) {
      return { kind: 'delivered', taskId, turn: latestTurn.turn, status: record.result!.status };
    }
    return { kind: 'result', result: record.result! };
  }

  private turnResult(turns: TurnFile[], turn: TurnFile): TurnResult {
    const next = turns.find((t) => t.turn === turn.turn + 1);
    return { result: turn.result!, ...(next?.viaHeld === true ? { openedTurn: next.turn } : {}) };
  }

  /** The state of the latest turn when it has no result: running, queued, abandoned or in another process. */
  private latestStatus(taskId: string, live: Task | undefined, record: NonNullable<ReturnType<TaskStore['readTask']>>): CollectReply | null {
    if (record.result !== null) return null;
    if (live !== undefined && live.settledResult === undefined) {
      const reply = this.liveReply(live);
      return reply.kind === 'started' ? { kind: 'running', taskId, startedAt: reply.startedAt } : reply;
    }
    if (record.status === 'abandoned') return { kind: 'abandoned', taskId };
    return {
      kind: 'other_process',
      taskId,
      ...(record.model !== undefined ? { model: record.model } : {}),
      enqueuedAt: record.enqueuedAt,
      ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    };
  }

  /** Wait up to timeoutMs for a live task; otherwise answer as collect does. */
  async waitFor(taskId: string, timeoutMs: number, options: { until?: AbortSignal } = {}): Promise<CollectReply> {
    const first = await this.collect(taskId, { onlyNew: true });
    const live = this.registry.get(taskId);
    if ((first.kind !== 'running' && first.kind !== 'queued') || live === undefined) return first;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      live.result,
      untilPromise(options.until),
      new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs)))),
    ]);
    clearTimeout(timer);
    // Read the task again: it may have been released while this call waited.
    return this.collect(taskId, { onlyNew: true });
  }

  /** Wait for a task owned by this process without a polling deadline. */
  async waitForCompletion(taskId: string, options: { until?: AbortSignal } = {}): Promise<CollectReply> {
    const live = this.registry.get(taskId);
    if (live !== undefined) await Promise.race([live.result, untilPromise(options.until)]);
    // An internal wait delivers nothing: the caller marks the turn collected where it delivers it.
    return this.collect(taskId, { mark: false });
  }

  async cancel(taskId: string): Promise<CollectReply> {
    const { store } = await this.connect();
    store.sweep();
    this.dropTakenOver(store);
    const live = this.registry.get(taskId);
    if (live !== undefined && live.settledResult === undefined) return { kind: 'result', result: await live.cancel() };
    // A settled task returns its stored result unchanged; nothing is signalled.
    return this.collect(taskId);
  }

  async cancelSession(parentSessionId: string | undefined, reason?: StopReason): Promise<{ kind: 'unknown_session' | 'cancelled'; taskIds: string[]; count: number }> {
    if (parentSessionId === undefined || parentSessionId === '') return { kind: 'unknown_session', taskIds: [], count: 0 };
    // A continuation still sweeping or loading the configuration must not start its turn.
    for (const opening of this.opening.get(parentSessionId) ?? []) opening.cancelled = true;
    const taskIds = [...(this.sessions.get(parentSessionId) ?? [])];
    const tasks = taskIds.map((id) => this.registry.get(id)).filter((task): task is Task => task !== undefined && task.settledResult === undefined);
    const pending = tasks.filter((task) => task.state === 'Pending');
    const live = tasks.filter((task) => task.state !== 'Pending');
    await Promise.all(pending.map((task) => task.cancel(reason)));
    await Promise.all(live.map((task) => task.cancel(reason)));
    return { kind: 'cancelled', taskIds: tasks.map((task) => task.taskId), count: tasks.length };
  }

  /**
   * After a pi reload or resume: one text that lists the turns of this conversation that a session
   * end stopped, or whose process died, and the messages that never reached them, for each turn
   * not reported before. Marks each listed turn reported, so a later reload does not repeat it.
   * A turn the user cancelled has no stop reason and is never listed. Undefined when nothing is new.
   */
  async reloadReport(parentSessionId: string): Promise<string | undefined> {
    const { store, core } = await this.connect();
    store.sweep();
    const lines: string[] = [];
    for (const view of store.list(parentSessionId)) {
      const record = store.readTask(view.taskId);
      if (record === null) continue;
      const events = store.readEvents(view.taskId);
      const latest = record.turns[record.turns.length - 1];
      for (const turn of record.turns) {
        const abandoned = turn === latest && turn.result === undefined && record.status === 'abandoned';
        if (turn.stopReason !== 'session_end' && !abandoned) continue;
        if (store.isReported(view.taskId, turn.turn)) continue;
        const prompted = events.some((e) => e.kind === 'prompt_sent' && e.turn === turn.turn);
        const lost = prompted
          ? []
          : [...(turn.replayed ?? []), ...(turn.message !== undefined ? [turn.message] : []), ...(turn.heldMessages ?? []), ...events.flatMap((e) => (e.kind === 'follow_up_message' && e.turn === turn.turn && e.outcome === 'queued' ? [e.text] : []))];
        const named = turn.turn >= 2 ? `${view.taskId} (turn ${turn.turn})` : view.taskId;
        lines.push(`- ${named} · ${view.agent} · stopped${lost.length > 0 ? `; it never received ${lost.map((m) => JSON.stringify(m)).join(', ')}` : ''}`);
        try {
          core.recordStopReported(view.taskId, turn.turn);
        } catch (err) {
          this.warn(`could not mark a turn of ${view.taskId} reported: ${(err as Error).message}`);
        }
      }
    }
    if (lines.length === 0) return undefined;
    return ['The session ended while these subzero tasks were running, so they were stopped:', ...lines, 'Send a message again with subzero_continue if a task still needs it.'].join('\n');
  }

  async list(parentSessionId?: string): Promise<TaskListing[]> {
    const { store } = await this.connect();
    store.sweep();
    this.dropTakenOver(store);
    return store.list(parentSessionId).map((view) => {
      const live = this.registry.get(view.taskId);
      const place = live !== undefined ? this.limiter.place(live.latest) : null;
      return place !== null ? { ...view, queuePlace: place } : view;
    });
  }

  async listLiveSession(parentSessionId: string): Promise<TaskListing[]> {
    const ids = this.sessions.get(parentSessionId) ?? new Set<string>();
    const { store } = await this.connect();
    return (await this.list(parentSessionId)).filter((task) => ids.has(task.taskId) && task.status === 'running').map((task) => {
      const tier = store.readTaskJson(task.taskId)?.tier;
      return { ...task, model: this.registry.get(task.taskId)?.agent.model, ...(tier !== undefined ? { tier } : {}) };
    });
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

  async notice(taskId: string, status: Result['status'], parentSessionId: string, collectTool: string, turn?: number): Promise<string> {
    if (status === 'cancelled') return stopNotice(taskId);
    return completionNotice(taskId, status, (await this.listLiveSession(parentSessionId)).filter((task) => task.taskId !== taskId), collectTool, turn);
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
      Promise.all(live.map((task) => task.cancel('session_end'))).then(() => true),
      new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), deadlineMs))),
    ]);
    clearTimeout(timer);
    if (!ended) for (const task of live) task.forceCancel();
    return ended;
  }
}
