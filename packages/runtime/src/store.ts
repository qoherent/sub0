import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  Admission, ChildEvent, ChildId, ChildRecord, CoreLimits, EventInput, ModelMetadata,
  RunId, RunRecord, Store, TemplateDefinition, WorkerTerminal,
} from '@subzero/core';

type StoreOptions = { brokerId?: string; eventRetention?: number; pollIntervalMs?: number };
type ChildRow = {
  child_id: string; workspace_root: string; state: ChildRecord['state']; template_snapshot: string; model: string;
  active_run_id: string | null; last_completed_leaf: string | null; last_result: string | null;
  owner_broker: string | null; owner_token: string | null; owner_generation: number; ownership_state: string;
  created_at: string; updated_at: string;
};
type RunRow = { run_id: string; child_id: string; prompt: string; status: RunRecord['status']; created_at: string; result: string | null; error_code: string | null };
type EventRow = { seq: number; at: string; child_id: string; run_id: string | null; type: string; payload: string };

/** Durable SQLite metadata store. A store instance represents one broker identity. */
export class SQLiteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly brokerId: string;
  private readonly eventRetention: number;
  private readonly pollIntervalMs: number;
  private closed = false;

  constructor(path: string, options: StoreOptions = {}) {
    this.brokerId = options.brokerId ?? randomUUID();
    this.eventRetention = integerOption(options.eventRetention, 1000, 'eventRetention');
    this.pollIntervalMs = integerOption(options.pollIntervalMs, 25, 'pollIntervalMs');
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS children (
        child_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL, state TEXT NOT NULL,
        template_snapshot TEXT NOT NULL, model TEXT NOT NULL, active_run_id TEXT,
        last_completed_leaf TEXT, last_result TEXT, owner_broker TEXT, owner_token TEXT,
        owner_generation INTEGER NOT NULL, ownership_state TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS children_workspace ON children(workspace_root);
      CREATE TABLE IF NOT EXISTS runs (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL UNIQUE,
        child_id TEXT NOT NULL REFERENCES children(child_id), prompt TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, result TEXT, error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_child ON runs(child_id, ordinal);
      CREATE TABLE IF NOT EXISTS templates (template_id TEXT PRIMARY KEY, definition TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        child_id TEXT NOT NULL REFERENCES children(child_id), seq INTEGER NOT NULL,
        at TEXT NOT NULL, run_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(child_id, seq)
      );
    `);
  }

  async close(): Promise<void> {
    if (!this.closed) { this.closed = true; this.db.close(); }
  }

  async createChild(child: ChildRecord, run: RunRecord, event: EventInput, limits: CoreLimits): Promise<Admission> {
    return this.transaction(() => {
      const cap = this.capacity(child.workspaceRoot, child.templateSnapshot.writeCapable, limits);
      if (!cap) return { kind: 'workspace_busy' };
      if (this.childRow(child.childId)) throw new Error(`Child already exists: ${child.childId}`);
      const ownerToken = randomUUID();
      const now = event.at;
      this.db.prepare(`INSERT INTO children
        (child_id, workspace_root, state, template_snapshot, model, active_run_id, last_completed_leaf, last_result,
         owner_broker, owner_token, owner_generation, ownership_state, created_at, updated_at)
        VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, 1, 'owned', ?, ?)`)
        .run(child.childId, child.workspaceRoot, json(child.templateSnapshot), json(child.model), run.runId,
          child.lastCompletedLeaf ?? null, child.lastResult ? json(child.lastResult) : null,
          this.brokerId, ownerToken, child.createdAt, now);
      this.insertRun(run, 'running');
      this.insertEvent(event);
      return { kind: 'started', lease: { ownerToken, generation: 1 } };
    });
  }

  async getChild(childId: ChildId): Promise<ChildRecord | undefined> {
    const row = this.childRow(childId);
    return row ? childFromRow(row) : undefined;
  }

  async listChildren(workspaceRoot?: string): Promise<ChildRecord[]> {
    const rows = workspaceRoot === undefined
      ? this.db.prepare('SELECT * FROM children ORDER BY created_at, child_id').all() as unknown as ChildRow[]
      : this.db.prepare('SELECT * FROM children WHERE workspace_root = ? ORDER BY created_at, child_id').all(workspaceRoot) as unknown as ChildRow[];
    return rows.map(childFromRow);
  }

  async putTemplate(template: TemplateDefinition): Promise<void> {
    this.db.prepare('INSERT INTO templates(template_id, definition) VALUES (?, ?) ON CONFLICT(template_id) DO UPDATE SET definition = excluded.definition')
      .run(template.id, json(template));
  }

  async getTemplate(templateId: string): Promise<TemplateDefinition | undefined> {
    const row = this.db.prepare('SELECT definition FROM templates WHERE template_id = ?').get(templateId) as { definition: string } | undefined;
    return row ? parse<TemplateDefinition>(row.definition) : undefined;
  }

  async listTemplates(): Promise<TemplateDefinition[]> {
    return (this.db.prepare('SELECT definition FROM templates ORDER BY template_id').all() as { definition: string }[]).map(row => parse<TemplateDefinition>(row.definition));
  }

  async admitRun(childId: ChildId, run: RunRecord, limits: CoreLimits, expectedGeneration?: number): Promise<Admission> {
    return this.transaction(() => {
      const row = this.childRow(childId);
      if (!row) return { kind: 'not_found' };
      if (expectedGeneration !== undefined && row.owner_generation !== expectedGeneration) return { kind: 'busy' };
      if (row.ownership_state === 'recovery_required') return { kind: 'recovery_required' };
      if (row.ownership_state === 'owned') {
        if (row.owner_broker !== this.brokerId) return { kind: 'recovery_required' };
        if (!row.active_run_id || row.state !== 'running') return { kind: 'recovery_required' };
        this.insertRun(run, 'queued');
        this.insertEvent({ childId, runId: run.runId, at: run.createdAt, type: 'run_queued' });
        return { kind: 'queued' };
      }
      const writeCapable = parse<TemplateDefinition>(row.template_snapshot).writeCapable;
      if (!this.capacity(row.workspace_root, writeCapable, limits)) return { kind: 'workspace_busy' };
      const token = randomUUID();
      const generation = row.owner_generation + 1;
      const now = run.createdAt;
      this.db.prepare(`UPDATE children SET state = 'running', active_run_id = ?, owner_broker = ?, owner_token = ?,
        owner_generation = ?, ownership_state = 'owned', updated_at = ? WHERE child_id = ? AND ownership_state = 'none'`)
        .run(run.runId, this.brokerId, token, generation, now, childId);
      this.insertRun(run, 'running');
      this.insertEvent({ childId, runId: run.runId, at: run.createdAt, type: 'run_started' });
      return { kind: 'started', lease: { ownerToken: token, generation } };
    });
  }

  async settleRun(childId: ChildId, runId: RunId, ownerToken: string, terminal: WorkerTerminal, event: EventInput, limits: CoreLimits, workerExitConfirmed: boolean) {
    void limits;
    return this.transaction(() => {
      const row = this.childRow(childId);
      if (!row || row.owner_token !== ownerToken || row.active_run_id !== runId || row.ownership_state !== 'owned') return { kind: 'stale' as const };
      if (!workerExitConfirmed) {
        this.updateRun(runId, 'interrupted', undefined, 'worker_exit_unconfirmed');
        this.cancelQueuedRuns(childId, 'interrupted', event.at);
        this.db.prepare(`UPDATE children SET state = 'interrupted', active_run_id = NULL, ownership_state = 'recovery_required', updated_at = ? WHERE child_id = ?`)
          .run(event.at, childId);
        this.insertEvent({ ...event, type: 'interrupted', code: 'worker_exit_unconfirmed' });
        return { kind: 'recovery_required' as const };
      }

      const runStatus = terminal.type;
      this.updateRun(runId, runStatus, terminal.type === 'completed' ? { artifactId: terminal.artifactId, preview: terminal.preview } : undefined,
        terminal.type === 'failed' || terminal.type === 'interrupted' ? terminal.code : undefined);
      const completed = terminal.type === 'completed';
      if (!completed) this.cancelQueuedRuns(childId, terminal.type, event.at);
      const next = completed ? this.db.prepare("SELECT * FROM runs WHERE child_id = ? AND status = 'queued' ORDER BY ordinal LIMIT 1").get(childId) as RunRow | undefined : undefined;
      if (completed) {
        this.db.prepare(`UPDATE children SET last_completed_leaf = ?, last_result = ?, active_run_id = ?, state = ?, updated_at = ? WHERE child_id = ?`)
          .run(terminal.checkpointId, json({ artifactId: terminal.artifactId, preview: terminal.preview }), next?.run_id ?? null,
            next ? 'running' : 'ready', event.at, childId);
      } else {
        this.db.prepare(`UPDATE children SET active_run_id = ?, state = ?, updated_at = ? WHERE child_id = ?`)
          .run(next?.run_id ?? null, next ? 'running' : terminal.type === 'interrupted' ? 'interrupted' : 'ready', event.at, childId);
      }
      this.insertEvent(event);
      if (next) {
        this.db.prepare("UPDATE runs SET status = 'running' WHERE run_id = ?").run(next.run_id);
        this.insertEvent({ childId, runId: next.run_id, at: event.at, type: 'run_started' });
        return { kind: 'next' as const, run: runFromRow({ ...next, status: 'running' }) };
      }
      this.db.prepare(`UPDATE children SET owner_broker = NULL, owner_token = NULL, ownership_state = 'none' WHERE child_id = ?`).run(childId);
      return { kind: 'idle' as const };
    });
  }

  async requestStop(childId: ChildId, expectedRunId: RunId, ownerToken?: string, at: string = new Date().toISOString()) {
    return this.transaction(() => {
      const child = this.childRow(childId);
      if (!child) return { kind: 'not_found' as const };
      const run = this.db.prepare('SELECT status FROM runs WHERE child_id = ? AND run_id = ?').get(childId, expectedRunId) as { status: RunRecord['status'] } | undefined;
      if (!run) return { kind: 'stale' as const };
      if (child.ownership_state === 'recovery_required') return { kind: 'recovery_required' as const };
      if (child.active_run_id !== expectedRunId) return terminalStatus(run.status) ? { kind: 'already_terminal' as const } : { kind: 'stale' as const };
      if (!ownerToken || child.owner_token !== ownerToken || child.ownership_state !== 'owned') return { kind: 'busy' as const };
      this.cancelQueuedRuns(childId, 'stopped', at);
      if (run.status !== 'stop_requested') {
        this.db.prepare("UPDATE runs SET status = 'stop_requested' WHERE run_id = ?").run(expectedRunId);
        this.insertEvent({ at, childId, runId: expectedRunId, type: 'stop_requested' });
      }
      return { kind: 'requested' as const };
    });
  }

  async appendEvent(childId: ChildId, event: EventInput): Promise<ChildEvent> {
    return this.transaction(() => {
      if (!this.childRow(childId)) throw new Error(`Child not found: ${childId}`);
      if (event.childId !== childId) throw new Error('Event childId does not match target child.');
      return this.insertEvent(event);
    });
  }

  async readEvents(childId: ChildId, afterCursor: number, limit: number) {
    if (!Number.isInteger(afterCursor) || afterCursor < 0 || !Number.isInteger(limit) || limit < 1) throw new RangeError('Invalid event cursor or limit.');
    const exists = this.db.prepare('SELECT 1 AS found FROM children WHERE child_id = ?').get(childId);
    if (!exists) throw new Error(`Child not found: ${childId}`);
    const row = this.db.prepare('SELECT MIN(seq) AS oldest, MAX(seq) AS latest FROM events WHERE child_id = ?').get(childId) as { oldest: number | null; latest: number | null };
    const oldestCursor = row.oldest ?? 0;
    const selected = this.db.prepare('SELECT * FROM events WHERE child_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(childId, afterCursor, limit) as unknown as EventRow[];
    const events = selected.map(eventFromRow);
    return { events, oldestCursor, nextCursor: events.at(-1)?.seq ?? afterCursor, cursorGap: oldestCursor > 0 && afterCursor < oldestCursor - 1 };
  }

  async subscribe(childId: ChildId, afterCursor: number, signal?: AbortSignal): Promise<AsyncIterable<ChildEvent>> {
    if (!this.childRow(childId)) throw new Error(`Child not found: ${childId}`);
    const self = this;
    return { async *[Symbol.asyncIterator]() {
      let cursor = afterCursor;
      while (!signal?.aborted && !self.closed) {
        const page = await self.readEvents(childId, cursor, 100);
        for (const event of page.events) {
          if (signal?.aborted) return;
          cursor = event.seq;
          yield event;
        }
        if (!signal?.aborted) await delay(self.pollIntervalMs, undefined, { signal }).catch(error => {
          if ((error as { name?: string }).name !== 'AbortError') throw error;
        });
      }
    } };
  }

  async hasArtifactInWorkspace(workspaceRoot: string, artifactId: string): Promise<boolean> {
    return this.db.prepare("SELECT 1 AS found FROM runs JOIN children ON runs.child_id = children.child_id WHERE children.workspace_root = ? AND json_extract(runs.result, '$.artifactId') = ? LIMIT 1")
      .get(workspaceRoot, artifactId) !== undefined;
  }

  async validateResume(childId: ChildId) {
    const row = this.childRow(childId);
    if (!row) return { kind: 'not_found' as const };
    if (row.ownership_state === 'recovery_required') return { kind: 'recovery_required' as const };
    if (row.ownership_state === 'owned') return row.owner_broker === this.brokerId ? { kind: 'busy' as const } : { kind: 'recovery_required' as const };
    if (row.state === 'running') return { kind: 'busy' as const };
    return { kind: 'ready' as const, child: childFromRow(row), generation: row.owner_generation };
  }

  /** Clear a persisted owner only after the engine independently proves its worker group exited. */
  async recoverExitedOwner(childId: ChildId, expectedGeneration: number, expectedRunId?: string): Promise<boolean> {
    return this.transaction(() => {
      const row = this.childRow(childId);
      if (!row || row.owner_generation !== expectedGeneration || !['owned', 'recovery_required'].includes(row.ownership_state)) return false;
      if (expectedRunId && row.active_run_id && row.active_run_id !== expectedRunId) return false;
      const at = new Date().toISOString();
      if (row.active_run_id) {
        this.db.prepare("UPDATE runs SET status = 'interrupted', error_code = 'worker_interrupted' WHERE run_id = ? AND status IN ('running', 'stop_requested')").run(row.active_run_id);
        this.insertEvent({ at, childId, runId: row.active_run_id, type: 'interrupted', code: 'worker_interrupted' });
      }
      this.cancelQueuedRuns(childId, 'interrupted', at);
      this.db.prepare(`UPDATE children SET state = 'interrupted', active_run_id = NULL, owner_broker = NULL,
        owner_token = NULL, ownership_state = 'none', updated_at = ? WHERE child_id = ? AND owner_generation = ?`)
        .run(at, childId, expectedGeneration);
      return true;
    });
  }

  async commitResume(childId: ChildId, expectedGeneration: number, model: ModelMetadata) {
    return this.transaction(() => {
      const row = this.childRow(childId);
      if (!row) return { kind: 'not_found' as const };
      if (row.ownership_state === 'recovery_required') return { kind: 'recovery_required' as const };
      if (row.ownership_state === 'owned' || row.state === 'running' || row.owner_generation !== expectedGeneration) return { kind: 'busy' as const };
      this.db.prepare(`UPDATE children SET model = ?, state = 'ready', owner_generation = owner_generation + 1, updated_at = ? WHERE child_id = ? AND owner_generation = ? AND ownership_state = 'none'`)
        .run(json(model), new Date().toISOString(), childId, expectedGeneration);
      const updated = this.childRow(childId)!;
      return { kind: 'committed' as const, child: childFromRow(updated) };
    });
  }

  private capacity(workspaceRoot: string, writeCapable: boolean, limits: CoreLimits): boolean {
    const active = this.db.prepare("SELECT COUNT(*) AS count FROM children WHERE workspace_root = ? AND ownership_state IN ('owned', 'recovery_required')").get(workspaceRoot) as { count: number };
    if (active.count >= limits.activeWorkersPerWorkspace) return false;
    if (writeCapable) {
      const writers = this.db.prepare(`SELECT COUNT(*) AS count FROM children WHERE workspace_root = ? AND ownership_state IN ('owned', 'recovery_required') AND json_extract(template_snapshot, '$.writeCapable') = 1`).get(workspaceRoot) as { count: number };
      if (writers.count >= limits.writeRunsPerWorkspace) return false;
    }
    return true;
  }

  private childRow(childId: ChildId): ChildRow | undefined {
    return this.db.prepare('SELECT * FROM children WHERE child_id = ?').get(childId) as unknown as ChildRow | undefined;
  }

  private insertRun(run: RunRecord, status: RunRecord['status']): void {
    this.db.prepare('INSERT INTO runs(run_id, child_id, prompt, status, created_at, result, error_code) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(run.runId, run.childId, run.prompt, status, run.createdAt, run.result ? json(run.result) : null, run.errorCode ?? null);
  }

  private updateRun(runId: RunId, status: RunRecord['status'], result?: RunRecord['result'], errorCode?: string): void {
    this.db.prepare('UPDATE runs SET status = ?, result = ?, error_code = ? WHERE run_id = ?')
      .run(status, result ? json(result) : null, errorCode ?? null, runId);
  }

  private cancelQueuedRuns(childId: ChildId, terminal: 'stopped' | 'failed' | 'interrupted', at: string): void {
    const queued = this.db.prepare("SELECT run_id FROM runs WHERE child_id = ? AND status = 'queued' ORDER BY ordinal")
      .all(childId) as { run_id: string }[];
    const errorCode = `previous_run_${terminal}`;
    const type = terminal === 'interrupted' ? 'interrupted' : 'failed';
    const update = this.db.prepare("UPDATE runs SET status = 'stopped', error_code = ? WHERE child_id = ? AND run_id = ? AND status = 'queued'");
    for (const run of queued) {
      update.run(errorCode, childId, run.run_id);
      this.insertEvent({ childId, runId: run.run_id, at, type, code: errorCode });
    }
  }

  private insertEvent(event: EventInput): ChildEvent {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE child_id = ?').get(event.childId) as { seq: number };
    const { childId, runId, at, type, ...fields } = event;
    const full = { seq: row.seq, childId, ...(runId === undefined ? {} : { runId }), at, type, ...fields } as ChildEvent;
    const { seq: _seq, childId: _childId, runId: _runId, at: _at, type: _type, ...payload } = full;
    this.db.prepare('INSERT INTO events(child_id, seq, at, run_id, type, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(childId, full.seq, at, runId ?? null, type, json(payload));
    this.db.prepare(`DELETE FROM events WHERE child_id = ? AND seq NOT IN
      (SELECT seq FROM events WHERE child_id = ? ORDER BY seq DESC LIMIT ?)`)
      .run(childId, childId, this.eventRetention);
    return full;
  }

  private transaction<T>(fn: () => T): T {
    if (this.closed) throw new Error('SQLiteStore is closed.');
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

function childFromRow(row: ChildRow): ChildRecord {
  return {
    childId: row.child_id, workspaceRoot: row.workspace_root, state: row.state,
    templateSnapshot: parse<TemplateDefinition>(row.template_snapshot), model: parse<ModelMetadata>(row.model),
    ...(row.active_run_id === null ? {} : { activeRunId: row.active_run_id }),
    ...(row.last_completed_leaf === null ? {} : { lastCompletedLeaf: row.last_completed_leaf }),
    ...(row.last_result === null ? {} : { lastResult: parse<NonNullable<ChildRecord['lastResult']>>(row.last_result) }),
    ownerGeneration: row.owner_generation, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function runFromRow(row: RunRow): RunRecord {
  return { runId: row.run_id, childId: row.child_id, prompt: row.prompt, status: row.status, createdAt: row.created_at,
    ...(row.result ? { result: parse<NonNullable<RunRecord['result']>>(row.result) } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}) };
}
function eventFromRow(row: EventRow): ChildEvent {
  return { ...parse<Record<string, unknown>>(row.payload), seq: row.seq, at: row.at, childId: row.child_id,
    ...(row.run_id === null ? {} : { runId: row.run_id }), type: row.type } as ChildEvent;
}
function terminalStatus(status: RunRecord['status']): boolean { return ['stopped', 'completed', 'failed', 'interrupted'].includes(status); }
function integerOption(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) throw new RangeError(`${name} must be a positive integer.`);
  return result;
}
function json(value: unknown): string { return JSON.stringify(value); }
function parse<T>(value: string): T { return JSON.parse(value) as T; }
