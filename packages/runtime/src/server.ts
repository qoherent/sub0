import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { McpServer, fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import { SubzeroError } from '@subzero/core';
import type { RuntimeApplication } from './application.ts';
import { safeToolError } from './application.ts';
import operations from '@subzero/core/schemas/wire-operations.schema.json' with { type: 'json' };

type OperationName = 'info' | 'spawn' | 'run' | 'get' | 'list' | 'send' | 'stop' | 'resume' | 'output';
type ToolInput = Record<string, unknown>;
type ToolOutput = Record<string, unknown>;
type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};
export type ManagedMcpServer = McpServer & { shutdown(): Promise<void> };
const operationNames: OperationName[] = ['info', 'spawn', 'run', 'get', 'list', 'send', 'stop', 'resume', 'output'];

/** Build one MCP stdio endpoint over an already assembled host runtime. */
export function createMcpServer(application: RuntimeApplication): ManagedMcpServer {
  const server = new McpServer({ name: 'subzero', version: '0.2.0' });
  let closing = false;
  let inFlight = 0;
  let resolveDrained: (() => void) | undefined;
  let closeRuntime: Promise<void> | undefined;
  const finishClose = () => closeRuntime ??= (async () => {
    closing = true;
    await application.beginShutdown();
    if (inFlight > 0) await new Promise<void>(resolve => { resolveDrained = resolve; });
    await application.close();
  })();
  for (const name of operationNames) {
    const operation = operations.$defs[name] as { properties: { arguments: Record<string, unknown> }; required?: string[] };
    const schema = detachedArgumentsSchema(name, operation.properties.arguments, operations.$defs.credentialModel);
    server.registerTool(`subzero_${name}`, {
      description: descriptions[name],
      inputSchema: fromJsonSchema<ToolInput>(schema as JsonSchemaType),
      annotations: annotations[name],
    }, async (input: ToolInput, context) => {
      if (closing) return errorResult({ code: 'runtime_shutting_down', message: 'The runtime is shutting down.' });
      inFlight++;
      try {
        const result = await invoke(application, name, input, context);
        const structuredContent = isPlainRecord(result) ? result : { value: result };
        const text = JSON.stringify(structuredContent);
        return { content: [{ type: 'text', text }], structuredContent };
      } catch (error) {
        return errorResult(safeToolError(error));
      } finally {
        inFlight--;
        if (closing && inFlight === 0) { resolveDrained?.(); resolveDrained = undefined; }
      }
    });
  }
  server.server.onclose = () => { void finishClose().catch(error => console.error('Subzero shutdown failed:', safeToolError(error).message)); };
  return Object.assign(server, { shutdown: finishClose });
}

async function invoke(application: RuntimeApplication, operation: OperationName, input: ToolInput, context: Parameters<Parameters<McpServer['registerTool']>[2]>[1]): Promise<unknown> {
  const signal = context.mcpReq.signal;
  switch (operation) {
    case 'info': return application.info();
    case 'spawn': {
      const args = input as unknown as { prompt: string; templateId: string; model: WireModel };
      return application.spawn({ prompt: args.prompt, templateId: args.templateId, workspaceRoot: application.workspaceRoot, model: await resolveModel(application, args.model) });
    }
    case 'run': {
      const args = input as unknown as { prompt: string; templateId: string; model: WireModel; waitMs?: number; previewLimit?: number };
      return withRunBudget(application, args.waitMs, 30_000, signal, async () => {
        const modelArgs = await resolveModel(application, args.model);
        return (waitMs, progress) => application.run({ prompt: args.prompt, templateId: args.templateId, workspaceRoot: application.workspaceRoot, model: modelArgs, waitMs, previewLimit: args.previewLimit }, signal, progress);
      }, context.mcpReq);
    }
    case 'get': {
      const args = input as unknown as { childId: string; runId?: string; waitMs?: number; cursor?: number; eventLimit?: number; previewLimit?: number };
      if (args.runId !== undefined) {
        const runId = args.runId;
        return withRunBudget(application, args.waitMs, 0, signal, async () => {
          await application.assertChildWorkspace(args.childId);
          return (waitMs, progress) => application.get(args.childId, { runId, waitMs, previewLimit: args.previewLimit }, signal, progress);
        }, context.mcpReq);
      }
      await application.assertChildWorkspace(args.childId);
      return application.get(args.childId, { waitMs: args.waitMs, cursor: args.cursor, eventLimit: args.eventLimit, previewLimit: args.previewLimit }, signal);
    }
    case 'list': {
      const args = input as unknown as { workspaceRoot?: string };
      if (args.workspaceRoot !== undefined) {
        let resolved: string | undefined;
        try {
          resolved = await realpath(resolve(application.workspaceRoot, args.workspaceRoot));
        } catch {
          throw new SubzeroError('invalid_request', 'List workspaceRoot must match the configured workspace.');
        }
        if (resolved !== application.workspaceRoot) {
          throw new SubzeroError('invalid_request', 'List workspaceRoot must match the configured workspace.');
        }
      }
      return { children: await application.list(application.workspaceRoot) };
    }
    case 'send': {
      const args = input as unknown as { childId: string; mode: 'steer' | 'followup'; message: string };
      await application.assertChildWorkspace(args.childId);
      return application.send(args.childId, { mode: args.mode, message: args.message });
    }
    case 'stop': {
      const args = input as unknown as { childId: string; expectedRunId: string };
      await application.assertChildWorkspace(args.childId);
      return application.stop(args.childId, args.expectedRunId);
    }
    case 'resume': {
      const args = input as unknown as { childId: string; model: WireModel; message?: string };
      await application.assertChildWorkspace(args.childId);
      await application.recoverChild(args.childId);
      return application.resume(args.childId, await resolveModel(application, args.model), args.message);
    }
    case 'output': {
      const args = input as unknown as { artifactId: string; offset?: number; length?: number };
      await application.assertArtifactWorkspace(args.artifactId);
      return application.readArtifact(args.artifactId, args.offset ?? 0, args.length ?? 4096);
    }
  }
}

function errorResult(safe: { code: string; message: string }) {
  return { isError: true, content: [{ type: 'text' as const, text: `${safe.code}: ${safe.message}` }], structuredContent: { error: safe } };
}

type WireModel = { url: string; model: string; api?: string; credentialRef: string };
async function resolveModel(application: RuntimeApplication, model: WireModel) {
  const credential = await application.credentials.resolve(model.credentialRef, model.url);
  return { url: model.url, model: model.model, key: credential.key, ...(model.api ? { api: model.api } : {}) };
}

function detachedArgumentsSchema(name: OperationName, input: Record<string, unknown>, credentialModel: Record<string, unknown>): Record<string, unknown> {
  const schema = structuredClone(input);
  if (name === 'spawn' || name === 'run' || name === 'resume') {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    properties.model = structuredClone(credentialModel);
  }
  return schema;
}

function isPlainRecord(value: unknown): value is ToolOutput {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const descriptions: Record<OperationName, string> = {
  info: 'Get Subzero protocol, worker, template, and limit information.',
  spawn: 'Create a child worker for the configured workspace.',
  run: 'Start a child run and wait up to the requested bounded interval for its compact result.',
  get: 'Read child state and persisted events, or wait for one run and return its compact result.',
  list: 'List child workers in the configured workspace.',
  send: 'Steer the active run or queue a followup on a child worker.',
  stop: 'Stop the run identified by childId and expectedRunId.',
  resume: 'Validate a ready child and update its model using an explicitly configured credential reference. Include a message to start the next run.',
  output: 'Read a bounded UTF-8 chunk from a child artifact.',
};

const annotations: Record<OperationName, ToolAnnotations> = {
  info: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  spawn: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  run: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  get: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  send: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  stop: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  resume: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  output: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

type ProgressRequest = { _meta?: { progressToken?: string | number }; notify?: (message: { method: string; params: Record<string, unknown> }) => Promise<unknown> | unknown };
type RunPlan<T> = (waitMs: number, progress?: (event: import('@subzero/core').ChildEvent) => void) => Promise<T>;
function progressMessage(event: import('@subzero/core').ChildEvent): string {
  switch (event.type) {
    case 'completed': return 'Run completed.';
    case 'failed': return 'Run failed.';
    case 'interrupted': return 'Run interrupted.';
    case 'stop_confirmed': return 'Run stopped.';
    case 'tool': return event.state === 'started' ? 'Worker tool started.' : 'Worker tool finished.';
    case 'run_queued': return 'Run queued.';
    default: return 'Run in progress.';
  }
}
async function withRunBudget<T>(application: RuntimeApplication, requestedWaitMs: number | undefined, defaultWaitMs: number, requestSignal: AbortSignal | undefined, prepare: () => Promise<RunPlan<T>>, request: ProgressRequest): Promise<T> {
  const startedAt = performance.now();
  const budgetMs = application.mcpRequestBudgetMs;
  const deadline = startedAt + budgetMs;
  if (requestSignal?.aborted) throw requestSignal.reason ?? new DOMException('MCP request aborted.', 'AbortError');
  const token = request._meta?.progressToken;
  const notify = request.notify;
  let lastNotify = -Infinity;
  let progressValue = 0;
  let notifyInFlight = false;
  let active = true;
  const progress = token !== undefined && notify ? (event: import('@subzero/core').ChildEvent) => {
    if (!active || requestSignal?.aborted || notifyInFlight) return;
    const now = performance.now();
    if (now - lastNotify < 250) return;
    progressValue++;
    lastNotify = now;
    const message = progressMessage(event);
    if (Buffer.byteLength(message, 'utf8') > 256) return;
    notifyInFlight = true;
    try {
      const delivery = notify({ method: 'notifications/progress', params: { progressToken: token, progress: progressValue, message } });
      if (delivery && typeof (delivery as Promise<unknown>).then === 'function') void (delivery as Promise<unknown>).then(() => { notifyInFlight = false; }, () => { notifyInFlight = false; });
      else notifyInFlight = false;
    } catch { notifyInFlight = false; /* Progress transport does not block or fail execution. */ }
  } : undefined;
  let prepTimer: ReturnType<typeof setTimeout> | undefined;
  let abortPreparation: (() => void) | undefined;
  try {
    const budgetRemaining = deadline - performance.now();
    if (budgetRemaining <= 0) throw new SubzeroError('request_timeout', 'MCP request work budget expired before run admission.');
    const preparation = prepare();
    const timedPreparation = new Promise<undefined>(resolve => { prepTimer = setTimeout(() => resolve(undefined), budgetRemaining); });
    const abortedPreparation = new Promise<never>((_resolve, reject) => {
      abortPreparation = () => reject(requestSignal?.reason ?? new DOMException('MCP request aborted.', 'AbortError'));
      requestSignal?.addEventListener('abort', abortPreparation, { once: true });
    });
    const plan = await Promise.race([preparation, timedPreparation, abortedPreparation]);
    if (!plan) throw new SubzeroError('request_timeout', 'MCP request work budget expired before run admission.');
    const preparedAt = performance.now();
    const remainingBudget = Math.max(0, Math.floor(deadline - preparedAt));
    if (!remainingBudget) throw new SubzeroError('request_timeout', 'MCP request work budget expired before run admission.');
    if (requestSignal?.aborted) throw requestSignal.reason ?? new DOMException('MCP request aborted.', 'AbortError');
    const waitLimit = requestedWaitMs ?? defaultWaitMs;
    const remainingWait = waitLimit === 0 ? 0 : Math.max(0, Math.floor(waitLimit - (preparedAt - startedAt)));
    const waitMs = Math.min(remainingWait, remainingBudget, 30_000);
    const result = await plan(waitMs, progress);
    if (waitLimit > 0 && waitMs === 0 && isPlainRecord(result) && typeof result.status === 'string' && !['stopped', 'completed', 'failed', 'interrupted'].includes(result.status) && result.waitExpired !== true) return { ...result, waitExpired: true };
    return result;
  } finally {
    active = false;
    clearTimeout(prepTimer);
    if (abortPreparation) requestSignal?.removeEventListener('abort', abortPreparation);
  }
}
