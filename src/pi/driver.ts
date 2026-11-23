// @sigil implements design/pi-driver.sigil PiDriver
//
// Starts an isolated pi 1.5.2 child in RPC mode, verifies that it loaded exactly the
// declared skills, runs one prompt (the brief, or the follow-up message of a resumed
// session) to agent_settled, takes steering messages into the running turn, and stops
// the child cleanly in every exit case. The driver writes no task record: it hands the
// launch spec to its caller in the run started event.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { THINKING_LEVELS, modelEndpoint, type ThinkingLevel } from '../config/agent-config.js';
import {
  unavailableUsage,
  type ChildDriver,
  type ChildOutcome,
  type ChildPort,
  type ChildRun,
  type ChildRunRequest,
  type DomainEvent,
  type ChildHostOptions,
  type HostModel,
  type LaunchSpec,
  type Measure,
  type ModelCheckFailure,
  type ModelCheckRequest,
  type ModelCheckResult,
  SessionMissingError,
  type SessionUsage,
  type SteerAnswer,
  type StarterTools,
  type Unavailable,
} from '../core/types.js';
import { CHILD_ENV, attachCommand, childRpcArgs, launchArgs, piExtensionsOf } from './launch.js';
import { missingSkills, prepareOverlay } from './overlay.js';
import { PiRpcClient, type PiEvent, type PiResponse } from './rpc-client.js';

/** The host name under which an entry point registers PiDriver with Kernel. */
export const PI_HOST = 'pi';

/**
 * The project root, the sessions folder and the driver-files folder come through the
 * child port on each start; the driver resolves none of them and calls no store.
 */
export interface PiDriverOptions {
  /** The pi program and any leading arguments. Defaults to the installed pi. */
  piCommand?: string[];
  env?: NodeJS.ProcessEnv;
  /** Where pi keeps SYSTEM.md. Defaults to PI_CODING_AGENT_DIR or ~/.pi/agent. */
  piAgentDir?: string;
  /** How long to wait for pi to answer abort. */
  abortWaitMs?: number;
  /** How long to wait for an exit after closing stdin and after SIGTERM. */
  killWaitMs?: number;
  /** How long the model listing waits for pi's answer. */
  listTimeoutMs?: number;
  /** How long a model check waits for the model to answer. */
  checkTimeoutMs?: number;
  log?: (message: string) => void;
}

const MESSAGE_LIMIT = 300;
const STDERR_TAIL_LIMIT = 4000;
const LIST_TIMEOUT_MS = 30_000;
// A cold local model may need this long to load before it answers.
const CHECK_TIMEOUT_MS = 120_000;
/** The one prompt a model check sends. */
const CHECK_PROMPT = 'Reply with the single word: ok';
/** What pi prints on stderr when it does not know a model, as an error or a warning. */
const UNKNOWN_MODEL = /model\b.*\bnot found/i;
const NO_MODELS =
  'pi offers no models that subzero children can use. Set up a pi provider (log in, set its API key, or add it to ' +
  "pi's models.json; a provider that only a pi extension adds does not reach children), then try again.";

// pi events that need no domain event. Anything else unrecognized is logged.
const QUIET_EVENTS = new Set([
  'agent_start',
  'agent_end',
  'turn_start',
  'message_start',
  'tool_execution_update',
  'compaction_start',
  'compaction_end',
  'auto_retry_end',
  'summarization_retry_scheduled',
  'summarization_retry_attempt_start',
  'summarization_retry_finished',
  'bash_execution_update',
  // Emitted by pi 0.87 for each session entry, though rpc.md does not list it.
  'entry_appended',
]);
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

export class PiDriver implements ChildDriver {
  private version: string | Unavailable | undefined;
  private readonly live = new Set<PiChildRun>();
  private readonly probes = new Set<PiProbe>();

  /** The child port of this driver, which Kernel hands to a caller. */
  readonly port: ChildPort = {
    start: (request, onEvent) => this.start(request, onEvent),
    resume: (request, message, onEvent) => this.resume(request, message, onEvent),
    steers: true,
  };

  constructor(private readonly options: PiDriverOptions = {}) {}

  /** Reopens the child session in the pi terminal interface. */
  readonly attachCommand = (spec: LaunchSpec): string[] => attachCommand(spec);

  /** The child session as HTML, written by pi --export. Rejects with the reason. */
  readonly sessionExport = (sessionFile: string, outputFile: string): Promise<void> => {
    const [program, ...lead] = this.piCommand;
    return new Promise((resolve, reject) => {
      const child = spawn(program!, [...lead, '--export', sessionFile, outputFile], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: this.options.env ?? process.env,
      });
      child.once('error', (err) => reject(new Error(`could not start ${program}: ${err.message}`)));
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`${program} --export exited with code ${code ?? 'unknown'}`)),
      );
    });
  };

  readonly starterTools = (): StarterTools => ({
    general: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    fallback: ['read', 'grep', 'find', 'ls'],
  });

  /**
   * Runs the configured pi command with --version. Undefined when it answers; a
   * message otherwise that names pi, says whether it was not found or did not run,
   * and says to install it and run subzero init again.
   */
  readonly prerequisites = (): string | undefined => {
    const [program, ...rest] = this.piCommand;
    const result = spawnSync(program!, [...rest, '--version'], {
      timeout: 10_000,
      env: { ...(this.options.env ?? process.env), ...CHILD_ENV },
      stdio: 'ignore',
    });
    const next = 'To continue, install pi and run `subzero init` again.';
    if (result.error !== undefined) {
      const notFound = (result.error as NodeJS.ErrnoException).code === 'ENOENT';
      return notFound
        ? `pi was not found (${program}). ${next}`
        : `pi did not run (${program}: ${result.error.message}). ${next}`;
    }
    if (result.status !== 0) {
      return `pi did not run (${[program, ...rest, '--version'].join(' ')} ${
        result.status === null ? `ended by ${result.signal}` : `exited with code ${result.status}`
      }). ${next}`;
    }
    return undefined;
  };

  /**
   * The models a child can use: pi's get_available_models, asked with the
   * children's environment, isolation flags and pi command, so that a provider
   * children cannot reach is not listed. Rejects with a one-line reason; zero
   * models is an error that points to pi provider setup.
   */
  readonly listModels = async (options: { projectRoot?: string; childHostOptions?: ChildHostOptions } = {}): Promise<HostModel[]> => {
    const { files: piExtensions, problem } = piExtensionsOf(options.childHostOptions);
    if (problem !== undefined) throw new Error(problem);
    const timeoutMs = this.options.listTimeoutMs ?? LIST_TIMEOUT_MS;
    const probe = this.probe([...childRpcArgs(piExtensions), '--no-session'], options.projectRoot, { strict: true });
    const timer = deadline(timeoutMs);
    try {
      const answer = await Promise.race([
        probe.client.send({ type: 'get_available_models' }).then(
          (response) => response,
          () => 'gone' as const,
        ),
        probe.gone.then(() => 'gone' as const),
        timer.promise,
      ]);
      if (answer === 'timeout') {
        probe.mustKill = true;
        throw new Error(`pi did not list its models within ${seconds(timeoutMs)}`);
      }
      if (answer === 'gone') throw new Error(await probe.whyGone('it listed its models'));
      if (!answer.success) throw new Error(bounded(`pi refused to list its models: ${answer.error ?? 'no reason given'}`));
      return hostModels(answer.data);
    } finally {
      timer.clear();
      await this.endProbe(probe);
    }
  };

  /**
   * Sends one fixed prompt to a model in a one-turn pi run with the children's
   * flags, the model and thinking level, no tools and no saved session. Answered,
   * or failed with a kind and a one-line reason; aborting kills pi.
   */
  readonly checkModel = async (request: ModelCheckRequest): Promise<ModelCheckResult> => {
    const { model, thinking, projectRoot, signal } = request;
    const { files: piExtensions, problem } = piExtensionsOf(request.childHostOptions);
    if (signal?.aborted) return checkFailed('cancelled', 'the check was cancelled');
    if (problem !== undefined) return checkFailed('failed', problem);
    const timeoutMs = this.options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
    let lastAssistant: any = null;
    let markSettled!: () => void;
    const settled = new Promise<'settled'>((resolve) => (markSettled = () => resolve('settled')));
    const probe = this.probe(
      [...childRpcArgs(piExtensions), '--model', model, '--thinking', thinking, '--no-tools', '--no-session'],
      projectRoot,
      {
        strict: false,
        onEvent: (event) => {
          if (event.type === 'message_end' && event.message?.role === 'assistant') lastAssistant = event.message;
          if (event.type === 'agent_settled') markSettled();
        },
      },
    );
    const timer = deadline(timeoutMs);
    let onAbort: () => void = () => {};
    const aborted = new Promise<'cancelled'>((resolve) => {
      onAbort = () => resolve('cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    const ended = Promise.race([timer.promise, aborted, probe.gone.then(() => 'gone' as const)]);
    const unknown = (message: string): ModelCheckResult =>
      probe.unknownModel ? checkFailed('unknown_model', `unknown model: ${model}: ${message}`) : checkFailed('failed', message);
    try {
      const prompt = await Promise.race([
        probe.client.send({ type: 'prompt', message: CHECK_PROMPT }).then(
          (response) => response,
          () => 'gone' as const,
        ),
        ended,
      ]);
      const done = typeof prompt === 'string' ? prompt : prompt.success ? await Promise.race([settled, ended]) : prompt;
      if (done === 'timeout' || done === 'cancelled') {
        probe.mustKill = true;
        return done === 'timeout'
          ? checkFailed('timeout', `no answer within ${seconds(timeoutMs)}`)
          : checkFailed('cancelled', 'the check was cancelled');
      }
      if (done === 'gone') {
        const reason = await probe.whyGone('the model answered');
        return probe.unknownModel ? checkFailed('unknown_model', `unknown model: ${model}`) : checkFailed('failed', reason);
      }
      if (done !== 'settled') return unknown(`pi refused the prompt: ${done.error ?? 'no reason given'}`);
      if (lastAssistant === null) return checkFailed('failed', 'no assistant message');
      if (lastAssistant.stopReason === 'error') return unknown(String(lastAssistant.errorMessage ?? 'pi reported an error'));
      if (lastAssistant.stopReason === 'aborted') return checkFailed('failed', 'pi aborted the turn');
      return { ok: true };
    } finally {
      timer.clear();
      signal?.removeEventListener('abort', onAbort);
      await this.endProbe(probe);
    }
  };

  private probe(args: string[], cwd: string | undefined, options: ProbeOptions): PiProbe {
    const probe = new PiProbe([...this.piCommand, ...args], cwd, this.options.env ?? process.env, options);
    this.probes.add(probe);
    return probe;
  }

  private async endProbe(probe: PiProbe): Promise<void> {
    try {
      await probe.end(this.options.killWaitMs ?? 2000);
    } finally {
      this.probes.delete(probe);
    }
  }

  get piCommand(): string[] {
    return this.options.piCommand ?? ['pi'];
  }

  piVersion(): string | Unavailable {
    if (this.version === undefined) {
      const [program, ...rest] = this.piCommand;
      try {
        this.version = execFileSync(program!, [...rest, '--version'], {
          encoding: 'utf8',
          timeout: 10_000,
          env: { ...(this.options.env ?? process.env), ...CHILD_ENV },
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch (err) {
        this.version = { unavailable: `pi --version failed: ${(err as Error).message}` };
      }
    }
    return this.version;
  }

  start(request: ChildRunRequest, onEvent: (event: DomainEvent) => void): ChildRun {
    return this.begin(new PiChildRun(this, this.options, request, onEvent));
  }

  /**
   * Starts pi on the existing session of the task, with the same flags as start: pi 1.5.2 reopens
   * the session from --session-id and --session-dir, so --session is never added. The follow-up
   * message is the prompt. Throws SessionMissingError, before anything starts, when the session
   * file is gone.
   */
  resume(request: ChildRunRequest, message: string, onEvent: (event: DomainEvent) => void): ChildRun {
    if (!sessionFileExists(request.sessionsFolder, request.taskId)) throw new SessionMissingError(request.taskId);
    return this.begin(new PiChildRun(this, this.options, request, onEvent, message));
  }

  private begin(run: PiChildRun): ChildRun {
    this.live.add(run);
    const outcome = run.execute().finally(() => this.live.delete(run));
    return {
      outcome,
      cancel: () => run.requestStop({ status: 'cancelled' }),
      steer: (message) => run.steer(message),
    };
  }

  /** Last resort when this process must exit now: SIGKILL every live child run. */
  killAll(): void {
    for (const run of this.live) run.forceKill();
    for (const probe of this.probes) probe.kill();
  }
}

interface ProbeOptions {
  /** A line on stdout that is not JSON ends the run, as a malformed answer. */
  strict: boolean;
  onEvent?: (event: PiEvent) => void;
}

/**
 * A short pi RPC run that is no task: the model listing and the model check. It
 * is a process group leader, and end() leaves no member of the group running.
 */
class PiProbe {
  readonly client: PiRpcClient;
  /** Resolves when pi can no longer answer: it exited, its pipe was lost, or it printed a line that is not JSON. */
  readonly gone: Promise<void>;
  unknownModel = false;
  /** Set when the run timed out or was cancelled: end() kills pi rather than closing stdin. */
  mustKill = false;
  private readonly child: ChildProcess;
  private readonly exit: Promise<{ code: number | null; signal: string | null }>;
  private exited = false;
  private spawnError: Error | null = null;
  private badRecord: string | null = null;
  private stderrTail = '';

  constructor(
    private readonly command: string[],
    cwd: string | undefined,
    env: NodeJS.ProcessEnv,
    options: ProbeOptions,
  ) {
    const [program, ...args] = command;
    const child = spawn(program!, args, {
      ...(cwd !== undefined ? { cwd } : {}),
      env: { ...env, ...CHILD_ENV },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    this.child = child;
    // 'close' comes after stderr is drained, which the unknown-model match needs;
    // a short wait after 'exit' covers a descendant that holds the pipes open.
    this.exit = new Promise((resolve) => {
      const done = (code: number | null, signal: string | null) => {
        this.exited = true;
        resolve({ code, signal });
      };
      child.once('close', (code, signal) => done(code, signal));
      child.once('exit', (code, signal) => setTimeout(() => done(code, signal), 200).unref());
      child.once('error', (err) => {
        this.spawnError = err;
        done(null, null);
      });
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT);
      if (UNKNOWN_MODEL.test(this.stderrTail)) this.unknownModel = true;
    });
    let markBad!: () => void;
    const bad = new Promise<void>((resolve) => (markBad = resolve));
    this.client = new PiRpcClient(child.stdin!, child.stdout!, {
      onEvent: options.onEvent ?? (() => {}),
      onBadRecord: (record) => {
        if (!options.strict || this.badRecord !== null) return;
        this.badRecord = record;
        markBad();
      },
    });
    this.gone = Promise.race([this.exit.then(() => undefined), this.client.lost, bad]);
  }

  /** One line saying why pi stopped answering before `what`. */
  async whyGone(what: string): Promise<string> {
    await this.exitedWithin(300);
    if (this.spawnError !== null) return bounded(`could not start pi (${this.command[0]}): ${this.spawnError.message}`);
    if (this.badRecord !== null) return bounded(`pi printed a line that is not JSON before ${what}: ${this.badRecord.slice(0, 120)}`);
    const tail = this.stderrTail.trim();
    if (!this.exited) return bounded(`lost the pipe to pi before ${what}${tail ? `: ${tail}` : ''}`);
    const exit = await this.exit;
    const how = exit.signal !== null ? `on signal ${exit.signal}` : `with code ${exit.code}`;
    return bounded(`pi exited ${how} before ${what}${tail ? `: ${tail}` : ''}`);
  }

  /** Close stdin and wait; then SIGTERM and SIGKILL the group. A killed probe is killed at once. */
  async end(waitMs: number): Promise<void> {
    this.client.close();
    if (!this.mustKill && !(await this.exitedWithin(waitMs))) {
      this.signal('SIGTERM');
      await this.exitedWithin(waitMs);
    }
    this.kill();
    await this.exit;
  }

  kill(): void {
    this.signal('SIGKILL');
  }

  private signal(signal: NodeJS.Signals): void {
    signalProcessTree(this.child.pid, this.exited, signal);
  }

  private exitedWithin(ms: number): Promise<boolean> {
    return waitForExit(this.exit, this.exited, ms);
  }
}

function checkFailed(kind: ModelCheckFailure, message: string): ModelCheckResult {
  return { ok: false, kind, message: bounded(message) };
}

/** pi's model list as tier choices; malformed or empty is an error, never an empty list. */
function hostModels(data: any): HostModel[] {
  const list: unknown = data?.models;
  if (!Array.isArray(list)) throw new Error('pi returned a malformed model list: it has no models array');
  if (list.length === 0) throw new Error(NO_MODELS);
  return list.map((model, i) => hostModel(model, i));
}

function hostModel(model: any, index: number): HostModel {
  const named = (value: unknown) => typeof value === 'string' && value !== '';
  if (typeof model !== 'object' || model === null || !named(model.provider) || !named(model.id)) {
    throw new Error(`pi returned a malformed model list: entry ${index + 1} has no provider or id`);
  }
  const name = `${model.provider}/${model.id}`;
  const reasoning = model.reasoning === true;
  const cost = model.cost;
  const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  return {
    name,
    endpoint: modelEndpoint(name),
    reasoning,
    thinkingLevels: supportedThinkingLevels(reasoning, model.thinkingLevelMap),
    ...(number(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
    ...(number(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
    input: Array.isArray(model.input) ? model.input.filter((kind: unknown) => typeof kind === 'string') : [],
    ...(typeof cost === 'object' && cost !== null && [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(number)
      ? { cost: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite } }
      : {}),
  };
}

/**
 * The thinking levels a model accepts, as pi-ai's getSupportedThinkingLevels
 * decides them: only off without reasoning; otherwise every level up to high that
 * the thinking level map does not mark null, and xhigh or max only when the map
 * gives them a value. THINKING_LEVELS has pi-ai's order, off to max.
 */
function supportedThinkingLevels(reasoning: boolean, thinkingLevelMap: unknown): ThinkingLevel[] {
  if (!reasoning) return ['off'];
  const map = typeof thinkingLevelMap === 'object' && thinkingLevelMap !== null ? (thinkingLevelMap as Record<string, unknown>) : {};
  return THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

/** True when the sessions folder holds the session file of the task, named as TaskStore finds it. */
function sessionFileExists(sessionsFolder: string, taskId: string): boolean {
  try {
    return readdirSync(sessionsFolder).some((f) => f.endsWith(`_${taskId}.jsonl`) || f === `${taskId}.jsonl`);
  } catch {
    return false;
  }
}

/** The text of one entry of pi's steering queue, a string or a message object. */
function queuedText(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  const o = entry as { text?: unknown; message?: unknown; content?: unknown } | null;
  for (const value of [o?.text, o?.message, o?.content]) if (typeof value === 'string') return value;
  return '';
}

function seconds(ms: number): string {
  return `${ms / 1000}s`;
}

function deadline(ms: number): { promise: Promise<'timeout'>; clear(): void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), ms)));
  return { promise, clear: () => clearTimeout(timer) };
}

type Stop = { status: 'cancelled' } | { status: 'failed'; failureKind: 'timeout'; message: string };
type Raced<T> = { kind: 'value'; value: T } | { kind: 'stop' } | { kind: 'exit' };

class PiChildRun {
  private stop: Stop | null = null;
  private settledSeen = false;
  private finished = false;
  private triggerStop!: () => void;
  private readonly stopped = new Promise<void>((resolve) => (this.triggerStop = resolve));
  private triggerSettled!: () => void;
  private readonly settled = new Promise<void>((resolve) => (this.triggerSettled = resolve));
  private child: ChildProcess | null = null;
  private client: PiRpcClient | null = null;
  private exit: Promise<{ code: number | null; signal: string | null }> | null = null;
  private exited = false;
  private exitReported = false;
  private spawnError: Error | null = null;
  private stderrTail = '';
  private textBuffer = '';
  private readonly toolPaths = new Map<string, string>();
  private lastAssistant: any = null;
  private ready = false;
  private pipeLost = false;
  private unknownModel = false;
  private sessionFile: string | undefined;
  private timer: NodeJS.Timeout | null = null;
  private readonly log: (message: string) => void;
  /** The usage baseline of a resumed run: pi's session stats before the prompt. Null when pi gave none. */
  private baseline: any | null | undefined;
  private promptSent = false;
  private triggerPromptSent!: () => void;
  private readonly promptReturned = new Promise<void>((resolve) => (this.triggerPromptSent = resolve));
  private triggerEnded!: () => void;
  private readonly ended = new Promise<void>((resolve) => (this.triggerEnded = resolve));
  /** Steering messages that pi accepted before agent_settled, with the steering queue pi last reported. */
  private readonly deliveredSteers: string[] = [];
  private steeringQueue: string[] = [];
  private unreadSteers: string[] = [];

  /** `resumeMessage` is the follow-up message of a resumed session; a fresh run sends the brief. */
  constructor(
    private readonly driver: PiDriver,
    private readonly options: PiDriverOptions,
    private readonly request: ChildRunRequest,
    private readonly emit: (event: DomainEvent) => void,
    private readonly resumeMessage?: string,
  ) {
    this.log = options.log ?? ((m) => process.stderr.write(`subzero: ${m}\n`));
  }

  /** The first termination wins; a stop after agent_settled changes nothing. */
  requestStop(stop: Stop): void {
    if (this.stop !== null || this.settledSeen || this.finished) return;
    this.stop = stop;
    this.triggerStop();
  }

  /**
   * Steering: send a steer to pi. Delivered when pi accepts it (queued or handled) before
   * agent_settled with no stop pending; settled once agent_settled was seen, sending nothing;
   * stopping while a cancel or timeout is in progress, or when the run has ended. Each delivered
   * steer restarts the timeout.
   */
  async steer(message: string): Promise<SteerAnswer> {
    const early = this.steerAnswerNow();
    if (early !== null) return early;
    // A steer before the prompt went out waits for it, since pi has no turn to steer yet.
    if (!this.promptSent) {
      await Promise.race([this.promptReturned, this.stopped, this.ended]);
      const next = this.steerAnswerNow();
      if (next !== null) return next;
      if (!this.promptSent) return 'stopping';
    }
    let accepted = false;
    const answered = await this.race(
      // The hook runs when the response is dispatched, before any later event of the same chunk.
      this.client!.send({ type: 'steer', message }, (response) => {
        accepted = response.success && !this.settledSeen && this.stop === null && !this.finished;
        if (accepted) this.deliveredSteers.push(message);
      }),
    );
    if (answered.kind !== 'value') return 'stopping';
    if (accepted) {
      this.armTimer();
      return 'delivered';
    }
    if (this.settledSeen) return 'settled';
    if (!answered.value.success) this.log(`${this.request.taskId}: pi refused a steer: ${bounded(answered.value.error ?? 'no reason given')}`);
    return 'stopping';
  }

  private steerAnswerNow(): SteerAnswer | null {
    if (this.settledSeen) return 'settled';
    if (this.stop !== null || this.finished) return 'stopping';
    return null;
  }

  /** (Re)starts the timeout: the full time, from now, until a stop or the end of the run. */
  private armTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.stop !== null || this.finished) return;
    const { agent } = this.request;
    this.timer = setTimeout(
      () => this.requestStop({ status: 'failed', failureKind: 'timeout', message: `timed out after ${agent.timeout}s` }),
      agent.timeout * 1000,
    );
  }

  async execute(): Promise<ChildOutcome> {
    try {
      return await this.main();
    } finally {
      this.finished = true;
      this.triggerEnded();
      if (this.timer !== null) clearTimeout(this.timer);
      this.signalGroup('SIGKILL'); // no grandchild of the group may remain
    }
  }

  forceKill(): void {
    this.signalTree('SIGKILL');
  }

  private async main(): Promise<ChildOutcome> {
    const { agent, taskId, brief, projectRoot, sessionsFolder, driverFilesFolder } = this.request;
    const { files: piExtensions, problem } = piExtensionsOf(this.request.childHostOptions);

    const missing = missingSkills(agent.skills);
    if (missing.length > 0) {
      return failed('skill_mismatch', `missing skill folder: ${missing.map((s) => `${s.name} (${s.folder})`).join(', ')}`);
    }
    if (problem !== undefined) return failed('error', problem);
    if (this.stop !== null) return this.stoppedBeforeSpawn();

    const overlay = prepareOverlay(driverFilesFolder, agent.skills);
    const env = this.options.env ?? process.env;
    const agentDir = this.options.piAgentDir ?? env.PI_CODING_AGENT_DIR ?? path.join(homedir(), '.pi', 'agent');
    if (existsSync(path.join(agentDir, 'SYSTEM.md'))) {
      this.emit({
        kind: 'warning',
        message: `${path.join(agentDir, 'SYSTEM.md')} exists and reaches the child: -nc does not cover it`,
      });
    }

    const command = [
      ...this.driver.piCommand,
      ...launchArgs({ taskId, agent, overlaySkills: overlay, sessionsFolder, ...(piExtensions.length > 0 ? { piExtensions } : {}) }),
    ];
    const launchSpec: LaunchSpec = {
      command,
      cwd: projectRoot,
      envNames: Object.keys(CHILD_ENV),
      version: this.driver.piVersion(),
      skillFolders: overlay,
      thinkingLevel: agent.thinking,
    };
    this.emit({ kind: 'run_started', launchSpec });
    if (this.stop !== null) return this.stoppedBeforeSpawn();

    this.spawnChild(command);
    // The timeout starts at spawn and covers skill verification and the turn; a delivered steer restarts it.
    this.armTimer();

    const state = await this.race(this.client!.send({ type: 'get_state' }));
    if (state.kind !== 'value') return this.interrupted(state.kind);
    this.ready = true;
    if (typeof state.value.data?.sessionFile === 'string') this.sessionFile = state.value.data.sessionFile;

    const commands = await this.race(this.client!.send({ type: 'get_commands' }));
    if (commands.kind !== 'value') return this.interrupted(commands.kind);
    const mismatch = verifySkills(overlay.map(expectedSkillName), commands.value);
    if (mismatch !== null) {
      await this.killNow();
      await this.emitRunExited();
      return failed('skill_mismatch', mismatch);
    }
    this.emit({ kind: 'skills_verified', skills: agent.skills.map((s) => s.name) });

    if (this.resumeMessage !== undefined) {
      // pi reports tokens and cost across the whole session; the turn's usage is the difference from here.
      const stats = await this.race(this.client!.send({ type: 'get_session_stats' }));
      if (stats.kind !== 'value') return this.interrupted(stats.kind);
      this.baseline = stats.value.success ? (stats.value.data ?? null) : null;
    }

    const prompt = await this.race(
      this.client!.send({ type: 'prompt', message: this.resumeMessage ?? brief }, (response) => {
        if (!response.success) return;
        // In order with pi's events: the first of them cannot be reported before this.
        this.promptSent = true;
        this.emit({ kind: 'prompt_sent' });
        this.triggerPromptSent();
      }),
    );
    if (prompt.kind !== 'value') return this.interrupted(prompt.kind);
    if (!prompt.value.success) {
      await this.killNow();
      await this.emitRunExited();
      return failed('error', bounded(this.withModelHint(`pi refused the prompt: ${prompt.value.error ?? 'no reason given'}`)));
    }

    const done = await this.race(this.settled);
    if (done.kind !== 'value') return this.interrupted(done.kind);

    // Settled: no termination applies from here on.
    const text = await this.ask('get_last_assistant_text');
    const stats = await this.ask('get_session_stats');
    this.client!.close();
    await this.waitExitOrKill();
    await this.emitRunExited();
    return this.settledOutcome(text?.text ?? null, stats);
  }

  private spawnChild(command: string[]): void {
    const [program, ...args] = command;
    // A process group leader so the whole group can be signalled. Its stdio pipes
    // stay attached and it is never unref'd, so pi sees EOF when this process dies.
    const child = spawn(program!, args, {
      cwd: this.request.projectRoot,
      env: { ...(this.options.env ?? process.env), ...CHILD_ENV },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    this.child = child;
    this.exit = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.exited = true;
        resolve({ code, signal });
      });
      child.once('error', (err) => {
        this.spawnError = err;
        this.exited = true;
        resolve({ code: null, signal: null });
      });
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT);
      // Remembered, since the warning can leave the tail on a long run.
      if (UNKNOWN_MODEL.test(this.stderrTail)) this.unknownModel = true;
    });
    this.client = new PiRpcClient(child.stdin!, child.stdout!, {
      onEvent: (event) => this.onPiEvent(event),
      onBadRecord: (record) => this.log(`${this.request.taskId}: ignoring a non-JSON line from pi: ${record.slice(0, 120)}`),
    });
  }

  private race<T>(promise: Promise<T>): Promise<Raced<T>> {
    return Promise.race([
      promise.then(
        (value): Raced<T> => ({ kind: 'value', value }),
        (): Raced<T> => ({ kind: 'exit' }),
      ),
      this.stopped.then((): Raced<T> => ({ kind: 'stop' })),
      this.exit!.then((): Raced<T> => ({ kind: 'exit' })),
      this.client!.lost.then((): Raced<T> => ({ kind: 'exit' })),
    ]);
  }

  private interrupted(kind: 'stop' | 'exit'): Promise<ChildOutcome> {
    return kind === 'stop' ? this.terminate() : this.crashed();
  }

  /** Send one command after settlement; any failure leaves its data unavailable. */
  private async ask(type: string): Promise<any> {
    if (this.exited) return null;
    try {
      const response = await withTimeout(this.client!.send({ type }), 10_000);
      return response?.success ? response.data : null;
    } catch {
      return null;
    }
  }

  // ---- pi events → domain events -----------------------------------------

  private onPiEvent(event: PiEvent): void {
    switch (event.type) {
      case 'tool_execution_start': {
        const target = targetPath(event.args);
        if (target !== undefined && typeof event.toolCallId === 'string') this.toolPaths.set(event.toolCallId, target);
        this.emit({ kind: 'tool_activity', phase: 'start', tool: String(event.toolName), ...(target ? { path: target } : {}) });
        return;
      }
      case 'tool_execution_end': {
        // pi sends no args on the end event; the path comes from its start event.
        const target = targetPath(event.args) ?? this.toolPaths.get(String(event.toolCallId));
        this.toolPaths.delete(String(event.toolCallId));
        this.emit({
          kind: 'tool_activity',
          phase: 'end',
          tool: String(event.toolName),
          ...(target ? { path: target } : {}),
          isError: event.isError === true,
        });
        return;
      }
      case 'message_update': {
        // Deltas are buffered into one agent message, never forwarded per token.
        const delta = event.assistantMessageEvent;
        if (delta?.type === 'text_delta' && typeof delta.delta === 'string') this.textBuffer += delta.delta;
        return;
      }
      case 'message_end': {
        const message = event.message;
        if (message?.role === 'assistant') {
          this.lastAssistant = message;
          const text = this.textBuffer || assistantText(message);
          if (text) this.emit({ kind: 'agent_message', text });
        }
        this.textBuffer = '';
        return;
      }
      case 'turn_end':
        this.emit({ kind: 'turn_settled' });
        return;
      case 'auto_retry_start':
        this.emit({ kind: 'retrying', ...(typeof event.attempt === 'number' ? { attempt: event.attempt } : {}) });
        return;
      case 'agent_settled':
        // Only agent_settled settles a run; agent_end may still be followed by retries.
        if (this.stop === null) {
          this.settledSeen = true;
          this.unreadSteers = this.queuedDeliveries();
          this.triggerSettled();
        }
        return;
      case 'queue_update':
        this.steeringQueue = Array.isArray(event.steering) ? event.steering.map(queuedText) : [];
        return;
      case 'extension_ui_request':
        // No dialog can be answered from here; a blocked dialog would hang the run.
        if (DIALOG_METHODS.has(event.method) && typeof event.id === 'string' && this.child?.stdin?.writable) {
          this.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: event.id, cancelled: true }) + '\n');
        }
        return;
      case 'extension_error':
        this.log(`${this.request.taskId}: pi extension error: ${String(event.error).slice(0, 200)}`);
        return;
      case 'response':
        return;
      default:
        if (!QUIET_EVENTS.has(event.type)) {
          this.log(`${this.request.taskId}: ignoring unrecognized pi event type ${JSON.stringify(event.type)}`);
        }
    }
  }

  // ---- endings --------------------------------------------------------------

  /**
   * The steers this run delivered that pi still holds in its steering queue, in queue order. A steer
   * pi answered after it settled is not here: its caller was told it settled.
   */
  private queuedDeliveries(): string[] {
    const pending = [...this.deliveredSteers];
    const unread: string[] = [];
    for (const queued of this.steeringQueue) {
      const at = pending.indexOf(queued);
      if (at === -1) continue;
      pending.splice(at, 1);
      unread.push(queued);
    }
    return unread;
  }

  private settledOutcome(text: string | null, stats: any): ChildOutcome {
    const usage = usageFromStats(stats, this.baseline);
    const base = {
      usage,
      ...(this.sessionFile !== undefined ? { sessionFile: this.sessionFile } : {}),
      ...(this.unreadSteers.length > 0 ? { unreadSteers: this.unreadSteers } : {}),
    };
    const message = this.lastAssistant;
    if (message === null) {
      return { ...base, lastAssistantText: text, status: 'failed', failureKind: 'error', message: 'no assistant message' };
    }
    const summary = text ?? assistantText(message);
    switch (message.stopReason) {
      case 'length':
        return { ...base, lastAssistantText: summary, status: 'truncated' };
      case 'error':
        return {
          ...base,
          lastAssistantText: summary,
          status: 'failed',
          failureKind: 'error',
          message: bounded(this.withModelHint(String(message.errorMessage ?? 'pi reported an error'))),
        };
      case 'aborted':
        return { ...base, lastAssistantText: summary, status: 'cancelled' };
      default:
        return { ...base, lastAssistantText: summary, status: 'completed' };
    }
  }

  /** pi starts with an unknown model id on a known provider and only warns on stderr. */
  private withModelHint(message: string): string {
    return this.unknownModel ? `unknown model: ${this.request.agent.model}: ${message}` : message;
  }

  private stoppedBeforeSpawn(): ChildOutcome {
    const stop = this.stop!;
    return {
      lastAssistantText: null,
      usage: unavailableUsage('the child run ended before pi started'),
      ...(stop.status === 'failed' ? { status: 'failed', failureKind: stop.failureKind, message: stop.message } : { status: 'cancelled' }),
    };
  }

  /**
   * Cancel or timeout: clear_queue, abort (up to abortWaitMs), close stdin, then
   * SIGTERM and SIGKILL to the process group. The status comes from the stop.
   */
  private async terminate(): Promise<ChildOutcome> {
    const stop = this.stop!;
    const client = this.client!;
    let text: string | null = null;
    let stats: any = null;
    if (!this.exited) {
      await withTimeout(client.send({ type: 'clear_queue' }), 1000).catch(() => undefined);
      const aborted = await withTimeout(client.send({ type: 'abort' }), this.options.abortWaitMs ?? 5000).catch(() => null);
      if (aborted?.success && !this.exited) {
        text = (await withTimeout(client.send({ type: 'get_last_assistant_text' }), 1000).catch(() => null))?.data?.text ?? null;
        stats = (await withTimeout(client.send({ type: 'get_session_stats' }), 1000).catch(() => null))?.data ?? null;
      }
      // pi's bash tool detaches its shells; stop them while pi still owns them.
      this.signalDescendants('SIGKILL');
      client.close();
      await this.waitExitOrKill();
    }
    await this.emitRunExited();
    return {
      lastAssistantText: text,
      usage: stats ? usageFromStats(stats, this.baseline) : unavailableUsage('pi did not report usage before it was stopped'),
      ...(this.sessionFile !== undefined ? { sessionFile: this.sessionFile } : {}),
      ...(stop.status === 'failed' ? { status: 'failed', failureKind: stop.failureKind, message: stop.message } : { status: 'cancelled' }),
    };
  }

  /** pi exited, or its pipe was lost, before the run settled. */
  private async crashed(): Promise<ChildOutcome> {
    // A lost pipe can leave pi running; it must not hold the run open.
    if (!this.exited && !(await this.exitedWithin(300))) {
      this.pipeLost = true;
      this.signalDescendants('SIGKILL');
      this.client?.close();
      await this.waitExitOrKill();
    }
    const exit = await this.exit!;
    const tail = this.stderrTail.trim();
    if (tail !== '') this.emit({ kind: 'stderr_tail', text: tail });
    await this.emitRunExited();
    const usage = unavailableUsage('pi exited before it reported usage');
    const session = this.sessionFile !== undefined ? { sessionFile: this.sessionFile } : {};
    if (this.spawnError !== null) {
      return { lastAssistantText: null, usage, status: 'failed', failureKind: 'crashed', message: bounded(`could not start pi: ${this.spawnError.message}`) };
    }
    if (this.pipeLost) {
      return { ...session, lastAssistantText: null, usage, status: 'failed', failureKind: 'crashed', message: 'lost the pipe to pi' };
    }
    if (this.unknownModel) {
      return { lastAssistantText: null, usage, status: 'failed', failureKind: 'error', message: bounded(`unknown model: ${this.request.agent.model}`) };
    }
    if (exit.code === 0 && this.lastAssistant === null) {
      return { ...session, lastAssistantText: null, usage, status: 'failed', failureKind: 'error', message: 'no assistant message' };
    }
    const how = exit.signal !== null ? `signal ${exit.signal}` : `code ${exit.code}`;
    return { ...session, lastAssistantText: null, usage, status: 'failed', failureKind: 'crashed', message: bounded(`pi exited mid-turn with ${how}`) };
  }

  /** Every path that ends a spawned child reports its exit, once. */
  private async emitRunExited(): Promise<void> {
    const exit = await this.exit!;
    if (this.exitReported) return;
    this.exitReported = true;
    this.emit({ kind: 'run_exited', code: exit.code, signal: exit.signal });
  }

  private async killNow(): Promise<void> {
    this.client?.close();
    this.signalTree('SIGKILL');
    await this.exit;
  }

  private async waitExitOrKill(): Promise<void> {
    const wait = this.options.killWaitMs ?? 2000;
    if (await this.exitedWithin(wait)) return;
    // On SIGTERM pi also kills the shells its bash tool detached.
    this.signalTree('SIGTERM');
    if (await this.exitedWithin(wait)) return;
    this.signalTree('SIGKILL');
    await this.exit;
  }

  private exitedWithin(ms: number): Promise<boolean> {
    return waitForExit(this.exit!, this.exited, ms);
  }

  /**
   * Signal pi's group and the group of every descendant of pi. pi's bash tool
   * spawns detached shells, which a signal to pi's own group does not reach.
   */
  private signalTree(signal: NodeJS.Signals): void {
    signalProcessTree(this.child?.pid, this.exited, signal);
  }

  /** Signal the groups of pi's descendants, not pi itself, while pi is alive. */
  private signalDescendants(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (pid === undefined || this.exited) return;
    signalTargets(descendants(pid), signal);
  }

  /** Signal pi's own process group. */
  private signalGroup(signal: NodeJS.Signals): void {
    signalOwnGroup(this.child?.pid, this.exited, signal);
  }
}

/** True once exit settles within ms; true at once when the process has already exited. */
async function waitForExit(exit: Promise<unknown>, exited: boolean, ms: number): Promise<boolean> {
  if (exited) return true;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  const result = await Promise.race([exit.then(() => true as const), timedOut]);
  clearTimeout(timer);
  return result;
}

/** Signal each target's process group, or the target alone when it leads no group. */
function signalTargets(targets: readonly number[], signal: NodeJS.Signals): void {
  for (const target of targets) {
    try {
      process.kill(-target, signal);
    } catch {
      try {
        process.kill(target, signal);
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Signal a process's own group. After the process is reaped its id is safe to use
 * only while a member of the group is still alive.
 */
function signalOwnGroup(pid: number | undefined, exited: boolean, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  if (exited && !groupHasMembers(pid)) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
}

/**
 * Signal a live process's group and the group of every descendant; once it has
 * exited, only its own group, under signalOwnGroup's guard.
 */
function signalProcessTree(pid: number | undefined, exited: boolean, signal: NodeJS.Signals): void {
  if (pid === undefined || exited) return signalOwnGroup(pid, exited, signal);
  signalTargets([pid, ...descendants(pid)], signal);
}

function failed(failureKind: 'skill_mismatch' | 'error', message: string): ChildOutcome {
  return { lastAssistantText: null, usage: unavailableUsage('pi did not run a turn'), status: 'failed', failureKind, message };
}

/**
 * The name pi gives the skill in a folder: its SKILL.md frontmatter name, or the
 * folder name when there is none.
 */
export function expectedSkillName(folder: string): string {
  try {
    const text = readFileSync(path.join(folder, 'SKILL.md'), 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const name = match ? (parseYaml(match[1]!) as { name?: unknown } | null)?.name : undefined;
    if (typeof name === 'string' && name !== '') return name;
  } catch {
    // fall back to the folder name, as pi does
  }
  return path.basename(folder);
}

/** Compare the skills pi loaded with the declared ones; null when they are equal. */
export function verifySkills(expected: string[], response: PiResponse): string | null {
  if (!response.success) return bounded(`get_commands failed: ${response.error ?? 'no reason given'}`);
  const commands: any[] = Array.isArray(response.data?.commands) ? response.data.commands : [];
  const loaded = commands.filter((c) => c?.source === 'skill').map((c) => String(c.name ?? '').replace(/^skill:/, ''));
  const extra = loaded.filter((name) => !expected.includes(name));
  const missing = expected.filter((name) => !loaded.includes(name));
  const counted = loaded.length === expected.length;
  if (extra.length === 0 && missing.length === 0 && counted) return null;
  const parts = [];
  if (!counted && extra.length === 0 && missing.length === 0) {
    parts.push(`pi loaded ${loaded.length} skills for ${expected.length} declared folders; two declare the same name`);
  }
  if (extra.length > 0) parts.push(`extra skill ${extra.join(', ')}`);
  if (missing.length > 0) parts.push(`missing skill ${missing.join(', ')}`);
  return `skill verification failed: ${parts.join('; ')}`;
}

function groupHasMembers(pgid: number): boolean {
  try {
    const listing = execFileSync('ps', ['-A', '-o', 'pgid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return listing.split('\n').some((line) => Number(line.trim()) === pgid);
  } catch {
    return false;
  }
}

/** Every live descendant of a process, from one ps listing. */
function descendants(root: number): number[] {
  let listing: string;
  try {
    listing = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of listing.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined || Number.isNaN(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

function targetPath(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const a = args as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'filePath', 'file', 'directory', 'dir']) {
    if (typeof a[key] === 'string' && a[key] !== '') return a[key] as string;
  }
  return undefined;
}

function assistantText(message: any): string {
  if (!Array.isArray(message?.content)) return typeof message?.content === 'string' ? message.content : '';
  return message.content
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('');
}

function measure(value: unknown, reason: string): Measure {
  return typeof value === 'number' && Number.isFinite(value) ? value : { unavailable: reason };
}

/**
 * Fill the session usage from get_session_stats; what pi does not report stays unavailable.
 * pi counts tokens and cost across the whole session, so a resumed run passes the stats it read
 * before its prompt (`baseline`, null when pi gave none) and reports the difference; context use
 * is reported as read. Without a baseline the stats are the usage of the run.
 */
export function usageFromStats(stats: any, baseline?: any | null): SessionUsage {
  const usage = readUsage(stats);
  if (baseline === undefined || stats === null || typeof stats !== 'object') return usage;
  const before = baseline === null ? null : readUsage(baseline);
  const turn = (now: Measure, was: Measure | undefined): Measure =>
    typeof now === 'number' && typeof was === 'number' ? now - was : { unavailable: 'pi did not report the usage before this turn' };
  return {
    ...usage,
    inputTokens: turn(usage.inputTokens, before?.inputTokens),
    outputTokens: turn(usage.outputTokens, before?.outputTokens),
    cacheReadTokens: turn(usage.cacheReadTokens, before?.cacheReadTokens),
    cacheWriteTokens: turn(usage.cacheWriteTokens, before?.cacheWriteTokens),
    totalTokens: turn(usage.totalTokens, before?.totalTokens),
    cost: turn(usage.cost, before?.cost),
  };
}

function readUsage(stats: any): SessionUsage {
  if (stats === null || typeof stats !== 'object') return unavailableUsage('pi did not report session stats');
  const tokens = stats.tokens ?? {};
  const context = stats.contextUsage ?? {};
  return {
    inputTokens: measure(tokens.input, 'pi did not report input tokens'),
    outputTokens: measure(tokens.output, 'pi did not report output tokens'),
    cacheReadTokens: measure(tokens.cacheRead, 'pi did not report cache reads'),
    cacheWriteTokens: measure(tokens.cacheWrite, 'pi did not report cache writes'),
    totalTokens: measure(tokens.total, 'pi did not report total tokens'),
    cost: measure(stats.cost, 'pi did not report cost'),
    contextTokens: measure(context.tokens, 'pi did not report context use'),
    contextWindow: measure(context.contextWindow, 'pi did not report the context window'),
    contextPercent: measure(context.percent, 'pi did not report context use'),
  };
}

function bounded(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MESSAGE_LIMIT ? `${oneLine.slice(0, MESSAGE_LIMIT - 1)}…` : oneLine;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error('timed out')), ms))),
  ]);
}
