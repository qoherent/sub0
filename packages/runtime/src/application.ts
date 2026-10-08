import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createSubzero, SubzeroError } from '@subzero/core';
import { LocalArtifactStore } from './artifacts.ts';
import { loadRuntimeConfig } from './config.ts';
import type { CredentialMap, CredentialResolver } from './credentials.ts';
import { PI_WORKER_VERSION, PiEngineFactory } from './engine/pi-engine.ts';
import { SQLiteStore } from './store.ts';
import { writeBrokerReceipt } from './broker-receipt.ts';

export type RuntimeApplicationOptions = { dataRoot: string; workspaceRoot: string; configFile?: string; brokerId?: string };
export type RuntimeApplication = ReturnType<typeof createSubzero> & {
  close(): Promise<void>; beginShutdown(): Promise<void>; recoverChild(childId: string): Promise<boolean>;
  assertChildWorkspace(childId: string): Promise<void>; assertArtifactWorkspace(artifactId: string): Promise<void>;
  workspaceRoot: string; dataRoot: string; credentials: CredentialResolver;
};
type RuntimeFile = { credentialRefs?: CredentialMap; templatesFile?: string };

/** Assemble the trusted host runtime. Config contains credential references only. */
export async function createRuntimeApplication(options: RuntimeApplicationOptions): Promise<RuntimeApplication> {
  const dataRoot = await ensurePrivateDirectory(options.dataRoot);
  const workspaceRoot = await realpath(resolve(options.workspaceRoot));
  const configPath = options.configFile ? resolve(options.configFile) : join(dataRoot, 'config.json');
  const runtimeFile = await readRuntimeFile(configPath);
  const config = await loadRuntimeConfig({
    dataRoot, workspaceRoot, credentialRefs: runtimeFile.credentialRefs,
    ...(runtimeFile.templatesFile ? { templatesFile: runtimeFile.templatesFile } : {}),
  });
  const brokerId = options.brokerId ?? randomUUID();
  const brokerIncarnation = randomUUID();
  const brokerReceiptDir = join(dataRoot, 'brokers');
  await writeBrokerReceipt(brokerReceiptDir, brokerId, 'active', brokerIncarnation);
  const store = new SQLiteStore(join(dataRoot, 'metadata.sqlite'), { brokerId });
  const artifacts = new LocalArtifactStore(join(dataRoot, 'artifacts'));
  const engineFactory = new PiEngineFactory({
    dataRoot: join(dataRoot, 'sessions'), artifactStore: artifacts,
    brokerId, brokerIncarnation, brokerReceiptDir,
    resolveSecretRef: reference => process.env[reference],
  });
  const subzero = createSubzero({
    store, engineFactory, templates: config.templates, ids: { child: randomUUID, run: randomUUID, token: randomUUID },
    clock: () => new Date(), worker: { name: 'pi', version: PI_WORKER_VERSION, capabilities: ['steer', 'followup', 'checkpoint-resume'] },
    configuredModelRefs: config.configuredModelRefs, artifactReader: (artifactId, offset, length) => artifacts.read(artifactId, offset, length),
  });
  const recoverChild = async (childId: string): Promise<boolean> => {
    const child = await store.getChild(childId);
    if (!child || (child.state !== 'running' && child.state !== 'interrupted')) return false;
    if (!await engineFactory.proveWorkerExited(childId, child.activeRunId, child.ownerGeneration)) return false;
    return store.recoverExitedOwner(childId, child.ownerGeneration, child.activeRunId);
  };
  const assertChildWorkspace = async (childId: string): Promise<void> => {
    const child = await store.getChild(childId);
    if (!child || child.workspaceRoot !== workspaceRoot) throw new SubzeroError('not_found', 'Child session was not found.');
  };
  const assertArtifactWorkspace = async (artifactId: string): Promise<void> => {
    if (!await store.hasArtifactInWorkspace(workspaceRoot, artifactId)) throw new SubzeroError('not_found', 'Artifact was not found.');
  };
  try { for (const child of await store.listChildren(workspaceRoot)) await recoverChild(child.childId); }
  catch (error) { await store.close(); await writeBrokerReceipt(brokerReceiptDir, brokerId, 'closed', brokerIncarnation); throw error; }
  let closing: Promise<void> | undefined;
  let beginningShutdown: Promise<void> | undefined;
  const beginShutdown = (): Promise<void> => beginningShutdown ??= (async () => {
    await engineFactory.beginShutdown();
    await subzero.shutdown();
  })();
  return Object.assign(subzero, {
    workspaceRoot, dataRoot, credentials: config.credentials, recoverChild, assertChildWorkspace, assertArtifactWorkspace,
    beginShutdown,
    close(): Promise<void> {
      if (!closing) closing = (async () => {
        await beginShutdown();
        await store.close();
        await writeBrokerReceipt(brokerReceiptDir, brokerId, 'closed', brokerIncarnation);
      })();
      return closing;
    },
  });
}

async function ensurePrivateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  return realpath(absolute);
}

async function readRuntimeFile(path: string): Promise<RuntimeFile> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Runtime config must contain valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Runtime config must be a JSON object.');
  const record = value as Record<string, unknown>;
  const extras = Object.keys(record).filter(key => key !== 'credentialRefs' && key !== 'templatesFile');
  if (extras.length) throw new Error(`Unsupported runtime config fields: ${extras.join(', ')}.`);
  if (containsCredentialKey(record)) throw new Error('Runtime config may contain credential references, not raw keys.');
  if (record.templatesFile !== undefined && (typeof record.templatesFile !== 'string' || !record.templatesFile || isAbsolute(record.templatesFile))) throw new Error('templatesFile must be a relative path under dataRoot.');
  if (record.credentialRefs !== undefined && (!record.credentialRefs || typeof record.credentialRefs !== 'object' || Array.isArray(record.credentialRefs))) throw new Error('credentialRefs must be an object.');
  return { ...(record.credentialRefs ? { credentialRefs: record.credentialRefs as CredentialMap } : {}), ...(record.templatesFile ? { templatesFile: record.templatesFile as string } : {}) };
}

function containsCredentialKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => key.toLowerCase() === 'key' || containsCredentialKey(item));
}

export function defaultDataRoot(): string {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Subzero');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Subzero');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'subzero');
}

export function runtimeVersion(): string { return '0.1.0'; }

const publicToolErrorCodes = new Set([
  'invalid_request', 'not_found', 'credentials_required', 'template_not_found', 'limit_exceeded',
  'workspace_busy', 'busy', 'recovery_required', 'stale_run', 'unsupported_steer',
  'checkpoint_incompatible', 'artifact_unavailable', 'request_failed', 'runtime_shutting_down',
]);

export function safeToolError(error: unknown): { code: string; message: string } {
  const candidate = typeof error === 'object' && error && 'code' in error && typeof (error as SubzeroError).code === 'string'
    ? (error as SubzeroError).code : undefined;
  const code = candidate && publicToolErrorCodes.has(candidate) ? candidate : 'request_failed';
  const message = error instanceof Error && (error.name === 'SubzeroError' || /credential reference|credential is not configured|credential target/i.test(error.message))
    ? error.message.slice(0, 500) : 'The runtime could not complete this request.';
  return { code: code.slice(0, 64), message };
}
