import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createTextRedactor, type ChildId, type EngineFactory, type ModelMetadata, type TemplateSnapshot, type Worker } from '@subzero/core';
import type { LocalArtifactStore } from '../artifacts.ts';
import { isBrokerIncarnationLive } from '../broker-receipt.ts';

export type PiEngineFactoryOptions = {
  dataRoot: string;
  artifactStore: LocalArtifactStore;
  resolveSecretRef?: (reference: string) => string | undefined | Promise<string | undefined>;
  shutdownGraceMs?: number;
  brokerId?: string;
  brokerIncarnation?: string;
  brokerReceiptDir?: string;
  /** Internal fault-injection seams used by runtime worker tests. */
  workerEntrypointForTesting?: string;
  workerArgumentsForTesting?: string[];
  controlRequestTimeoutMs?: number;
  processGroupGoneForTesting?: (pid: number) => Promise<boolean>;
};

type WorkerMessage = { type: string; id?: number; [key: string]: unknown };
type Identity = { pid: number; incarnation: string; runId: string; ownerGeneration?: number; startedAt: string; brokerId: string; brokerIncarnation: string };
export const PI_WORKER_VERSION = '1.0.4';

/** Owns isolated Pi worker processes and their durable per-child transcripts. */
export class PiEngineFactory implements EngineFactory {
  private readonly dataRoot: string;
  private readonly artifactStore: LocalArtifactStore;
  private readonly resolveSecretRef?: PiEngineFactoryOptions['resolveSecretRef'];
  private readonly shutdownGraceMs: number;
  private readonly brokerId: string;
  private readonly brokerIncarnation: string;
  private readonly brokerReceiptDir?: string;
  private readonly workerEntrypointForTesting?: string;
  private readonly workerArgumentsForTesting: string[];
  private readonly controlRequestTimeoutMs: number;
  private readonly processGroupGoneForTesting?: (pid: number) => Promise<boolean>;
  private readonly openingWorkers = new Set<WorkerIpc>();
  private shuttingDown = false;
  constructor(options: PiEngineFactoryOptions) {
    this.dataRoot = resolve(options.dataRoot);
    this.artifactStore = options.artifactStore;
    this.resolveSecretRef = options.resolveSecretRef;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 1_500;
    this.brokerId = options.brokerId ?? 'untracked-broker';
    this.brokerIncarnation = options.brokerIncarnation ?? randomBytes(24).toString('hex');
    this.brokerReceiptDir = options.brokerReceiptDir;
    this.workerEntrypointForTesting = options.workerEntrypointForTesting;
    this.workerArgumentsForTesting = options.workerArgumentsForTesting ?? [];
    this.controlRequestTimeoutMs = options.controlRequestTimeoutMs ?? 10_000;
    this.processGroupGoneForTesting = options.processGroupGoneForTesting;
  }

  async open(input: Parameters<EngineFactory['open']>[0]): Promise<Worker> {
    if (this.shuttingDown) throw new Error('runtime_shutting_down');
    if (input.templateSnapshot.workerAdapter !== undefined && input.templateSnapshot.workerAdapter !== 'pi') throw new Error(`Unsupported worker adapter: ${input.templateSnapshot.workerAdapter}`);
    if (input.templateSnapshot.workerVersion !== undefined && input.templateSnapshot.workerVersion !== PI_WORKER_VERSION) throw new Error(`Unsupported worker version: ${input.templateSnapshot.workerVersion}`);
    const childDir = this.childDir(input.childId);
    await mkdir(childDir, { recursive: true, mode: 0o700 });
    const session = await readSessionMeta(childDir);
    if (session && session.engineVersion !== PI_WORKER_VERSION) throw new Error('session metadata has an incompatible worker version.');
    const ipc = await this.launch(input.childId, input.runId ?? 'opening', input.ownerGeneration, childDir, input.workspaceRoot, input.templateSnapshot, input.model, input.credential.key, session?.sessionFile);
    return new PiWorker({
      childDir, ipc,
      ownerGeneration: input.ownerGeneration, artifactStore: this.artifactStore, shutdownGraceMs: this.shutdownGraceMs,
      brokerId: this.brokerId, brokerIncarnation: this.brokerIncarnation,
    });
  }

  async validateCheckpoint(input: Parameters<EngineFactory['validateCheckpoint']>[0]): Promise<void> {
    const childDir = this.childDir(input.childId);
    const session = await readSessionMeta(childDir);
    if (!session?.sessionFile || !session.workspaceRoot || session.engineVersion !== PI_WORKER_VERSION) throw new Error('checkpoint_incompatible');
    if (!await checkpointExists(session.sessionFile, input.checkpointId)) throw new Error('checkpoint_incompatible');
  }

  /** Return true only after the identity recorded for this child and run has no live process group. */
  async proveWorkerExited(childId: ChildId, expectedRunId?: string, expectedGeneration?: number): Promise<boolean> {
    const childDir = this.childDir(childId);
    let identity: Identity;
    try { identity = JSON.parse(await readFile(join(childDir, 'worker-owner.json'), 'utf8')) as Identity; }
    catch { return false; }
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 1 || !/^[a-f0-9]{48}$/.test(identity.incarnation) || !identity.runId ||
      (expectedRunId && identity.runId !== expectedRunId) || (expectedGeneration !== undefined && identity.ownerGeneration !== expectedGeneration)) return false;
    if (this.brokerReceiptDir) {
      const ownerLive = await isBrokerIncarnationLive(this.brokerReceiptDir, identity.brokerId, identity.brokerIncarnation);
      if (ownerLive !== false) return false;
    } else if (identity.brokerId !== this.brokerId || identity.brokerIncarnation !== this.brokerIncarnation) return false;
    if (!await processGroupGone(identity.pid)) return false;
    return true;
  }

  async beginShutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all([...this.openingWorkers].map(ipc => ipc.close(this.shutdownGraceMs)));
  }

  private childDir(childId: ChildId): string {
    const safe = createHash('sha256').update(childId).digest('hex');
    return join(this.dataRoot, safe);
  }

  private async launch(childId: ChildId, runId: string, ownerGeneration: number | undefined, childDir: string, workspaceRoot: string, templateSnapshot: TemplateSnapshot, model: ModelMetadata, key: string, sessionFile?: string): Promise<WorkerIpc> {
    const entry = this.workerEntrypointForTesting ?? fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './worker-child.ts' : './worker-child.js', import.meta.url));
    const child = spawn(process.execPath, [entry, ...this.workerArgumentsForTesting], {
      cwd: workspaceRoot,
      env: minimalWorkerEnvironment(),
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
    });
    const ipc = WorkerIpc.create(child, this.controlRequestTimeoutMs, this.processGroupGoneForTesting);
    this.openingWorkers.add(ipc);
    try {
      if (ipc.pid <= 1) throw new Error('worker_pid_unavailable');
      await persistIdentity(childDir, { pid: ipc.pid, incarnation: ipc.incarnation, runId, ...(ownerGeneration !== undefined ? { ownerGeneration } : {}), startedAt: new Date().toISOString(), brokerId: this.brokerId, brokerIncarnation: this.brokerIncarnation });
      await ipc.ready;
      const mcpEnv: Record<string, string> = {};
      for (const server of templateSnapshot.mcpServers) {
        for (const reference of server.envRefs ?? []) {
          const [kind, ...rest] = reference.split(':');
          const name = rest.join(':');
          let value: string | undefined;
          if (kind === 'env' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) value = process.env[name];
          else if (kind === 'secret' && name && this.resolveSecretRef) value = await this.resolveSecretRef(name);
          if (value === undefined) throw new Error(`MCP credential reference is unavailable: ${kind}:${name}`);
          mcpEnv[`${server.name}:${reference}`] = value;
        }
      }
      ipc.redactionSecrets = [key, ...Object.values(mcpEnv)];
      await ipc.request({ type: 'initialize', childId, workspaceRoot, childDir, templateSnapshot, model, key, mcpEnv, sessionFile, engineVersion: PI_WORKER_VERSION });
      if (this.shuttingDown) throw new Error('runtime_shutting_down');
      this.openingWorkers.delete(ipc);
    }
    catch (error) {
      this.openingWorkers.delete(ipc);
      ipc.initializationError = 'worker_initialization_failed';
      await ipc.close();
      if (ipc.exitConfirmed) throw error;
    }
    return ipc;
  }
}

class PiWorker implements Worker {
  readonly capabilities = { steer: true };
  readonly pid: number;
  private readonly childDir: string;
  private readonly ipc: WorkerIpc;
  private readonly ownerGeneration?: number;
  private readonly brokerId: string;
  private readonly brokerIncarnation: string;
  private readonly artifactStore: LocalArtifactStore;
  private readonly shutdownGraceMs: number;
  private activeRun?: string;
  private closed = false;
  constructor(options: { childDir: string; ipc: WorkerIpc; ownerGeneration?: number; artifactStore: LocalArtifactStore; shutdownGraceMs: number; brokerId: string; brokerIncarnation: string }) {
    this.pid = options.ipc.pid;
    this.childDir = options.childDir;
    this.ipc = options.ipc;
    this.ownerGeneration = options.ownerGeneration;
    this.brokerId = options.brokerId;
    this.brokerIncarnation = options.brokerIncarnation;
    this.artifactStore = options.artifactStore;
    this.shutdownGraceMs = options.shutdownGraceMs;
  }
  async *run(input: { runId: string; prompt: string; fromCheckpointId?: string }) {
    if (this.closed) throw new Error('worker_closed');
    if (this.activeRun) throw new Error('worker_run_already_active');
    this.activeRun = input.runId;
    await persistIdentity(this.childDir, { pid: this.ipc.pid, incarnation: this.ipc.incarnation, runId: input.runId, ...(this.ownerGeneration !== undefined ? { ownerGeneration: this.ownerGeneration } : {}), startedAt: new Date().toISOString(), brokerId: this.brokerId, brokerIncarnation: this.brokerIncarnation });
    try {
      if (this.ipc.initializationError) { yield { type: 'failed' as const, code: this.ipc.initializationError }; return; }
      const stream = this.ipc.eventsFor({ type: 'run', ...input });
      let finalOutput = '';
      const redactor = createTextRedactor(this.ipc.redactionSecrets);
      try {
        for await (const message of stream) {
          if (message.type === 'text') {
            const text = redactor.push(String(message.text ?? ''));
            if (!text) continue;
            finalOutput += text;
            yield { type: 'text' as const, text };
            continue;
          }
          if (message.type === 'completed' || message.type === 'stopped' || message.type === 'failed' || message.type === 'interrupted') {
            const tail = redactor.flush();
            if (tail) { finalOutput += tail; yield { type: 'text' as const, text: tail }; }
          }
          if (message.type === 'tool') {
            yield { type: 'tool' as const, name: String(message.name ?? ''), state: message.state as 'started' | 'finished' };
          } else if (message.type === 'completed') {
            const artifact = await this.artifactStore.write(input.runId, redactMany(String(message.output ?? finalOutput), this.ipc.redactionSecrets));
            yield { type: 'completed' as const, checkpointId: String(message.checkpointId), artifactId: artifact.artifactId, preview: redactMany(artifact.preview, this.ipc.redactionSecrets) };
            return;
          } else if (message.type === 'stopped') { yield { type: 'stopped' as const }; return; }
          else if (message.type === 'failed') { yield { type: 'failed' as const, code: String(message.code ?? 'worker_failed'), message: redactMany(String(message.message ?? ''), this.ipc.redactionSecrets) }; return; }
          else if (message.type === 'interrupted') { yield { type: 'interrupted' as const, code: String(message.code ?? 'worker_interrupted'), message: redactMany(String(message.message ?? ''), this.ipc.redactionSecrets) }; return; }
        }
      } catch (error) {
        const tail = redactor.flush();
        if (tail) yield { type: 'text' as const, text: tail };
        throw error;
      }
      const tail = redactor.flush();
      if (tail) yield { type: 'text' as const, text: tail };
      yield { type: 'interrupted' as const, code: 'worker_eof' };
    } finally { this.activeRun = undefined; }
  }
  async steer(message: string): Promise<void> {
    if (!this.activeRun) throw new Error('worker_not_running');
    await this.ipc.request({ type: 'steer', message });
  }
  async stop(expectedRunId: string): Promise<{ confirmed: boolean }> {
    if (this.activeRun !== expectedRunId) return { confirmed: false };
    try { const result = await this.ipc.request({ type: 'stop', runId: expectedRunId }); return { confirmed: result.confirmed === true }; }
    catch { return { confirmed: (await this.close()).exitConfirmed }; }
  }
  async close(): Promise<{ exitConfirmed: boolean }> {
    if (this.closed) return { exitConfirmed: this.ipc.exitConfirmed };
    this.closed = true;
    await this.ipc.close(this.shutdownGraceMs);
    const exitConfirmed = this.ipc.exitConfirmed;
    return { exitConfirmed };
  }
}

class WorkerIpc {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly incarnation: string;
  readonly ready: Promise<void>;
  exited = false;
  exitConfirmed = false;
  initializationError?: string;
  redactionSecrets: string[] = [];
  private nextId = 1;
  private buffer = '';
  private readonly responses = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  private readonly eventQueues = new Map<number, AsyncMessageQueue<WorkerMessage>>();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private exitPromise: Promise<void>;
  private resolveExit!: () => void;
  private readonly controlRequestTimeoutMs: number;
  private readonly isGroupGone: (pid: number) => Promise<boolean>;
  private constructor(child: ChildProcess, controlRequestTimeoutMs: number, isGroupGone: (pid: number) => Promise<boolean>) {
    this.child = child;
    this.controlRequestTimeoutMs = controlRequestTimeoutMs;
    this.isGroupGone = isGroupGone;
    this.pid = child.pid ?? -1;
    this.incarnation = randomBytes(24).toString('hex');
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => this.onData(String(chunk)));
    child.on('error', error => this.fail(error));
    child.on('exit', () => { this.exited = true; this.resolveExit(); this.fail(new Error('worker_process_exited')); });
  }
  static create(child: ChildProcess, controlRequestTimeoutMs: number, groupGone = processGroupGone): WorkerIpc {
    return new WorkerIpc(child, controlRequestTimeoutMs, groupGone);
  }
  private onData(chunk: string) {
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) break;
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      let message: WorkerMessage;
      try { message = JSON.parse(line) as WorkerMessage; } catch { this.fail(new Error('invalid_worker_message')); continue; }
      if (message.type === 'ready') { this.resolveReady(); continue; }
      if (message.type === 'debug') continue;
      if (typeof message.id === 'number' && this.eventQueues.has(message.id) && message.type !== 'response') { this.eventQueues.get(message.id)?.push(message); continue; }
      if (typeof message.id === 'number') {
        const waiter = this.responses.get(message.id);
        if (waiter) { this.responses.delete(message.id); message.type === 'response' && message.ok === true ? waiter.resolve(message) : waiter.reject(new Error(String(message.error ?? 'worker_request_failed'))); }
      }
    }
  }
  private fail(error: Error) {
    this.rejectReady(error);
    for (const waiter of this.responses.values()) waiter.reject(error);
    this.responses.clear();
    for (const queue of this.eventQueues.values()) queue.end(error);
  }
  request(payload: WorkerMessage): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiter = this.responses.get(id);
        if (!waiter) return;
        this.responses.delete(id);
        waiter.reject(new Error('worker_control_timeout'));
      }, this.controlRequestTimeoutMs);
      timer.unref();
      this.responses.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin?.write(`${JSON.stringify({ ...payload, id })}\n`, error => {
        if (!error) return;
        const waiter = this.responses.get(id);
        if (!waiter) return;
        this.responses.delete(id);
        waiter.reject(error);
      });
    });
  }
  async *eventsFor(payload: WorkerMessage): AsyncIterable<WorkerMessage> {
    const id = this.nextId++;
    const queue = new AsyncMessageQueue<WorkerMessage>();
    this.eventQueues.set(id, queue);
    this.child.stdin?.write(`${JSON.stringify({ ...payload, id })}\n`);
    try { for await (const message of queue) { yield message; if (message.type === 'completed' || message.type === 'stopped' || message.type === 'failed' || message.type === 'interrupted') break; } }
    finally { this.eventQueues.delete(id); }
  }
  async close(graceMs = 1_000): Promise<void> {
    if (this.exitConfirmed) return;
    this.child.stdin?.end();
    const grace = new Promise(resolve => setTimeout(resolve, graceMs));
    await Promise.race([this.exitPromise, grace]);
    this.signalGroup('SIGTERM');
    await this.waitForGroupExit(500);
    if (!await this.groupGone()) { this.signalGroup('SIGKILL'); await this.waitForGroupExit(1_000); }
    this.exitConfirmed = this.exited && await this.groupGone();
  }
  private signalGroup(signal: NodeJS.Signals) {
    try { if (process.platform !== 'win32' && this.pid > 1) process.kill(-this.pid, signal); else if (!this.exited) this.child.kill(signal); } catch { /* process already exited */ }
  }
  private async groupGone(): Promise<boolean> {
    if (process.platform === 'win32') return this.exited;
    return this.isGroupGone(this.pid);
  }
  private async waitForGroupExit(ms: number) {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (this.exited && await this.groupGone()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  }
}

class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;
  private error?: Error;
  push(value: T) { const waiter = this.waiters.shift(); waiter ? waiter({ value, done: false }) : this.items.push(value); }
  end(error?: Error) { this.ended = true; this.error = error; for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: async () => { const value = this.items.shift(); if (value !== undefined) return { value, done: false }; if (this.ended) { if (this.error) throw this.error; return { value: undefined, done: true }; } return new Promise(resolve => this.waiters.push(resolve)); } };
  }
}

function minimalWorkerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'SYSTEMROOT', 'WINDIR']) if (process.env[name] !== undefined) env[name] = process.env[name];
  env.PI_CODING_AGENT_DIR = join(tmpdir(), `subzero-pi-${process.pid}`);
  return env;
}
async function persistIdentity(childDir: string, identity: Identity) {
  const path = join(childDir, 'worker-owner.json');
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(identity), 'utf8'); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}
async function processGroupGone(pid: number): Promise<boolean> {
  if (process.platform === 'linux') {
    let found = false;
    let entries: string[];
    try { entries = await readdir('/proc'); } catch { return false; }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try { stat = await readFile(`/proc/${entry}/stat`, 'utf8'); } catch { continue; }
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const state = tail[0]; const group = Number(tail[2]);
      if (group !== pid) continue;
      found = true;
      if (state !== 'Z' && state !== 'X') return false;
    }
    if (found) return true;
  }
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
async function readSessionMeta(childDir: string): Promise<{ sessionFile?: string; workspaceRoot?: string; engineVersion?: string } | undefined> {
  let text: string;
  try { text = await readFile(join(childDir, 'session-meta.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('Session metadata is malformed.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Session metadata must be an object.');
  const metadata = parsed as Record<string, unknown>;
  if (typeof metadata.sessionFile !== 'string' || !metadata.sessionFile || typeof metadata.workspaceRoot !== 'string' || !metadata.workspaceRoot || typeof metadata.engineVersion !== 'string' || !metadata.engineVersion) throw new Error('Session metadata is incomplete.');
  return { sessionFile: metadata.sessionFile, workspaceRoot: metadata.workspaceRoot, engineVersion: metadata.engineVersion };
}
async function checkpointExists(sessionFile: string, checkpointId: string): Promise<boolean> {
  let header = false;
  let found = false;
  try {
    const lines = createInterface({ input: createReadStream(sessionFile, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) throw new Error('blank_session_entry');
      const entry = JSON.parse(line) as { type?: unknown; version?: unknown; id?: unknown };
      if (!header) {
        if (entry.type !== 'session' || entry.version !== 3 || typeof entry.id !== 'string') return false;
        header = true;
      } else {
        if (typeof entry.id !== 'string' || typeof entry.type !== 'string') return false;
        if (entry.id === checkpointId) found = true;
      }
    }
  } catch { return false; }
  return header && found;
}

function redact(value: string, key: string): string { return key ? value.split(key).join('[REDACTED]') : value; }
function redactMany(value: string, secrets: string[]): string { return secrets.reduce((output, secret) => redact(output, secret), value); }
