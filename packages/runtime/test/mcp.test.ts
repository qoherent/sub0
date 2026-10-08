import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Value } from 'typebox/value';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFakeProvider, sendCompletion, sendToolCall } from './fixtures/fake-provider.mjs';

const rootDir = fileURLToPath(new URL('../../..', import.meta.url));
const cliSource = join(rootDir, 'packages/runtime/src/cli.ts');
const cliCompiled = join(rootDir, 'packages/runtime/dist/cli.js');
const key = 'mcp-synthetic-secret-91a';

type Session = { client: Client; pid: number; close(): Promise<void> };

async function launch(dataDir: string, workspace: string, origin: string, overrides: NodeJS.ProcessEnv = {}, compiled = false): Promise<Session> {
  await mkdir(dataDir, { recursive: true });
  const config = join(dataDir, 'config.json');
  await writeFile(config, JSON.stringify({ credentialRefs: { TEST_MODEL: { env: 'SUBZERO_MCP_TEST_KEY', origins: [origin] } } }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...(compiled ? [cliCompiled] : ['--conditions=development', cliSource]), '--data-dir', dataDir, '--workspace', workspace, '--config', config],
    env: { ...process.env, SUBZERO_MCP_TEST_KEY: key, ...overrides },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'subzero-mcp-test', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  const pid = transport.pid;
  assert.ok(pid);
  return {
    client, pid,
    async close() {
      await client.close().catch(() => undefined);
      const exited = await waitFor(async () => { try { process.kill(pid, 0); return false; } catch { return true; } }, value => value, 4_000).then(() => true, () => false);
      if (!exited) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* process already exited */ }
        await waitFor(async () => { try { process.kill(pid, 0); return false; } catch { return true; } }, value => value, 1_000).catch(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } });
      }
    },
  };
}

function model(url: string) { return { url, model: 'fake-model', credentialRef: 'TEST_MODEL' }; }
function structured<T>(value: { structuredContent?: T }): T {
  assert.ok(value.structuredContent, 'MCP tool result includes structuredContent');
  return value.structuredContent;
}
async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await read();
    if (ready(value)) return value;
    await delay(30);
  }
  throw new Error('Timed out waiting for MCP runtime state.');
}
async function hasLiveGroup(pid: number): Promise<boolean> {
  if (process.platform === 'linux') {
    for (const entry of await readdir('/proc').catch(() => [] as string[])) {
      if (!/^\d+$/.test(entry)) continue;
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8').catch(() => '');
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(tail[2]) === pid && tail[0] !== 'Z' && tail[0] !== 'X') return true;
    }
    return false;
  }
  try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function isProcessLive(pid: number): Promise<boolean> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  if (!stat) return false;
  const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
  return state !== 'Z' && state !== 'X';
}

test('response schema accepts the actual structured list response', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-mcp-schema-list-'));
  const workspace = join(root, 'workspace');
  const provider = await startFakeProvider();
  let session: Session | undefined;
  try {
    await mkdir(workspace);
    session = await launch(join(root, 'data'), workspace, new URL(provider.endpoint).origin);
    const schema = JSON.parse(await readFile(join(rootDir, 'packages/core/schemas/wire-responses.schema.json'), 'utf8'));
    const response = structured(await session.client.callTool({ name: 'subzero_list', arguments: {} }));
    assert.equal(Value.Check(schema.$defs, schema.$defs.children, response), true, JSON.stringify(response));
  } finally { await session?.close(); await provider.close(); await rm(root, { recursive: true, force: true }); }
});

test('subzero_list with invalid or nonexistent workspaceRoot returns invalid_request error', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-mcp-list-invalid-'));
  const workspace = join(root, 'workspace');
  const provider = await startFakeProvider();
  let session: Session | undefined;
  try {
    await mkdir(workspace);
    session = await launch(join(root, 'data'), workspace, new URL(provider.endpoint).origin);
    const nonexistent = structured(await session.client.callTool({ name: 'subzero_list', arguments: { workspaceRoot: join(root, 'nonexistent') } }));
    assert.deepEqual(nonexistent, { error: { code: 'invalid_request', message: 'List workspaceRoot must match the configured workspace.' } });
    const wrong = structured(await session.client.callTool({ name: 'subzero_list', arguments: { workspaceRoot: root } }));
    assert.deepEqual(wrong, { error: { code: 'invalid_request', message: 'List workspaceRoot must match the configured workspace.' } });
  } finally { await session?.close(); await provider.close(); await rm(root, { recursive: true, force: true }); }
});

test('response schema accepts actual handled tool error structured content', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-mcp-schema-error-'));
  const workspace = join(root, 'workspace');
  const provider = await startFakeProvider();
  let session: Session | undefined;
  try {
    await mkdir(workspace);
    session = await launch(join(root, 'data'), workspace, new URL(provider.endpoint).origin);
    const schema = JSON.parse(await readFile(join(rootDir, 'packages/core/schemas/wire-responses.schema.json'), 'utf8'));
    const response = structured(await session.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'do not start', templateId: 'researcher', model: { ...model(provider.endpoint), credentialRef: 'MISSING' } } }));
    assert.equal(Value.Check(schema.$defs, schema.$defs.error, response), true, JSON.stringify(response));
    assert.equal(provider.requests.length, 0);
  } finally { await session?.close(); await provider.close(); await rm(root, { recursive: true, force: true }); }
});

test('separate CLI process advertises canonical tools and rejects invalid wire arguments', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-mcp-discovery-'));
  const workspace = join(root, 'workspace');
  const provider = await startFakeProvider();
  let session: Session | undefined;
  try {
    await mkdir(workspace);
    session = await launch(join(root, 'data'), workspace, new URL(provider.endpoint).origin);
    const discovered = await session.client.listTools();
    assert.deepEqual(discovered.tools.map(tool => tool.name).sort(), [
      'subzero_get', 'subzero_info', 'subzero_list', 'subzero_output', 'subzero_resume', 'subzero_send', 'subzero_spawn', 'subzero_stop',
    ]);
    const spawnTool = discovered.tools.find(tool => tool.name === 'subzero_spawn');
    assert.ok(spawnTool);
    assert.deepEqual(spawnTool.inputSchema.required, ['prompt', 'templateId', 'model']);
    assert.equal(JSON.stringify(spawnTool.inputSchema).includes('workspaceRoot'), false);
    assert.equal(JSON.stringify(spawnTool.inputSchema).includes('"key"'), false);
    const info = structured(await session.client.callTool({ name: 'subzero_info', arguments: {} })) as { worker: { name: string; version: string } };
    assert.deepEqual(info.worker, { name: 'pi', version: '1.0.4', capabilities: ['steer', 'followup', 'checkpoint-resume'] });
    const invalid = await session.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'x', templateId: 'researcher', model: { url: provider.endpoint, model: 'fake-model', credentialRef: 'TEST_MODEL', key } } });
    assert.equal(invalid.isError, true);
    assert.equal(JSON.stringify(invalid).includes(key), false);
  } finally {
    await session?.close(); await provider.close(); await rm(root, { recursive: true, force: true });
  }
});

test('compiled CLI exposes the same MCP tools over stdio', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-mcp-compiled-'));
  const workspace = join(root, 'workspace');
  const provider = await startFakeProvider();
  let session: Session | undefined;
  try {
    await mkdir(workspace);
    session = await launch(join(root, 'data'), workspace, new URL(provider.endpoint).origin, {}, true);
    const tools = await session.client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
      'subzero_get', 'subzero_info', 'subzero_list', 'subzero_output', 'subzero_resume', 'subzero_send', 'subzero_spawn', 'subzero_stop',
    ]);
  } finally { await session?.close(); await provider.close(); await rm(root, { recursive: true, force: true }); }
});

test('spawn, long poll, list, artifact output, followup, resume, and run-specific stop work over MCP stdio', { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-mcp-lifecycle-'));
  const workspace = join(root, 'workspace');
  const provider = await startFakeProvider({ reply: body => `reply:${body.messages.at(-1)?.content ?? 'empty'}` });
  let session: Session | undefined;
  try {
    await mkdir(workspace);
    session = await launch(join(root, 'data'), workspace, new URL(provider.endpoint).origin);
    const started = structured(await session.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'first request', templateId: 'researcher', model: model(provider.endpoint) } })) as { childId: string; runId: string };
    assert.ok(started.childId && started.runId);
    const done = await waitFor(async () => structured(await session!.client.callTool({ name: 'subzero_get', arguments: { childId: started.childId, waitMs: 250, cursor: 0 } })) as { state: string; result?: { artifactId: string }; events: unknown[] }, value => value.state === 'ready' && Boolean(value.result));
    assert.ok(done.result?.artifactId);
    const listed = structured(await session.client.callTool({ name: 'subzero_list', arguments: {} })) as { children: Array<{ childId: string }> };
    assert.ok(JSON.stringify(listed).includes(started.childId));
    const artifact = structured(await session.client.callTool({ name: 'subzero_output', arguments: { artifactId: done.result!.artifactId, offset: 0, length: 4096 } })) as { text: string; eof: boolean };
    assert.match(artifact.text, /reply:/); assert.equal(artifact.eof, true);
    const resumed = structured(await session.client.callTool({ name: 'subzero_resume', arguments: { childId: started.childId, model: model(provider.endpoint) } })) as { state: string; childId: string };
    assert.equal(resumed.state, 'ready'); assert.equal(resumed.childId, started.childId);
    const followup = structured(await session.client.callTool({ name: 'subzero_send', arguments: { childId: started.childId, mode: 'followup', message: 'second request' } })) as { runId: string; delivery: string };
    assert.equal(followup.delivery, 'started');
    const doneAgain = await waitFor(async () => structured(await session!.client.callTool({ name: 'subzero_get', arguments: { childId: started.childId, waitMs: 250 } })) as { state: string; activeRunId?: string }, value => value.state === 'ready' && value.activeRunId === undefined);
    assert.equal(doneAgain.state, 'ready');

    const blocked = await startFakeProvider({ onRequest(_body, response) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: {"id":"pending","object":"chat.completion.chunk","created":1,"model":"fake-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'); } });
    const longSession = await launch(join(root, 'other-data'), workspace, new URL(blocked.endpoint).origin);
    try {
      const long = structured(await longSession.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'wait for stop', templateId: 'researcher', model: model(blocked.endpoint) } })) as { childId: string; runId: string };
      await delay(150);
      const abort = new AbortController();
      const waitRequest = longSession.client.callTool({ name: 'subzero_get', arguments: { childId: long.childId, waitMs: 500, cursor: 100_000 } }, { signal: abort.signal }).catch(() => undefined);
      await delay(50);
      abort.abort();
      await waitRequest;
      const stillRunning = structured(await longSession.client.callTool({ name: 'subzero_get', arguments: { childId: long.childId } })) as { state: string; activeRunId?: string };
      assert.equal(stillRunning.state, 'running');
      assert.equal(stillRunning.activeRunId, long.runId);
      const stopped = structured(await longSession.client.callTool({ name: 'subzero_stop', arguments: { childId: long.childId, expectedRunId: long.runId } })) as { requested: boolean; confirmed: boolean };
      assert.equal(stopped.requested, true);
      assert.equal(stopped.confirmed, true);
    } finally { await longSession.close(); await blocked.close(); }
  } finally {
    await session?.close(); await provider.close(); await rm(root, { recursive: true, force: true });
  }
});

test('credential references fail before a worker or provider request and tool results redact keys', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-mcp-credentials-'));
  const workspace = join(root, 'workspace');
  const provider = await startFakeProvider({ reply: () => `echo:${key}` });
  let session: Session | undefined;
  try {
    await mkdir(workspace);
    session = await launch(join(root, 'data'), workspace, 'https://different.example');
    const denied = await session.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'must not call provider', templateId: 'researcher', model: model(provider.endpoint) } });
    assert.equal(denied.isError, true);
    assert.equal(provider.requests.length, 0);
    await session.close(); session = undefined;
    session = await launch(join(root, 'data2'), workspace, new URL(provider.endpoint).origin);
    const unknownRef = await session.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'unknown credential ref', templateId: 'researcher', model: { ...model(provider.endpoint), credentialRef: 'MISSING' } } });
    assert.equal(unknownRef.isError, true);
    assert.match(JSON.stringify(unknownRef), /unknown credential reference/i);
    assert.equal(provider.requests.length, 0);
    const result = await session.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'echo key', templateId: 'researcher', model: model(provider.endpoint) } });
    assert.equal(JSON.stringify(result).includes(key), false);
    const files = await readdir(join(root, 'data2'), { recursive: true });
    for (const relativePath of files) {
      const value = await readFile(join(root, 'data2', relativePath), 'utf8').catch(() => '');
      assert.equal(value.includes(key), false, `key persisted in ${relativePath}`);
    }
  } finally {
    await session?.close(); await provider.close(); await rm(root, { recursive: true, force: true });
  }
});

test('credential-bearing model URLs fail before child metadata or provider requests while ordinary query options pass', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-mcp-url-credentials-'));
  const workspace = join(root, 'workspace');
  const provider = await startFakeProvider();
  let session: Session | undefined;
  try {
    await mkdir(workspace);
    session = await launch(join(root, 'data'), workspace, new URL(provider.endpoint).origin);
    const encodedSecretUrl = `${provider.endpoint}?token=${encodeURIComponent(key)}`;
    const denied = await session.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'reject embedded key', templateId: 'researcher', model: model(encodedSecretUrl) } });
    assert.equal(denied.isError, true);
    assert.equal(JSON.stringify(denied).includes(key), false);
    assert.equal(provider.requests.length, 0);
    const empty = structured(await session.client.callTool({ name: 'subzero_list', arguments: {} })) as { children: unknown[] };
    assert.equal(empty.children.length, 0);

    const endpointWithOption = `${provider.endpoint}?api-version=2026-01`;
    const started = structured(await session.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'keep harmless option', templateId: 'researcher', model: model(endpointWithOption) } })) as { childId: string };
    assert.ok(started.childId);
    const snapshot = structured(await session.client.callTool({ name: 'subzero_get', arguments: { childId: started.childId } })) as { model: { url: string } };
    assert.equal(snapshot.model.url, endpointWithOption);
  } finally { await session?.close(); await provider.close(); await rm(root, { recursive: true, force: true }); }
});

test('separate brokers share child state, reject control of a live foreign worker, and enforce workspace capacity', { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-mcp-brokers-'));
  const workspace = join(root, 'workspace');
  const provider = await startFakeProvider({ onRequest(_body, response) { response.writeHead(200, { 'content-type': 'text/event-stream' }); } });
  let first: Session | undefined; let second: Session | undefined;
  try {
    await mkdir(workspace);
    first = await launch(join(root, 'data'), workspace, new URL(provider.endpoint).origin);
    second = await launch(join(root, 'data'), workspace, new URL(provider.endpoint).origin);
    const childA = structured(await first.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'first long task', templateId: 'coder', model: model(provider.endpoint) } })) as { childId: string; runId: string };
    const foreignSend = await second.client.callTool({ name: 'subzero_send', arguments: { childId: childA.childId, mode: 'followup', message: 'must not cross broker boundary' } });
    assert.equal(foreignSend.isError, true);
    assert.match(JSON.stringify(foreignSend), /busy/i);
    const crossList = structured(await second.client.callTool({ name: 'subzero_list', arguments: {} })) as { children: Array<{ childId: string }> };
    assert.ok(crossList.children.some(child => child.childId === childA.childId));
    const overLimit = await second.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'second writer', templateId: 'coder', model: model(provider.endpoint) } });
    assert.equal(overLimit.isError, true);
    assert.match(JSON.stringify(overLimit), /workspace_busy/i);
    await first.client.callTool({ name: 'subzero_stop', arguments: { childId: childA.childId, expectedRunId: childA.runId } });
  } finally {
    await second?.close(); await first?.close(); await provider.close(); await rm(root, { recursive: true, force: true });
  }
});

test('broker EOF closes the worker process group, including an ordinary bash descendant', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-mcp-eof-'));
  const workspace = join(root, 'workspace');
  const pidFile = join(root, 'sleep.pid');
  const provider = await startFakeProvider({ onRequest(_body, response) {
    sendToolCall(response, 'bash', { command: `sleep 45 & echo $! > '${pidFile}'; wait` });
  } });
  let session: Session | undefined;
  let sleepPid: number | undefined;
  try {
    await mkdir(workspace);
    session = await launch(join(root, 'data'), workspace, new URL(provider.endpoint).origin);
    const child = structured(await session.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'run the background sleep command and wait', templateId: 'coder', model: model(provider.endpoint) } })) as { childId: string; runId: string };
    await waitFor(async () => readFile(pidFile, 'utf8').then(value => { const pid = Number(value.trim()); if (!Number.isSafeInteger(pid) || pid <= 1) return false; sleepPid = pid; return true; }, () => false), Boolean, 8_000);
    const broker = session; session = undefined;
    await broker.close();
    await waitFor(async () => { try { process.kill(sleepPid!, 0); return false; } catch { return true; } }, value => value, 4_000);
    const readOnly = await import('../src/store.ts');
    const store = new readOnly.SQLiteStore(join(root, 'data', 'metadata.sqlite'));
    try { assert.equal((await store.getChild(child.childId))?.state, 'ready'); }
    finally { await store.close(); }
  } finally {
    await session?.close(); await provider.close(); await rm(root, { recursive: true, force: true });
  }
});

test('broker EOF during worker initialization cancels pending opens before the metadata store closes', { timeout: 12_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-mcp-open-race-'));
  const workspace = join(root, 'workspace');
  const provider = await startFakeProvider();
  let session: Session | undefined;
  try {
    await mkdir(workspace);
    const dataDir = join(root, 'data');
    await mkdir(dataDir);
    await writeFile(join(dataDir, 'templates.json'), JSON.stringify([{
      id: 'slow-init', description: 'Waits for an MCP startup that never arrives.', instructions: 'No model call.',
      tools: [], skills: [], writeCapable: false,
      mcpServers: [{ name: 'slow', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], tools: ['slow_tool'], writeCapable: false }],
    }]));
    session = await launch(dataDir, workspace, new URL(provider.endpoint).origin);
    const broker = session; session = undefined;
    const pending = broker.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'init then close', templateId: 'slow-init', model: model(provider.endpoint) } }).catch(() => undefined);
    await delay(300);
    await broker.client.close();
    const exited = await waitFor(async () => { try { process.kill(broker.pid, 0); return false; } catch { return true; } }, value => value, 2_000).then(() => true, () => false);
    assert.equal(exited, true, 'stdio EOF cancels an opening worker and lets the broker exit');
    await pending;
    const { SQLiteStore } = await import('../src/store.ts');
    const store = new SQLiteStore(join(dataDir, 'metadata.sqlite'));
    await store.close();
  } finally {
    await session?.close(); await provider.close(); await rm(root, { recursive: true, force: true });
  }
});

test('abrupt broker death refuses recovery while the recorded worker group is alive, then resumes its checkpoint after exit', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-mcp-recovery-'));
  const workspace = join(root, 'workspace');
  const pidFile = join(root, 'sleep.pid');
  let requestCount = 0;
  const provider = await startFakeProvider({ onRequest(_body, response) {
    const call = requestCount++;
    if (call === 0) sendCompletion(response, 'completed checkpoint before broker loss');
    else if (call === 1) sendToolCall(response, 'bash', { command: `sleep 2 & echo $! > '${pidFile}'; wait` });
    else sendCompletion(response, 'second run finished');
  } });
  let first: Session | undefined; let restarted: Session | undefined;
  let stoppedWorkerPid: number | undefined;
  try {
    await mkdir(workspace);
    const dataDir = join(root, 'data');
    first = await launch(dataDir, workspace, new URL(provider.endpoint).origin);
    const child = structured(await first.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'complete first run', templateId: 'coder', model: model(provider.endpoint) } })) as { childId: string; runId: string };
    const initial = await waitFor(async () => structured(await first!.client.callTool({ name: 'subzero_get', arguments: { childId: child.childId } })) as { state: string; lastCompletedLeaf?: string }, value => value.state === 'ready' && Boolean(value.lastCompletedLeaf));
    const checkpoint = initial.lastCompletedLeaf;
    await first.client.callTool({ name: 'subzero_send', arguments: { childId: child.childId, mode: 'followup', message: 'start shell and wait' } });
    await waitFor(async () => readFile(pidFile, 'utf8').then(value => Number.isSafeInteger(Number(value.trim())) && Number(value.trim()) > 1, () => false), Boolean, 8_000);
    const identityPath = join(dataDir, 'sessions', createHash('sha256').update(child.childId).digest('hex'), 'worker-owner.json');
    stoppedWorkerPid = (JSON.parse(await readFile(identityPath, 'utf8')) as { pid: number }).pid;
    process.kill(stoppedWorkerPid, 'SIGSTOP');
    const deadBroker = first; first = undefined;
    try { process.kill(deadBroker.pid, 'SIGKILL'); } catch { /* process exited between calls */ }
    await waitFor(async () => { try { process.kill(deadBroker.pid, 0); return false; } catch { return true; } }, value => value, 4_000);
    restarted = await launch(dataDir, workspace, new URL(provider.endpoint).origin);
    const identityBytes = await readFile(identityPath, 'utf8');
    const identity = JSON.parse(identityBytes) as { pid: number; ownerGeneration: number };
    assert.equal(await hasLiveGroup(identity.pid), true, 'the detached worker group remains live immediately after broker death');
    const premature = await restarted.client.callTool({ name: 'subzero_resume', arguments: { childId: child.childId, model: model(provider.endpoint) } });
    assert.equal(premature.isError, true);
    assert.match(JSON.stringify(premature), /recovery_required/i);
    await writeFile(identityPath, JSON.stringify({ ...identity, ownerGeneration: identity.ownerGeneration + 1 }));
    const mismatched = await restarted.client.callTool({ name: 'subzero_resume', arguments: { childId: child.childId, model: model(provider.endpoint) } });
    assert.equal(mismatched.isError, true);
    assert.match(JSON.stringify(mismatched), /recovery_required/i);
    await writeFile(identityPath, identityBytes);
    process.kill(stoppedWorkerPid, 'SIGCONT');
    await waitFor(() => hasLiveGroup(identity.pid), value => !value, 8_000);
    const resumed = structured(await restarted.client.callTool({ name: 'subzero_resume', arguments: { childId: child.childId, model: model(provider.endpoint) } })) as { state: string; childId: string };
    assert.equal(resumed.state, 'ready', JSON.stringify(resumed));
    assert.equal(resumed.childId, child.childId);
    const recovered = structured(await restarted.client.callTool({ name: 'subzero_get', arguments: { childId: child.childId } })) as { lastCompletedLeaf?: string };
    assert.equal(recovered.lastCompletedLeaf, checkpoint);
  } finally {
    if (stoppedWorkerPid !== undefined) { try { process.kill(stoppedWorkerPid, 'SIGCONT'); } catch { } }
    await restarted?.close(); await first?.close(); await provider.close(); await rm(root, { recursive: true, force: true });
  }
});

test('audit: another workspace on the same data directory cannot list, inspect, control, or read a child it does not own', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-mcp-audit-workspaces-'));
  const workspaceA = join(root, 'workspace-a');
  const workspaceB = join(root, 'workspace-b');
  const provider = await startFakeProvider();
  let brokerA: Session | undefined; let brokerB: Session | undefined;
  try {
    await mkdir(workspaceA); await mkdir(workspaceB);
    const dataDir = join(root, 'data');
    const origin = new URL(provider.endpoint).origin;
    brokerA = await launch(dataDir, workspaceA, origin);
    brokerB = await launch(dataDir, workspaceB, origin);
    const started = structured(await brokerA.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'workspace A task', templateId: 'researcher', model: model(provider.endpoint) } })) as { childId: string; runId: string };
    const done = await waitFor(async () => structured(await brokerA!.client.callTool({ name: 'subzero_get', arguments: { childId: started.childId, waitMs: 250 } })) as { state: string; result?: { artifactId: string } }, value => value.state === 'ready' && Boolean(value.result));
    const artifactId = done.result!.artifactId;
    const listedByA = structured(await brokerA.client.callTool({ name: 'subzero_list', arguments: {} })) as { children: Array<{ childId: string }> };
    assert.ok(listedByA.children.some(child => child.childId === started.childId), 'positive control: the owning workspace lists the child');
    const listedByB = structured(await brokerB.client.callTool({ name: 'subzero_list', arguments: {} })) as { children: Array<{ childId: string }> };
    assert.equal(listedByB.children.some(child => child.childId === started.childId), false);

    const before = JSON.stringify(structured(await brokerA.client.callTool({ name: 'subzero_get', arguments: { childId: started.childId } })));
    const requestsBefore = provider.requests.length;
    const foreign = {
      get: await brokerB.client.callTool({ name: 'subzero_get', arguments: { childId: started.childId } }),
      send: await brokerB.client.callTool({ name: 'subzero_send', arguments: { childId: started.childId, mode: 'followup', message: 'cross-workspace followup' } }),
      stop: await brokerB.client.callTool({ name: 'subzero_stop', arguments: { childId: started.childId, expectedRunId: started.runId } }),
      resume: await brokerB.client.callTool({ name: 'subzero_resume', arguments: { childId: started.childId, model: { ...model(provider.endpoint), model: 'other-model' } } }),
      output: await brokerB.client.callTool({ name: 'subzero_output', arguments: { artifactId, offset: 0, length: 4096 } }),
    };
    const leaks = Object.entries(foreign).filter(([name, result]) => result.isError !== true || (name !== 'output' && !/not_found/.test(JSON.stringify(result)))).map(([name]) => name);
    assert.deepEqual(leaks, [], 'foreign calls that did not fail with not_found');
    const after = JSON.stringify(structured(await brokerA.client.callTool({ name: 'subzero_get', arguments: { childId: started.childId } })));
    assert.equal(after, before, 'foreign calls leave child metadata, model, and events unchanged');
    assert.equal(provider.requests.length, requestsBefore, 'foreign calls start no provider request');
    const own = structured(await brokerA.client.callTool({ name: 'subzero_output', arguments: { artifactId, offset: 0, length: 4096 } })) as { text: string };
    assert.match(own.text, /fake-provider-ok/);
  } finally {
    await brokerB?.close(); await brokerA?.close(); await provider.close(); await rm(root, { recursive: true, force: true });
  }
});

async function assertBrokerKillReapsWorkerGroup(variant: 'shell-descendant' | 'hanging-provider') {
  const root = await mkdtemp(join(tmpdir(), `subzero-mcp-audit-kill-${variant}-`));
  const workspace = join(root, 'workspace');
  const pidFile = join(root, 'sleep.pid');
  const provider = await startFakeProvider({ onRequest(_body, response) {
    if (variant === 'shell-descendant') sendToolCall(response, 'bash', { command: `sleep 45 & echo $! > '${pidFile}'; wait` });
    else {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'pending' }, finish_reason: null }] })}\n\n`);
    }
  } });
  let session: Session | undefined;
  let workerPid: number | undefined;
  let sleepPid: number | undefined;
  try {
    await mkdir(workspace);
    const dataDir = join(root, 'data');
    session = await launch(dataDir, workspace, new URL(provider.endpoint).origin);
    const child = structured(await session.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'start a long operation', templateId: 'coder', model: model(provider.endpoint) } })) as { childId: string; runId: string };
    const identityPath = join(dataDir, 'sessions', createHash('sha256').update(child.childId).digest('hex'), 'worker-owner.json');
    workerPid = await waitFor(async () => readFile(identityPath, 'utf8').then(value => (JSON.parse(value) as { pid: number }).pid, () => undefined), value => value !== undefined, 8_000);
    if (variant === 'shell-descendant') {
      sleepPid = await waitFor(async () => readFile(pidFile, 'utf8').then(value => { const pid = Number(value.trim()); return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined; }, () => undefined), value => value !== undefined, 8_000);
      assert.equal(await isProcessLive(sleepPid!), true, 'precondition: the shell descendant is running');
    } else await waitFor(async () => provider.requests.length, value => value > 0, 8_000);
    assert.equal(await hasLiveGroup(workerPid!), true, 'precondition: the worker process group is live with an active run');
    const broker = session; session = undefined;
    process.kill(broker.pid, 'SIGKILL');
    await waitFor(async () => isProcessLive(broker.pid), value => !value, 4_000);
    let state = { group: true, descendant: sleepPid !== undefined };
    const reaped = await waitFor(async () => { state = { group: await hasLiveGroup(workerPid!), descendant: sleepPid === undefined ? false : await isProcessLive(sleepPid) }; return state; }, value => !value.group && !value.descendant, 5_000).then(() => true, () => false);
    assert.equal(reaped, true, `worker group and descendant must exit within 5s of broker SIGKILL without a supervisor close: ${JSON.stringify(state)}`);
  } finally {
    if (workerPid !== undefined) { try { process.kill(-workerPid, 'SIGKILL'); } catch { } }
    if (sleepPid !== undefined) { try { process.kill(sleepPid, 'SIGKILL'); } catch { } }
    await session?.close(); await provider.close(); await rm(root, { recursive: true, force: true });
  }
}

test('audit: broker SIGKILL stops the worker group and its shell descendant within 5 seconds without a supervisor close', { timeout: 30_000 }, () => assertBrokerKillReapsWorkerGroup('shell-descendant'));

test('audit: broker SIGKILL stops a worker waiting on a hanging provider within 5 seconds without a supervisor close', { timeout: 30_000 }, () => assertBrokerKillReapsWorkerGroup('hanging-provider'));

test('audit: large valid tool results stay parseable JSON in the model-facing text content', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-mcp-audit-large-result-'));
  const workspace = join(root, 'workspace');
  const provider = await startFakeProvider({ onRequest(_body, response) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let index = 0; index < 120; index++) response.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: index === 0 ? { role: 'assistant', content: 'a'.repeat(100) } : { content: 'a'.repeat(100) }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  } });
  let session: Session | undefined;
  try {
    await mkdir(workspace);
    session = await launch(join(root, 'data'), workspace, new URL(provider.endpoint).origin);
    const started = structured(await session.client.callTool({ name: 'subzero_spawn', arguments: { prompt: 'produce a large reply', templateId: 'researcher', model: model(provider.endpoint) } })) as { childId: string };
    const done = await waitFor(async () => structured(await session!.client.callTool({ name: 'subzero_get', arguments: { childId: started.childId, waitMs: 250 } })) as { state: string; result?: { artifactId: string } }, value => value.state === 'ready' && Boolean(value.result));

    const output = await session.client.callTool({ name: 'subzero_output', arguments: { artifactId: done.result!.artifactId, offset: 0, length: 12000 } });
    const outputText = (output.content as Array<{ text: string }>)[0]!.text;
    const parsedOutput = (() => { try { return JSON.parse(outputText); } catch (error) { assert.fail(`output text content is not valid JSON (length ${outputText.length}): ${(error as Error).message}`); } })();
    assert.deepEqual(parsedOutput, output.structuredContent);
    const chunk = structured(output) as { text: string; eof: boolean };
    assert.equal(chunk.text.length, 12000);
    assert.equal(chunk.eof, true);

    const get = await session.client.callTool({ name: 'subzero_get', arguments: { childId: started.childId, cursor: 0 } });
    const getText = (get.content as Array<{ text: string }>)[0]!.text;
    const structuredGet = structured(get) as { nextCursor?: number };
    assert.ok(JSON.stringify(structuredGet).length > 6000, 'precondition: the structured get result exceeds 6000 characters');
    const parsedGet = (() => { try { return JSON.parse(getText) as { nextCursor?: number }; } catch (error) { assert.fail(`get text content is not valid JSON (length ${getText.length}): ${(error as Error).message}`); } })();
    assert.deepEqual(parsedGet, get.structuredContent);
    assert.equal(parsedGet.nextCursor, structuredGet.nextCursor);
  } finally {
    await session?.close(); await provider.close(); await rm(root, { recursive: true, force: true });
  }
});

test('audit: raw stdin EOF with a pending long get stops the broker, worker group, and shell descendant within 5 seconds', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-mcp-audit-raw-eof-'));
  const workspace = join(root, 'workspace');
  const dataDir = join(root, 'data');
  const pidFile = join(root, 'sleep.pid');
  const provider = await startFakeProvider({ onRequest(_body, response) { sendToolCall(response, 'bash', { command: `sleep 45 & echo $! > '${pidFile}'; wait` }); } });
  let broker: ReturnType<typeof spawn> | undefined;
  let workerPid: number | undefined;
  let sleepPid: number | undefined;
  try {
    await mkdir(workspace); await mkdir(dataDir);
    const config = join(dataDir, 'config.json');
    await writeFile(config, JSON.stringify({ credentialRefs: { TEST_MODEL: { env: 'SUBZERO_MCP_TEST_KEY', origins: [new URL(provider.endpoint).origin] } } }));
    broker = spawn(process.execPath, ['--conditions=development', cliSource, '--data-dir', dataDir, '--workspace', workspace, '--config', config], { env: { ...process.env, SUBZERO_MCP_TEST_KEY: key }, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map<number, (message: { result?: { structuredContent?: Record<string, unknown> } }) => void>();
    let buffer = '';
    broker.stdout!.setEncoding('utf8').on('data', chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const message = JSON.parse(line) as { id?: number; result?: { structuredContent?: Record<string, unknown> } };
        if (message.id !== undefined) pending.get(message.id)?.(message);
      }
    });
    let nextId = 1;
    const send = (method: string, params: unknown) => broker!.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })}\n`);
    const request = (method: string, params: unknown) => new Promise<{ result?: { structuredContent?: Record<string, unknown> } }>(resolve => { pending.set(nextId, resolve); send(method, params); });
    await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-eof', version: '0' } });
    broker.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const spawned = await request('tools/call', { name: 'subzero_spawn', arguments: { prompt: 'run the background sleep command and wait', templateId: 'coder', model: model(provider.endpoint) } });
    const childId = String(spawned.result?.structuredContent?.childId);
    const identityPath = join(dataDir, 'sessions', createHash('sha256').update(childId).digest('hex'), 'worker-owner.json');
    workerPid = await waitFor(async () => readFile(identityPath, 'utf8').then(value => (JSON.parse(value) as { pid: number }).pid, () => undefined), value => value !== undefined, 8_000);
    sleepPid = await waitFor(async () => readFile(pidFile, 'utf8').then(value => { const pid = Number(value.trim()); return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined; }, () => undefined), value => value !== undefined, 8_000);
    assert.equal(await hasLiveGroup(workerPid!), true, 'precondition: the worker group is live');
    send('tools/call', { name: 'subzero_get', arguments: { childId, waitMs: 30_000, cursor: 100_000 } });
    await delay(300);
    assert.equal(await isProcessLive(sleepPid!), true, 'precondition: the run is active while the long get is pending');
    const brokerPid = broker.pid!;
    broker.stdin!.end();
    let state = { broker: true, group: true, descendant: true };
    const stopped = await waitFor(async () => { state = { broker: await isProcessLive(brokerPid), group: await hasLiveGroup(workerPid!), descendant: await isProcessLive(sleepPid!) }; return state; }, value => !value.broker && !value.group && !value.descendant, 5_000).then(() => true, () => false);
    assert.equal(stopped, true, `broker, worker group, and descendant must exit within 5s of stdin EOF: ${JSON.stringify(state)}`);
  } finally {
    if (broker?.pid) { try { process.kill(broker.pid, 'SIGKILL'); } catch { } }
    if (workerPid !== undefined) { try { process.kill(-workerPid, 'SIGKILL'); } catch { } }
    if (sleepPid !== undefined) { try { process.kill(sleepPid, 'SIGKILL'); } catch { } }
    await provider.close(); await rm(root, { recursive: true, force: true });
  }
});
