import type { ChildRecord, ChildEvent, EngineFactory, EventInput, ModelMetadata, RunRecord, Store, TemplateDefinition, Worker, WorkerEvent, WorkerTerminal } from '../src/types.ts';

export const template: TemplateDefinition = {
  id: 'researcher', description: 'Read only research assistant', instructions: 'Read and summarize.',
  tools: [{ name: 'read_file', writable: false }], skills: [], mcpServers: [], writeCapable: false,
};

export const coderTemplate: TemplateDefinition = {
  id: 'coder', description: 'Coding assistant', instructions: 'Make code changes.',
  tools: [{ name: 'read_file', writable: false }, { name: 'write_file', writable: true }], skills: [], mcpServers: [], writeCapable: true,
};

export const tooManyToolsTemplate: TemplateDefinition = {
  id: 'too-many-tools', description: 'Invalid large grants', instructions: 'No.',
  tools: Array.from({ length: 65 }, (_, index) => ({ name: `tool-${index}`, writable: false })), skills: [], mcpServers: [], writeCapable: false,
};

export function ids() {
  let child = 0;
  let run = 0;
  return { child: () => `child-${++child}`, run: () => `run-${++run}`, token: () => `owner-${child}-${run}` };
}

class AsyncEvents<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;
  push(value: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }
  end() {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>(resolve => this.waiters.push(resolve));
      },
      return: async () => { this.end(); return { value: undefined, done: true }; },
    };
  }
}

export class ControlledRun {
  readonly events = new AsyncEvents<WorkerEvent>();
  readonly settled: Promise<void>;
  readonly input: { runId: string; prompt: string; fromCheckpointId?: string };
  stopCalls = 0;
  private settle!: () => void;
  constructor(input: { runId: string; prompt: string; fromCheckpointId?: string }) {
    this.input = input;
    this.settled = new Promise(resolve => { this.settle = resolve; });
  }
  emit(event: WorkerEvent) { this.events.push(event); }
  complete(result: { checkpointId: string; artifactId: string; preview: string }) {
    this.events.push({ type: 'completed', ...result });
    this.events.end();
    this.settle();
  }
  fail(code: string, message?: string) {
    this.events.push({ type: 'failed', code, message });
    this.events.end();
    this.settle();
  }
  stop() {
    this.stopCalls++;
    this.events.push({ type: 'stopped' });
    this.events.end();
    this.settle();
  }
}

export class ControlledEngineFactory implements EngineFactory {
  opened: Array<{ templateSnapshot: ChildRecord['templateSnapshot']; model: ModelMetadata }> = [];
  runs: ControlledRun[] = [];
  failClose = false;
  closeGate?: Promise<void>;
  closeStarted?: Promise<void>;
  private releaseCloseGate?: () => void;
  private signalCloseStarted?: () => void;
  holdNextClose() {
    this.closeGate = new Promise(resolve => { this.releaseCloseGate = resolve; });
    this.closeStarted = new Promise(resolve => { this.signalCloseStarted = resolve; });
  }
  finishClose() { this.releaseCloseGate?.(); }
  steerable = false;
  steered: string[] = [];
  async open(input: Parameters<EngineFactory['open']>[0]): Promise<Worker> {
    this.opened.push({ templateSnapshot: input.templateSnapshot, model: input.model });
    return {
      capabilities: { steer: this.steerable },
      run: (runInput) => {
        const controlled = new ControlledRun(runInput);
        this.runs.push(controlled);
        return controlled.events;
      },
      steer: async (message) => {
        if (!this.steerable) throw new Error('not supported');
        this.steered.push(message);
      },
      stop: async () => {
        const running = this.runs.at(-1);
        running?.stop();
        return { confirmed: true };
      },
      close: async () => { this.signalCloseStarted?.(); await this.closeGate; return { exitConfirmed: !this.failClose }; },
    };
  }
  async validateCheckpoint(): Promise<void> {}
}

type Row = { child: ChildRecord; runs: RunRecord[]; events: ChildEvent[]; nextSeq: number; queue: RunRecord[]; ownerToken?: string };

export class FakeStore implements Store {
  private rows = new Map<string, Row>();
  private templates = new Map<string, TemplateDefinition>();
  private listeners = new Map<string, Set<(event: ChildEvent) => void>>();
  private settleGate?: Promise<void>;
  private releaseSettle?: () => void;
  private settleStartedResolve?: () => void;
  settleStarted?: Promise<void>;
  holdNextSettle() {
    this.settleGate = new Promise(resolve => { this.releaseSettle = resolve; });
    this.settleStarted = new Promise(resolve => { this.settleStartedResolve = resolve; });
  }
  finishSettle() { this.releaseSettle?.(); }
  async createChild(child: ChildRecord, run: RunRecord, event: EventInput, limits: Parameters<Store['createChild']>[3]) {
    if ([...this.rows.values()].filter(row => row.child.workspaceRoot === child.workspaceRoot && (row.child.state === 'running' || row.ownerToken !== undefined)).length >= limits.activeWorkersPerWorkspace) return { kind: 'workspace_busy' as const };
    if (child.templateSnapshot.writeCapable && [...this.rows.values()].filter(row => row.child.workspaceRoot === child.workspaceRoot && row.child.templateSnapshot.writeCapable && (row.child.state === 'running' || row.ownerToken !== undefined)).length >= limits.writeRunsPerWorkspace) return { kind: 'workspace_busy' as const };
    const token = `lease-${child.childId}`;
    child.ownerGeneration = 1;
    child.state = 'running';
    child.activeRunId = run.runId;
    const row = { child, runs: [run], events: [] as ChildEvent[], nextSeq: 1, queue: [], ownerToken: token };
    this.rows.set(child.childId, row);
    this.push(child.childId, row, event);
    return { kind: 'started' as const, lease: { ownerToken: token, generation: 1 } };
  }
  async getChild(id: string) { return this.rows.get(id)?.child; }
  async listChildren(workspaceRoot?: string) { return [...this.rows.values()].map(row => row.child).filter(child => !workspaceRoot || child.workspaceRoot === workspaceRoot); }
  async putTemplate(template: TemplateDefinition) { this.templates.set(template.id, structuredClone(template)); }
  async getTemplate(id: string) { const template = this.templates.get(id); return template && structuredClone(template); }
  async listTemplates() { return [...this.templates.values()].map(template => structuredClone(template)); }
  async admitRun(id: string, run: RunRecord, limits: Parameters<Store['admitRun']>[2], expectedGeneration?: number) {
    const row = this.rows.get(id);
    if (!row) return { kind: 'not_found' as const };
    if (expectedGeneration !== undefined && row.child.ownerGeneration !== expectedGeneration) return { kind: 'busy' as const };
    if (row.child.state === 'running') {
      row.queue.push(run);
      row.runs.push(run);
      this.push(id, row, { childId: id, runId: run.runId, at: run.createdAt, type: 'run_queued' });
      return { kind: 'queued' as const };
    }
    if (row.ownerToken) return { kind: 'recovery_required' as const };
    if ([...this.rows.values()].filter(other => other.child.workspaceRoot === row.child.workspaceRoot && other.child.state === 'running').length >= limits.activeWorkersPerWorkspace) return { kind: 'workspace_busy' as const };
    if (row.child.templateSnapshot.writeCapable && [...this.rows.values()].filter(other => other.child.workspaceRoot === row.child.workspaceRoot && other.child.templateSnapshot.writeCapable && (other.child.state === 'running' || other.ownerToken !== undefined)).length >= limits.writeRunsPerWorkspace) return { kind: 'workspace_busy' as const };
    const token = `lease-${id}`;
    row.ownerToken = token;
    row.child.ownerGeneration++;
    row.child.state = 'running';
    row.child.activeRunId = run.runId;
    row.runs.push(run);
    this.push(id, row, { childId: id, runId: run.runId, at: run.createdAt, type: 'run_started' });
    return { kind: 'started' as const, lease: { ownerToken: token, generation: row.child.ownerGeneration } };
  }
  async settleRun(id: string, runId: string, ownerToken: string, terminal: WorkerTerminal, event: EventInput, _limits: Parameters<Store['settleRun']>[5], workerExitConfirmed: boolean) {
    this.settleStartedResolve?.();
    await this.settleGate;
    const row = this.rows.get(id);
    if (!row || row.ownerToken !== ownerToken || row.child.activeRunId !== runId) return { kind: 'stale' as const };
    const run = row.runs.find(item => item.runId === runId)!;
    run.status = workerExitConfirmed ? terminal.type : 'interrupted';
    const effectiveTerminal = workerExitConfirmed ? terminal.type : 'interrupted';
    if (effectiveTerminal !== 'completed') {
      for (const queued of row.queue.splice(0)) {
        queued.status = 'stopped';
        queued.errorCode = `previous_run_${effectiveTerminal}`;
        const queuedEvent: EventInput = effectiveTerminal === 'interrupted'
          ? { at: event.at, childId: id, runId: queued.runId, type: 'interrupted', code: 'previous_run_interrupted' }
          : { at: event.at, childId: id, runId: queued.runId, type: 'failed', code: `previous_run_${effectiveTerminal}` };
        this.push(id, row, queuedEvent);
      }
    }
    if (!workerExitConfirmed) {
      row.child.state = 'interrupted';
      row.child.activeRunId = undefined;
      this.push(id, row, { at: event.at, childId: id, runId, type: 'interrupted', code: 'worker_exit_unconfirmed' });
      return { kind: 'recovery_required' as const };
    }
    if (terminal.type === 'completed') {
      row.child.lastCompletedLeaf = terminal.checkpointId;
      row.child.lastResult = { artifactId: terminal.artifactId, preview: terminal.preview };
    }
    row.child.activeRunId = undefined;
    this.push(id, row, event);
    const next = row.queue.shift();
    if (next && terminal.type === 'completed') {
      row.child.activeRunId = next.runId;
      row.child.state = 'running';
      this.push(id, row, { childId: id, runId: next.runId, at: event.at, type: 'run_started' });
      return { kind: 'next' as const, run: next };
    }
    row.child.state = 'ready';
    row.ownerToken = undefined;
    return { kind: 'idle' as const };
  }
  async requestStop(id: string, expectedRunId: string, ownerToken?: string, at: string = new Date().toISOString()) {
    const row = this.rows.get(id);
    if (!row) return { kind: 'not_found' as const };
    const run = row.runs.find(item => item.runId === expectedRunId);
    if (!run) return { kind: 'stale' as const };
    if (row.ownerToken && row.child.state === 'interrupted') return { kind: 'recovery_required' as const };
    if (row.child.activeRunId !== expectedRunId) return ['completed', 'failed', 'interrupted', 'stopped'].includes(run.status) ? { kind: 'already_terminal' as const } : { kind: 'stale' as const };
    if (!ownerToken || row.ownerToken !== ownerToken) return { kind: 'busy' as const };
    const active = row.runs.find(run => run.runId === expectedRunId)!;
    if (active.status !== 'stop_requested') {
      for (const queued of row.queue.splice(0)) {
        queued.status = 'stopped';
        queued.errorCode = 'previous_run_stopped';
        this.push(id, row, { at, childId: id, runId: queued.runId, type: 'failed', code: 'previous_run_stopped' });
      }
      active.status = 'stop_requested';
      this.push(id, row, { at, childId: id, runId: expectedRunId, type: 'stop_requested' });
    }
    return { kind: 'requested' as const };
  }
  async appendEvent(id: string, event: EventInput) {
    const row = this.rows.get(id);
    if (!row) throw new Error('missing child');
    return this.push(id, row, event);
  }
  async readEvents(id: string, after: number, limit: number) {
    const events = this.rows.get(id)?.events ?? [];
    const oldestCursor = events[0]?.seq ?? 0;
    const selected = events.filter(event => event.seq > after).slice(0, limit);
    return { events: selected, oldestCursor, nextCursor: selected.at(-1)?.seq ?? after, cursorGap: after < oldestCursor - 1 };
  }
  async subscribe(id: string, after: number, signal?: AbortSignal): Promise<AsyncIterable<ChildEvent>> {
    const self = this;
    return { async *[Symbol.asyncIterator]() {
      let cursor = after;
      while (!signal?.aborted) {
        const page = await self.readEvents(id, cursor, 50);
        for (const event of page.events) { cursor = event.seq; yield event; }
        await new Promise<void>(resolve => {
          const set = self.listeners.get(id) ?? new Set();
          self.listeners.set(id, set);
          const done = () => { set.delete(onEvent); signal?.removeEventListener('abort', done); resolve(); };
          const onEvent = (event: ChildEvent) => { if (event.seq > cursor) done(); };
          set.add(onEvent);
          signal?.addEventListener('abort', done, { once: true });
        });
      }
    } };
  }
  async validateResume(id: string) { const row = this.rows.get(id); if (!row) return { kind: 'not_found' as const }; if (row.child.state === 'running') return { kind: 'busy' as const }; if (row.ownerToken) return { kind: 'recovery_required' as const }; return { kind: 'ready' as const, child: structuredClone(row.child), generation: row.child.ownerGeneration }; }
  async commitResume(id: string, expectedGeneration: number, model: ModelMetadata) { const row = this.rows.get(id); if (!row) return { kind: 'not_found' as const }; if (row.child.ownerGeneration !== expectedGeneration) return { kind: 'busy' as const }; if (row.child.state === 'running') return { kind: 'busy' as const }; if (row.ownerToken) return { kind: 'recovery_required' as const }; row.child.model = model; row.child.ownerGeneration++; return { kind: 'committed' as const, child: row.child }; }
  claimForOtherBroker(id: string) { const row = this.rows.get(id); if (row) { row.child.ownerGeneration++; row.ownerToken = 'other-broker'; row.child.state = 'running'; } }
  async pruneEvents(id: string, retain: number) { const row = this.rows.get(id); if (row) row.events = row.events.slice(-retain); }
  async dump() { return [...this.rows.values()].map(row => ({ child: row.child, runs: row.runs, events: row.events })); }
  async dumpRuns(id: string) { return structuredClone(this.rows.get(id)?.runs ?? []); }
  private push(id: string, row: Row, event: EventInput) {
    const next: ChildEvent = { ...event, seq: row.nextSeq++ } as ChildEvent;
    row.events.push(next);
    for (const listener of this.listeners.get(id) ?? []) listener(next);
    return next;
  }
}

export { coderTemplate as coder, tooManyToolsTemplate as tooManyTools };
