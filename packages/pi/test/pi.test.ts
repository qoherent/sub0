import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createSubzeroServerConfig, default as registerSubzeroExtension } from '../src/index.ts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const piCli = process.env.SUBZERO_TEST_PI_CLI ?? join(repoRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
let piCliVersionPromise: Promise<string> | undefined;

test('package manifest exposes the built extension and only the runtime dependency', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>; devDependencies: Record<string, string>; peerDependencies: Record<string, string>; pi: { extensions: string[] };
  };
  const runtimeManifest = JSON.parse(await readFile(new URL('../../runtime/package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
  assert.deepEqual(manifest.pi.extensions, ['./dist/index.js']);
  assert.deepEqual(manifest.dependencies, { '@subzero/runtime': '0.2.0' });
  assert.equal(manifest.devDependencies['@earendil-works/pi-coding-agent'], '1.2.0');
  assert.equal(manifest.peerDependencies['@earendil-works/pi-coding-agent'], '1.2.0');
  assert.equal(runtimeManifest.dependencies['@earendil-works/pi-coding-agent'], '1.2.0');
  assert.equal(runtimeManifest.dependencies['@earendil-works/pi-ai'], '1.2.0');
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
  await handlers.get('session_start')?.({}, { cwd: '/tmp/switched-worktree' });
  assert.equal(registrations.length, 3, 'switching workspace cwd without shutdown updates the MCP registration');
  assert.equal((registrations[2]?.config as { cwd?: string }).cwd, '/tmp/switched-worktree');
  await handlers.get('session_shutdown')?.({}, { cwd: '/tmp/switched-worktree' });
  assert.deepEqual(removals, ['subzero', 'subzero']);
});

test('before_agent_start adds one bounded subzero_delegation section only while registered', async () => {
  const handlers = new Map<string, (event: unknown, context: { cwd: string }) => unknown>();
  registerSubzeroExtension({
    registerMcpServer: () => undefined,
    unregisterMcpServer: () => undefined,
    on: (event: string, handler: (event: unknown, context: { cwd: string }) => unknown) => { handlers.set(event, handler); return () => handlers.delete(event); },
  } as never);
  const beforeAgentStart = handlers.get('before_agent_start');
  assert.ok(beforeAgentStart, 'a before_agent_start handler is registered');
  const freshEvent = () => ({
    type: 'before_agent_start',
    systemPromptOptions: { sections: { sentinel: 'keep me' }, appendSystemPrompt: 'append', customPrompt: 'custom', forceSystemPrompt: 'force', selectedTools: ['read', 'mcp__subzero__subzero_run'] },
  });
  const before = freshEvent();
  assert.equal(await beforeAgentStart(before, { cwd: '/tmp/worktree' }), undefined);
  assert.deepEqual(before.systemPromptOptions.sections, { sentinel: 'keep me' }, 'no guide before registration');

  await handlers.get('session_start')?.({}, { cwd: '/tmp/worktree' });
  const userLike = { ...freshEvent(), prompt: 'delegate this', images: [] };
  const customTriggered = { ...freshEvent(), messageType: 'custom' };
  for (const event of [userLike, customTriggered]) {
    assert.equal(await beforeAgentStart(event, { cwd: '/tmp/worktree' }), undefined, 'the handler returns no replacement');
    const sections = event.systemPromptOptions.sections as Record<string, string>;
    assert.deepEqual(Object.keys(sections).sort(), ['sentinel', 'subzero_delegation']);
    assert.equal(sections.sentinel, 'keep me');
    assert.ok(sections.subzero_delegation.length > 0);
    assert.ok(Buffer.byteLength(sections.subzero_delegation, 'utf8') <= 2048);
    for (const fragment of ['mcp__subzero__subzero_info', 'mcp__subzero__subzero_run', 'mcp__subzero__subzero_get', 'mcp__subzero__subzero_output', 'mcp__subzero__subzero_stop', 'credentialRef', 'expectedRunId', 'isError', 'No background parent wakeup']) assert.ok(sections.subzero_delegation.includes(fragment), fragment);
    assert.equal(event.systemPromptOptions.appendSystemPrompt, 'append');
    assert.equal(event.systemPromptOptions.customPrompt, 'custom');
    assert.equal(event.systemPromptOptions.forceSystemPrompt, 'force');
    assert.deepEqual(event.systemPromptOptions.selectedTools, ['read', 'mcp__subzero__subzero_run']);
  }
  const first = (userLike.systemPromptOptions.sections as Record<string, string>).subzero_delegation;
  assert.equal((customTriggered.systemPromptOptions.sections as Record<string, string>).subzero_delegation, first, 'the guide is stable');
  await beforeAgentStart(userLike, { cwd: '/tmp/worktree' });
  assert.deepEqual(Object.keys(userLike.systemPromptOptions.sections).sort(), ['sentinel', 'subzero_delegation'], 'repeated calls replace the same key');
  assert.equal((userLike.systemPromptOptions.sections as Record<string, string>).subzero_delegation, first);

  await handlers.get('session_shutdown')?.({}, { cwd: '/tmp/worktree' });
  const afterShutdown = freshEvent();
  assert.equal(await beforeAgentStart(afterShutdown, { cwd: '/tmp/worktree' }), undefined);
  assert.deepEqual(afterShutdown.systemPromptOptions.sections, { sentinel: 'keep me' }, 'no guide after shutdown');
});

test('headless Pi calls Subzero MCP tools, waits for a fake child write, and shuts the runtime down', { timeout: 45_000 }, async context => {
  context.diagnostic(`Pi CLI ${piCli} version ${await piCliVersion()}`);
  await verifyPiDelegation('direct');
});

test('headless Pi codemode on drives subzero_run to a completed child write beside direct declarations', { timeout: 45_000 }, async context => {
  context.diagnostic(`Pi CLI ${piCli} version ${await piCliVersion()}`);
  await verifyPiDelegation('codemode-on');
});

test('headless Pi codemode only drives subzero_run to a completed child write with only codemode declared', { timeout: 45_000 }, async context => {
  context.diagnostic(`Pi CLI ${piCli} version ${await piCliVersion()}`);
  await verifyPiDelegation('codemode-only');
});

test('headless Pi codemode only sees a handled credentials_required error as data', { timeout: 45_000 }, async context => {
  context.diagnostic(`Pi CLI ${piCli} version ${await piCliVersion()}`);
  await verifyPiDelegation('codemode-only', 'credentials-required');
});

async function piCliVersion(): Promise<string> {
  piCliVersionPromise ??= (async () => {
    if (!isAbsolute(piCli)) throw new Error(`SUBZERO_TEST_PI_CLI must be an absolute path: ${piCli}`);
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [piCli, '--version'], { timeout: 5_000, encoding: 'utf8' });
      const version = `${stdout}${stderr}`.trim();
      const required = (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { devDependencies: Record<string, string> }).devDependencies['@earendil-works/pi-coding-agent'];
      if (version !== required) throw new Error(`Pi CLI ${piCli} reports unsupported version ${version}; only the latest pinned release ${required} is supported`);
      return version;
    } catch (error) {
      throw new Error(`Pi CLI ${piCli} --version failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  return piCliVersionPromise;
}

async function verifyPiDelegation(mode: 'direct' | 'codemode-on' | 'codemode-only', outcome: 'completed' | 'credentials-required' = 'completed'): Promise<void> {
  const codemode = mode !== 'direct';
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
      const runArguments = {
        prompt: 'Write child-result.txt with the exact text child-write-ok. Make ten separate harmless tool calls before writing the file.', templateId: 'coder', waitMs: 10000,
        model: { url: endpoint, model: 'child-model', api: 'openai-completions', credentialRef: outcome === 'completed' ? 'child' : 'unavailable_ref' },
      };
      if (codemode) {
        if (parentRounds === 1) sendToolCall(response, 'codemode', { code: codemodeScript(runArguments, outcome) });
        else sendCompletion(response, 'The codemode script finished.');
      } else if (parentRounds === 1) {
        sendToolCall(response, 'mcp__subzero__subzero_run', runArguments);
      } else {
        const toolResults = messages?.filter(message => message.role === 'tool').map(message => String(message.content ?? '')) ?? [];
        const previousResult = toolResults.at(-1) ?? '';
        const status = JSON.parse(previousResult) as { childId?: string; runId?: string; status?: string; result?: { artifactId?: string } };
        const childId = status.childId;
        if (!childId || !status.runId) { sendCompletion(response, `missing run identity in Subzero tool result: ${previousResult}`); return; }
        if (status.status === 'completed' && status.result?.artifactId) sendCompletion(response, `Subzero run ${status.runId} completed with artifact ${status.result.artifactId}.`);
        else sendToolCall(response, 'mcp__subzero__subzero_get', { childId, runId: status.runId, waitMs: 10_000 });
      }
      return;
    }

    if (model === 'child-model') {
      const round = requests.filter(entry => entry.model === 'child-model').length;
      if (round <= 10) sendToolCall(response, 'ls', { path: '.' });
      else if (round === 11) sendToolCall(response, 'write', { path: 'child-result.txt', content: 'child-write-ok' });
      else sendCompletion(response, 'child-write-ok');
    }
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
  if (codemode) await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ codemode: { mode: mode === 'codemode-on' ? 'on' : 'only' } }));

  const extension = join(repoRoot, 'packages/pi/dist/index.js');
  let stdout = '';
  let stderr = '';
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const prompt = codemode ? 'Use codemode to delegate the requested file write to a Subzero child and wait for its result.' : 'Delegate the requested file write to a Subzero child and wait for its result.';
    const piProcess = spawn(process.execPath, [piCli, '--print', '--mode', 'json', '--no-session', '--tools', codemode ? 'codemode,mcp__subzero__*' : 'mcp__subzero__*', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--extension', extension, '--provider', 'fake', '--model', 'parent-model', prompt], {
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
    const jsonEvents = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) as { type?: string; toolName?: string; partialResult?: unknown; result?: unknown }; } catch { return undefined; } }).filter((event): event is NonNullable<typeof event> => event !== undefined);
    const runProgress = jsonEvents.filter(event => event.type === 'tool_execution_update' && event.toolName?.includes('subzero_run')).flatMap(event => extractText((event.partialResult as { content?: unknown } | undefined)?.content));
    const parentCalls = requests.filter(entry => entry.model === 'parent-model');
    assert.equal(parentCalls.length, 2, 'one run tool round trip has one call request and one final answer request');
    for (const entry of parentCalls) {
      const systemText = (entry.body.messages as Array<{ role?: string; content?: unknown }>).filter(message => message.role === 'system').map(message => JSON.stringify(message.content)).join('\n');
      assert.equal(systemText.split('<subzero_delegation>').length - 1, 1, 'every parent request carries exactly one subzero_delegation section');
      for (const fragment of ['mcp__subzero__subzero_run', 'mcp__subzero__subzero_get', 'credentialRef', 'expectedRunId']) assert.ok(systemText.includes(fragment), `parent guidance names ${fragment}`);
    }
    const declaredNames = ((parentCalls[0]?.body.tools ?? []) as Array<{ function?: { name?: string } }>).map(tool => tool.function?.name);
    const declaredTools = declaredNames.filter((name): name is string => name?.startsWith('mcp__subzero__') === true);
    const allSubzeroTools = [
      'mcp__subzero__subzero_info', 'mcp__subzero__subzero_spawn', 'mcp__subzero__subzero_run', 'mcp__subzero__subzero_get',
      'mcp__subzero__subzero_list', 'mcp__subzero__subzero_send', 'mcp__subzero__subzero_stop',
      'mcp__subzero__subzero_resume', 'mcp__subzero__subzero_output',
    ];
    if (mode === 'codemode-only') assert.deepEqual(declaredNames, ['codemode'], 'codemode only declares just codemode');
    else if (mode === 'codemode-on') assert.deepEqual(declaredNames, ['codemode', ...allSubzeroTools], 'codemode on declares codemode beside the direct tools');
    else assert.deepEqual(declaredTools, allSubzeroTools);
    const calledTools = parentCalls.flatMap(entry => {
      const messages = entry.body.messages as Array<{ tool_calls?: Array<{ function?: { name?: string } }> }> | undefined;
      return messages?.flatMap(message => message.tool_calls?.map(call => call.function?.name) ?? []) ?? [];
    });
    if (codemode) assert.deepEqual([...new Set(calledTools)], ['codemode'], 'the parent model calls only codemode');
    else assert.ok(calledTools.includes('mcp__subzero__subzero_run'));
    assert.equal(calledTools.filter(name => name === (codemode ? 'codemode' : 'mcp__subzero__subzero_run')).length, 1, codemode ? 'parent dispatches exactly one codemode script' : 'parent dispatches exactly one run');
    const parentMessages = parentCalls.flatMap(entry => entry.body.messages as Array<{ role?: string; content?: unknown }> ?? []);
    const parentContent = parentMessages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
    const finalToolMessages = parentMessages.filter(message => message.role === 'tool');
    assert.equal(finalToolMessages.length, 1, 'the model receives one final compact result');
    const workspaceFile = await readFile(join(workspace, 'child-result.txt'), 'utf8').catch(() => '<missing>');

    if (outcome === 'credentials-required') {
      const toolText = String(finalToolMessages[0]?.content ?? '');
      assert.match(toolText, /Output:\s*handled-credentials-required\s*$/);
      assert.equal(requests.filter(entry => entry.model === 'child-model').length, 0, 'no child provider request');
      assert.equal(workspaceFile, '<missing>', 'no file effect');
      const db = new DatabaseSync(join(dataDir, 'metadata.sqlite'), { readOnly: true });
      try { assert.equal((db.prepare('SELECT COUNT(*) AS count FROM children').get() as { count: number }).count, 0, 'no child admitted'); }
      finally { db.close(); }
      assert.deepEqual(workerPids, []);
    } else {
      assert.ok(runProgress.length > 0, 'the real Pi host emits run progress as UI updates');
      assert.ok(jsonEvents.some(event => event.type === 'tool_execution_end' && event.result), 'the Pi host emits the final compact tool result');
      assert.equal(workspaceFile, 'child-write-ok', JSON.stringify({ stdout, stderr, models: requests.map(entry => entry.model), bodies: requests.map(entry => entry.body.messages) }));
      assert.ok(runProgress.every(text => !parentContent.includes(text)), `actual UI progress text should be absent; progress=${JSON.stringify(runProgress)} parent=${parentContent}`);
      let childResult: { childId?: string; runId?: string; status?: string; waitExpired?: boolean; result?: { artifactId?: string; preview?: string }; events?: unknown[] };
      if (codemode) {
        const marked = /SUBZERO_BEGIN([\s\S]*?)SUBZERO_END/.exec(String(finalToolMessages[0]?.content ?? ''));
        assert.ok(marked, 'the codemode result carries the marker-bounded snapshot');
        childResult = JSON.parse(marked[1] ?? '{}');
      } else {
        const parsedEnvelope = JSON.parse(String(finalToolMessages[0]?.content ?? '{}')) as { structuredContent?: unknown };
        childResult = (parsedEnvelope.structuredContent ?? parsedEnvelope) as typeof childResult;
      }
      assert.deepEqual(Object.keys(childResult).sort(), ['childId', 'result', 'runId', 'status', 'waitExpired']);
      assert.equal(childResult.status, 'completed');
      assert.equal(childResult.waitExpired, false);
      assert.ok(childResult.runId);
      assert.ok(childResult.result?.artifactId);
      assert.equal(childResult.result?.preview, 'child-write-ok');
      assert.equal('events' in childResult, false);
      assert.equal(requests.filter(entry => entry.model === 'child-model').length, 12, 'the child provider performed eleven tool turns and one final turn');
      assert.ok(requests.filter(entry => entry.model === 'child-model').every(entry => !JSON.stringify(entry.body.messages).includes('subzero_delegation')), 'child requests do not inherit the parent guidance');
      const verifyDb = new DatabaseSync(join(dataDir, 'metadata.sqlite'), { readOnly: true });
      let persistedChild;
      let persistedRun;
      try {
        persistedChild = verifyDb.prepare('SELECT child_id, state, ownership_state FROM children WHERE workspace_root = ?').get(workspace);
        assert.ok(persistedChild?.child_id);
        persistedRun = verifyDb.prepare('SELECT run_id, status, result FROM runs WHERE child_id = ?').get(String(persistedChild.child_id));
      }
      finally { verifyDb.close(); }
      assert.equal(persistedChild?.state, 'ready', 'Subzero should persist a ready child');
      assert.equal(persistedChild?.ownership_state, 'none', 'Subzero should release child ownership');
      assert.equal(persistedChild?.child_id, childResult.childId);
      assert.equal(persistedRun?.run_id, childResult.runId);
      assert.equal(persistedRun?.status, 'completed');
      assert.equal(JSON.parse(String(persistedRun?.result)).artifactId, childResult.result.artifactId);
      assert.equal(await readFile(join(dataDir, 'artifacts', `${childResult.result.artifactId}.artifact`), 'utf8'), 'child-write-ok');
      assert.ok(workerPids.length > 0, 'the fake child provider request should identify the worker process');
    }
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
}

function codemodeScript(runArguments: Record<string, unknown>, outcome: 'completed' | 'credentials-required'): string {
  const call = `const response = await tools.mcp__subzero__subzero_run(${JSON.stringify(runArguments)});`;
  if (outcome === 'credentials-required') return `${call}
if (response.isError !== true) throw new Error('expected a handled error: ' + JSON.stringify(response));
if (!response.structuredContent || !response.structuredContent.error || response.structuredContent.error.code !== 'credentials_required') throw new Error('unexpected error: ' + JSON.stringify(response));
text('handled-credentials-required');`;
  return `${call}
if (response.isError) throw new Error('subzero error: ' + JSON.stringify(response));
if (!response.structuredContent || response.structuredContent.status !== 'completed') throw new Error('not completed: ' + JSON.stringify(response));
text('SUBZERO_BEGIN' + JSON.stringify(response.structuredContent) + 'SUBZERO_END');`;
}

function sendCompletion(response: ServerResponse, text: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const data of [
    { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]) response.write(`data: ${JSON.stringify(data)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function extractText(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(extractText);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return [record.text];
    return Object.values(record).flatMap(extractText);
  }
  return [];
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
