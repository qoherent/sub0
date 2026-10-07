import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSubzeroServerConfig, default as registerSubzeroExtension } from '../src/index.ts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

test('package manifest exposes the built extension and only the runtime dependency', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>; devDependencies: Record<string, string>; pi: { extensions: string[] };
  };
  assert.deepEqual(manifest.pi.extensions, ['./dist/index.js']);
  assert.deepEqual(manifest.dependencies, { '@subzero/runtime': '0.1.0' });
  assert.equal(manifest.devDependencies['@earendil-works/pi-coding-agent'], '1.0.4');
  const extension = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(extension, /sqlite|worker-child|PiEngineFactory/i, 'the host adapter should not import runtime internals');
});

test('server config resolves the runtime CLI and routes workspace and optional runtime config paths', () => {
  const config = createSubzeroServerConfig('/tmp/worktree', {
    SUBZERO_NODE: '/opt/node24/bin/node',
    SUBZERO_DATA_DIR: '/tmp/subzero-data',
    SUBZERO_CONFIG: '/tmp/subzero-data/config.json',
    OPENCODE_API_KEY: 'parent-only-secret',
    SUBZERO_TEST_KEY: 'child-only-secret',
  });
  assert.equal(config.command, '/opt/node24/bin/node');
  assert.equal(config.exposure, 'direct');
  assert.equal(config.cwd, '/tmp/worktree');
  assert.deepEqual(config.args, [
    createSubzeroServerConfig('/tmp/worktree', {}).args[0],
    '--workspace', '/tmp/worktree', '--data-dir', '/tmp/subzero-data', '--config', '/tmp/subzero-data/config.json',
  ]);
  assert.match(config.args[0] ?? '', /packages\/runtime\/(src\/cli\.ts|dist\/cli\.js)$/);
  const defaults = createSubzeroServerConfig('/tmp/default-worktree', {});
  assert.equal(defaults.command, process.execPath);
  assert.deepEqual(defaults.args.slice(1), ['--workspace', '/tmp/default-worktree']);
  const serialized = JSON.stringify(config);
  assert.equal(serialized.includes('parent-only-secret'), false);
  assert.equal(serialized.includes('child-only-secret'), false);
});

test('extension registers once across session start and unregisters on shutdown', async () => {
  const registrations: Array<{ name: string; config: unknown }> = [];
  const removals: string[] = [];
  const handlers = new Map<string, (event: unknown, context: { cwd: string }) => unknown>();
  registerSubzeroExtension({
    registerMcpServer: (name: string, config: unknown) => registrations.push({ name, config }),
    unregisterMcpServer: (name: string) => removals.push(name),
    on: (event: string, handler: (event: unknown, context: { cwd: string }) => unknown) => { handlers.set(event, handler); return () => handlers.delete(event); },
  } as never);

  assert.equal(registrations.length, 0);
  await handlers.get('session_start')?.({}, { cwd: '/tmp/worktree' });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.name, 'subzero');
  await handlers.get('session_start')?.({}, { cwd: '/tmp/worktree' });
  await handlers.get('session_start')?.({}, { cwd: '/tmp/worktree' });
  assert.equal(registrations.length, 1);
  await handlers.get('session_shutdown')?.({}, { cwd: '/tmp/worktree' });
  assert.deepEqual(removals, ['subzero']);
  await handlers.get('session_start')?.({}, { cwd: '/tmp/next-worktree' });
  assert.equal(registrations.length, 2, 'a replacement Pi session gets its own MCP registration');
  assert.equal((registrations[1]?.config as { cwd?: string }).cwd, '/tmp/next-worktree');
  await handlers.get('session_shutdown')?.({}, { cwd: '/tmp/next-worktree' });
  assert.deepEqual(removals, ['subzero', 'subzero']);
});

test('headless Pi calls Subzero MCP tools, waits for a fake child write, and shuts the runtime down', { timeout: 45_000 }, async () => {
  const requests: Array<{ model: string; body: Record<string, unknown> }> = [];
  const workerPids: number[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) { response.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    const model = String(body.model ?? '');
    requests.push({ model, body });
    if (model === 'child-model') workerPids.push(...await findWorkerPids(dataDir));
    const messages = body.messages as Array<{ role?: string; content?: unknown }> | undefined;

    if (model === 'parent-model') {
      const parentRounds = requests.filter(entry => entry.model === 'parent-model').length;
      if (parentRounds === 1) {
        sendToolCall(response, 'mcp__subzero__subzero_spawn', {
          prompt: 'Write child-result.txt with the exact text child-write-ok.', templateId: 'coder',
          model: { url: endpoint, model: 'child-model', api: 'openai-completions', credentialRef: 'child' },
        });
      } else {
        const toolResults = messages?.filter(message => message.role === 'tool').map(message => String(message.content ?? '')) ?? [];
        const previousResult = toolResults.at(-1) ?? '';
        const childId = /"childId"\s*:\s*"([^"]+)"/.exec(previousResult)?.[1];
        if (!childId) { sendCompletion(response, `missing child id in Subzero tool result: ${previousResult}`); return; }
        const status = JSON.parse(previousResult) as { state?: string; nextCursor?: number };
        if (status.state === 'ready') sendCompletion(response, 'Subzero child completed.');
        else sendToolCall(response, 'mcp__subzero__subzero_get', { childId, cursor: status.nextCursor ?? 1, waitMs: 10_000, previewLimit: 256 });
      }
      return;
    }

    if (model === 'child-model' && requests.filter(entry => entry.model === 'child-model').length === 1) {
      sendToolCall(response, 'write', { path: 'child-result.txt', content: 'child-write-ok' });
    } else sendCompletion(response, 'child-write-ok');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  const root = await mkdtemp(join(tmpdir(), 'subzero-pi-host-'));
  const workspace = join(root, 'workspace');
  const agentDir = join(root, 'pi-agent');
  const dataDir = join(root, 'runtime');
  await Promise.all([mkdir(workspace), mkdir(agentDir), mkdir(dataDir)]);
  const runtimePidFile = join(root, 'runtime.pid');
  const nodeWrapper = join(root, 'node-wrapper.sh');
  await writeFile(nodeWrapper, '#!/bin/sh\nprintf "%s" "$$" > "$SUBZERO_RUNTIME_PID_FILE"\nexec "$SUBZERO_TEST_NODE" "$@"\n');
  await chmod(nodeWrapper, 0o700);
  const configFile = join(dataDir, 'config.json');
  await writeFile(configFile, JSON.stringify({ credentialRefs: { child: { env: 'SUBZERO_TEST_KEY', origins: [new URL(endpoint).origin] } } }));
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: {
    fake: { baseUrl: endpoint, api: 'openai-completions', apiKey: 'fake-parent-key', models: [
      { id: 'parent-model', name: 'parent-model', contextWindow: 16_000, maxTokens: 2_000, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ] },
  } }));

  const cli = join(repoRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
  const extension = join(repoRoot, 'packages/pi/dist/index.js');
  let stdout = '';
  let stderr = '';
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const piProcess = spawn(process.execPath, [cli, '--print', '--no-session', '--tools', 'mcp__subzero__*', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--extension', extension, '--provider', 'fake', '--model', 'parent-model', 'Delegate the requested file write to a Subzero child and wait for its result.'], {
      cwd: workspace,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', SUBZERO_NODE: nodeWrapper, SUBZERO_RUNTIME_PID_FILE: runtimePidFile, SUBZERO_TEST_NODE: process.execPath, SUBZERO_DATA_DIR: dataDir, SUBZERO_CONFIG: configFile, SUBZERO_TEST_KEY: 'synthetic-child-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = piProcess;
    if (!piProcess.stdout || !piProcess.stderr) throw new Error('Pi CLI pipes are unavailable.');
    piProcess.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    piProcess.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        const trace = requests.map(entry => {
          const messages = entry.body.messages as Array<{ role?: string; content?: unknown; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }> | undefined;
          return { model: entry.model, calls: messages?.at(-1)?.tool_calls?.map(call => call.function?.name), lastToolResult: messages?.filter(message => message.role === 'tool').at(-1)?.content };
        });
        piProcess.kill('SIGTERM');
        reject(new Error(`Pi host timed out. trace=${JSON.stringify(trace)} stdout=${stdout}\nstderr=${stderr}`));
      }, 15_000);
      piProcess.once('error', error => { clearTimeout(timer); reject(error); });
      piProcess.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /Subzero child completed\./);
    assert.equal(await readFile(join(workspace, 'child-result.txt'), 'utf8').catch(() => '<missing>'), 'child-write-ok', JSON.stringify({ stdout, stderr, models: requests.map(entry => entry.model), bodies: requests.map(entry => entry.body.messages) }));
    const parentCalls = requests.filter(entry => entry.model === 'parent-model');
    assert.ok(parentCalls.length >= 3, 'Pi should call Subzero spawn and get tools');
    const declaredTools = ((parentCalls[0]?.body.tools ?? []) as Array<{ function?: { name?: string } }>)
      .map(tool => tool.function?.name).filter((name): name is string => name?.startsWith('mcp__subzero__') === true);
    assert.deepEqual(declaredTools, [
      'mcp__subzero__subzero_info', 'mcp__subzero__subzero_spawn', 'mcp__subzero__subzero_get',
      'mcp__subzero__subzero_list', 'mcp__subzero__subzero_send', 'mcp__subzero__subzero_stop',
      'mcp__subzero__subzero_resume', 'mcp__subzero__subzero_output',
    ]);
    const calledTools = parentCalls.flatMap(entry => {
      const messages = entry.body.messages as Array<{ tool_calls?: Array<{ function?: { name?: string } }> }> | undefined;
      return messages?.flatMap(message => message.tool_calls?.map(call => call.function?.name) ?? []) ?? [];
    });
    assert.ok(calledTools.includes('mcp__subzero__subzero_spawn'));
    assert.ok(calledTools.includes('mcp__subzero__subzero_get'));
    assert.match(JSON.stringify(parentCalls[1]?.body.messages), /childId/);
    const finalMessages = parentCalls.at(-1)?.body.messages as Array<{ role?: string; content?: unknown }> | undefined;
    const finalToolResult = finalMessages?.filter(message => message.role === 'tool').map(message => String(message.content ?? '')).at(-1);
    const childResult = JSON.parse(finalToolResult ?? '{}') as { state?: string; events?: Array<{ type?: string }> };
    assert.equal(childResult.state, 'ready');
    assert.ok(childResult.events?.some(event => event.type === 'completed'));
    const db = new DatabaseSync(join(dataDir, 'metadata.sqlite'), { readOnly: true });
    let persistedChild;
    try { persistedChild = db.prepare('SELECT state, ownership_state FROM children WHERE workspace_root = ?').get(workspace); }
    finally { db.close(); }
    assert.equal(persistedChild?.state, 'ready', 'Subzero should persist a ready child');
    assert.equal(persistedChild?.ownership_state, 'none', 'Subzero should release child ownership');
    assert.ok(workerPids.length > 0, 'the fake child provider request should identify the worker process');
    for (const pid of workerPids) {
      const state = await readProcState(pid);
      assert.ok(state === 'gone' || state === 'Z', `worker process should exit by Pi session shutdown; pid=${pid}, state=${state}`);
    }

    const runtimePid = Number(await readFile(runtimePidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(runtimePid) && runtimePid > 1, 'Pi should start the configured Subzero runtime process');
    const processState = await readProcState(runtimePid);
    assert.ok(processState === 'gone' || processState === 'Z', `Subzero runtime should exit after Pi session shutdown; state=${processState}`);
  } finally {
    const piProcess = child;
    if (piProcess && piProcess.exitCode === null) {
      piProcess.kill('SIGTERM');
      await Promise.race([
        new Promise<void>(resolve => piProcess.once('exit', () => resolve())),
        new Promise<void>(resolve => setTimeout(() => { piProcess.kill('SIGKILL'); resolve(); }, 1_500)),
      ]);
    }
    const runtimePid = Number(await readFile(runtimePidFile, 'utf8').catch(() => '0'));
    if (runtimePid > 1) await stopProcess(runtimePid);
    for (const pid of workerPids) await stopProcess(pid, true);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

function sendCompletion(response: ServerResponse, text: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const data of [
    { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]) response.write(`data: ${JSON.stringify(data)}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function readProcState(pid: number): Promise<string> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? 'unknown';
  } catch { return 'gone'; }
}

async function findWorkerPids(dataDir: string): Promise<number[]> {
  const files = await readdir(join(dataDir, 'sessions'), { recursive: true }).catch(() => [] as string[]);
  const owners: number[] = [];
  for (const path of files.filter(value => String(value).endsWith('worker-owner.json'))) {
    const owner = await readFile(join(dataDir, 'sessions', String(path)), 'utf8').then(JSON.parse).catch(() => undefined) as { pid?: number } | undefined;
    if (owner?.pid && owner.pid > 1) owners.push(owner.pid);
  }
  return owners;
}

async function stopProcess(pid: number, group = false): Promise<void> {
  let state = await readProcState(pid);
  if (state === 'gone' || state === 'Z') return;
  try { process.kill(group ? -pid : pid, 'SIGTERM'); } catch { return; }
  for (let attempt = 0; attempt < 80; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    state = await readProcState(pid);
    if (state === 'gone' || state === 'Z') return;
  }
  try { process.kill(group ? -pid : pid, 'SIGKILL'); } catch { /* Already exited. */ }
}

function sendToolCall(response: ServerResponse, name: string, args: Record<string, unknown>): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const data of [
    { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'subzero-host-test', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]) response.write(`data: ${JSON.stringify(data)}\n\n`);
  response.end('data: [DONE]\n\n');
}
