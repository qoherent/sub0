// @sigil implements design/task-core.sigil TaskCore (shapes)
//
// The host-neutral shapes of a task. Nothing here names pi: a child driver fills
// them in through the child port.
import type { AgentDefinition, ThinkingLevel } from '../config/agent-config.js';

export type ChildRunState = 'Pending' | 'Starting' | 'Live' | 'Settled' | 'Failed' | 'Cancelled';
export const ENDED_STATES: ReadonlySet<ChildRunState> = new Set(['Settled', 'Failed', 'Cancelled']);

export type FailureKind = 'timeout' | 'crashed' | 'error' | 'skill_mismatch';
export type ResultStatus = 'completed' | 'truncated' | 'failed' | 'cancelled';

/** A measure the driver could not report. It is never written as zero. */
export interface Unavailable {
  unavailable: string;
}
export type Measure = number | Unavailable;

export function isUnavailable(value: unknown): value is Unavailable {
  return typeof value === 'object' && value !== null && 'unavailable' in value;
}

export interface SessionUsage {
  inputTokens: Measure;
  outputTokens: Measure;
  cacheReadTokens: Measure;
  cacheWriteTokens: Measure;
  totalTokens: Measure;
  cost: Measure;
  /** Context use at settle, not its peak. */
  contextTokens: Measure;
  contextWindow: Measure;
  contextPercent: Measure;
}

export function unavailableUsage(reason: string): SessionUsage {
  const u: Unavailable = { unavailable: reason };
  return {
    inputTokens: u,
    outputTokens: u,
    cacheReadTokens: u,
    cacheWriteTokens: u,
    totalTokens: u,
    cost: u,
    contextTokens: u,
    contextWindow: u,
    contextPercent: u,
  };
}

/** How a driver started a child run, without its prompt and never with env values. */
export interface LaunchSpec {
  /** The command as one opaque list. TaskCore never reads into it. */
  command: string[];
  cwd: string;
  envNames: string[];
  version: string | Unavailable;
  skillFolders: string[];
  thinkingLevel: string | Unavailable;
}

/**
 * What became of one follow-up message: held for a run that is not Live yet, delivered into the
 * running turn, opened a new turn, or reached no child.
 */
export type DeliveryOutcome = 'queued' | 'steered' | 'new_turn' | 'not_delivered';

export type DomainEvent =
  | { kind: 'brief'; text: string }
  | { kind: 'run_started'; launchSpec: LaunchSpec }
  | { kind: 'skills_verified'; skills: string[] }
  /** The child has been sent its prompt: the run is Live from here on. */
  | { kind: 'prompt_sent' }
  /** A follow-up message of the caller, whole, with its delivery outcome and the turn it joined or opened. */
  | { kind: 'follow_up_message'; text: string; outcome: DeliveryOutcome; turn?: number }
  /**
   * A held message of a turn whose steering answered: delivered into the run, or settled, which means it
   * reached the next turn. Without this record a held message of a turn that sent its prompt counts as
   * not delivered, because its answer would live only in memory.
   */
  | { kind: 'held_message_handled'; text: string; answer: 'delivered' | 'settled'; turn?: number }
  | { kind: 'tool_activity'; phase: 'start' | 'end'; tool: string; path?: string; isError?: boolean }
  | { kind: 'agent_message'; text: string }
  | { kind: 'turn_settled' }
  | { kind: 'retrying'; attempt?: number }
  | { kind: 'warning'; message: string }
  | { kind: 'stderr_tail'; text: string }
  | { kind: 'run_exited'; code: number | null; signal: string | null };

export type DomainEventKind = DomainEvent['kind'];

/** The one answer a task returns. The task id always comes first. */
export interface Result {
  taskId: string;
  /** The turn number, set from turn 2 on. */
  turn?: number;
  agent: string;
  status: ResultStatus;
  summary?: string;
  usage?: SessionUsage;
  failureKind?: FailureKind;
  message?: string;
  durationMs?: number;
  /** How many held follow-up messages never reached the child, because its run ended before its prompt. */
  heldNotDelivered?: number;
}

/** What a child driver reports when a child run ends. */
export interface ChildOutcome {
  lastAssistantText: string | null;
  status: ResultStatus;
  failureKind?: FailureKind;
  message?: string;
  usage: SessionUsage;
  /** Where the driver keeps the child session, when it knows. */
  sessionFile?: string;
  /** Steering messages the child accepted but had not read when its run settled, in order. */
  unreadSteers?: string[];
}

/**
 * The options the global file holds for one child host, read only by the driver of that host.
 * The core carries them without looking inside, so it names no child host.
 */
export type ChildHostOptions = Readonly<Record<string, unknown>>;

/**
 * What a child driver receives on each start. It resolves none of these itself
 * and reads no task record.
 */
export interface ChildRunRequest {
  taskId: string;
  agent: AgentDefinition;
  brief: string;
  projectRoot: string;
  /** Where TaskStore keeps child sessions. */
  sessionsFolder: string;
  /** Where the driver keeps its own files of the task, beside the task record. */
  driverFilesFolder: string;
  /** The global file's options for this child host, as its driver reads them. Absent means none. */
  childHostOptions?: ChildHostOptions;
}

/** What a live run answers a steering message: it took it, had settled already, or is being stopped. */
export type SteerAnswer = 'delivered' | 'settled' | 'stopping';

export interface ChildRun {
  outcome: Promise<ChildOutcome>;
  cancel(): void;
  /**
   * Turn steering: deliver a steering message into the running turn. A driver that offers it also
   * restarts the timeout of the run for each delivered message.
   */
  steer?(message: string): Promise<SteerAnswer>;
}

/**
 * What `resume` throws, before it starts anything, when the child session of the task is gone.
 * TaskCore then opens the turn by releasing the task with its brief, and holds the message.
 */
export class SessionMissingError extends Error {
  readonly code = 'session_missing';
  constructor(taskId: string) {
    super(`the child session of ${taskId} is gone`);
    this.name = 'SessionMissingError';
  }
}

/** The child port: the only way TaskCore reaches a child. */
export interface ChildPort {
  start(request: ChildRunRequest, onEvent: (event: DomainEvent) => void): ChildRun;
  /**
   * Session resume: start a run on the existing child session of the task with the follow-up
   * message as its prompt. Absent when the driver cannot resume a session.
   */
  resume?(request: ChildRunRequest, message: string, onEvent: (event: DomainEvent) => void): ChildRun;
  /**
   * True when the runs of this port accept steering messages. It is static, because TaskCore
   * decides to hold a message for a run that has not started before any run exists.
   */
  steers?: boolean;
}

/** Builds the command that reopens a child session in its program's terminal interface. */
export type AttachCommand = (spec: LaunchSpec) => string[];

/** Writes a child session as a document a person can read; rejects with the reason. */
export type SessionExport = (sessionFile: string, outputFile: string) => Promise<void>;

/** The tool lists that suit a general agent and a read-only fallback agent on one host. */
export interface StarterTools {
  general: string[];
  fallback: string[];
}

/**
 * A check that the host of a child driver can run: undefined when it passes, and
 * otherwise a message that says what is missing and what to do.
 */
export type PrerequisitesCheck = () => string | undefined;

/** Prices of a model in US dollars per million tokens, as its host reports them. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One model a child host offers, as a choice for a tier. */
export interface HostModel {
  /** The model as a tier names it: `provider/id`. */
  name: string;
  /** The text of the name before its first slash. */
  endpoint: string;
  reasoning: boolean;
  /** The thinking levels the model accepts; `['off']` for a model without reasoning. */
  thinkingLevels: ThinkingLevel[];
  contextWindow?: number;
  maxTokens?: number;
  /** The input kinds the model takes, such as text and image. */
  input: string[];
  cost?: ModelCost;
}

/**
 * The models a child of the host can use. Rejects with a one-line reason, and
 * never resolves to an empty list.
 */
export type ListModels = (options?: { projectRoot?: string; childHostOptions?: ChildHostOptions }) => Promise<HostModel[]>;

export interface ModelCheckRequest {
  /** The model as a tier names it: `provider/id`. */
  model: string;
  thinking: ThinkingLevel;
  /** Where the check runs, as a child would; defaults to the current folder. */
  projectRoot?: string;
  /** The global file's options for this child host; a check loads them as a child does. */
  childHostOptions?: ChildHostOptions;
  /** Aborting ends the check and stops its process. */
  signal?: AbortSignal;
}

export type ModelCheckFailure = 'unknown_model' | 'timeout' | 'failed' | 'cancelled';
export type ModelCheckResult = { ok: true } | { ok: false; kind: ModelCheckFailure; message: string };

/** Sends one fixed prompt to a model as a child would, and reports whether it answered. */
export type CheckModel = (request: ModelCheckRequest) => Promise<ModelCheckResult>;

/**
 * A child driver: its child port, and whatever else it offers. A caller asks for
 * the attach command, session export, starter tools, prerequisites check, model
 * listing and model check through the driver of the host, and never assumes a
 * driver offers them.
 */
export interface ChildDriver {
  port: ChildPort;
  attachCommand?: AttachCommand;
  sessionExport?: SessionExport;
  starterTools?: () => StarterTools;
  prerequisites?: PrerequisitesCheck;
  listModels?: ListModels;
  checkModel?: CheckModel;
}
