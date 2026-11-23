// @sigil implements design/task-core.sigil TaskCore
//
// Runs each task on one child through the child port and keeps it in the task
// record. A task is a list of turns; each turn is one input (the brief or a
// follow-up message) with its own child run and its own result. TaskCore imports
// no child driver: its caller hands it the port of the host of the agent
// definition, and TaskCore hands the port the project root, the sessions folder
// and the driver-files folder of the task on each start.
import type { AgentDefinition } from '../config/agent-config.js';
import type { StopReason, TaskRecordWriter, TurnFile } from '../store/task-store.js';
import { newTaskId } from './ids.js';
import {
  ENDED_STATES,
  SessionMissingError,
  type ChildHostOptions,
  type ChildOutcome,
  type ChildPort,
  type ChildRun,
  type ChildRunRequest,
  type ChildRunState,
  type DeliveryOutcome,
  type DomainEvent,
  type Result,
  type SteerAnswer,
  unavailableUsage,
} from './types.js';

export interface TaskRequest {
  agent: AgentDefinition;
  brief: string;
  /** The child port of the host of the agent definition. */
  port: ChildPort;
  /** The global file's options for the child host of the agent definition, handed to the child port on start. */
  childHostOptions?: ChildHostOptions;
  parentSessionId?: string;
  /** The model tier the task was delegated at; kept in the task record. */
  tier?: string;
}

export interface TaskCoreOptions {
  projectRoot: string;
  store: TaskRecordWriter;
  warn?: (message: string) => void;
  /**
   * Called for a turn that TaskCore opens on its own, for follow-up messages a run left unread or
   * held; the caller admits it to its queue and releases it. Absent, TaskCore releases it at once.
   */
  onTurnOpened?: (task: Task, turn: Turn) => void;
}

/** What a follow-up message became. */
export interface FollowUpReply {
  outcome: DeliveryOutcome;
  /** The turn the message opened, which its caller releases; set for the outcome new turn. */
  turn?: Turn;
  /** How many messages of an abandoned turn were replayed ahead of this one. */
  replayed?: number;
  /** Another process claimed the turn first, so nothing was written and the caller may read the record again. */
  taken?: true;
}

type Listener<T> = (value: T) => void;

/** How the child run of a turn is told what to do first. */
type Prompt = { kind: 'brief' } | { kind: 'resume'; message: string };

/** How long a settling run waits for steering messages still in flight before it is built into a result. */
const STEER_DRAIN_MS = 1000;

/** One turn of a task: one input, one child run, one result. */
export class Turn {
  readonly result: Promise<Result>;
  /** True for a turn loaded from a record that holds no result: its process died. */
  readonly abandoned: boolean;
  private stateValue: ChildRunState = 'Pending';
  private run: ChildRun | null = null;
  private finalResult: Result | undefined;
  private resolveResult!: (result: Result) => void;
  private readonly eventListeners = new Set<Listener<DomainEvent>>();
  private readonly stateListeners = new Set<Listener<ChildRunState>>();
  private startedMs: number | null = null;
  private startedIso: string | null = null;
  private promptSent = false;
  /** Messages held for a run that has not sent its prompt, in the order received. */
  private held: string[] = [];
  /** Messages that a steer answered "settled" for, which open the next turn. */
  private leftover: string[] = [];
  /** Messages that no child received and none will. */
  private undelivered: string[] = [];
  /** Steering messages are sent one at a time, so a late message never overtakes a held one. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly task: Task,
    readonly number: number,
    readonly enqueuedAt: string,
    private prompt: Prompt,
    held: string[] = [],
    loaded?: { startedAt?: string; result?: Result },
  ) {
    this.held = [...held];
    this.result = new Promise((resolve) => (this.resolveResult = resolve));
    if (loaded !== undefined) {
      this.abandoned = loaded.result === undefined;
      this.startedIso = loaded.startedAt ?? null;
      if (loaded.result !== undefined) {
        this.finalResult = loaded.result;
        this.resolveResult(loaded.result);
        this.stateValue = loaded.result.status === 'failed' ? 'Failed' : loaded.result.status === 'cancelled' ? 'Cancelled' : 'Settled';
      } else {
        this.stateValue = 'Cancelled';
      }
    } else {
      this.abandoned = false;
    }
  }

  get state(): ChildRunState {
    return this.stateValue;
  }

  /** When the caller released the child run, or null while it is Pending. Never read from the launch spec. */
  get startedAt(): string | null {
    return this.startedIso;
  }

  /** The result once the child run has ended, or undefined while it runs. */
  get settledResult(): Result | undefined {
    return this.finalResult;
  }

  /** Whether this turn was opened by messages held for the one before it. */
  viaHeld = false;

  /** Whether the child of this turn was sent its prompt. */
  get sentPrompt(): boolean {
    return this.promptSent;
  }

  onEvent(listener: Listener<DomainEvent>): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStateChange(listener: Listener<ChildRunState>): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: ChildRunState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    for (const listener of this.stateListeners) listener(state);
  }

  /** Hold a message for this turn until its child run sends its prompt. */
  hold(message: string): void {
    this.held.push(message);
  }

  /** Release a Pending child run: the prompt goes to the child port and the run starts. */
  release(): void {
    if (this.stateValue !== 'Pending') return;
    // The start time is taken at the release, before any listener sees the new state.
    this.startedMs = Date.now();
    this.startedIso = new Date(this.startedMs).toISOString();
    try {
      this.task.core.store.writeStartTime(this.task.taskId, this.startedIso, this.number);
    } catch (err) {
      this.task.core.warn(`could not record the start time of ${this.task.taskId}: ${(err as Error).message}`);
    }
    this.setState('Starting');
    try {
      this.run = this.startRun();
    } catch (err) {
      this.finish(this.failedResult(`could not start the child run: ${(err as Error).message}`));
      return;
    }
    this.run.outcome.then(
      (outcome) => void this.settle(outcome),
      (err: unknown) => void this.settle(null, this.failedResult(`child driver failed: ${String(err)}`)),
    );
  }

  private startRun(): ChildRun {
    const request = this.task.requestFor();
    const onEvent = (event: DomainEvent) => this.handleEvent(event);
    const { port } = this.task;
    if (this.prompt.kind === 'resume' && port.resume !== undefined) {
      try {
        return port.resume(request, this.prompt.message, onEvent);
      } catch (err) {
        if (!(err instanceof SessionMissingError)) throw err;
        // The child session is gone: start again with the brief, and hold the message that opened the turn.
        this.held.unshift(this.prompt.message);
        this.prompt = { kind: 'brief' };
      }
    }
    return port.start(request, onEvent);
  }

  /**
   * Cancel the turn. A Pending run never starts a child and ends with no summary and no session
   * usage; a live run is cancelled through the child port. A reason is kept in the turn file.
   */
  cancel(reason?: StopReason): Promise<Result> {
    if (reason !== undefined && this.finalResult === undefined) {
      try {
        this.task.core.store.writeStopReason(this.task.taskId, this.number, reason);
      } catch (err) {
        this.task.core.warn(`could not record why ${this.task.taskId} stopped: ${(err as Error).message}`);
      }
    }
    if (this.stateValue === 'Pending') {
      this.finish(this.baseResult('cancelled'));
    } else if (!ENDED_STATES.has(this.stateValue)) {
      this.run?.cancel();
    }
    return this.result;
  }

  /** Record cancellation when a child did not stop before shutdown's deadline. */
  forceCancel(): void {
    if (this.finalResult === undefined) this.finish(this.baseResult('cancelled'));
  }

  /** Give the live run a steering message, behind any message already on its way. */
  steer(message: string): Promise<SteerAnswer | 'unsupported'> {
    const sent = this.chain.then(() => this.sendSteer(message));
    this.chain = sent.catch(() => undefined);
    return sent;
  }

  private async sendSteer(message: string): Promise<SteerAnswer | 'unsupported'> {
    if (this.run?.steer === undefined) return 'unsupported';
    if (this.finalResult !== undefined) return 'settled';
    try {
      return await this.run.steer(message);
    } catch (err) {
      this.task.core.warn(`could not steer ${this.task.taskId}: ${(err as Error).message}`);
      return 'stopping';
    }
  }

  private handleEvent(event: DomainEvent): void {
    if (this.finalResult !== undefined) return;
    try {
      this.task.core.store.appendEvent(this.task.taskId, event, this.number);
      // The launch spec goes into the task record as it is, unread.
      if (event.kind === 'run_started') this.task.core.store.writeLaunchSpec(this.task.taskId, event.launchSpec);
    } catch (err) {
      this.task.core.warn(`could not record an event of ${this.task.taskId}: ${(err as Error).message}`);
    }
    if (event.kind === 'prompt_sent') {
      this.promptSent = true;
      this.task.promptEver = true;
      this.setState('Live');
      this.flushHeld();
    }
    for (const listener of this.eventListeners) listener(event);
  }

  /** Hand each held message to turn steering, in the order received. */
  private flushHeld(): void {
    const batch = this.held.splice(0);
    for (const message of batch) {
      void this.steer(message).then((answer) => {
        if (answer === 'settled') this.leftover.push(message);
        else if (answer !== 'delivered') this.undelivered.push(message);
      });
    }
  }

  /** The run ended: let steering messages in flight answer, then build the result. */
  private async settle(outcome: ChildOutcome | null, failed?: Result): Promise<void> {
    await Promise.race([this.chain, new Promise((r) => setTimeout(r, STEER_DRAIN_MS))]);
    if (failed !== undefined) this.finish(failed);
    else this.finish(this.buildResult(outcome!), outcome!.sessionFile, outcome!.unreadSteers);
  }

  private baseResult(status: Result['status']): Result {
    return { taskId: this.task.taskId, ...(this.number >= 2 ? { turn: this.number } : {}), agent: this.task.agent.name, status };
  }

  private buildResult(outcome: ChildOutcome): Result {
    const result: Result = {
      ...this.baseResult(outcome.status),
      // The summary is the child's whole last assistant message, never cut.
      summary: outcome.lastAssistantText ?? '',
      usage: outcome.usage,
    };
    if (outcome.status === 'failed') {
      result.failureKind = outcome.failureKind ?? 'error';
      if (outcome.message !== undefined) result.message = outcome.message;
    }
    if (this.startedMs !== null) result.durationMs = Date.now() - this.startedMs;
    return result;
  }

  private failedResult(message: string): Result {
    return {
      ...this.baseResult('failed'),
      summary: '',
      usage: unavailableUsage('the child driver reported no usage'),
      failureKind: 'crashed',
      message,
    };
  }

  /**
   * The final step: exactly one result per turn, written to the task record. Messages that a run
   * left unread or held open the next turn only after the result is written, so the earlier turn
   * comes first in the record and no two runs of a task are live at once.
   */
  private finish(result: Result, sessionFile?: string, unreadSteers: string[] = []): void {
    if (this.finalResult !== undefined) return;
    const waiting = [...unreadSteers, ...this.leftover, ...this.held];
    const clean = result.status === 'completed' || result.status === 'truncated';
    const lost = clean ? this.undelivered.length : waiting.length + this.undelivered.length;
    const final: Result = lost > 0 ? { ...result, heldNotDelivered: lost } : result;
    this.finalResult = final;
    this.held = [];
    try {
      this.task.core.store.writeResult(this.task.taskId, final, { ...(sessionFile !== undefined ? { sessionFile } : {}), turn: this.number });
    } catch (err) {
      this.task.core.warn(`could not write the result of ${this.task.taskId}: ${(err as Error).message}`);
    }
    if (clean && waiting.length > 0) this.task.openFollowOn(waiting);
    const state: ChildRunState = final.status === 'failed' ? 'Failed' : final.status === 'cancelled' ? 'Cancelled' : 'Settled';
    this.setState(state);
    this.resolveResult(final);
  }
}

/** One task: its frozen agent definition, its brief and its turns. */
export class Task {
  readonly taskId: string;
  readonly agent: AgentDefinition;
  readonly createdAt: string;
  /** The turns this process knows of, oldest first; a loaded task holds only its latest. */
  readonly turns: Turn[] = [];
  /** True once any child of the task was sent its prompt, which means the task has a child session. */
  promptEver = false;

  /** The child host options the next start hands the port; the service sets them before it releases a turn. */
  setChildHostOptions(options: ChildHostOptions): void {
    this.childHostOptions = options;
  }

  constructor(
    readonly core: TaskCore,
    taskId: string,
    agent: AgentDefinition,
    private readonly brief: string,
    readonly port: ChildPort,
    createdAt: string,
    private childHostOptions: ChildHostOptions = {},
  ) {
    this.taskId = taskId;
    this.agent = agent;
    this.createdAt = createdAt;
  }

  /** The latest turn. */
  get latest(): Turn {
    return this.turns[this.turns.length - 1]!;
  }

  get state(): ChildRunState {
    return this.latest.state;
  }

  /** The enqueue time of the latest turn: when it opened, before any release. */
  get enqueuedAt(): string {
    return this.latest.enqueuedAt;
  }

  get startedAt(): string | null {
    return this.latest.startedAt;
  }

  /** The result of the latest turn once its child run has ended, or undefined while it runs. */
  get settledResult(): Result | undefined {
    return this.latest.settledResult;
  }

  /** The result of the latest turn. */
  get result(): Promise<Result> {
    return this.latest.result;
  }

  /** Listeners attach to the latest turn only; a later turn has its own. */
  onEvent(listener: Listener<DomainEvent>): () => void {
    return this.latest.onEvent(listener);
  }

  onStateChange(listener: Listener<ChildRunState>): () => void {
    return this.latest.onStateChange(listener);
  }

  release(): void {
    this.latest.release();
  }

  cancel(reason?: StopReason): Promise<Result> {
    return this.latest.cancel(reason);
  }

  forceCancel(): void {
    this.latest.forceCancel();
  }

  /** What each start hands the port. The brief is part of it, but a resume prompts with its message. */
  requestFor(): ChildRunRequest {
    return {
      taskId: this.taskId,
      agent: this.agent,
      brief: this.brief,
      projectRoot: this.core.projectRoot,
      sessionsFolder: this.core.store.sessionsFolder,
      driverFilesFolder: this.core.store.driverFilesFolder(this.taskId),
      ...(Object.keys(this.childHostOptions).length > 0 ? { childHostOptions: this.childHostOptions } : {}),
    };
  }

  /**
   * Route a follow-up message by the state of the latest turn: hold it for a run that has not sent
   * its prompt, steer it into a live run, or open a new turn for a turn that ended.
   */
  async followUp(message: string): Promise<FollowUpReply> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const turn = this.latest;
      switch (turn.state) {
        case 'Pending':
        case 'Starting':
          if (this.port.steers !== true) return this.answer(message, 'not_delivered', turn.number);
          turn.hold(message);
          return this.answer(message, 'queued', turn.number);
        case 'Live': {
          const answer = await turn.steer(message);
          if (answer === 'delivered') return this.answer(message, 'steered', turn.number);
          if (answer !== 'settled') return this.answer(message, 'not_delivered', turn.number);
          // It had already settled: wait for its result to be written, then go on as for a settled turn.
          await turn.result;
          continue;
        }
        default:
          return this.openAfter(turn, message);
      }
    }
    return this.answer(message, 'not_delivered', this.latest.number);
  }

  /** Log a follow-up message whole with what became of it. */
  private answer(message: string, outcome: DeliveryOutcome, turn: number, extra: Omit<FollowUpReply, 'outcome'> = {}): FollowUpReply {
    try {
      this.core.store.appendEvent(this.taskId, { kind: 'follow_up_message', text: message, outcome, turn });
    } catch (err) {
      this.core.warn(`could not record a message for ${this.taskId}: ${(err as Error).message}`);
    }
    return { outcome, ...extra };
  }

  /** The messages that an abandoned turn never delivered, in order, when its child never got its prompt. */
  private replayFor(ended: Turn): string[] {
    if (!ended.abandoned) return [];
    const events = this.core.store.readEvents(this.taskId);
    if (events.some((e) => e.kind === 'prompt_sent' && e.turn === ended.number)) return [];
    const file = this.core.store.readTurns(this.taskId).find((t) => t.turn === ended.number);
    const queued = events.flatMap((e) => (e.kind === 'follow_up_message' && e.turn === ended.number && e.outcome === 'queued' ? [e.text] : []));
    return [...(file?.replayed ?? []), ...(file?.message !== undefined ? [file.message] : []), ...queued];
  }

  /** Open the next turn for a message, after a turn that ended. */
  private openAfter(ended: Turn, message: string): FollowUpReply {
    const replayed = this.replayFor(ended);
    const messages = [...replayed, message];
    const resumable = this.promptEver && this.port.resume !== undefined;
    // A task with a child session resumes it; one that never sent its prompt starts again with its brief.
    if (this.promptEver ? !resumable : this.port.steers !== true) return this.answer(message, 'not_delivered', ended.number);
    if (messages.length > 1 && this.port.steers !== true) return this.answer(message, 'not_delivered', ended.number);
    const number = ended.number + 1;
    const enqueuedAt = new Date().toISOString();
    let claimed: boolean;
    try {
      claimed = this.core.store.claimTurn(this.taskId, number, { message, replayed, enqueuedAt });
    } catch (err) {
      this.core.warn(`could not open turn ${number} of ${this.taskId}: ${(err as Error).message}`);
      return this.answer(message, 'not_delivered', ended.number);
    }
    if (!claimed) return this.answer(message, 'not_delivered', ended.number, { taken: true });
    const turn = this.promptEver
      ? new Turn(this, number, enqueuedAt, { kind: 'resume', message: messages[0]! }, messages.slice(1))
      : new Turn(this, number, enqueuedAt, { kind: 'brief' }, messages);
    this.turns.push(turn);
    return this.answer(message, 'new_turn', number, { turn, ...(replayed.length > 0 ? { replayed: replayed.length } : {}) });
  }

  /** Open the turn for messages a settled run left unread or held; its first message is its prompt. */
  openFollowOn(messages: string[]): void {
    if (!this.promptEver || this.port.resume === undefined) {
      this.core.warn(`${messages.length} message(s) for ${this.taskId} did not reach the child and cannot be resumed`);
      return;
    }
    const number = this.latest.number + 1;
    const enqueuedAt = new Date().toISOString();
    let claimed = false;
    try {
      claimed = this.core.store.claimTurn(this.taskId, number, { viaHeld: true, message: messages[0]!, enqueuedAt });
    } catch (err) {
      this.core.warn(`could not open turn ${number} of ${this.taskId}: ${(err as Error).message}`);
    }
    if (!claimed) {
      this.core.warn(`another process opened turn ${number} of ${this.taskId} first, so ${messages.length} message(s) were not delivered`);
      return;
    }
    const turn = new Turn(this, number, enqueuedAt, { kind: 'resume', message: messages[0]! }, messages.slice(1));
    turn.viaHeld = true;
    this.turns.push(turn);
    if (this.core.onTurnOpened !== undefined) this.core.onTurnOpened(this, turn);
    else turn.release();
  }
}

export class TaskCore {
  readonly projectRoot: string;
  readonly store: TaskRecordWriter;
  readonly warn: (message: string) => void;
  readonly onTurnOpened: TaskCoreOptions['onTurnOpened'];

  constructor(options: TaskCoreOptions) {
    this.projectRoot = options.projectRoot;
    this.store = options.store;
    this.warn = options.warn ?? ((m) => process.stderr.write(`subzero: ${m}\n`));
    this.onTurnOpened = options.onTurnOpened;
  }

  /**
   * Create a task and write its task record as running. The child run stays Pending
   * until the caller releases it, so the caller can limit how many run at once.
   */
  start(request: TaskRequest): Task {
    if (typeof request.brief !== 'string' || request.brief.trim() === '') {
      throw new Error('a task needs exactly one non-empty brief');
    }
    let taskId = newTaskId();
    while (this.store.exists(taskId)) taskId = newTaskId();

    const agent = structuredClone(request.agent);
    const createdAt = new Date().toISOString();
    this.store.createTaskRecord({
      taskId,
      agent,
      brief: request.brief,
      ...(request.parentSessionId !== undefined ? { parentSessionId: request.parentSessionId } : {}),
      model: agent.model,
      ...(request.tier !== undefined ? { tier: request.tier } : {}),
      createdAt,
    });
    try {
      this.store.appendEvent(taskId, { kind: 'brief', text: request.brief }, 1);
    } catch (err) {
      this.warn(`could not record the brief of ${taskId}: ${(err as Error).message}`);
    }
    const task = new Task(this, taskId, agent, request.brief, request.port, createdAt, request.childHostOptions);
    task.turns.push(new Turn(task, 1, createdAt, { kind: 'brief' }));
    return task;
  }

  /**
   * Load a task that is not live in this process from its task record, with its frozen agent
   * definition and its latest turn. A latest turn with no result counts as ended, because the
   * process that ran it is gone. Null when the record is missing or has no task file.
   */
  load(taskId: string, port: ChildPort, childHostOptions?: ChildHostOptions): Task | null {
    const record = this.store.readTask(taskId);
    if (record === null || record.task === null) return null;
    const task = new Task(this, taskId, record.task.agent, record.task.brief, port, record.createdAt, childHostOptions);
    task.promptEver = this.store.promptWasSent(taskId);
    const latest: TurnFile | undefined = record.turns.at(-1);
    task.turns.push(
      new Turn(
        task,
        latest?.turn ?? 1,
        latest?.enqueuedAt ?? record.createdAt,
        { kind: 'brief' },
        [],
        { ...(latest?.startedAt !== undefined ? { startedAt: latest.startedAt } : {}), ...(latest?.result !== undefined ? { result: latest.result } : {}) },
      ),
    );
    return task;
  }
}
