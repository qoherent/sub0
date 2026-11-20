// @sigil implements design/task-core.sigil TaskCore
//
// Runs each task on one child through the child port and keeps it in the task
// record. TaskCore imports no child driver: its caller hands it the port of the
// host of the agent definition, and TaskCore hands the port the project root, the
// sessions folder and the driver-files folder of the task on each start.
import type { AgentDefinition } from '../config/agent-config.js';
import type { TaskRecordWriter } from '../store/task-store.js';
import { newTaskId } from './ids.js';
import {
  ENDED_STATES,
  type ChildHostOptions,
  type ChildOutcome,
  type ChildPort,
  type ChildRun,
  type ChildRunState,
  type DomainEvent,
  type Result,
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
}

export interface TaskCoreOptions {
  projectRoot: string;
  store: TaskRecordWriter;
  warn?: (message: string) => void;
}

type Listener<T> = (value: T) => void;

/** One task: its frozen agent definition, its brief and its one child run. */
export class Task {
  readonly taskId: string;
  readonly agent: AgentDefinition;
  readonly createdAt: string;
  readonly result: Promise<Result>;
  private stateValue: ChildRunState = 'Pending';
  private run: ChildRun | null = null;
  private finalResult: Result | undefined;
  private resolveResult!: (result: Result) => void;
  private readonly eventListeners = new Set<Listener<DomainEvent>>();
  private readonly stateListeners = new Set<Listener<ChildRunState>>();
  private startedMs: number | null = null;
  private startedIso: string | null = null;

  constructor(
    private readonly core: TaskCore,
    taskId: string,
    agent: AgentDefinition,
    private readonly brief: string,
    private readonly port: ChildPort,
    createdAt: string,
    private readonly childHostOptions: ChildHostOptions = {},
  ) {
    this.taskId = taskId;
    this.agent = agent;
    this.createdAt = createdAt;
    this.result = new Promise((resolve) => (this.resolveResult = resolve));
  }

  get state(): ChildRunState {
    return this.stateValue;
  }

  /** The enqueue time: when the task was created, before any release. */
  get enqueuedAt(): string {
    return this.createdAt;
  }

  /** When the caller released the child run, or null while it is Pending. Never read from the launch spec. */
  get startedAt(): string | null {
    return this.startedIso;
  }

  /** The result once the child run has ended, or undefined while it runs. */
  get settledResult(): Result | undefined {
    return this.finalResult;
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

  /** Release a Pending child run: the brief goes to the child port and the run starts. */
  release(): void {
    if (this.stateValue !== 'Pending') return;
    // The start time is taken at the release, before any listener sees the new state.
    this.startedMs = Date.now();
    this.startedIso = new Date(this.startedMs).toISOString();
    try {
      this.core.store.writeStartTime(this.taskId, this.startedIso);
    } catch (err) {
      this.core.warn(`could not record the start time of ${this.taskId}: ${(err as Error).message}`);
    }
    this.setState('Starting');
    try {
      this.run = this.port.start(
        {
          taskId: this.taskId,
          agent: this.agent,
          brief: this.brief,
          projectRoot: this.core.projectRoot,
          sessionsFolder: this.core.store.sessionsFolder,
          driverFilesFolder: this.core.store.driverFilesFolder(this.taskId),
          ...(Object.keys(this.childHostOptions).length > 0 ? { childHostOptions: this.childHostOptions } : {}),
        },
        (event) => this.handleEvent(event),
      );
    } catch (err) {
      this.finish(this.failedResult(`could not start the child run: ${(err as Error).message}`));
      return;
    }
    this.run.outcome.then(
      (outcome) => this.finish(this.buildResult(outcome), outcome.sessionFile),
      (err: unknown) => this.finish(this.failedResult(`child driver failed: ${String(err)}`)),
    );
  }

  /**
   * Cancel the task. A Pending run never starts a child and ends with no summary
   * and no session usage; a live run is cancelled through the child port.
   */
  cancel(): Promise<Result> {
    if (this.stateValue === 'Pending') {
      this.finish({ taskId: this.taskId, agent: this.agent.name, status: 'cancelled' });
    } else if (!ENDED_STATES.has(this.stateValue)) {
      this.run?.cancel();
    }
    return this.result;
  }

  /** Record cancellation when a child did not stop before shutdown's deadline. */
  forceCancel(): void {
    if (this.finalResult === undefined) this.finish({ taskId: this.taskId, agent: this.agent.name, status: 'cancelled' });
  }

  private handleEvent(event: DomainEvent): void {
    if (this.finalResult !== undefined) return;
    try {
      this.core.store.appendEvent(this.taskId, event);
      // The launch spec goes into the task record as it is, unread.
      if (event.kind === 'run_started') this.core.store.writeLaunchSpec(this.taskId, event.launchSpec);
    } catch (err) {
      this.core.warn(`could not record an event of ${this.taskId}: ${(err as Error).message}`);
    }
    if (event.kind === 'skills_verified') this.setState('Live');
    for (const listener of this.eventListeners) listener(event);
  }

  private buildResult(outcome: ChildOutcome): Result {
    const result: Result = {
      taskId: this.taskId,
      agent: this.agent.name,
      status: outcome.status,
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
      taskId: this.taskId,
      agent: this.agent.name,
      status: 'failed',
      summary: '',
      usage: unavailableUsage('the child driver reported no usage'),
      failureKind: 'crashed',
      message,
    };
  }

  /** The final step: exactly one result per task, written to the task record. */
  private finish(result: Result, sessionFile?: string): void {
    if (this.finalResult !== undefined) return;
    this.finalResult = result;
    try {
      this.core.store.writeResult(this.taskId, result, sessionFile !== undefined ? { sessionFile } : {});
    } catch (err) {
      this.core.warn(`could not write the result of ${this.taskId}: ${(err as Error).message}`);
    }
    const state: ChildRunState =
      result.status === 'failed' ? 'Failed' : result.status === 'cancelled' ? 'Cancelled' : 'Settled';
    this.setState(state);
    this.resolveResult(result);
  }
}

export class TaskCore {
  readonly projectRoot: string;
  readonly store: TaskRecordWriter;
  readonly warn: (message: string) => void;

  constructor(options: TaskCoreOptions) {
    this.projectRoot = options.projectRoot;
    this.store = options.store;
    this.warn = options.warn ?? ((m) => process.stderr.write(`subzero: ${m}\n`));
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
      endpoint: agent.endpoint,
      createdAt,
    });
    return new Task(this, taskId, agent, request.brief, request.port, createdAt, request.childHostOptions);
  }
}
