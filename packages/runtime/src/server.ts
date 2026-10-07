import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { McpServer, fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import type { RuntimeApplication } from './application.ts';
import { safeToolError } from './application.ts';
import operations from '@subzero/core/schemas/wire-operations.schema.json' with { type: 'json' };

type OperationName = 'info' | 'spawn' | 'get' | 'list' | 'send' | 'stop' | 'resume' | 'output';
type ToolInput = Record<string, unknown>;
type ToolOutput = Record<string, unknown>;
export type ManagedMcpServer = McpServer & { shutdown(): Promise<void> };
const operationNames: OperationName[] = ['info', 'spawn', 'get', 'list', 'send', 'stop', 'resume', 'output'];

/** Build one MCP stdio endpoint over an already assembled host runtime. */
export function createMcpServer(application: RuntimeApplication): ManagedMcpServer {
  const server = new McpServer({ name: 'subzero', version: '0.1.0' });
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
    }, async (input: ToolInput) => {
      if (closing) return errorResult({ code: 'runtime_shutting_down', message: 'The runtime is shutting down.' });
      inFlight++;
      try {
        const result = await invoke(application, name, input);
        const structuredContent = isPlainRecord(result) ? result : { value: result };
        const text = JSON.stringify(structuredContent);
        return { content: [{ type: 'text', text: text.length <= 6000 ? text : `${text.slice(0, 5997)}...` }], structuredContent };
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

async function invoke(application: RuntimeApplication, operation: OperationName, input: ToolInput): Promise<unknown> {
  switch (operation) {
    case 'info': return application.info();
    case 'spawn': {
      const args = input as unknown as { prompt: string; templateId: string; model: WireModel };
      return application.spawn({ prompt: args.prompt, templateId: args.templateId, workspaceRoot: application.workspaceRoot, model: await resolveModel(application, args.model) });
    }
    case 'get': {
      const args = input as unknown as { childId: string; waitMs?: number; cursor?: number; eventLimit?: number; previewLimit?: number };
      return application.get(args.childId, { waitMs: args.waitMs, cursor: args.cursor, eventLimit: args.eventLimit, previewLimit: args.previewLimit });
    }
    case 'list': {
      const args = input as unknown as { workspaceRoot?: string };
      if (args.workspaceRoot !== undefined && await realpath(resolve(args.workspaceRoot)) !== application.workspaceRoot) throw new Error('List workspaceRoot must match the configured workspace.');
      return { children: await application.list(application.workspaceRoot) };
    }
    case 'send': {
      const args = input as unknown as { childId: string; mode: 'steer' | 'followup'; message: string };
      return application.send(args.childId, { mode: args.mode, message: args.message });
    }
    case 'stop': {
      const args = input as unknown as { childId: string; expectedRunId: string };
      return application.stop(args.childId, args.expectedRunId);
    }
    case 'resume': {
      const args = input as unknown as { childId: string; model: WireModel; message?: string };
      await application.recoverChild(args.childId);
      return application.resume(args.childId, await resolveModel(application, args.model), args.message);
    }
    case 'output': {
      const args = input as unknown as { artifactId: string; offset?: number; length?: number };
      return application.readArtifact(args.artifactId, args.offset ?? 0, args.length ?? 4096);
    }
  }
}

function errorResult(safe: { code: string; message: string }) {
  return { isError: true, content: [{ type: 'text' as const, text: `${safe.code}: ${safe.message}` }], structuredContent: { error: safe } };
}

type WireModel = { url: string; model: string; api?: string; credentialRef: string };
async function resolveModel(application: RuntimeApplication, model: WireModel) {
  const credential = application.credentials.resolve(model.credentialRef, model.url);
  return { url: model.url, model: model.model, key: credential.key, ...(model.api ? { api: model.api } : {}) };
}

function detachedArgumentsSchema(name: OperationName, input: Record<string, unknown>, credentialModel: Record<string, unknown>): Record<string, unknown> {
  const schema = structuredClone(input);
  if (name === 'spawn' || name === 'resume') {
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
  get: 'Read child state and persisted events, optionally waiting for changes.',
  list: 'List child workers in the configured workspace.',
  send: 'Steer the active run or queue a followup on a child worker.',
  stop: 'Stop the run identified by childId and expectedRunId.',
  resume: 'Validate a ready child and update its model using an explicitly configured credential reference. Include a message to start the next run.',
  output: 'Read a bounded UTF-8 chunk from a child artifact.',
};
