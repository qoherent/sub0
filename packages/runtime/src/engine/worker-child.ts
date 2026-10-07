import { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, type BashOperations } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Type, type TSchema } from 'typebox';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

type Json = Record<string, unknown>;
type Envelope = Json & { type: string; id?: number };
let configuration: Json | undefined;
let redactionSecrets: string[] = [];
let runtime: ModelRuntime | undefined;
let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
let manager: SessionManager | undefined;
let running: { id: number; runId: string; controller: AbortController; promise: Promise<void> } | undefined;
const mcpClients: Client[] = [];
function setRunPromise(value: Promise<void>) { if (running) running.promise = value; }

function send(value: Json) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function response(id: number, value: Json = {}) { send({ type: 'response', id, ok: true, ...value }); }
function failure(id: number, error: unknown) { send({ type: 'response', id, ok: false, error: safeError(error) }); }
function safeError(error: unknown) { return redactSecrets(error instanceof Error ? error.message : String(error)); }
function event(id: number, payload: Json) { send({ type: 'event', id, ...payload }); }

async function initialize(message: Envelope, id: number) {
  configuration = message;
  const key = String(message.key ?? '');
  redactionSecrets = [key, ...Object.values(message.mcpEnv as Record<string, string> ?? {})].filter(Boolean);
  if (!key) throw new Error('credentials_required');
  const childDir = String(message.childDir);
  const cwd = resolve(String(message.workspaceRoot));
  const sessionDir = join(childDir, 'transcript');
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const credentials = new InMemoryCredentialStore();
  runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const metadata = message.model as { url: string; model: string; api?: string };
  const api = metadata.api ?? 'openai-completions';
  const selected = runtime.getModels().find((candidate: any) => candidate.id === metadata.model && candidate.api === api && canonicalUrl(candidate.baseUrl) === canonicalUrl(metadata.url));
  let providerId: string;
  let model: any;
  if (selected) {
    providerId = selected.provider;
    model = selected;
  } else {
    providerId = `subzero-${createHash('sha256').update(`${metadata.url}\0${metadata.model}\0${api}`).digest('hex').slice(0, 20)}`;
    runtime.registerProvider(providerId, {
      baseUrl: metadata.url, api,
      models: [{ id: metadata.model, name: metadata.model, contextWindow: 128_000, maxTokens: 8_192, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    model = runtime.getModel(providerId, metadata.model);
  }
  if (!model) throw new Error('model_metadata_unavailable');
  await runtime.setRuntimeApiKey(providerId, key);
  const settingsManager = SettingsManager.inMemory({ defaultTools: [] });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: String(process.env.PI_CODING_AGENT_DIR), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: systemPrompt(message.templateSnapshot as any),
  });
  await resourceLoader.reload();
  const sessionPath = typeof message.sessionFile === 'string' ? String(message.sessionFile) : undefined;
  if (sessionPath) manager = SessionManager.open(sessionPath, sessionDir, cwd);
  else manager = SessionManager.create(cwd, sessionDir);
  protectSessionPersistence(manager, redactionSecrets);
  const mcpTools = await createMcpTools(message.templateSnapshot as any, message.mcpEnv as Record<string, string> ?? {});
  const builtinTools = createBuiltinTools(cwd, message.templateSnapshot as any, redactionSecrets);
  const customTools = [...builtinTools, ...mcpTools];
  const localNames = (message.templateSnapshot as any)?.tools?.map((grant: any) => grant.name) ?? [];
  const allowedNames = [...localNames, ...mcpTools.map((tool: any) => tool.name)];
  const customNames = new Set(customTools.map((tool: any) => tool.name));
  if (customNames.size !== customTools.length || new Set(allowedNames).size !== allowedNames.length) throw new Error('tool_name_collision');
  for (const name of allowedNames) if (!customNames.has(name)) throw new Error(`unsupported_grant:${name}`);
  const created = await createAgentSession({
    cwd, agentDir: String(process.env.PI_CODING_AGENT_DIR), modelRuntime: runtime, model,
    settingsManager, resourceLoader, sessionManager: manager, noTools: 'all', tools: allowedNames,
    customTools,
  });
  session = created.session;
  await session.bindExtensions({ mode: 'json' });
  const currentFile = manager.getSessionFile();
  if (currentFile) await writeFile(join(childDir, 'session-meta.json'), JSON.stringify({ sessionFile: currentFile, workspaceRoot: cwd, engineVersion: String(message.engineVersion) }), { mode: 0o600 });
  response(id, { initialized: true, providerId, sessionFile: currentFile });
}

function createBuiltinTools(cwd: string, snapshot: any, secrets: string[]): any[] {
  const results: any[] = [];
  for (const grant of snapshot.tools ?? []) {
    if (grant.name === 'read') {
      const definition = createReadToolDefinition(cwd);
      results.push({ ...definition, name: grant.name, label: grant.name });
    } else if (grant.name === 'write') {
      if (!grant.writable) throw new Error(`writable_tool_not_granted:${grant.name}`);
      const definition = createWriteToolDefinition(cwd);
      results.push({ ...definition, name: grant.name, label: grant.name });
    } else if (grant.name === 'edit') {
      if (!grant.writable) throw new Error(`writable_tool_not_granted:${grant.name}`);
      results.push({ ...createEditToolDefinition(cwd), name: grant.name, label: grant.name });
    } else if (grant.name === 'bash') {
      if (!grant.writable) throw new Error(`writable_tool_not_granted:${grant.name}`);
      const operations: BashOperations = { exec: (command, dir, options) => ownedExec(command, dir, options) };
      const definition = createBashToolDefinition(cwd, { operations, exposeSessionEnvironment: false });
      results.push({ ...definition, name: grant.name, label: grant.name });
    } else if (grant.name === 'grep') results.push({ ...createGrepToolDefinition(cwd), name: grant.name, label: grant.name });
    else if (grant.name === 'find') results.push({ ...createFindToolDefinition(cwd), name: grant.name, label: grant.name });
    else if (grant.name === 'ls') results.push({ ...createLsToolDefinition(cwd), name: grant.name, label: grant.name });
  }
  return results.map(tool => {
    const execute = tool.execute?.bind(tool);
    if (!execute) return tool;
    return {
      ...tool,
      execute: async (...args: unknown[]) => redactStructured(await execute(...args), secrets),
    };
  });
}

async function createMcpTools(snapshot: any, envMap: Record<string, string>) {
  const definitions: any[] = [];
  for (const server of snapshot.mcpServers ?? []) {
    const env: Record<string, string> = {};
    for (const reference of server.envRefs ?? []) {
      const value = envMap[`${server.name}:${reference}`];
      if (value !== undefined) env[reference.slice(reference.indexOf(':') + 1)] = value;
    }
    const transport = new StdioClientTransport({
      command: server.command, args: server.args ?? [], env: { ...safeChildEnv(), ...env },
      cwd: String(configuration?.workspaceRoot), stderr: 'ignore',
    });
    const client = new Client({ name: `subzero-${server.name}`, version: '0.1.0' });
    await client.connect(transport);
    mcpClients.push(client);
    const listed = await client.listTools();
    const selected = new Set<string>(server.tools ?? []);
    for (const name of selected) {
      if (!listed.tools.some((tool: any) => tool.name === name)) throw new Error(`mcp_grant_missing:${name}`);
    }
    for (const tool of listed.tools) {
      if (!selected.has(tool.name)) continue;
      const name = tool.name;
      const parameters = safeObjectSchema(tool.inputSchema) as TSchema;
      definitions.push({
        name, label: name, description: tool.description ?? `MCP tool from ${server.name}`,
        parameters,
        execute: async (_callId: string, args: unknown, context: { signal?: AbortSignal }) => {
          const result = await client.callTool({ name: tool.name, arguments: (args ?? {}) as Record<string, unknown> }, { signal: context.signal });
          const content = (result.content ?? []).map((part: any) => ({ type: 'text' as const, text: redactSecrets(typeof part.text === 'string' ? part.text : JSON.stringify(part)) }));
          return { content, details: undefined, isError: result.isError === true };
        },
      });
    }
  }
  return definitions;
}

function safeObjectSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('mcp_tool_schema_invalid');
  const value = schema as Record<string, unknown>;
  if (value.type !== 'object' || '$ref' in value || 'definitions' in value) throw new Error('mcp_tool_schema_unsupported');
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes, 'utf8') > 32 * 1024) throw new Error('mcp_tool_schema_too_large');
  return Type.Unsafe(value as any);
}

async function ownedExec(command: string, cwd: string, options: { onData(data: Buffer): void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }): Promise<{ exitCode: number | null }> {
  if (process.platform === 'win32') throw new Error('worker_shell_requires_posix');
  return new Promise((resolvePromise, reject) => {
    const env = { ...safeChildEnv(), ...(options.env ?? {}) };
    const child = spawn('/bin/bash', ['-lc', command], { cwd, env, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let finished = false;
    let timeout: NodeJS.Timeout | undefined;
    const abort = () => {
      try { child.kill('SIGTERM'); } catch { /* exited */ }
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const finish = (fn: () => void) => { if (finished) return; finished = true; if (timeout) clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); fn(); };
    child.stdout.on('data', (chunk: Buffer) => options.onData(chunk));
    child.stderr.on('data', (chunk: Buffer) => options.onData(chunk));
    child.once('error', error => finish(() => reject(error)));
    child.once('close', code => finish(() => options.signal?.aborted ? reject(new Error('aborted')) : resolvePromise({ exitCode: code })));
    if (options.timeout && options.timeout > 0) timeout = setTimeout(() => { abort(); }, options.timeout * 1000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

async function runPrompt(message: Envelope, id: number) {
  if (!session || !manager) throw new Error('worker_not_initialized');
  const checkpointId = typeof message.fromCheckpointId === 'string' ? message.fromCheckpointId : undefined;
  if (checkpointId) {
    try { manager.branch(checkpointId); } catch { event(id, { type: 'failed', code: 'checkpoint_incompatible' }); return; }
  } else if (manager.getLeafId()) manager.resetLeaf();
  const controller = new AbortController();
  running = { id, runId: String(message.runId ?? ''), controller, promise: Promise.resolve() };
  const listener = (value: any) => {
    if (value.type === 'message_update' && value.assistantMessageEvent?.type === 'text_delta') {
      const delta = String(value.assistantMessageEvent.delta ?? '');
      event(id, { type: 'text', text: delta });
    } else if (value.type === 'tool_execution_start') event(id, { type: 'tool', name: String(value.toolName ?? ''), state: 'started' });
    else if (value.type === 'tool_execution_end') event(id, { type: 'tool', name: String(value.toolName ?? ''), state: 'finished' });
  };
  const unsubscribe = session.subscribe(listener);
  try {
    const prompt = String(message.prompt ?? '');
    const notice = checkpointId ? 'You are continuing from a saved checkpoint. Inspect the current workspace before acting.\n\n' : '';
    await session.prompt(`${notice}${prompt}`);
    if (controller.signal.aborted) { event(id, { type: 'stopped' }); return; }
    const output = session.getLastAssistantText();
    const leaf = manager.getLeafId();
    if (!leaf) throw new Error('checkpoint_missing');
    event(id, { type: 'completed', checkpointId: leaf, output });
  } catch (error) {
    const aborted = controller.signal.aborted || (error instanceof Error && /abort/i.test(error.message));
    event(id, aborted ? { type: 'stopped' } : { type: 'failed', code: 'pi_run_failed', message: safeError(error) });
  } finally {
    unsubscribe();
    running = undefined;
  }
}

async function handle(message: Envelope) {
  const id = Number(message.id);
  try {
    if (message.type === 'initialize') await initialize(message, id);
    else if (message.type === 'validate') {
      if (!manager) throw new Error('worker_not_initialized');
      const entries = manager.getEntries();
      response(id, { valid: entries.some(entry => entry.id === String(message.checkpointId)) });
    } else if (message.type === 'run') {
      if (running) throw new Error('worker_run_already_active');
      const promise = runPrompt(message, id);
      setRunPromise(promise);
      void promise.catch(error => event(id, { type: 'failed', code: 'pi_run_failed', message: safeError(error) }));
    } else if (message.type === 'steer') {
      if (!session || !running) throw new Error('worker_not_running');
      const result = await session.steer(String(message.message ?? ''));
      response(id, { delivery: result });
    } else if (message.type === 'stop') {
      if (!running || running.runId !== String(message.runId ?? '')) {
        response(id, { confirmed: false });
      } else {
        running.controller.abort();
        await session?.abort();
        response(id, { confirmed: true });
      }
    } else if (message.type === 'close') {
      await shutdown(); response(id, { closed: true });
    } else throw new Error('unknown_worker_command');
  } catch (error) { failure(id, error); }
}

async function shutdown() {
  running?.controller.abort();
  await running?.promise.catch(() => undefined);
  session?.dispose(); session = undefined;
  for (const client of mcpClients.splice(0)) await client.close().catch(() => undefined);
}

function canonicalUrl(url: string | undefined): string { return (url ?? '').replace(/\/+$/, ''); }
function safeChildEnv() { const env: Record<string, string> = {}; for (const name of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'SYSTEMROOT', 'WINDIR']) if (process.env[name]) env[name] = process.env[name]!; return env; }
function redactSecrets(value: string) { return redactionSecrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value); }
function protectSessionPersistence(sessionManager: SessionManager, secrets: string[]) {
  const append = sessionManager.appendMessage.bind(sessionManager);
  sessionManager.appendMessage = message => append(redactStructured(message, secrets) as typeof message);
}
function redactStructured<T>(value: T, secrets: string[]): T {
  if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value) as T;
  if (Array.isArray(value)) return value.map(item => redactStructured(item, secrets)) as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(value)) output[name] = redactStructured(child, secrets);
    return output as T;
  }
  return value;
}
function systemPrompt(snapshot: any) {
  const parts = [String(snapshot?.instructions ?? '')];
  for (const skill of snapshot?.skills ?? []) parts.push(`## Explicit skill: ${String(skill.name)}\n\n${String(skill.content)}`);
  return parts.filter(Boolean).join('\n\n');
}

let inputBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  inputBuffer += chunk;
  for (;;) { const end = inputBuffer.indexOf('\n'); if (end < 0) break; const line = inputBuffer.slice(0, end); inputBuffer = inputBuffer.slice(end + 1); if (line) void handle(JSON.parse(line) as Envelope); }
});
process.stdin.on('end', () => { void shutdown().finally(() => process.exit(0)); });
process.on('uncaughtException', error => { process.stderr.write(`${safeError(error)}\n`); void shutdown().finally(() => process.exit(1)); });
process.on('unhandledRejection', error => { process.stderr.write(`${safeError(error)}\n`); void shutdown().finally(() => process.exit(1)); });
send({ type: 'ready' });
