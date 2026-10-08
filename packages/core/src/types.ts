export type ChildId = string;
export type RunId = string;
export type TemplateId = string;
export type SendMode = 'steer' | 'followup';
export type Delivery = 'steered' | 'queued' | 'started';

export type ModelArgs = { url: string; model: string; key: string; api?: string };
export type ModelMetadata = { url: string; model: string; api?: string };

export type ToolGrant = { name: string; writable: boolean };
export type SkillSnapshot = { name: string; content: string };
export type McpGrant = { name: string; command: string; args?: string[]; envRefs?: string[]; tools: string[]; writeCapable: boolean };
export type TemplateDefinition = {
  id: TemplateId;
  description: string;
  instructions: string;
  tools: ToolGrant[];
  skills: SkillSnapshot[];
  mcpServers: McpGrant[];
  writeCapable: boolean;
  workerAdapter?: string;
  workerVersion?: string;
};
export type TemplateSnapshot = Readonly<TemplateDefinition>;

export type ChildState = 'ready' | 'running' | 'interrupted';
export type RunState = 'queued' | 'running' | 'stop_requested' | 'stopped' | 'completed' | 'failed' | 'interrupted';
export type RunRecord = {
  runId: RunId;
  childId: ChildId;
  prompt: string;
  status: RunState;
  createdAt: string;
  result?: { artifactId: string; preview: string };
  errorCode?: string;
};
export type ChildRecord = {
  childId: ChildId;
  workspaceRoot: string;
  state: ChildState;
  templateSnapshot: TemplateSnapshot;
  model: ModelMetadata;
  activeRunId?: RunId;
  lastCompletedLeaf?: string;
  lastResult?: { artifactId: string; preview: string };
  ownerGeneration: number;
  createdAt: string;
  updatedAt: string;
};

export type ChildEvent = ({ seq: number; at: string; childId: ChildId; runId?: RunId } & (
  | { type: 'run_started' }
  | { type: 'run_queued' }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; state: 'started' | 'finished' }
  | { type: 'stop_requested' }
  | { type: 'stop_confirmed' }
  | { type: 'completed'; artifactId: string; preview: string }
  | { type: 'failed' | 'interrupted'; code: string; message?: string }
));
export type EventInput<T = ChildEvent> = T extends unknown ? Omit<T, 'seq'> : never;
export type CursorGap = { type: 'cursor_gap'; requestedCursor: number; oldestCursor: number };
export type SubscriptionItem = ChildEvent | CursorGap;

export type ChildSnapshot = {
  childId: ChildId;
  workspaceRoot: string;
  state: ChildState;
  templateId: TemplateId;
  model: ModelMetadata;
  activeRunId?: RunId;
  lastCompletedLeaf?: string;
  result?: { artifactId: string; preview: string };
  events: ChildEvent[];
  cursor: number;
  oldestCursor: number;
  nextCursor: number;
  cursorGap: boolean;
};
export type ChildSummary = Pick<ChildRecord, 'childId' | 'workspaceRoot' | 'state' | 'model' | 'activeRunId' | 'lastCompletedLeaf' | 'lastResult' | 'createdAt' | 'updatedAt'> & { templateId: TemplateId };
export type ArtifactChunk = { artifactId: string; offset: number; text: string; nextOffset: number; eof: boolean };

export type CoreLimits = {
  activeWorkersPerWorkspace: number;
  writeRunsPerWorkspace: number;
  promptBytes: number;
  instructionBytes: number;
  grantedTools: number;
  eventBytes: number;
  eventBatch: number;
  outputPreviewBytes: number;
  maxWaitMs: number;
};
export type OwnerLease = { ownerToken: string; generation: number };
export type Admission =
  | { kind: 'started'; lease: OwnerLease }
  | { kind: 'queued' }
  | { kind: 'workspace_busy' }
  | { kind: 'not_found' }
  | { kind: 'busy' }
  | { kind: 'recovery_required' };
export type Settled = { kind: 'idle' } | { kind: 'next'; run: RunRecord } | { kind: 'stale' } | { kind: 'recovery_required' };

/** Persistence boundary. Admission and its run_started/run_queued event, queue, stop and settle operations are atomic. `settleRun` may return `next` only after a completed terminal and successor run_started event are committed with confirmed worker exit; other terminals clear queued runs and record them as terminal without dispatching them. Resume validation is readonly, while commit rechecks the child generation and idle ownership atomically. */
export interface Store {
  createChild(child: ChildRecord, run: RunRecord, event: EventInput, limits: CoreLimits): Promise<Admission>;
  getChild(childId: ChildId): Promise<ChildRecord | undefined>;
  listChildren(workspaceRoot?: string): Promise<ChildRecord[]>;
  putTemplate(template: TemplateDefinition): Promise<void>;
  getTemplate(templateId: TemplateId): Promise<TemplateDefinition | undefined>;
  listTemplates(): Promise<TemplateDefinition[]>;
  admitRun(childId: ChildId, run: RunRecord, limits: CoreLimits, expectedGeneration?: number): Promise<Admission>;
  settleRun(childId: ChildId, runId: RunId, ownerToken: string, terminal: WorkerTerminal, event: EventInput, limits: CoreLimits, workerExitConfirmed: boolean): Promise<Settled>;
  requestStop(childId: ChildId, expectedRunId: RunId, ownerToken?: string, at?: string): Promise<{ kind: 'requested' | 'already_terminal' | 'stale' | 'not_found' | 'busy' | 'recovery_required' }>;
  appendEvent(childId: ChildId, event: EventInput): Promise<ChildEvent>;
  readEvents(childId: ChildId, afterCursor: number, limit: number): Promise<{ events: ChildEvent[]; oldestCursor: number; nextCursor: number; cursorGap: boolean }>;
  subscribe(childId: ChildId, afterCursor: number, signal?: AbortSignal): Promise<AsyncIterable<ChildEvent>>;
  validateResume(childId: ChildId): Promise<{ kind: 'ready'; child: ChildRecord; generation: number } | { kind: 'busy' } | { kind: 'not_found' } | { kind: 'recovery_required' }>;
  commitResume(childId: ChildId, expectedGeneration: number, model: ModelMetadata): Promise<{ kind: 'committed'; child: ChildRecord } | { kind: 'busy' } | { kind: 'not_found' } | { kind: 'recovery_required' }>;
}

export type WorkerTerminal =
  | { type: 'completed'; checkpointId: string; artifactId: string; preview: string }
  | { type: 'stopped' }
  | { type: 'failed'; code: string; message?: string }
  | { type: 'interrupted'; code: string; message?: string };
export type WorkerEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; state: 'started' | 'finished' }
  | WorkerTerminal;
export interface Worker {
  capabilities: { steer: boolean };
  run(input: { runId: RunId; prompt: string; fromCheckpointId?: string }): AsyncIterable<WorkerEvent>;
  steer(message: string): Promise<void>;
  stop(expectedRunId: RunId): Promise<{ confirmed: boolean }>;
  close(): Promise<{ exitConfirmed: boolean }>;
}
export interface EngineFactory {
  open(input: { childId: ChildId; runId?: RunId; ownerGeneration?: number; workspaceRoot: string; templateSnapshot: TemplateSnapshot; model: ModelMetadata; credential: { key: string } }): Promise<Worker>;
  validateCheckpoint(input: { childId: ChildId; checkpointId: string; templateSnapshot: TemplateSnapshot; model: ModelMetadata; credential: { key: string } }): Promise<void>;
}
export type SubzeroOptions = {
  store: Store;
  engineFactory: EngineFactory;
  templates: TemplateDefinition[];
  ids: { child(): ChildId; run(): RunId; token(): string };
  clock: () => Date;
  limits?: Partial<CoreLimits>;
  worker: { name: string; version: string; capabilities: string[] };
  configuredModelRefs?: string[];
  artifactReader?: (artifactId: string, offset: number, length: number) => Promise<ArtifactChunk>;
};
/** Trusted host-side spawn input; the host injects workspaceRoot, which is absent from the public wire schema. */
export type SpawnInput = { prompt: string; templateId: TemplateId; model: ModelArgs; workspaceRoot: string };
export type SendInput = { mode: SendMode; message: string };
export type GetInput = { waitMs?: number; cursor?: number; eventLimit?: number; previewLimit?: number };
export type StopResult = { requested: boolean; confirmed: boolean };
export type ResumeResult = { state: 'ready'; childId: ChildId } | { state: 'running'; childId: ChildId; runId: RunId };

export type SubzeroErrorCode = 'invalid_request' | 'not_found' | 'credentials_required' | 'template_not_found' | 'limit_exceeded' | 'workspace_busy' | 'busy' | 'recovery_required' | 'stale_run' | 'unsupported_steer' | 'checkpoint_incompatible' | 'artifact_unavailable';
