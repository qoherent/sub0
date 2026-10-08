import type {
  Admission, ArtifactChunk, ChildId, ChildRecord, ChildSnapshot, ChildSummary, CoreLimits, EventInput,
  GetInput, ModelArgs, ModelMetadata, OwnerLease, ResumeResult, RunId, RunRecord, SubscriptionItem,
  SendInput, SpawnInput, StopResult, SubzeroOptions, TemplateDefinition, Worker, WorkerEvent, WorkerTerminal,
} from './types.ts';
export * from './types.ts';

const DEFAULT_LIMITS: CoreLimits = {
  activeWorkersPerWorkspace: 4,
  writeRunsPerWorkspace: 1,
  promptBytes: 64 * 1024,
  instructionBytes: 64 * 1024,
  grantedTools: 64,
  eventBytes: 8 * 1024,
  eventBatch: 50,
  outputPreviewBytes: 2048,
  maxWaitMs: 30_000,
};

export class SubzeroError extends Error {
  readonly code: import('./types.ts').SubzeroErrorCode;
  constructor(code: import('./types.ts').SubzeroErrorCode, message: string) {
    super(message);
    this.name = 'SubzeroError';
    this.code = code;
  }
}

type LocalWorker = { worker: Worker; lease: OwnerLease; childId: ChildId; key: string; closed: boolean; done: Promise<boolean>; finish: (exitConfirmed: boolean) => void };
type Info = {
  protocolVersion: string;
  coreVersion: string;
  worker: SubzeroOptions['worker'];
  templates: Array<{ id: string; description: string; tools: string[]; skills: string[]; mcpServers: string[]; writeCapable: boolean }>;
  configuredModelRefs: string[];
  limits: CoreLimits;
};

export function createSubzero(options: SubzeroOptions) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const templates = new Map<string, TemplateDefinition>();
  for (const item of options.templates) {
    validateTemplate(item, limits);
    templates.set(item.id, immutableSnapshot(item));
  }
  const localWorkers = new Map<ChildId, LocalWorker>();
  const pendingDispatches = new Set<Promise<void>>();
  const credentials = new Map<ChildId, ModelArgs>();
  const templateById = async (id: string): Promise<TemplateDefinition> => {
    let template = templates.get(id);
    if (!template) {
      template = await options.store.getTemplate(id);
      if (template) templates.set(id, immutableSnapshot(template));
    }
    if (!template) throw new SubzeroError('template_not_found', `Unknown template: ${id}`);
    validateTemplate(template, limits);
    return immutableSnapshot(template);
  };
  const modelMetadata = ({ url, model, api }: ModelArgs): ModelMetadata => ({ url, model, ...(api ? { api } : {}) });
  const now = () => options.clock().toISOString();
  const makeRun = (childId: ChildId, prompt: string, status: RunRecord['status'] = 'running', key?: string): RunRecord => {
    const safePrompt = redact(prompt, key);
    if (utf8Length(safePrompt) > limits.promptBytes) throw new SubzeroError('limit_exceeded', `Prompt exceeds ${limits.promptBytes} UTF-8 bytes.`);
    return { runId: options.ids.run(), childId, prompt: safePrompt, status, createdAt: now() };
  };
  const validatePrompt = (prompt: unknown) => {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new SubzeroError('invalid_request', 'Prompt/message must be a non-empty string.');
    if (utf8Length(prompt) > limits.promptBytes) throw new SubzeroError('limit_exceeded', `Prompt exceeds ${limits.promptBytes} UTF-8 bytes.`);
  };
  const validateModel = (model: ModelArgs) => {
    if (!model || typeof model.url !== 'string' || !model.url || typeof model.model !== 'string' || !model.model) throw new SubzeroError('invalid_request', 'Model URL and model name are required.');
    if (typeof model.key !== 'string' || !model.key) throw new SubzeroError('credentials_required', 'Model credentials are required.');
    if (model.api !== undefined && (typeof model.api !== 'string' || !model.api)) throw new SubzeroError('invalid_request', 'API protocol must be a non-empty string when supplied.');
  };
  const ensureNoAdmissionError = (result: Admission) => {
    if (result.kind === 'workspace_busy') throw new SubzeroError('workspace_busy', 'Workspace worker or writer limit is currently reached.');
    if (result.kind === 'recovery_required') throw new SubzeroError('recovery_required', 'The prior worker exit is unconfirmed; child ownership cannot be acquired.');
    if (result.kind === 'not_found') throw new SubzeroError('not_found', 'Child session was not found.');
    if (result.kind === 'busy') throw new SubzeroError('busy', 'Child ownership changed before the run was admitted.');
    if (result.kind === 'queued') return undefined;
    return result.lease;
  };
  const dispatch = async (child: ChildRecord, run: RunRecord, lease: OwnerLease, model: ModelArgs) => {
    const opening = dispatchWorker(child, run, lease, model);
    pendingDispatches.add(opening);
    try { await opening; } finally { pendingDispatches.delete(opening); }
  };
  const dispatchWorker = async (child: ChildRecord, run: RunRecord, lease: OwnerLease, model: ModelArgs) => {
    let entry = localWorkers.get(child.childId);
    if (entry?.closed) { localWorkers.delete(child.childId); entry = undefined; }
    if (!entry) {
      let worker: Worker;
      try {
        worker = await options.engineFactory.open({
          childId: child.childId, runId: run.runId, ownerGeneration: lease.generation,
          workspaceRoot: child.workspaceRoot, templateSnapshot: child.templateSnapshot,
          model: child.model, credential: { key: model.key },
        });
      } catch (error) {
        await settleLocal(child, run, lease, { type: 'failed', code: 'worker_start_failed', message: safeMessage(error, model.key) }, model, undefined, true);
        return;
      }
      let finish!: (exitConfirmed: boolean) => void;
      const done = new Promise<boolean>(resolve => { finish = resolve; });
      entry = { worker, lease, childId: child.childId, key: model.key, closed: false, done, finish };
      localWorkers.set(child.childId, entry);
    }
    void pump(entry, child, run, model);
  };
  const emitWorkerEvent = async (childId: ChildId, runId: RunId, event: WorkerEvent, key: string) => {
    if (event.type === 'completed' || event.type === 'stopped' || event.type === 'failed' || event.type === 'interrupted') return;
    const at = now();
    if (event.type === 'text') {
      const text = truncateUtf8(redact(event.text, key), Math.min(limits.eventBytes, 4096));
      await options.store.appendEvent(childId, { at, childId, runId, type: 'text', text });
    } else {
      const name = truncateUtf8(redact(event.name, key), 256);
      await options.store.appendEvent(childId, { at, childId, runId, type: 'tool', name, state: event.state });
    }
  };
  const pump = async (entry: LocalWorker, child: ChildRecord, run: RunRecord, model: ModelArgs) => {
    let terminal: WorkerTerminal | undefined;
    const redactor = createTextRedactor([model.key]);
    const emitText = async (text: string) => { if (text) await emitWorkerEvent(child.childId, run.runId, { type: 'text', text }, model.key); };
    try {
      for await (const event of entry.worker.run({ runId: run.runId, prompt: run.prompt, fromCheckpointId: child.lastCompletedLeaf })) {
        if (event.type === 'completed' || event.type === 'stopped' || event.type === 'failed' || event.type === 'interrupted') terminal = event;
        else if (event.type === 'text') await emitText(redactor.push(event.text));
        else await emitWorkerEvent(child.childId, run.runId, event, model.key);
      }
      await emitText(redactor.flush());
      if (!terminal) terminal = { type: 'interrupted', code: 'worker_stream_ended' };
    } catch (error) {
      await emitText(redactor.flush()).catch(() => undefined);
      terminal = { type: 'interrupted', code: 'worker_stream_failed', message: safeMessage(error, model.key) };
    }
    const closed = await closeEntry(entry);
    if (!closed) terminal = { type: 'interrupted', code: 'worker_exit_unconfirmed' };
    await settleLocal(child, run, entry.lease, terminal, model, entry, closed);
  };
  const settleLocal = async (child: ChildRecord, run: RunRecord, lease: OwnerLease, terminal: WorkerTerminal, model: ModelArgs, entry = localWorkers.get(child.childId), workerExitConfirmed = true) => {
    const safeTerminal = sanitizeTerminal(terminal, model.key, limits.outputPreviewBytes);
    const ev = terminalToEvent(child.childId, run.runId, safeTerminal, now(), limits.outputPreviewBytes);
    const settled = await options.store.settleRun(child.childId, run.runId, lease.ownerToken, safeTerminal, ev, limits, workerExitConfirmed);
    if (settled.kind === 'stale') {
      if (entry) finishEntry(entry, workerExitConfirmed);
      return;
    }
    if (settled.kind === 'recovery_required') { if (entry) finishEntry(entry, false); return; }
    if (settled.kind === 'next' && safeTerminal.type === 'completed' && workerExitConfirmed) {
      const latest = await options.store.getChild(child.childId);
      if (latest) {
        await dispatch(latest, settled.run, lease, credentials.get(child.childId) ?? model);
      }
      if (entry) finishEntry(entry, workerExitConfirmed);
      return;
    }
    if (entry) finishEntry(entry, workerExitConfirmed);
  };
  const closeEntry = async (entry: LocalWorker): Promise<boolean> => {
    try {
      const outcome = await entry.worker.close();
      entry.closed = true;
      return outcome.exitConfirmed;
    } catch { entry.closed = true; return false; }
  };
  const finishEntry = (entry: LocalWorker, exitConfirmed: boolean) => {
    if (localWorkers.get(entry.childId) === entry) localWorkers.delete(entry.childId);
    entry.finish(exitConfirmed);
  };
  const readSnapshot = async (childId: ChildId, input: GetInput = {}, signal?: AbortSignal): Promise<ChildSnapshot> => {
    signal?.throwIfAborted();
    let child = await requiredChild(childId);
    const after = nonnegativeInteger(input.cursor, 0, 'cursor');
    const eventLimit = clampInt(input.eventLimit, 1, limits.eventBatch, limits.eventBatch);
    const previewLimit = clampInt(input.previewLimit, 0, limits.outputPreviewBytes, limits.outputPreviewBytes);
    let page = await options.store.readEvents(childId, after, eventLimit);
    const waitMs = clampInt(input.waitMs, 0, limits.maxWaitMs, 0);
    if (waitMs && page.events.length === 0) {
      const abort = new AbortController();
      const forward = () => abort.abort();
      signal?.addEventListener('abort', forward, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let iterator: AsyncIterator<unknown> | undefined;
      try {
        const stream = await options.store.subscribe(childId, after, abort.signal);
        iterator = stream[Symbol.asyncIterator]();
        signal?.throwIfAborted();
        await Promise.race([iterator.next(), new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
        signal?.throwIfAborted();
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forward);
        abort.abort();
        await iterator?.return?.();
      }
      page = await options.store.readEvents(childId, after, eventLimit);
      child = await requiredChild(childId);
    }
    const result = child.lastResult ? { ...child.lastResult, preview: truncateUtf8(child.lastResult.preview, previewLimit) } : undefined;
    return {
      childId: child.childId, workspaceRoot: child.workspaceRoot, state: child.state,
      templateId: child.templateSnapshot.id, model: { ...child.model }, activeRunId: child.activeRunId,
      lastCompletedLeaf: child.lastCompletedLeaf, result, events: page.events,
      cursor: page.nextCursor, oldestCursor: page.oldestCursor, nextCursor: page.nextCursor, cursorGap: page.cursorGap,
    };
  };
  const requiredChild = async (childId: string) => {
    if (typeof childId !== 'string' || !childId) throw new SubzeroError('invalid_request', 'childId is required.');
    const child = await options.store.getChild(childId);
    if (!child) throw new SubzeroError('not_found', 'Child session was not found.');
    return child;
  };

  return {
    async info(): Promise<Info> {
      const stored = await options.store.listTemplates();
      const available = new Map([...stored, ...templates.values()].map(template => [template.id, template]));
      return {
        protocolVersion: '0.1', coreVersion: '0.1.0', worker: { ...options.worker, capabilities: [...options.worker.capabilities] },
        templates: [...available.values()].map(template => ({ id: template.id, description: template.description, tools: [...template.tools.map(tool => tool.name), ...template.mcpServers.flatMap(server => server.tools)], skills: template.skills.map(skill => skill.name), mcpServers: template.mcpServers.map(server => server.name), writeCapable: template.writeCapable })),
        configuredModelRefs: [...(options.configuredModelRefs ?? [])], limits: { ...limits },
      };
    },
    async spawn(input: SpawnInput): Promise<{ childId: ChildId; runId: RunId }> {
      strictObject(input, ['prompt', 'templateId', 'model', 'workspaceRoot'], 'spawn input');
      strictObject(input.model, ['url', 'model', 'key', 'api'], 'model');
      validatePrompt(input?.prompt);
      validateModel(input?.model);
      if (typeof input.workspaceRoot !== 'string' || !input.workspaceRoot) throw new SubzeroError('invalid_request', 'workspaceRoot is required.');
      const snapshot = await templateById(input.templateId);
      await options.store.putTemplate(snapshot);
      const childId = options.ids.child();
      const run = makeRun(childId, input.prompt, 'running', input.model.key);
      const child: ChildRecord = {
        childId, workspaceRoot: input.workspaceRoot, state: 'running', templateSnapshot: snapshot,
        model: modelMetadata(input.model), activeRunId: run.runId, ownerGeneration: 0,
        createdAt: now(), updatedAt: now(),
      };
      const admission = await options.store.createChild(child, run, { at: now(), childId, runId: run.runId, type: 'run_started' }, limits);
      const lease = ensureNoAdmissionError(admission);
      if (!lease) throw new SubzeroError('workspace_busy', 'Could not acquire worker ownership.');
      credentials.set(childId, input.model);
      await dispatch(child, run, lease, input.model);
      return { childId, runId: run.runId };
    },
    async get(childId: ChildId, input: GetInput = {}, signal?: AbortSignal) {
      strictObject(input, ['waitMs', 'cursor', 'eventLimit', 'previewLimit'], 'get input');
      return readSnapshot(childId, input, signal);
    },
    async list(workspaceRoot?: string): Promise<ChildSummary[]> {
      return (await options.store.listChildren(workspaceRoot)).map(child => ({
        childId: child.childId, workspaceRoot: child.workspaceRoot, state: child.state, model: { ...child.model },
        activeRunId: child.activeRunId, lastCompletedLeaf: child.lastCompletedLeaf, lastResult: child.lastResult ? { ...child.lastResult } : undefined,
        createdAt: child.createdAt, updatedAt: child.updatedAt, templateId: child.templateSnapshot.id,
      }));
    },
    async registerTemplate(template: TemplateDefinition): Promise<void> {
      validateTemplate(template, limits);
      const snapshot = immutableSnapshot(template);
      templates.set(snapshot.id, snapshot);
      await options.store.putTemplate(snapshot);
    },
    async send(childId: ChildId, input: SendInput): Promise<{ runId: RunId; delivery: import('./types.ts').Delivery }> {
      strictObject(input, ['mode', 'message'], 'send input');
      if (!input || (input.mode !== 'steer' && input.mode !== 'followup')) throw new SubzeroError('invalid_request', 'send requires mode "steer" or "followup".');
      validatePrompt(input.message);
      const child = await requiredChild(childId);
      const active = localWorkers.get(childId);
      if (input.mode === 'steer') {
        if (!child.activeRunId || child.state !== 'running') throw new SubzeroError('busy', 'There is no active run to steer.');
        if (!active || active.closed) throw new SubzeroError('busy', 'The active child worker is not available for steering.');
        if (!active.worker.capabilities.steer) throw new SubzeroError('unsupported_steer', 'The active worker does not support steering.');
        const key = active.key ?? credentials.get(childId)?.key;
        const safeMessage = redact(input.message, key);
        if (utf8Length(safeMessage) > limits.promptBytes) throw new SubzeroError('limit_exceeded', `Prompt exceeds ${limits.promptBytes} UTF-8 bytes.`);
        await active.worker.steer(safeMessage);
        return { runId: child.activeRunId, delivery: 'steered' };
      }
      if (child.state === 'running' && !active) throw new SubzeroError('busy', 'The active child worker is owned by another broker.');
      const model = credentials.get(childId);
      if (child.state !== 'running' && !model) throw new SubzeroError('credentials_required', 'Call resume with credentials before sending work after broker restart.');
      if (child.state !== 'running' && model && !sameModelMetadata(child.model, modelMetadata(model))) throw new SubzeroError('credentials_required', 'Saved model settings changed; resume with credentials for the current model before sending work.');
      const run = makeRun(childId, input.message, 'queued', model?.key);
      const admission = await options.store.admitRun(childId, run, limits, child.ownerGeneration);
      if (admission.kind === 'not_found') throw new SubzeroError('not_found', 'Child session was not found.');
      if (admission.kind === 'workspace_busy' || admission.kind === 'recovery_required' || admission.kind === 'busy') ensureNoAdmissionError(admission);
      if (admission.kind === 'queued') {
        return { runId: run.runId, delivery: 'queued' };
      }
      if (admission.kind !== 'started') { ensureNoAdmissionError(admission); throw new SubzeroError('busy', 'Could not acquire a worker for this run.'); }
      const lease = admission.lease;
      await dispatch(child, run, lease, model!);
      return { runId: run.runId, delivery: 'started' };
    },
    async stop(childId: ChildId, expectedRunId: RunId): Promise<StopResult> {
      const child = await requiredChild(childId);
      if (typeof expectedRunId !== 'string' || !expectedRunId) throw new SubzeroError('invalid_request', 'expectedRunId is required.');
      const entry = localWorkers.get(childId);
      if (child.activeRunId && child.activeRunId !== expectedRunId) throw new SubzeroError('stale_run', 'expectedRunId does not identify the active run.');
      if (child.activeRunId === expectedRunId && (!entry || entry.closed)) throw new SubzeroError('busy', 'The active child worker is owned by another broker.');
      const outcome = await options.store.requestStop(childId, expectedRunId, entry?.lease.ownerToken, now());
      if (outcome.kind === 'stale') throw new SubzeroError('stale_run', 'expectedRunId does not identify the active run.');
      if (outcome.kind === 'busy') throw new SubzeroError('busy', 'Child worker ownership changed before stop admission.');
      if (outcome.kind === 'not_found') throw new SubzeroError('not_found', 'Child session was not found.');
      if (outcome.kind === 'recovery_required') throw new SubzeroError('recovery_required', 'Prior worker termination is unconfirmed.');
      if (outcome.kind === 'already_terminal') return { requested: false, confirmed: true };
      const stopped = await entry!.worker.stop(expectedRunId);
      if (stopped.confirmed) {
        const exitConfirmed = await entry!.done;
        return { requested: true, confirmed: exitConfirmed };
      }
      return { requested: true, confirmed: false };
    },
    async resume(childId: ChildId, model: ModelArgs, message?: string): Promise<ResumeResult> {
      strictObject(model, ['url', 'model', 'key', 'api'], 'model');
      validateModel(model);
      if (message !== undefined) validatePrompt(message);
      const claim = await options.store.validateResume(childId);
      if (claim.kind === 'not_found') throw new SubzeroError('not_found', 'Child session was not found.');
      if (claim.kind === 'busy') throw new SubzeroError('busy', 'Child is owned by another broker.');
      if (claim.kind === 'recovery_required') throw new SubzeroError('recovery_required', 'Prior worker termination is unconfirmed.');
      const child = claim.child;
      const leaf = child.lastCompletedLeaf;
      if (leaf) {
        try { await options.engineFactory.validateCheckpoint({ childId, checkpointId: leaf, templateSnapshot: child.templateSnapshot, model: modelMetadata(model), credential: { key: model.key } }); }
        catch { throw new SubzeroError('checkpoint_incompatible', 'The exact last completed checkpoint cannot be loaded.'); }
      }
      const commit = await options.store.commitResume(childId, claim.generation, modelMetadata(model));
      if (commit.kind === 'not_found') throw new SubzeroError('not_found', 'Child session was not found.');
      if (commit.kind === 'busy') throw new SubzeroError('busy', 'Child ownership changed while validating resume.');
      if (commit.kind === 'recovery_required') throw new SubzeroError('recovery_required', 'Prior worker termination is unconfirmed.');
      const committedChild = commit.child;
      credentials.set(childId, model);
      if (message === undefined) return { state: 'ready', childId };
      const run = makeRun(childId, message, 'running', model.key);
      const admission = await options.store.admitRun(childId, run, limits, committedChild.ownerGeneration);
      if (admission.kind !== 'started') { ensureNoAdmissionError(admission); throw new SubzeroError('busy', 'Child could not be claimed for resume.'); }
      const lease = admission.lease;
      await dispatch({ ...committedChild, state: 'running', activeRunId: run.runId }, run, lease, model);
      return { state: 'running', childId, runId: run.runId };
    },
    subscribe(childId: ChildId, cursor = 0): AsyncIterable<SubscriptionItem> {
      if (!Number.isInteger(cursor) || cursor < 0) throw new SubzeroError('invalid_request', 'cursor must be a non-negative integer.');
      return { async *[Symbol.asyncIterator]() {
        await requiredChild(childId);
        const initial = await options.store.readEvents(childId, cursor, 1);
        if (initial.cursorGap) yield { type: 'cursor_gap', requestedCursor: cursor, oldestCursor: initial.oldestCursor };
        yield* await options.store.subscribe(childId, cursor);
      } };
    },
    async readArtifact(artifactId: string, offset = 0, length = 4096): Promise<ArtifactChunk> {
      if (!options.artifactReader) throw new SubzeroError('artifact_unavailable', 'Artifact reading is not configured.');
      if (typeof artifactId !== 'string' || !artifactId || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > 64 * 1024) throw new SubzeroError('invalid_request', 'Artifact id, offset, or length is invalid.');
      return options.artifactReader(artifactId, offset, length);
    },
    async shutdown(): Promise<void> {
      const stopOwnedWorkers = async () => {
        for (const [childId, entry] of [...localWorkers]) {
          if (entry.closed) continue;
          const child = await options.store.getChild(childId);
          if (!child?.activeRunId) continue;
          const runId = child.activeRunId;
          const requested = await options.store.requestStop(childId, runId, entry.lease.ownerToken, now());
          if (requested.kind !== 'requested') continue;
          const stopped = await entry.worker.stop(runId);
          if (!stopped.confirmed) continue;
          await entry.done;
        }
      };
      await stopOwnedWorkers();
      await Promise.allSettled([...pendingDispatches]);
      await stopOwnedWorkers();
      await Promise.allSettled([...pendingDispatches]);
    },
  };
}

function validateTemplate(template: TemplateDefinition, limits: CoreLimits) {
  strictObject(template, ['id', 'description', 'instructions', 'tools', 'skills', 'mcpServers', 'writeCapable', 'workerAdapter', 'workerVersion'], 'template');
  if (!template.id || !template.description || typeof template.instructions !== 'string' || typeof template.writeCapable !== 'boolean' || !Array.isArray(template.tools) || !Array.isArray(template.skills) || !Array.isArray(template.mcpServers)) throw new SubzeroError('invalid_request', 'Template definition is incomplete.');
  if (utf8Length(template.instructions) > limits.instructionBytes) throw new SubzeroError('limit_exceeded', 'Template instructions exceed the configured UTF-8 byte limit.');
  template.tools.forEach(tool => strictObject(tool, ['name', 'writable'], 'tool grant'));
  template.skills.forEach(skill => strictObject(skill, ['name', 'content'], 'skill snapshot'));
  template.mcpServers.forEach(server => strictObject(server, ['name', 'command', 'args', 'envRefs', 'tools', 'writeCapable'], 'MCP grant'));
  if (template.tools.some(tool => typeof tool.name !== 'string' || !tool.name || typeof tool.writable !== 'boolean')) throw new SubzeroError('invalid_request', 'Tool grants require a name and writable flag.');
  if (template.mcpServers.some(server => !server || !Array.isArray(server.tools) || (server.args !== undefined && !Array.isArray(server.args)) || (server.envRefs !== undefined && !Array.isArray(server.envRefs)) || typeof server.name !== 'string' || typeof server.command !== 'string')) throw new SubzeroError('invalid_request', 'MCP grants require a name, command, tool list, and array arguments or environment references.');
  const toolNames = new Set(template.tools.map(tool => tool.name));
  const mcpNames = template.mcpServers.flatMap(server => server.tools);
  if (toolNames.size + mcpNames.length > limits.grantedTools) throw new SubzeroError('limit_exceeded', `Template grants more than ${limits.grantedTools} tools.`);
  if ([...toolNames].some(name => !name) || mcpNames.some(name => !name)) throw new SubzeroError('invalid_request', 'Tool grants must have explicit names.');
  if (template.skills.some(skill => !skill.name || typeof skill.content !== 'string')) throw new SubzeroError('invalid_request', 'Skill snapshots require a name and resolved content.');
  if (utf8Length(template.instructions) + template.skills.reduce((total, skill) => total + utf8Length(skill.content), 0) > limits.instructionBytes) throw new SubzeroError('limit_exceeded', 'Template instructions and skill contents exceed the configured UTF-8 byte limit.');
  if ((template.workerAdapter !== undefined && (typeof template.workerAdapter !== 'string' || !template.workerAdapter)) || (template.workerVersion !== undefined && (typeof template.workerVersion !== 'string' || !template.workerVersion))) throw new SubzeroError('invalid_request', 'Worker adapter and version must be non-empty strings when supplied.');
  if (template.mcpServers.some(server => typeof server.writeCapable !== 'boolean' || (server.args !== undefined && !Array.isArray(server.args)) || (server.envRefs !== undefined && !Array.isArray(server.envRefs)) || server.tools.some(tool => typeof tool !== 'string' || !tool) || server.args?.some(arg => typeof arg !== 'string') || server.envRefs?.some(ref => typeof ref !== 'string' || !/^(env|secret):[A-Za-z_][A-Za-z0-9_.-]*$/.test(ref)))) throw new SubzeroError('invalid_request', 'MCP grants require write capability, explicit tools, and valid secret references.');
  const hasWriteGrant = template.tools.some(tool => tool.writable) || template.mcpServers.some(server => server.writeCapable);
  if (hasWriteGrant && !template.writeCapable) throw new SubzeroError('invalid_request', 'A template with write-capable grants must be marked writeCapable.');
}
function immutableSnapshot(template: TemplateDefinition): TemplateDefinition {
  return Object.freeze({
    ...template,
    tools: Object.freeze(template.tools.map(tool => Object.freeze({ ...tool }))) as unknown as TemplateDefinition['tools'],
    skills: Object.freeze(template.skills.map(skill => Object.freeze({ ...skill }))) as unknown as TemplateDefinition['skills'],
    mcpServers: Object.freeze(template.mcpServers.map(server => Object.freeze({ ...server, args: server.args ? Object.freeze([...server.args]) : undefined, envRefs: server.envRefs ? Object.freeze([...server.envRefs]) : undefined, tools: Object.freeze([...server.tools]) }))) as unknown as TemplateDefinition['mcpServers'],
  });
}
function sameModelMetadata(left: ModelMetadata, right: ModelMetadata) {
  return left.url === right.url && left.model === right.model && left.api === right.api;
}
function utf8Length(value: string) { return new TextEncoder().encode(value).byteLength; }
function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  let result = '';
  for (const character of value) {
    if (utf8Length(result + character) > maxBytes) break;
    result += character;
  }
  return result;
}
function clampInt(value: number | undefined, min: number, max: number, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) throw new SubzeroError('invalid_request', 'Expected an integer option.');
  return Math.max(min, Math.min(max, value));
}
function strictObject(value: unknown, allowedKeys: string[], label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SubzeroError('invalid_request', `${label} must be an object.`);
  const extras = Object.keys(value).filter(key => !allowedKeys.includes(key));
  if (extras.length) throw new SubzeroError('invalid_request', `${label} contains unsupported fields: ${extras.join(', ')}.`);
}
function nonnegativeInteger(value: number | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new SubzeroError('invalid_request', `${name} must be a non-negative integer.`);
  return value;
}
function safeMessage(error: unknown, key?: string) { return redact(error instanceof Error ? error.message : 'Worker error', key); }
function redact(value: string, key?: string) { return key ? value.split(key).join('[REDACTED]') : value; }
function sanitizeTerminal(terminal: WorkerTerminal, key: string, previewLimit: number): WorkerTerminal {
  if (terminal.type === 'completed') return { ...terminal, artifactId: redact(terminal.artifactId, key), preview: truncateUtf8(redact(terminal.preview, key), previewLimit) };
  if (terminal.type === 'stopped') return terminal;
  return { ...terminal, code: redact(terminal.code, key), ...(terminal.message ? { message: truncateUtf8(redact(terminal.message, key), 512) } : {}) };
}
function terminalToEvent(childId: ChildId, runId: RunId, terminal: WorkerTerminal, at: string, previewLimit: number): EventInput {
  if (terminal.type === 'completed') return { at, childId, runId, type: 'completed', artifactId: terminal.artifactId, preview: truncateUtf8(terminal.preview, previewLimit) };
  if (terminal.type === 'stopped') return { at, childId, runId, type: 'stop_confirmed' };
  return { at, childId, runId, type: terminal.type, code: terminal.code, ...(terminal.message ? { message: truncateUtf8(terminal.message, 512) } : {}) };
}

export function createTextRedactor(secrets: string[]): { push(text: string): string; flush(): string } {
  const known = [...new Set(secrets.filter(secret => typeof secret === 'string' && secret.length > 0))].sort((a, b) => b.length - a.length);
  const longest = Math.max(known[0]?.length ?? 0, 1);
  let pending = '';
  const scan = (input: string, final: boolean): string => {
    let output = '';
    let index = 0;
    while (index < input.length) {
      if (!final && input.length - index <= longest) {
        const rest = input.slice(index);
        if (known.some(secret => secret.length > rest.length && secret.startsWith(rest)) || /^[\uD800-\uDBFF]$/.test(rest)) { pending = rest; return output; }
      }
      const match = known.find(secret => input.startsWith(secret, index));
      if (match) { output += '[REDACTED]'; index += match.length; continue; }
      const point = String.fromCodePoint(input.codePointAt(index)!);
      output += point;
      index += point.length;
    }
    pending = '';
    return output;
  };
  return {
    push: text => scan(pending + text, false),
    flush: () => { const rest = pending; pending = ''; return scan(rest, true); },
  };
}
