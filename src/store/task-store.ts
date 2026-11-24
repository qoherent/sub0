// @sigil implements design/task-store.sigil TaskStore
//
// Layout under <project root>/.agents/subzero/:
//   .gitignore            ignores everything in the store folder
//   index.jsonl           append-only; the latest line per task wins
//   tasks/<id>/task.json  frozen agent definition, brief, tier, model and, once started, the launch spec of the latest run
//   tasks/<id>/events.jsonl
//   tasks/<id>/turns/<n>.json  turn n: the owner that claimed it, its opening message, its times, and the exact result
//                              the parent received once it settled; a bare result is turn 1 of a v0.1 record
//   tasks/<id>/turns/<n>.collected  empty; present once the result of turn n reached the parent
//   tasks/<id>/            also holds the driver files of the task, which the store never writes
//   sessions/             child sessions
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  linkSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { AgentDefinition } from '../config/agent-config.js';
import type { DomainEvent, LaunchSpec, Result, ResultStatus } from '../core/types.js';

export type TaskStatus = 'running' | ResultStatus | 'abandoned';

export interface OwnerProcess {
  pid: number;
  startTime: string;
}

/** Why a turn stopped before it settled by itself. */
export type StopReason = 'session_end';

/** One turn of a task as its turn file holds it. */
export interface TurnFile {
  turn: number;
  /** The process that claimed the turn; null for a bare result of a v0.1 record. */
  owner: OwnerProcess | null;
  /** The follow-up message that opened the turn; none for the brief's turn. */
  message?: string;
  /** Messages of an abandoned turn that never sent its prompt, replayed before `message`, in order. */
  replayed?: string[];
  /** The messages after `message` that were held for a turn that opened for several, in order. */
  heldMessages?: string[];
  /** When the turn opened; for turn 1 the creation time of the task. */
  enqueuedAt: string;
  /** True when messages held for the turn before it settled opened this turn by themselves. */
  viaHeld?: true;
  /**
   * True when the child run of this turn was released with the brief as its prompt, because no
   * child run of the task ever sent its prompt or the child session is gone; the follow-up
   * message stays beside it as held.
   */
  briefPrompt?: true;
  /** When the caller released its child run. */
  startedAt?: string;
  stopReason?: StopReason;
  /** The exact result the parent received; absent while the turn runs. */
  result?: Result;
}

/** A domain event as the event log holds it. */
export type LoggedEvent = DomainEvent & { ts: string; turn?: number };

/** What the caller gives when it opens a turn. */
export type OpenedTurn = Pick<TurnFile, 'viaHeld' | 'message' | 'replayed' | 'heldMessages' | 'briefPrompt' | 'enqueuedAt'>;

export interface IndexLine {
  taskId: string;
  agent: string;
  status: TaskStatus;
  parentSessionId?: string;
  /** The child session id, which is the task id. */
  childSession: string;
  sessionFile?: string;
  createdAt: string;
  updatedAt: string;
  /** The full model id of the task. Written on the first line of a task only. */
  model?: string;
  /** The number of the latest turn, and when it opened. Carried forward by readers. */
  turn?: number;
  enqueuedAt?: string;
  /** Written on the first line of a task only. */
  owner?: OwnerProcess;
}

export interface TaskJson {
  taskId: string;
  agent: AgentDefinition;
  brief: string;
  parentSessionId?: string;
  /** The full model id of the task, kept from its first write and never read from the launch spec. */
  model?: string;
  /** The model tier the task was delegated at, so a task loaded from its record shows it. */
  tier?: string;
  /** The enqueue time of the task: the time it was created. */
  createdAt: string;
  /** Written by v0.1 at the release; v0.2 keeps the start time in the turn file. */
  startedAt?: string;
  launchSpec?: LaunchSpec;
}

/** One task as a reader sees it: the latest index line merged with the record. */
export interface TaskView {
  taskId: string;
  agent: string;
  status: TaskStatus;
  parentSessionId?: string;
  /** The creation time of the task, which is the enqueue time of turn 1. */
  createdAt: string;
  updatedAt: string;
  /** The full model id of the task, when its first write recorded one. */
  model?: string;
  /** The number of the latest turn; absent in a record that holds no turn file. */
  turn?: number;
  /** The enqueue time of the latest turn. */
  enqueuedAt: string;
  /** When the child run of the latest turn was released; none while it is queued. */
  startedAt?: string;
  sessionFile?: string;
  owner?: OwnerProcess;
}

export interface TaskRecord extends TaskView {
  task: TaskJson | null;
  /** The result of the latest turn, or null while it runs. */
  result: Result | null;
  turns: TurnFile[];
}

/**
 * Reports when a process started, without signalling it: its start time while it
 * is alive, null when there is no such process, and undefined when it cannot tell.
 */
export interface ProcessProbe {
  startTime(pid: number): string | null | undefined;
}

export const psProbe: ProcessProbe = {
  startTime(pid: number): string | null | undefined {
    // On Linux the start time in ticks since boot is stable; lstart moves when the
    // wall clock is stepped.
    if (process.platform === 'linux' && existsSync('/proc/self/stat')) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return fields[19] ?? undefined;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
      }
    }
    try {
      // A fixed locale and zone, so every process prints the same start time.
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out === '' ? null : out;
    } catch (err) {
      // ps exits 1 when the process does not exist; anything else is unknown.
      return (err as { status?: number }).status === 1 ? null : undefined;
    }
  },
};

export interface TaskStoreOptions {
  warn?: (message: string) => void;
  probe?: ProcessProbe;
  /** The process recorded as owner of new tasks. Defaults to this process. */
  owner?: OwnerProcess;
}

/**
 * The writer side of a task record. Only TaskCore holds one; every other component
 * reads through TaskStore.
 */
export interface TaskRecordWriter {
  readonly sessionsFolder: string;
  /** The folder where the child driver keeps its own files of a task. */
  driverFilesFolder(taskId: string): string;
  /** Create the task record, claiming turn 1 for this process. */
  createTaskRecord(task: TaskJson): void;
  /**
   * Claim turn `turn` by exclusive create of its turn file. False when another process
   * already holds it; then nothing else is written.
   */
  claimTurn(taskId: string, turn: number, opened: OpenedTurn): boolean;
  /** Record when the child run of a turn was released, for a reader in any process. */
  writeStartTime(taskId: string, startedAt: string, turn?: number): void;
  writeStopReason(taskId: string, turn: number, reason: StopReason): void;
  /** Mark that a turn is released with the brief as its prompt. */
  writeBriefPrompt(taskId: string, turn: number): void;
  /** Mark that the stop of a turn was reported to the parent model. A marker is never removed. */
  markReported(taskId: string, turn: number): void;
  writeLaunchSpec(taskId: string, spec: LaunchSpec): void;
  /** Append a domain event to the event log, marked with its turn when it has one. */
  appendEvent(taskId: string, event: DomainEvent, turn?: number): void;
  /**
   * Every event of the log, oldest first, each with its turn when it was written with one. With
   * `kinds`, lines that cannot hold an event of one of those kinds are skipped before they are parsed.
   */
  readEvents(taskId: string, kinds?: LoggedEvent['kind'][]): LoggedEvent[];
  /** The messages of a turn that no child run received, in order; none when its prompt was sent. */
  undeliveredMessages(turn: TurnFile, events: LoggedEvent[]): string[];
  /** True when a child of the task was ever sent a prompt, so the task has a child session. */
  promptWasSent(taskId: string): boolean;
  /** Write the result of a turn (`extra.turn`, else the result's turn, else 1), then its index line. */
  writeResult(taskId: string, result: Result, extra?: { sessionFile?: string; turn?: number }): void;
  exists(taskId: string): boolean;
  /** Every turn file of a task, oldest first. */
  readTurns(taskId: string): TurnFile[];
  /** One turn file; null when there is none. */
  readTurn(taskId: string, turn: number): TurnFile | null;
  /** Read a task record, so a task of another process can be loaded and continued. */
  readTask(taskId: string): TaskRecord | null;
}

export class TaskStore implements TaskRecordWriter {
  readonly storeFolder: string;
  readonly sessionsFolder: string;
  readonly indexPath: string;
  private readonly warn: (message: string) => void;
  private readonly probe: ProcessProbe;
  private ownerProcess: OwnerProcess | undefined;

  /** The project root comes from the caller; TaskStore resolves none of its own. */
  constructor(projectRoot: string, options: TaskStoreOptions = {}) {
    this.storeFolder = path.join(projectRoot, '.agents', 'subzero');
    this.sessionsFolder = path.join(this.storeFolder, 'sessions');
    this.indexPath = path.join(this.storeFolder, 'index.jsonl');
    this.warn = options.warn ?? ((m) => process.stderr.write(`subzero: ${m}\n`));
    this.probe = options.probe ?? psProbe;
    this.ownerProcess = options.owner;
  }

  taskDir(taskId: string): string {
    return path.join(this.storeFolder, 'tasks', taskId);
  }

  /** The driver files of a task sit in its task folder, beside the task record. */
  driverFilesFolder(taskId: string): string {
    return this.taskDir(taskId);
  }

  /**
   * Whether the process of an owner is alive with the start time it was recorded with: true,
   * false, or undefined when the probe cannot tell.
   */
  ownerAlive(owner: OwnerProcess): boolean | undefined {
    const startTime = this.probe.startTime(owner.pid);
    if (startTime === undefined) return undefined;
    return startTime !== null && (startTime === owner.startTime || owner.startTime === 'unknown');
  }

  /** True when the owner is this process. */
  isOwner(owner: OwnerProcess): boolean {
    return owner.pid === this.owner.pid && owner.startTime === this.owner.startTime;
  }

  private get owner(): OwnerProcess {
    if (this.ownerProcess === undefined) {
      this.ownerProcess = { pid: process.pid, startTime: this.probe.startTime(process.pid) ?? 'unknown' };
    }
    return this.ownerProcess;
  }

  // ---- writes -------------------------------------------------------------

  /** Create the store folder, owner-only, with a .gitignore that ignores it all. */
  private ensureStoreFolder(): void {
    if (!existsSync(this.storeFolder)) {
      mkdirSync(this.storeFolder, { recursive: true, mode: 0o700 });
      chmodSync(this.storeFolder, 0o700);
    }
    const ignore = path.join(this.storeFolder, '.gitignore');
    if (existsSync(ignore)) return;
    try {
      writeFileSync(ignore, '*\n', { flag: 'wx' });
    } catch (err) {
      // Another process wrote it first.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }

  exists(taskId: string): boolean {
    return existsSync(this.taskDir(taskId));
  }

  createTaskRecord(task: TaskJson): void {
    this.ensureStoreFolder();
    const dir = this.taskDir(task.taskId);
    mkdirSync(path.join(dir, 'turns'), { recursive: true, mode: 0o700 });
    writeAtomic(path.join(dir, 'task.json'), task);
    this.createTurnFile(task.taskId, 1, { enqueuedAt: task.createdAt });
    this.appendIndex({
      taskId: task.taskId,
      agent: task.agent.name,
      status: 'running',
      ...(task.parentSessionId !== undefined ? { parentSessionId: task.parentSessionId } : {}),
      childSession: task.taskId,
      createdAt: task.createdAt,
      updatedAt: task.createdAt,
      ...(task.model !== undefined ? { model: task.model } : {}),
      turn: 1,
      enqueuedAt: task.createdAt,
      owner: this.owner,
    });
  }

  private turnPath(taskId: string, turn: number): string {
    return path.join(this.taskDir(taskId), 'turns', `${turn}.json`);
  }

  /**
   * Publish a new turn file whole and only if none exists: a temporary file is linked into
   * place, and a link fails when its target is there, so a reader never sees part of it and
   * two claimants never both win. False when the turn is taken.
   */
  private createTurnFile(taskId: string, turn: number, opened: OpenedTurn): boolean {
    const file = this.turnPath(taskId, turn);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const body: TurnFile = {
      turn,
      owner: this.owner,
      ...(opened.viaHeld === true ? { viaHeld: true as const } : {}),
      ...(opened.briefPrompt === true ? { briefPrompt: true as const } : {}),
      ...(opened.message !== undefined ? { message: opened.message } : {}),
      ...(opened.replayed !== undefined && opened.replayed.length > 0 ? { replayed: opened.replayed } : {}),
      ...(opened.heldMessages !== undefined && opened.heldMessages.length > 0 ? { heldMessages: opened.heldMessages } : {}),
      enqueuedAt: opened.enqueuedAt,
    };
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
    try {
      linkSync(tmp, file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    } finally {
      unlinkSync(tmp);
    }
  }

  claimTurn(taskId: string, turn: number, opened: OpenedTurn): boolean {
    if (!this.createTurnFile(taskId, turn, opened)) return false;
    const first = this.readLatest().get(taskId);
    // The running line follows only a claim that succeeded, with the owner when it changes.
    this.appendIndex({
      taskId,
      agent: first?.agent ?? this.readTaskJson(taskId)?.agent.name ?? '',
      status: 'running',
      ...(first?.parentSessionId !== undefined ? { parentSessionId: first.parentSessionId } : {}),
      childSession: taskId,
      ...sessionField(first?.sessionFile),
      createdAt: first?.createdAt ?? opened.enqueuedAt,
      updatedAt: new Date().toISOString(),
      turn,
      enqueuedAt: opened.enqueuedAt,
      ...(first?.owner === undefined || !this.isOwner(first.owner) ? { owner: this.owner } : {}),
    });
    return true;
  }

  /**
   * Change one turn file in place, keeping the rest of it. A bare result is read as turn 1 first.
   * Only a result may create a missing turn file: a file with no result reads as a running turn.
   */
  private updateTurn(taskId: string, turn: number, change: (file: TurnFile) => TurnFile, create = false): void {
    const existing = this.readTurn(taskId, turn);
    if (existing === null && !create) {
      this.warn(`no turn ${turn} of ${taskId} to update`);
      return;
    }
    const current = existing ?? { turn, owner: this.owner, enqueuedAt: this.readLatest().get(taskId)?.createdAt ?? new Date().toISOString() };
    writeAtomic(this.turnPath(taskId, turn), change(current));
  }

  /** Write the start time into the turn file: no index line, so the task status is still running. */
  writeStartTime(taskId: string, startedAt: string, turn: number): void {
    if (!this.exists(taskId)) throw new Error(`no task record for ${taskId}`);
    this.updateTurn(taskId, turn, (file) => ({ ...file, startedAt }));
  }

  writeStopReason(taskId: string, turn: number, reason: StopReason): void {
    this.updateTurn(taskId, turn, (file) => ({ ...file, stopReason: reason }));
  }

  writeBriefPrompt(taskId: string, turn: number): void {
    this.updateTurn(taskId, turn, (file) => ({ ...file, briefPrompt: true }));
  }

  // ---- collected markers ---------------------------------------------------

  private collectedPath(taskId: string, turn: number): string {
    return this.markerPath(taskId, turn, 'collected');
  }

  private markerPath(taskId: string, turn: number, ext: 'collected' | 'reported'): string {
    return path.join(this.taskDir(taskId), 'turns', `${turn}.${ext}`);
  }

  /** Create an empty marker file unless it exists. A marker is never removed or rewritten. */
  private markOnce(taskId: string, turn: number, ext: 'collected' | 'reported'): void {
    try {
      writeFileSync(this.markerPath(taskId, turn, ext), '', { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }

  private hasMarker(taskId: string, turn: number, ext: 'collected' | 'reported'): boolean {
    return existsSync(this.markerPath(taskId, turn, ext));
  }

  /** Mark that the result of a turn reached the parent. A marker is never removed or rewritten. */
  markCollected(taskId: string, turn: number): void {
    this.markOnce(taskId, turn, 'collected');
  }

  /** Mark that a stopped turn was named in a reload report. A marker is never removed. */
  markReported(taskId: string, turn: number): void {
    this.markOnce(taskId, turn, 'reported');
  }

  isReported(taskId: string, turn: number): boolean {
    return this.hasMarker(taskId, turn, 'reported');
  }

  /** Where the collected marker of a turn lives, so a front end can name it for another process to create. */
  collectedMarkerPath(taskId: string, turn: number): string {
    return this.collectedPath(taskId, turn);
  }

  isCollected(taskId: string, turn: number): boolean {
    return this.hasMarker(taskId, turn, 'collected');
  }

  /** The turns that hold a result no path has delivered to the parent yet, oldest first. */
  uncollectedTurns(taskId: string): TurnFile[] {
    return this.readTurns(taskId).filter((t) => t.result !== undefined && !this.isCollected(taskId, t.turn));
  }

  writeLaunchSpec(taskId: string, spec: LaunchSpec): void {
    const file = path.join(this.taskDir(taskId), 'task.json');
    const task = readJson<TaskJson>(file);
    if (task === null) throw new Error(`no task record for ${taskId}`);
    writeAtomic(file, { ...task, launchSpec: spec });
  }

  appendEvent(taskId: string, event: DomainEvent, turn?: number): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event, ...(turn !== undefined && !('turn' in event) ? { turn } : {}) }) + '\n';
    appendFileSync(path.join(this.taskDir(taskId), 'events.jsonl'), line, { mode: 0o600 });
  }

  readEvents(taskId: string, kinds?: LoggedEvent['kind'][]): LoggedEvent[] {
    let text: string;
    try {
      text = readFileSync(path.join(this.taskDir(taskId), 'events.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const needles = kinds?.map((kind) => `"kind":"${kind}"`);
    return text.split('\n').flatMap((raw) => {
      if (raw.trim() === '') return [];
      if (needles !== undefined && !needles.some((needle) => raw.includes(needle))) return [];
      try {
        const event = JSON.parse(raw) as LoggedEvent;
        return kinds === undefined || kinds.includes(event.kind) ? [event] : [];
      } catch {
        return [];
      }
    });
  }

  /**
   * A `prompt_sent` event proves a child session. A record that an earlier version wrote has no
   * such event, so its session file stands in for it; a turn 1 file with an owner process marks a
   * record of this version, where a session file proves nothing because the driver creates it
   * before the prompt.
   */
  promptWasSent(taskId: string): boolean {
    if (this.readEvents(taskId, ['prompt_sent']).some((e) => e.kind === 'prompt_sent')) return true;
    if (this.readTurn(taskId, 1)?.owner != null) return false;
    return this.findSessionFile(taskId) !== undefined;
  }

  /**
   * The messages of a turn that no child run received, in the order they were given: those the turn
   * file records, then the follow-ups the log shows queued for it. None once the turn sent its
   * prompt; `events` is the log of the task.
   */
  undeliveredMessages(turn: TurnFile, events: LoggedEvent[]): string[] {
    const queued = events.flatMap((e) => (e.kind === 'follow_up_message' && e.turn === turn.turn && e.outcome === 'queued' ? [e.text] : []));
    if (!events.some((e) => e.kind === 'prompt_sent' && e.turn === turn.turn)) {
      return [...(turn.replayed ?? []), ...(turn.message !== undefined ? [turn.message] : []), ...(turn.heldMessages ?? []), ...queued];
    }
    // The prompt carried the turn's first message. Every other one went to steering afterwards, one at a
    // time, and counts as delivered only once its answer was recorded; a repeated text is matched one for one.
    const handled = new Map<string, number>();
    for (const e of events) {
      if (e.kind === 'held_message_handled' && e.turn === turn.turn) handled.set(e.text, (handled.get(e.text) ?? 0) + 1);
    }
    return [...heldAfterPrompt(turn), ...queued].filter((text) => {
      const answered = handled.get(text) ?? 0;
      if (answered === 0) return true;
      handled.set(text, answered - 1);
      return false;
    });
  }

  /** Write the result in one step, and only then the index line that gives its status. */
  writeResult(taskId: string, result: Result, extra: { sessionFile?: string; turn?: number } = {}): void {
    const turn = extra.turn ?? result.turn ?? 1;
    this.updateTurn(taskId, turn, (file) => ({ ...file, result }), true);
    const first = this.readLatest().get(taskId);
    this.appendIndex({
      taskId,
      agent: result.agent,
      status: result.status,
      ...(first?.parentSessionId !== undefined ? { parentSessionId: first.parentSessionId } : {}),
      childSession: taskId,
      ...(extra.sessionFile !== undefined ? { sessionFile: extra.sessionFile } : {}),
      createdAt: first?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  /** One line, one write: O_APPEND keeps two processes from interleaving a line. */
  private appendIndex(line: IndexLine): void {
    this.ensureStoreFolder();
    appendFileSync(this.indexPath, JSON.stringify(line) + '\n', { mode: 0o600 });
  }

  // ---- reads --------------------------------------------------------------

  /** The latest line per task, with the owner and creation time of its first line. */
  readLatest(): Map<string, IndexLine> {
    const latest = new Map<string, IndexLine>();
    let text: string;
    try {
      text = readFileSync(this.indexPath, 'utf8');
    } catch {
      return latest;
    }
    const lines = text.split('\n');
    lines.forEach((raw, i) => {
      if (raw.trim() === '') return;
      let line: IndexLine;
      try {
        line = JSON.parse(raw) as IndexLine;
        if (typeof line.taskId !== 'string' || typeof line.status !== 'string') throw new Error('shape');
      } catch {
        this.warn(`skipping corrupt line ${i + 1} of ${this.indexPath}`);
        return;
      }
      const earlier = latest.get(line.taskId);
      latest.set(line.taskId, {
        ...line,
        // The latest line that records an owner wins, so a takeover shows; the first line gives the creation time.
        owner: line.owner ?? earlier?.owner,
        createdAt: earlier?.createdAt ?? line.createdAt,
        parentSessionId: line.parentSessionId ?? earlier?.parentSessionId,
        sessionFile: line.sessionFile ?? earlier?.sessionFile,
        model: line.model ?? earlier?.model,
        turn: line.turn ?? earlier?.turn,
        enqueuedAt: line.enqueuedAt ?? earlier?.enqueuedAt,
      });
    });
    return latest;
  }

  /** One turn file; a bare result is turn 1 of a v0.1 record. Null when there is none. */
  readTurn(taskId: string, turn: number): TurnFile | null {
    const raw = readJson<Record<string, unknown>>(this.turnPath(taskId, turn));
    if (raw === null) return null;
    if (typeof raw.enqueuedAt === 'string' && typeof raw.turn === 'number') return raw as unknown as TurnFile;
    // A v0.1 record wrote the bare result as turns/1.json.
    if (turn === 1 && typeof raw.status === 'string' && typeof raw.taskId === 'string') {
      const task = this.readTaskJson(taskId);
      return {
        turn: 1,
        owner: null,
        enqueuedAt: task?.createdAt ?? this.readLatest().get(taskId)?.createdAt ?? '',
        ...(task?.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
        result: raw as unknown as Result,
      };
    }
    return null;
  }

  /** The numbers of the turn files of a task, ascending. */
  private turnNumbers(taskId: string): number[] {
    let names: string[];
    try {
      names = readdirSync(path.join(this.taskDir(taskId), 'turns'));
    } catch {
      return [];
    }
    return names.flatMap((n) => (/^\d+\.json$/.test(n) ? [Number(n.slice(0, -5))] : [])).sort((a, b) => a - b);
  }

  /** Every turn file of a task, oldest first. */
  readTurns(taskId: string): TurnFile[] {
    return this.turnNumbers(taskId).flatMap((n) => {
      const turn = this.readTurn(taskId, n);
      return turn === null ? [] : [turn];
    });
  }


  /** The latest turn, which is the turn file with the highest turn number. */
  latestTurn(taskId: string): TurnFile | null {
    return this.readTurns(taskId).at(-1) ?? null;
  }

  /**
   * The owner recorded in the turn file with the highest number, reading that one file only: undefined
   * when the task has no turn file, null for a bare result of a v0.1 record.
   */
  latestTurnOwner(taskId: string): OwnerProcess | null | undefined {
    const latest = this.turnNumbers(taskId).at(-1);
    return latest === undefined ? undefined : this.readTurn(taskId, latest)?.owner;
  }

  /** The result of the latest turn, or null while it runs. */
  readResult(taskId: string): Result | null {
    return this.latestTurn(taskId)?.result ?? null;
  }

  readTaskJson(taskId: string): TaskJson | null {
    return readJson<TaskJson>(path.join(this.taskDir(taskId), 'task.json'));
  }

  /**
   * A stored result of the latest turn outranks whatever the latest index line says, and a latest
   * turn with no result is running unless the sweep marked it abandoned.
   */
  private view(line: IndexLine, latest: TurnFile | null): TaskView {
    const status: TaskStatus =
      latest?.result?.status ?? (latest !== null && line.status !== 'abandoned' ? 'running' : line.status);
    const turn = latest?.turn ?? line.turn;
    const owner = latest !== null && latest.result === undefined && latest.owner !== null ? latest.owner : line.owner;
    return {
      taskId: line.taskId,
      agent: line.agent,
      status,
      ...(line.parentSessionId !== undefined ? { parentSessionId: line.parentSessionId } : {}),
      createdAt: line.createdAt,
      updatedAt: line.updatedAt,
      ...(line.model !== undefined ? { model: line.model } : {}),
      ...(turn !== undefined ? { turn } : {}),
      enqueuedAt: latest?.enqueuedAt ?? line.enqueuedAt ?? line.createdAt,
      ...(latest?.startedAt !== undefined ? { startedAt: latest.startedAt } : {}),
      ...(line.sessionFile !== undefined ? { sessionFile: line.sessionFile } : {}),
      // The owner of a running turn is the one in its turn file.
      ...(owner !== undefined ? { owner } : {}),
    };
  }

  readTask(taskId: string): TaskRecord | null {
    const line = this.readLatest().get(taskId);
    if (line === undefined) return null;
    const turns = this.readTurns(taskId);
    const task = this.readTaskJson(taskId);
    const latest = turns.at(-1) ?? null;
    const view = this.view(line, latest);
    const startedAt = view.startedAt ?? (latest === null ? task?.startedAt : undefined);
    const sessionFile = view.sessionFile ?? this.findSessionFile(taskId);
    return {
      ...view,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(sessionFile !== undefined ? { sessionFile } : {}),
      task,
      result: latest?.result ?? null,
      turns,
    };
  }

  /** The child session file of a task in the sessions folder; its id is the task id. */
  findSessionFile(taskId: string): string | undefined {
    try {
      const name = readdirSync(this.sessionsFolder).find((f) => f.endsWith(`_${taskId}.jsonl`) || f === `${taskId}.jsonl`);
      return name === undefined ? undefined : path.join(this.sessionsFolder, name);
    } catch {
      return undefined;
    }
  }

  /** Every task, or the tasks of one parent session id. */
  list(parentSessionId?: string): TaskView[] {
    const views: TaskView[] = [];
    for (const line of this.readLatest().values()) {
      if (parentSessionId !== undefined && line.parentSessionId !== parentSessionId) continue;
      const open = line.status === 'running' || line.status === 'abandoned';
      // The start time lives in the turn file; only a task whose line says running can still be queued.
      // A line of an earlier version carries no turn number, so its turn file gives it.
      const read = open || line.turn === undefined ? this.latestTurn(line.taskId) : null;
      const latest = open || read?.result !== undefined ? read : null;
      const view = this.view(line, latest);
      if (line.status === 'running' && latest === null && view.startedAt === undefined) {
        const taskStartedAt = this.readTaskJson(line.taskId)?.startedAt;
        views.push({ ...view, ...(taskStartedAt !== undefined ? { startedAt: taskStartedAt } : {}) });
      } else {
        views.push(view);
      }
    }
    return views;
  }

  /**
   * Mark abandoned each task whose latest line says running, or whose latest turn file is newer
   * than its latest line, and whose owner process is gone or has another start time. Signals no
   * process. Returns the marked ids.
   */
  sweep(): string[] {
    const marked: string[] = [];
    // A probe that cannot even read this process cannot tell anyone is gone.
    if (typeof this.probe.startTime(process.pid) !== 'string') return marked;
    for (const line of this.readLatest().values()) {
      try {
        if (this.abandonIfGone(line)) marked.push(line.taskId);
      } catch (err) {
        // One task that cannot be read or marked must not keep the sweep from the others.
        this.warn(`the sweep could not check ${line.taskId}: ${(err as Error).message}`);
      }
    }
    return marked;
  }

  /** Mark one task abandoned when its owner process is gone; true when it was marked. */
  private abandonIfGone(line: IndexLine): boolean {
    const latest = this.latestTurn(line.taskId);
    // A turn that settled is nobody's to abandon; the owner of a running turn is the one in its turn file.
    if (latest?.result !== undefined) return false;
    // A process that died between claiming a turn and writing its running line left only the turn file.
    const unindexed = (indexed: IndexLine) => latest !== null && latest.turn > (indexed.turn ?? 1);
    if (line.status !== 'running' && !unindexed(line)) return false;
    const owner = latest?.owner ?? line.owner;
    if (owner === undefined) return false;
    // A probe that cannot tell (undefined) never marks a task, and a live owner keeps its task.
    if (this.ownerAlive(owner) !== false) return false;

    // Read again just before appending: the owner may have settled meanwhile, or another
    // process may have taken the task over by claiming a newer turn.
    const now = this.readLatest().get(line.taskId);
    if (now === undefined || (now.status !== 'running' && !unindexed(now))) return false;
    const fresh = this.latestTurn(line.taskId);
    if (fresh?.result !== undefined || fresh?.turn !== latest?.turn) return false;
    this.appendIndex({
      taskId: line.taskId,
      agent: line.agent,
      status: 'abandoned',
      ...(now.parentSessionId !== undefined ? { parentSessionId: now.parentSessionId } : {}),
      childSession: line.taskId,
      ...sessionField(now.sessionFile ?? this.findSessionFile(line.taskId)),
      createdAt: now.createdAt,
      updatedAt: new Date().toISOString(),
      // The turn it abandons, so that a turn file with no running line is marked once.
      ...(latest !== null ? { turn: latest.turn } : {}),
    });
    return true;
  }
}

/** The messages a turn handed to steering after its prompt, from its turn file. */
function heldAfterPrompt(turn: TurnFile): string[] {
  const held = turn.heldMessages ?? [];
  // A turn opened for held messages prompts with its first and holds the rest, which its file lists.
  if (turn.viaHeld === true) return held;
  const all = [...(turn.replayed ?? []), ...(turn.message !== undefined ? [turn.message] : [])];
  // A turn that starts again with its brief holds every message; one that resumes a session prompts with the first.
  return [...(turn.briefPrompt === true ? all : all.slice(1)), ...held];
}

function sessionField(sessionFile: string | undefined): { sessionFile?: string } {
  return sessionFile !== undefined ? { sessionFile } : {};
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Write to a temporary file and rename it, so a reader never sees part of it. */
function writeAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}
