import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Value } from 'typebox/value';
import { createSubzero, createTextRedactor } from '../src/index.ts';
import { FakeStore, ControlledEngineFactory, ids, template, coder, tooManyTools } from './support.ts';

const args = { url: 'https://model.example/v1', model: 'model-x', key: 'secret-key' };

function setup(options: { active?: number; writers?: number } = {}, templateDefs = [template, coder], artifactReader?: (artifactId: string, offset: number, length: number) => Promise<{ artifactId: string; offset: number; text: string; nextOffset: number; eof: boolean }>) {
  const store = new FakeStore();
  const engine = new ControlledEngineFactory();
  const core = createSubzero({
    store,
    engineFactory: engine,
    templates: templateDefs,
    ids: ids(),
    clock: () => new Date('2026-10-07T12:00:00.000Z'),
    worker: { name: 'fake', version: '1', capabilities: ['stop'] },
    limits: { activeWorkersPerWorkspace: options.active ?? 4, writeRunsPerWorkspace: options.writers ?? 1 },
    artifactReader,
  });
  return { core, store, engine };
}

test('spawn snapshots the template and starts one child run with no persisted credential', async () => {
  const { core, store, engine } = setup();
  const created = await core.spawn({
    prompt: 'Research this change', templateId: 'researcher', model: args, workspaceRoot: '/repo',
  });
  assert.deepEqual(created, { childId: 'child-1', runId: 'run-1' });
  assert.equal(engine.opened.length, 1);
  assert.equal(engine.opened[0]?.templateSnapshot.tools.length, 1);
  assert.equal(JSON.stringify(await store.dump()).includes(args.key), false);
  assert.equal((await core.get(created.childId)).activeRunId, created.runId);
});

test('run returns its exact terminal result and get can retrieve it after a successor starts', async () => {
  const { core, engine } = setup();
  const pending = core.run({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo', waitMs: 500 });
  await eventuallyAsync(async () => engine.runs.length === 1);
  const concurrentRead = core.get('child-1', { runId: 'run-1', waitMs: 500 });
  engine.runs[0]!.complete({ checkpointId: 'leaf-a', artifactId: 'artifact-a', preview: 'first result' });
  const first = await pending;
  assert.deepEqual(first, { childId: 'child-1', runId: 'run-1', status: 'completed', waitExpired: false, result: { artifactId: 'artifact-a', preview: 'first result' } });
  assert.deepEqual(await concurrentRead, first);
  assert.deepEqual(await core.get(first.childId, { runId: first.runId }), first);
});

test('run deadline returns identity during pending open; abort does not stop and shutdown closes the late worker', async () => {
  const { core, engine } = setup();
  const originalOpen = engine.open.bind(engine);
  let releaseOpen!: () => void;
  let signalOpen!: () => void;
  let closeCalls = 0;
  const openGate = new Promise<void>(resolve => { releaseOpen = resolve; });
  const openStarted = new Promise<void>(resolve => { signalOpen = resolve; });
  engine.open = async input => {
    signalOpen();
    await openGate;
    const worker = await originalOpen(input);
    return { ...worker, close: async () => { closeCalls++; return worker.close(); } };
  };
  const controller = new AbortController();
  const pending = core.run({ prompt: 'slow start', templateId: 'researcher', model: args, workspaceRoot: '/repo', waitMs: 5 }, controller.signal);
  const snapshot = await pending;
  assert.deepEqual(snapshot, { childId: 'child-1', runId: 'run-1', status: 'running', waitExpired: true });
  controller.abort();
  assert.equal((await core.get(snapshot.childId, { runId: snapshot.runId })).status, 'running');
  let shutdownFinished = false;
  const shutdown = core.shutdown().then(() => { shutdownFinished = true; });
  try {
    await openStarted;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(shutdownFinished, false, 'shutdown keeps responsibility for the accepted worker while open is pending');
    releaseOpen();
    await shutdown;
  } finally {
    releaseOpen();
    await shutdown;
  }
  assert.equal(engine.runs.length, 0, 'shutdown prevents the late-opened worker from entering worker.run');
  assert.equal(closeCalls, 1, 'shutdown closes the late-opened worker');
  await eventuallyAsync(async () => (await core.get(snapshot.childId, { runId: snapshot.runId })).status === 'stopped');
});

test('explicit stop accepted during worker initialization prevents worker.run and reaps the late worker', async () => {
  const { core, engine } = setup();
  const originalOpen = engine.open.bind(engine);
  let releaseOpen!: () => void;
  let signalOpen!: () => void;
  let closeCalls = 0;
  const openGate = new Promise<void>(resolve => { releaseOpen = resolve; });
  const openStarted = new Promise<void>(resolve => { signalOpen = resolve; });
  engine.open = async input => {
    signalOpen();
    await openGate;
    const worker = await originalOpen(input);
    return { ...worker, close: async () => { closeCalls++; return worker.close(); } };
  };
  const pending = core.run({ prompt: 'must not execute', templateId: 'researcher', model: args, workspaceRoot: '/repo', waitMs: 500 });
  try {
    await openStarted;
    assert.deepEqual(await core.stop('child-1', 'run-1'), { requested: true, confirmed: false });
    releaseOpen();
    const result = await pending;
    assert.equal(result.status, 'stopped');
    assert.equal(engine.runs.length, 0, 'stopped pending work never enters worker.run');
    assert.equal(closeCalls, 1, 'the opened worker is reaped without running');
  } finally {
    releaseOpen();
    await pending.catch(() => undefined);
  }
});

test('shutdown preserves interrupted recovery when a late worker cannot confirm close', async () => {
  const { core, engine } = setup();
  engine.failClose = true;
  const originalOpen = engine.open.bind(engine);
  let releaseOpen!: () => void;
  let signalOpen!: () => void;
  let closeCalls = 0;
  const openGate = new Promise<void>(resolve => { releaseOpen = resolve; });
  const openStarted = new Promise<void>(resolve => { signalOpen = resolve; });
  engine.open = async input => {
    signalOpen();
    await openGate;
    const worker = await originalOpen(input);
    return { ...worker, close: async () => { closeCalls++; return worker.close(); } };
  };
  const pending = core.run({ prompt: 'uncertain late close', templateId: 'researcher', model: args, workspaceRoot: '/repo', waitMs: 5 });
  const snapshot = await pending;
  assert.equal(snapshot.waitExpired, true);
  const shutdown = core.shutdown();
  try {
    await openStarted;
    releaseOpen();
    await shutdown;
  } finally {
    releaseOpen();
    await shutdown;
  }
  assert.equal(engine.runs.length, 0, 'shutdown never starts the worker when closing a late open');
  assert.equal(closeCalls, 1, 'shutdown attempts to close the late worker');
  assert.equal((await core.get(snapshot.childId, { runId: snapshot.runId })).status, 'interrupted');
  await assert.rejects(core.resume(snapshot.childId, args), { code: 'recovery_required' });
});

test('accepted run observation abort leaves its worker running until explicit stop', async () => {
  const { core, engine, store } = setup();
  let signalSubscribed!: () => void;
  const subscribed = new Promise<void>(resolve => { signalSubscribed = resolve; });
  const originalSubscribe = store.subscribe.bind(store);
  store.subscribe = async (...args) => { const value = await originalSubscribe(...args); signalSubscribed(); return value; };
  const controller = new AbortController();
  const pending = core.run({ prompt: 'abort observation', templateId: 'researcher', model: args, workspaceRoot: '/repo', waitMs: 10_000 }, controller.signal);
  await eventuallyAsync(async () => engine.runs.length === 1);
  await subscribed;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(engine.runs[0]!.stopCalls, 0);
  assert.equal((await core.get('child-1', { runId: 'run-1' })).status, 'running');
  await core.stop('child-1', 'run-1');
});

test('run reports an elapsed positive deadline after delayed admission commits', async () => {
  const { core, store, engine } = setup();
  let releaseCreate!: () => void;
  let signalCreate!: () => void;
  const gate = new Promise<void>(resolve => { releaseCreate = resolve; });
  const started = new Promise<void>(resolve => { signalCreate = resolve; });
  const originalCreate = store.createChild.bind(store);
  store.createChild = async (...args) => { signalCreate(); await gate; return originalCreate(...args); };
  const pending = core.run({ prompt: 'slow admission', templateId: 'researcher', model: args, workspaceRoot: '/repo', waitMs: 5 });
  await started;
  await new Promise(resolve => setTimeout(resolve, 15));
  releaseCreate();
  const snapshot = await pending;
  assert.deepEqual(snapshot, { childId: 'child-1', runId: 'run-1', status: 'running', waitExpired: true });
  assert.equal(engine.runs.length, 1);
  await core.stop(snapshot.childId, snapshot.runId);
});

test('run progress reports only safe non-text milestones and cannot break the wait', async () => {
  const { core, engine } = setup();
  const seen: string[] = [];
  const pending = core.run({ prompt: 'progress', templateId: 'researcher', model: args, workspaceRoot: '/repo', waitMs: 500 }, undefined, event => {
    seen.push(event.type);
    throw new Error('broken host progress callback');
  });
  await eventuallyAsync(async () => engine.runs.length === 1);
  engine.runs[0]!.emit({ type: 'text', text: 'private transcript text' });
  engine.runs[0]!.emit({ type: 'tool', name: 'read_file', state: 'started' });
  engine.runs[0]!.complete({ checkpointId: 'leaf', artifactId: 'artifact', preview: 'done' });
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.waitExpired, false);
  assert.deepEqual(seen, ['run_started', 'tool', 'completed']);
});

test('run rejects unknown child and mismatched run without exposing another result', async () => {
  const { core } = setup();
  await assert.rejects(core.get('missing', { runId: 'run-x' }), { code: 'not_found' });
  const first = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  const second = await core.spawn({ prompt: 'second', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  await assert.rejects(core.get(second.childId, { runId: first.runId }), { code: 'not_found' });
});

test('run-specific reads keep the prior result while an immediate successor runs', async () => {
  const { core, engine } = setup();
  const firstPending = core.run({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo', waitMs: 500 });
  await eventuallyAsync(async () => engine.runs.length === 1);
  const successor = await core.send('child-1', { mode: 'followup', message: 'next' });
  engine.runs[0]!.complete({ checkpointId: 'leaf-first', artifactId: 'artifact-first', preview: 'first result' });
  const first = await firstPending;
  await eventuallyAsync(async () => engine.runs.length === 2);
  const reread = await core.get(first.childId, { runId: first.runId, waitMs: 500 });
  assert.equal(reread.status, 'completed');
  assert.equal(reread.result?.artifactId, 'artifact-first');
  assert.equal((await core.get(first.childId)).activeRunId, successor.runId);
  await core.stop(first.childId, successor.runId);
});

test('run returns the stored failure and zero-wait reads never mark expiry', async () => {
  const { core, engine } = setup();
  const pending = core.run({ prompt: 'will fail', templateId: 'researcher', model: args, workspaceRoot: '/repo', waitMs: 500 });
  await eventuallyAsync(async () => engine.runs.length === 1);
  engine.runs[0]!.fail('provider_error', 'failed');
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'provider_error');
  const immediate = await core.get(result.childId, { runId: result.runId, waitMs: 0 });
  assert.equal(immediate.waitExpired, false);
});

test('run snapshots report stopped and interrupted outcomes without a prior result', async () => {
  const stoppedSetup = setup();
  const stoppedPending = stoppedSetup.core.run({ prompt: 'stop me', templateId: 'researcher', model: args, workspaceRoot: '/repo', waitMs: 500 });
  await eventuallyAsync(async () => stoppedSetup.engine.runs.length === 1);
  await stoppedSetup.core.stop('child-1', 'run-1');
  const stopped = await stoppedPending;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.result, undefined);

  const interruptedSetup = setup();
  interruptedSetup.engine.failClose = true;
  const interruptedPending = interruptedSetup.core.run({ prompt: 'uncertain exit', templateId: 'researcher', model: args, workspaceRoot: '/repo', waitMs: 500 });
  await eventuallyAsync(async () => interruptedSetup.engine.runs.length === 1);
  interruptedSetup.engine.runs[0]!.complete({ checkpointId: 'leaf', artifactId: 'should-not-be-success', preview: 'no' });
  const interrupted = await interruptedPending;
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.errorCode, 'worker_exit_unconfirmed');
  assert.equal(interrupted.result, undefined);
});

test('abort before admission commits no child or worker', async () => {
  const { core, engine, store } = setup();
  const controller = new AbortController();
  const pending = core.run({ prompt: 'cancel before acceptance', templateId: 'researcher', model: args, workspaceRoot: '/repo', waitMs: 500 }, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal((await store.dump()).length, 0);
  assert.equal(engine.opened.length, 0);
});

test('info and list expose safe metadata and output reads are bounded chunks', async () => {
  const reader = async (artifactId: string, offset: number, length: number) => ({ artifactId, offset, text: 'chunk'.slice(0, length), nextOffset: offset + Math.min(5, length), eof: true });
  const { core } = setup({}, [template], reader);
  const created = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  const info = await core.info();
  assert.equal(info.protocolVersion, '0.2');
  assert.equal(JSON.stringify(info).includes(args.key), false);
  assert.deepEqual(info.templates.map(item => item.id), ['researcher']);
  const rows = await core.list('/repo');
  assert.equal(rows[0]?.templateId, 'researcher');
  assert.equal('templateSnapshot' in rows[0]!, false);
  assert.deepEqual(await core.readArtifact('artifact-1', 5, 5), { artifactId: 'artifact-1', offset: 5, text: 'chunk', nextOffset: 10, eof: true });
  await assert.rejects(core.readArtifact('artifact-1', 0, 65537), { code: 'invalid_request' });
  assert.equal(created.childId, 'child-1');
});

test('wire schemas parse and use credential references rather than raw keys', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/wire-operations.schema.json', import.meta.url), 'utf8'));
  const responseSchema = JSON.parse(await readFile(new URL('../schemas/wire-responses.schema.json', import.meta.url), 'utf8'));
  const templateSchema = JSON.parse(await readFile(new URL('../schemas/templates.schema.json', import.meta.url), 'utf8'));
  const fixture = JSON.parse(await readFile(new URL('../conformance/valid-spawn.json', import.meta.url), 'utf8'));
  const runFixture = JSON.parse(await readFile(new URL('../conformance/valid-run.json', import.meta.url), 'utf8'));
  const runSnapshots = JSON.parse(await readFile(new URL('../conformance/run-snapshots.json', import.meta.url), 'utf8')) as Array<{ status: string; waitExpired: boolean; [key: string]: unknown }>;
  for (const snapshot of runSnapshots) assert.equal(Value.Check(responseSchema, snapshot), true, JSON.stringify(snapshot));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(responseSchema.$schema, schema.$schema);
  assert.equal(templateSchema.$schema, schema.$schema);
  assert.deepEqual(Object.keys(schema.$defs.credentialModel.properties).sort(), ['api', 'credentialRef', 'model', 'url']);
  assert.equal(schema.$defs.spawn.properties.arguments.required.includes('workspaceRoot'), false);
  assert.equal('workspaceRoot' in schema.$defs.spawn.properties.arguments.properties, false);
  assert.deepEqual(schema.$defs.run.properties.arguments.required, ['prompt', 'templateId', 'model']);
  assert.deepEqual(Object.keys(schema.$defs.get.properties.arguments.properties).sort(), ['childId', 'cursor', 'eventLimit', 'previewLimit', 'runId', 'waitMs']);
  assert.equal(schema.$defs.get.properties.arguments.properties.runId.minLength, 1);
  assert.equal(responseSchema.$defs.runSnapshot.properties.waitExpired.type, 'boolean');
  assert.equal(schema.$id, 'urn:subzero:protocol:0.2:operations');
  assert.equal(responseSchema.$id, 'urn:subzero:protocol:0.2:responses');
  assert.equal(templateSchema.$id, 'urn:subzero:protocol:0.1:templates');
  assert.equal(fixture.arguments.model.credentialRef, 'MODEL_KEY');
  assert.equal('key' in fixture.arguments.model, false);
  assert.equal(runFixture.operation, 'subzero_run');
  assert.equal(runFixture.arguments.model.credentialRef, 'MODEL_KEY');
  assert.equal('key' in runFixture.arguments.model, false);
  assert.deepEqual(runSnapshots.map(snapshot => snapshot.status), ['completed', 'running', 'failed', 'stopped', 'interrupted']);
  assert.equal(runSnapshots[1]?.waitExpired, true);
  assert.ok(runSnapshots.every(snapshot => Object.keys(snapshot).every(key => ['childId', 'runId', 'status', 'waitExpired', 'result', 'errorCode'].includes(key))));
  assert.ok(runSnapshots.filter(snapshot => snapshot.status === 'completed').every(snapshot => JSON.stringify(snapshot.result).includes('artifact-a')));
  const { core } = setup();
  await assert.rejects(core.spawn({ prompt: 'host injects root', templateId: 'researcher', model: args } as never), { code: 'invalid_request' });
});

test('operation objects reject unknown fields, including credential-bearing model extras', async () => {
  const { core } = setup();
  await assert.rejects(core.spawn({ prompt: 'x', templateId: 'researcher', model: { ...args, unexpectedKey: 'sensitive' }, workspaceRoot: '/repo' } as never), { code: 'invalid_request' });
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  await assert.rejects(core.send(child.childId, { mode: 'followup', message: 'x', queuePolicy: 'silent' } as never), { code: 'invalid_request' });
  await assert.rejects(core.get(child.childId, { cursor: 0, includeTranscript: true } as never), { code: 'invalid_request' });
});

test('template snapshots freeze skill content and explicit MCP launch descriptors', async () => {
  const definition = structuredClone(template);
  definition.skills = [{ name: 'project-guide', content: 'Read the project guide.' }];
  definition.mcpServers = [{ name: 'docs', command: 'mcp-docs', args: ['--local'], envRefs: ['secret:DOCS_TOKEN'], tools: ['search'], writeCapable: false }];
  const { core, store, engine } = setup({}, [definition]);
  const child = await core.spawn({ prompt: 'read docs', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  definition.skills[0]!.content = 'mutated';
  definition.mcpServers[0]!.args![0] = '--changed';
  const snapshot = (await store.getChild(child.childId))!.templateSnapshot;
  assert.equal(snapshot.skills[0]?.content, 'Read the project guide.');
  assert.equal(snapshot.mcpServers[0]?.command, 'mcp-docs');
  assert.equal(snapshot.mcpServers[0]?.args?.[0], '--local');
  assert.equal(engine.opened[0]?.templateSnapshot.skills[0]?.content, 'Read the project guide.');
});

test('invalid MCP argument and environment reference shapes become invalid_request errors', async () => {
  for (const patch of [
    { args: 'not-an-array' },
    { envRefs: 'secret:TOKEN' },
    { workerAdapter: '' },
    { workerVersion: 4 },
  ]) {
    const definition = structuredClone(template) as any;
    definition.mcpServers = [{ name: 'docs', command: 'mcp-docs', tools: [], writeCapable: false, ...patch }];
    const { core } = setup();
    await assert.rejects(core.registerTemplate(definition), { name: 'SubzeroError', code: 'invalid_request' });
  }
});

test('stored user templates remain discoverable and spawnable after creating a new core service', async () => {
  const { core, store } = setup();
  await core.registerTemplate({ ...template, id: 'persisted-researcher' });
  const restarted = createSubzero({
    store, engineFactory: new ControlledEngineFactory(), templates: [], ids: { child: () => 'child-restarted', run: () => 'run-restarted', token: () => 'owner-restarted' },
    clock: () => new Date('2026-10-07T12:00:00.000Z'), worker: { name: 'fake', version: '1', capabilities: [] },
  });
  assert.equal((await restarted.info()).templates[0]?.id, 'persisted-researcher');
  const child = await restarted.spawn({ prompt: 'after restart', templateId: 'persisted-researcher', model: args, workspaceRoot: '/repo' });
  assert.equal(child.childId, 'child-restarted');
});

test('followups queue in core and dispatch from the completed checkpoint after the prior run settles', async () => {
  const { core, engine } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  const sent = await core.send(child.childId, { mode: 'followup', message: 'second' });
  assert.equal(sent.delivery, 'queued');
  assert.equal(engine.runs.length, 1);
  engine.runs[0]!.complete({ checkpointId: 'leaf-1', artifactId: 'artifact-1', preview: 'done' });
  await eventually(() => engine.runs.length === 2);
  assert.equal(engine.runs.length, 2);
  assert.equal(engine.runs[1]?.input.fromCheckpointId, 'leaf-1');
  assert.equal(engine.runs[1]?.input.prompt, 'second');
});

test('failed queued worker open clears later followups and keeps the completed checkpoint', async () => {
  const { core, store, engine } = setup();
  const originalOpen = engine.open.bind(engine);
  let opens = 0;
  engine.open = async input => {
    opens++;
    if (opens === 2) throw new Error('queued worker failed to start');
    return originalOpen(input);
  };
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  const second = await core.send(child.childId, { mode: 'followup', message: 'second' });
  const third = await core.send(child.childId, { mode: 'followup', message: 'third' });
  engine.runs[0]!.complete({ checkpointId: 'retained-leaf', artifactId: 'artifact-1', preview: 'done' });
  await eventuallyAsync(async () => (await core.get(child.childId)).state === 'ready');
  assert.equal(opens, 2);
  assert.equal(engine.runs.length, 1);
  const snapshot = await core.get(child.childId);
  assert.equal(snapshot.lastCompletedLeaf, 'retained-leaf');
  assert.equal(snapshot.activeRunId, undefined);
  assert.deepEqual((await store.dumpRuns(child.childId)).filter(run => [second.runId, third.runId].includes(run.runId)).map(run => run.status), ['failed', 'stopped']);
});

test('failed, interrupted, and stopped runs clear queued work without dispatching it', async () => {
  for (const terminal of ['failed', 'interrupted', 'stopped'] as const) {
    const { core, store, engine } = setup();
    const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
    const queued = await core.send(child.childId, { mode: 'followup', message: `queued after ${terminal}` });
    if (terminal === 'failed') engine.runs[0]!.fail('worker_error');
    else if (terminal === 'stopped') await core.stop(child.childId, child.runId);
    else {
      engine.failClose = true;
      engine.runs[0]!.complete({ checkpointId: 'uncommitted-leaf', artifactId: 'artifact-1', preview: 'done' });
    }
    await eventuallyAsync(async () => (await core.get(child.childId)).state !== 'running');
    assert.equal(engine.runs.length, 1);
    const run = (await store.dumpRuns(child.childId)).find(item => item.runId === queued.runId);
    assert.equal(run?.status, 'stopped');
  }
});

test('followup admitted while the completed worker is closing is queued and dispatched from its checkpoint', async () => {
  const { core, engine } = setup();
  engine.holdNextClose();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  engine.runs[0]!.complete({ checkpointId: 'leaf-close-race', artifactId: 'artifact-1', preview: 'done' });
  await engine.closeStarted;
  const sent = await core.send(child.childId, { mode: 'followup', message: 'second during close' });
  assert.equal(sent.delivery, 'queued');
  engine.finishClose();
  await eventually(() => engine.runs.length === 2);
  assert.equal(engine.runs[1]?.input.fromCheckpointId, 'leaf-close-race');
});

test('followup admitted between worker close and atomic settle is retained in the core queue', async () => {
  const { core, store, engine } = setup();
  store.holdNextSettle();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  engine.runs[0]!.complete({ checkpointId: 'leaf-settle-race', artifactId: 'artifact-1', preview: 'done' });
  await store.settleStarted;
  const sent = await core.send(child.childId, { mode: 'followup', message: 'second during settle' });
  assert.equal(sent.delivery, 'queued');
  store.finishSettle();
  await eventually(() => engine.runs.length === 2);
  assert.equal(engine.runs[1]?.input.fromCheckpointId, 'leaf-settle-race');
});

test('send requires explicit mode and steer rejects when the worker does not advertise it', async () => {
  const { core } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  await assert.rejects(core.send(child.childId, { mode: 'steer', message: 'change course' }), { code: 'unsupported_steer' });
});

test('another broker can inspect a live child but cannot send or stop to its worker', async () => {
  const { core, store, engine } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  const peer = createSubzero({
    store, engineFactory: new ControlledEngineFactory(), templates: [template], ids: { child: () => 'peer-child', run: () => 'peer-run', token: () => 'peer-token' },
    clock: () => new Date('2026-10-07T12:00:00.000Z'), worker: { name: 'fake', version: '1', capabilities: [] },
  });
  assert.equal((await peer.get(child.childId)).state, 'running');
  await assert.rejects(peer.send(child.childId, { mode: 'followup', message: 'remote write' }), { code: 'busy' });
  await assert.rejects(peer.stop(child.childId, child.runId), { code: 'busy' });
  assert.equal(engine.runs.length, 1);
});

test('stop rejects stale run ids without affecting the active worker and confirms a matching stop', async () => {
  const { core, engine } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  await assert.rejects(core.stop(child.childId, 'older-run'), { code: 'stale_run' });
  assert.equal(engine.runs[0]?.stopCalls, 0);
  const stopped = await core.stop(child.childId, child.runId);
  assert.equal(stopped.requested, true);
  assert.equal(stopped.confirmed, true);
  assert.equal(engine.runs[0]?.stopCalls, 1);
});

test('stop is idempotent for a completed run and a prior run cannot stop its queued successor', async () => {
  const { core, engine } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  const queued = await core.send(child.childId, { mode: 'followup', message: 'second' });
  engine.runs[0]!.complete({ checkpointId: 'leaf-1', artifactId: 'artifact-1', preview: 'done' });
  await eventually(() => engine.runs.length === 2);
  await assert.rejects(core.stop(child.childId, child.runId), { code: 'stale_run' });
  assert.equal(engine.runs[1]?.stopCalls, 0);
  const result = await core.stop(child.childId, queued.runId);
  assert.equal(result.confirmed, true);
  const again = await core.stop(child.childId, queued.runId);
  assert.deepEqual(again, { requested: false, confirmed: true });
});

test('shutdown stops owned workers and clears their queued followups', async () => {
  const { core, engine } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  await core.send(child.childId, { mode: 'followup', message: 'queued' });
  await core.shutdown();
  assert.equal(engine.runs[0]?.stopCalls, 1);
  assert.equal(engine.runs.length, 1);
  assert.equal((await core.get(child.childId)).state, 'ready');
});

test('shutdown prevents an already-admitted pending EngineFactory.open from starting execution', async () => {
  const { core, engine, store } = setup();
  const originalOpen = engine.open.bind(engine);
  let releaseOpen!: () => void;
  let signalOpen!: () => void;
  const openGate = new Promise<void>(resolve => { releaseOpen = resolve; });
  const openStarted = new Promise<void>(resolve => { signalOpen = resolve; });
  engine.open = async input => { signalOpen(); await openGate; return originalOpen(input); };
  const spawning = core.spawn({ prompt: 'pending engine open', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  let shutdownFinished = false;
  const shutdown = core.shutdown().then(() => { shutdownFinished = true; });
  try {
    await openStarted;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(shutdownFinished, false, 'shutdown stays open until the admitted worker open is settled');
  } finally {
    releaseOpen();
    await spawning;
    await shutdown;
    await core.shutdown();
  }
  assert.equal(engine.runs.length, 0, 'shutdown does not start a worker after waiting for the admitted open');
  assert.equal((await store.getChild('child-1'))?.state, 'ready');
});

test('shutdown prevents execution when a pending admission resolves after shutdown begins', async () => {
  const { core, engine, store } = setup();
  const originalCreateChild = store.createChild.bind(store);
  let releaseCreate!: () => void;
  let signalCreate!: () => void;
  const createGate = new Promise<void>(resolve => { releaseCreate = resolve; });
  const createStarted = new Promise<void>(resolve => { signalCreate = resolve; });
  store.createChild = async (...input) => {
    signalCreate();
    await createGate;
    return originalCreateChild(...input);
  };
  const spawning = core.spawn({ prompt: 'pending admission during shutdown', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  await createStarted;
  const shutdown = core.shutdown();
  try {
    releaseCreate();
    const child = await spawning;
    await shutdown;
    assert.equal(engine.runs.length, 0, 'an admission resolving during shutdown never enters worker.run');
    assert.equal((await core.get(child.childId)).state, 'ready');
  } finally {
    releaseCreate();
    await spawning.catch(() => undefined);
    await shutdown;
  }
});

test('resume without a message validates and stores credentials but starts no run; message resumes at last completed leaf', async () => {
  const { core, engine, store } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  engine.runs[0]!.complete({ checkpointId: 'leaf-1', artifactId: 'artifact-1', preview: 'done' });
  await eventuallyAsync(async () => (await core.get(child.childId)).state === 'ready');
  const count = engine.runs.length;
  const selectedModel = { url: 'https://other.example/v1', model: 'model-y', key: 'new-secret' };
  const ready = await core.resume(child.childId, selectedModel);
  assert.equal(ready.state, 'ready');
  assert.equal(engine.runs.length, count);
  const resumed = await core.resume(child.childId, selectedModel, 'continue from the checkpoint');
  if (resumed.state !== 'running') throw new Error('resume with a message must start a run');
  assert.equal(resumed.runId, 'run-2');
  assert.equal(engine.runs[1]?.input.fromCheckpointId, 'leaf-1');
  assert.equal(engine.opened[1]?.model.model, 'model-y');
  assert.equal(JSON.stringify(await store.dump()).includes(args.key), false);
  assert.equal(JSON.stringify(await store.dump()).includes(selectedModel.key), false);
});

test('checkpoint rejection during resume leaves model and child state unchanged', async () => {
  const { core, store, engine } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  engine.runs[0]!.complete({ checkpointId: 'leaf-1', artifactId: 'artifact-1', preview: 'done' });
  await eventuallyAsync(async () => (await core.get(child.childId)).state === 'ready');
  const before = structuredClone(await store.getChild(child.childId));
  engine.validateCheckpoint = async () => { throw new Error('incompatible'); };
  await assert.rejects(core.resume(child.childId, { url: 'https://other.example/v1', model: 'new-model', key: 'other-secret' }), { code: 'checkpoint_incompatible' });
  const after = await store.getChild(child.childId);
  assert.deepEqual(after?.model, before?.model);
  assert.equal(after?.state, before?.state);
  assert.equal(after?.ownerGeneration, before?.ownerGeneration);
  assert.equal(after?.lastCompletedLeaf, before?.lastCompletedLeaf);
});

test('resume commit fails busy if another owner claims the child after checkpoint validation', async () => {
  const { core, store, engine } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  engine.runs[0]!.complete({ checkpointId: 'leaf-1', artifactId: 'artifact-1', preview: 'done' });
  await eventuallyAsync(async () => (await core.get(child.childId)).state === 'ready');
  let signal!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { signal = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  engine.validateCheckpoint = async () => { signal(); await gate; };
  const pending = core.resume(child.childId, { url: 'https://other.example/v1', model: 'new-model', key: 'other-secret' });
  await started;
  store.claimForOtherBroker(child.childId);
  release();
  await assert.rejects(pending, { code: 'busy' });
  assert.deepEqual((await store.getChild(child.childId))?.model, { url: args.url, model: args.model });
});

test('a broker with cached credentials cannot send after another broker commits a different model', async () => {
  const { core, store, engine } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  engine.runs[0]!.complete({ checkpointId: 'leaf-1', artifactId: 'artifact-1', preview: 'done' });
  await eventuallyAsync(async () => (await core.get(child.childId)).state === 'ready');
  const peer = createSubzero({
    store, engineFactory: new ControlledEngineFactory(), templates: [template], ids: { child: () => 'peer-child', run: () => 'peer-run', token: () => 'peer-token' },
    clock: () => new Date('2026-10-07T12:00:00.000Z'), worker: { name: 'fake', version: '1', capabilities: [] },
  });
  const modelA = { url: 'https://a.example/v1', model: 'model-a', key: 'key-a' };
  const modelB = { url: 'https://b.example/v1', model: 'model-b', key: 'key-b' };
  await core.resume(child.childId, modelA);
  await peer.resume(child.childId, modelB);
  assert.deepEqual((await store.getChild(child.childId))?.model, { url: modelB.url, model: modelB.model });
  await assert.rejects(core.send(child.childId, { mode: 'followup', message: 'must use saved model' }), { code: 'credentials_required' });
});

test('get reports a cursor gap and bounds its event batch and output preview', async () => {
  const { core, store, engine } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  for (let i = 0; i < 8; i++) engine.runs[0]!.emit({ type: 'tool', name: `tool-${i}`, state: 'finished' });
  await eventuallyAsync(async () => (await store.dump())[0]?.events.length === 9);
  await store.pruneEvents(child.childId, 4);
  engine.runs[0]!.complete({ checkpointId: 'leaf-1', artifactId: 'artifact-1', preview: 'x'.repeat(2000) });
  await eventuallyAsync(async () => (await core.get(child.childId)).state === 'ready');
  const snapshot = await core.get(child.childId, { cursor: 0, eventLimit: 2, previewLimit: 64 });
  assert.equal(snapshot.cursorGap, true);
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.result?.preview.length, 64);
  assert.equal(snapshot.nextCursor, snapshot.events[1]?.seq);
  const subscription = core.subscribe(child.childId, 0)[Symbol.asyncIterator]();
  assert.deepEqual(await subscription.next(), { value: { type: 'cursor_gap', requestedCursor: 0, oldestCursor: snapshot.oldestCursor }, done: false });
  await subscription.return?.();

  const unicodeChild = await core.spawn({ prompt: 'unicode preview', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  engine.runs[1]!.complete({ checkpointId: 'leaf-u', artifactId: 'artifact-u', preview: '🙂'.repeat(300) });
  await eventuallyAsync(async () => (await core.get(unicodeChild.childId)).state === 'ready');
  const unicodeSnapshot = await core.get(unicodeChild.childId, { previewLimit: 10 });
  assert.equal(unicodeSnapshot.result?.preview, '🙂🙂');
  assert.equal((await core.get(unicodeChild.childId, { previewLimit: 3 })).result?.preview, '');
});

test('limits reject oversized UTF-8 prompts, excessive grants, active worker count, and a second writer', async () => {
  const { core } = setup({ active: 2, writers: 1 });
  await assert.rejects(core.spawn({ prompt: '🙂'.repeat(17000), templateId: 'researcher', model: args, workspaceRoot: '/repo' }), { code: 'limit_exceeded' });
  assert.throws(() => setup({}, [tooManyTools]), { code: 'limit_exceeded' });
  const one = await core.spawn({ prompt: 'write', templateId: 'coder', model: args, workspaceRoot: '/repo' });
  await assert.rejects(core.spawn({ prompt: 'second writer', templateId: 'coder', model: args, workspaceRoot: '/repo' }), { code: 'workspace_busy' });
  const second = await core.spawn({ prompt: 'read', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  await assert.rejects(core.spawn({ prompt: 'over active cap', templateId: 'researcher', model: args, workspaceRoot: '/repo' }), { code: 'workspace_busy' });
  assert.equal(one.childId, 'child-1');
  assert.equal(second.childId, 'child-3');
});

test('subscribe starts after its cursor and receives later events', async () => {
  const { core, engine } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  const iterator = core.subscribe(child.childId, 0)[Symbol.asyncIterator]();
  await iterator.next(); // The initial run_started event is sequence 1.
  engine.runs[0]!.emit({ type: 'text', text: 'hello' });
  engine.runs[0]!.emit({ type: 'tool', name: 'read_file', state: 'started' });
  const next = await iterator.next();
  assert.equal(next.value?.type, 'tool');
  assert.equal(next.value?.type === 'tool' && next.value.name, 'read_file');
  await iterator.return?.();
});

test('worker output and errors redact the in-memory model key before persistence or return', async () => {
  const { core, store, engine } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  engine.runs[0]!.emit({ type: 'text', text: `provider echoed ${args.key}` });
  engine.runs[0]!.complete({ checkpointId: 'leaf-1', artifactId: 'artifact-1', preview: `result ${args.key}` });
  await eventuallyAsync(async () => (await core.get(child.childId)).state === 'ready');
  const serialized = JSON.stringify(await store.dump());
  assert.equal(serialized.includes(args.key), false);
  assert.equal(serialized.includes('[REDACTED]'), true);
  assert.equal(JSON.stringify(await core.get(child.childId)).includes(args.key), false);
});

test('failed runs preserve the last completed checkpoint without replaying failed input', async () => {
  const { core, engine } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  engine.runs[0]!.complete({ checkpointId: 'safe-leaf', artifactId: 'artifact-1', preview: 'done' });
  await eventuallyAsync(async () => (await core.get(child.childId)).state === 'ready');
  const second = await core.send(child.childId, { mode: 'followup', message: 'effect may be partial' });
  assert.equal(second.delivery, 'started');
  engine.runs[1]!.fail('provider_error', 'temporary failure');
  await eventuallyAsync(async () => (await core.get(child.childId)).state === 'ready');
  const snapshot = await core.get(child.childId);
  assert.equal(snapshot.lastCompletedLeaf, 'safe-leaf');
  const resumed = await core.resume(child.childId, args, 'new request');
  if (resumed.state !== 'running') throw new Error('resume with a message must start a run');
  assert.equal(engine.runs[2]?.input.fromCheckpointId, 'safe-leaf');
  assert.equal(resumed.runId, 'run-3');
});

test('unconfirmed worker exit preserves ownership and refuses resume without advancing checkpoint', async () => {
  const { core, engine } = setup();
  engine.failClose = true;
  const child = await core.spawn({ prompt: 'possibly partial', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  engine.runs[0]!.complete({ checkpointId: 'unsafe-leaf', artifactId: 'artifact-1', preview: 'done' });
  await eventuallyAsync(async () => (await core.get(child.childId)).state === 'interrupted');
  const snapshot = await core.get(child.childId);
  assert.equal(snapshot.lastCompletedLeaf, undefined);
  await assert.rejects(core.resume(child.childId, args), { code: 'recovery_required' });
});

test('stop remains unconfirmed when the worker process exit cannot be verified', async () => {
  const { core, engine } = setup();
  engine.failClose = true;
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  const stopped = await core.stop(child.childId, child.runId);
  assert.deepEqual(stopped, { requested: true, confirmed: false });
  assert.equal((await core.get(child.childId)).state, 'interrupted');
});

test('provider failure text containing the in-memory model key is redacted', async () => {
  const { core, store, engine } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  engine.runs[0]!.fail('provider_error', `rejected ${args.key}`);
  await eventuallyAsync(async () => (await core.get(child.childId)).state === 'ready');
  const persisted = JSON.stringify(await store.dump());
  assert.equal(persisted.includes(args.key), false);
  assert.equal(persisted.includes('[REDACTED]'), true);
});

test('audit: worker text is not persisted as orchestration events while terminal output remains redacted', async () => {
  const { core, store, engine } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  engine.runs[0]!.emit({ type: 'text', text: `provider echoed ${args.key}` });
  engine.runs[0]!.complete({ checkpointId: 'leaf-1', artifactId: 'artifact-1', preview: `result ${args.key}` });
  await eventuallyAsync(async () => (await core.get(child.childId)).state === 'ready');
  const persistedEvents = (await store.dump()).flatMap(row => row.events);
  assert.equal(persistedEvents.some(event => event.type === 'text'), false);
  const persisted = JSON.stringify(await store.dump());
  assert.equal(persisted.includes(args.key), false);
  assert.match(persisted, /\[REDACTED\]/);
  const read = JSON.stringify(await core.get(child.childId, { cursor: 0 }));
  assert.equal(read.includes(args.key), false);
  assert.match(read, /\[REDACTED\]/);
});

test('audit: template instructions plus resolved skill contents are bounded by instructionBytes in UTF-8', () => {
  const build = (skillEmoji: number) => ({
    ...structuredClone(template), instructions: '\u{1F642}'.repeat(8000),
    skills: [{ name: 'large-skill', content: '\u{1F642}'.repeat(skillEmoji) }],
  });
  assert.doesNotThrow(() => setup({}, [build(8000)]), 'combined 64000 bytes is within 65536');
  assert.throws(() => setup({}, [build(9000)]), { code: 'limit_exceeded' });
});

test('audit: streaming redactor replaces a secret split at every boundary and emits no fragment', () => {
  const secret = 'sk-synthetic-redactor-4821';
  for (let split = 0; split <= secret.length; split++) {
    const redactor = createTextRedactor([secret]);
    const first = redactor.push(`before ${secret.slice(0, split)}`);
    assert.equal(first.includes(secret.slice(0, Math.max(split, 1))) && split > 0, false, `split ${split} emitted a secret fragment: ${first}`);
    const joined = first + redactor.push(`${secret.slice(split)} after`) + redactor.flush();
    assert.equal(joined, 'before [REDACTED] after', `split ${split}`);
  }
});

test('audit: streaming redactor handles overlapping prefixes, adjacent repeats, and several chunks', () => {
  const overlapping = createTextRedactor(['abc', 'abcd']);
  assert.equal(overlapping.push('xabcd') + overlapping.flush(), 'x[REDACTED]');
  const shorter = createTextRedactor(['abc', 'abcd']);
  assert.equal(shorter.push('abc') + shorter.push('z') + shorter.flush(), '[REDACTED]z');
  const trailing = createTextRedactor(['abc', 'abcd']);
  assert.equal(trailing.push('abc') + trailing.flush(), '[REDACTED]');
  const repeats = createTextRedactor(['secret']);
  assert.equal(repeats.push('sec') + repeats.push('retsec') + repeats.push('ret') + repeats.flush(), '[REDACTED][REDACTED]');
  const pieces = createTextRedactor(['secret']);
  assert.equal([...'secret!'].map(character => pieces.push(character)).join('') + pieces.flush(), '[REDACTED]!');
});

test('audit: streaming redactor preserves Unicode and non-secret text and releases incomplete suffixes on flush', () => {
  const redactor = createTextRedactor(['', 'secret\u{1F642}key']);
  assert.equal(redactor.push('héllo \u{1F642} wörld sec') + redactor.push('ret\u{1F642}') + redactor.push('key done'), 'héllo \u{1F642} wörld [REDACTED] done');
  const partial = createTextRedactor(['secret']);
  assert.equal(partial.push('a sec') + partial.push('ond') + partial.flush(), 'a second');
  const unfinished = createTextRedactor(['secret']);
  assert.equal(unfinished.push('end sec'), 'end ');
  assert.equal(unfinished.flush(), 'sec');
  assert.equal(unfinished.flush(), '');
  const marker = createTextRedactor(['ACTED']);
  assert.equal(marker.push('ACTED') + marker.push('x') + marker.flush(), '[REDACTED]x');
  assert.equal(createTextRedactor([]).push('plain'), 'plain');
});

test('audit: send fails busy when another broker commits a different model between observation and admission', async () => {
  const { core, store, engine } = setup();
  const peer = createSubzero({
    store, engineFactory: new ControlledEngineFactory(), templates: [template, coder], ids: ids(),
    clock: () => new Date('2026-10-07T12:00:00.000Z'), worker: { name: 'fake', version: '1', capabilities: [] },
  });
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  engine.runs[0]!.complete({ checkpointId: 'leaf-1', artifactId: 'artifact-1', preview: 'done' });
  await eventuallyAsync(async () => (await core.get(child.childId)).state === 'ready');
  const getChild = store.getChild.bind(store);
  store.getChild = async id => { const row = await getChild(id); return row && structuredClone(row); };
  const admitRun = store.admitRun.bind(store);
  const modelB = { ...args, model: 'model-b' };
  (store as any).admitRun = async (...admitArgs: Parameters<typeof admitRun>) => {
    await peer.resume(child.childId, modelB);
    return admitRun(...admitArgs);
  };
  const runsBefore = (await store.dumpRuns(child.childId)).length;
  await assert.rejects(core.send(child.childId, { mode: 'followup', message: 'stale model dispatch' }), { code: 'busy' });
  assert.equal(engine.opened.length, 1);
  assert.equal((await getChild(child.childId))?.model.model, 'model-b');
  assert.equal((await store.dumpRuns(child.childId)).length, runsBefore);
});

test('audit: a second stop after an unconfirmed worker exit reports recovery_required, not confirmation', async () => {
  const { core, engine } = setup();
  engine.failClose = true;
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  assert.deepEqual(await core.stop(child.childId, child.runId), { requested: true, confirmed: false });
  const before = await core.get(child.childId);
  assert.equal(before.state, 'interrupted');
  await assert.rejects(core.stop(child.childId, child.runId), { code: 'recovery_required' });
  const after = await core.get(child.childId);
  assert.equal(after.state, 'interrupted');
  assert.equal(after.lastCompletedLeaf, before.lastCompletedLeaf);
});

test('audit: a model key embedded in spawn, followup, and resume prompts is never persisted or dispatched', async () => {
  const { core, store, engine } = setup();
  const child = await core.spawn({ prompt: `spawn before ${args.key} after`, templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  engine.runs[0]!.complete({ checkpointId: 'leaf-1', artifactId: 'artifact-1', preview: 'done' });
  await eventuallyAsync(async () => (await core.get(child.childId)).state === 'ready');
  const followup = await core.send(child.childId, { mode: 'followup', message: `followup before ${args.key} after` });
  assert.equal(followup.delivery, 'started');
  engine.runs[1]!.complete({ checkpointId: 'leaf-2', artifactId: 'artifact-2', preview: 'done' });
  await eventuallyAsync(async () => (await core.get(child.childId)).state === 'ready');
  const resumed = await core.resume(child.childId, args, `resume before ${args.key} after`);
  assert.equal(resumed.state, 'running');
  assert.equal(JSON.stringify(await store.dump()).includes(args.key), false, 'persisted state contains the model key');
  for (const [index, label] of ['spawn', 'followup', 'resume'].entries()) {
    const prompt = engine.runs[index]!.input.prompt;
    assert.equal(prompt, `${label} before [REDACTED] after`);
  }
});

test('audit: a model key in steer messages is redacted before worker dispatch', async () => {
  const { core, engine } = setup();
  engine.steerable = true;
  const child = await core.spawn({ prompt: 'initial prompt', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  const steered = await core.send(child.childId, { mode: 'steer', message: `steer before ${args.key} after` });
  assert.equal(steered.delivery, 'steered');
  assert.deepEqual(engine.steered, ['steer before [REDACTED] after']);
  await assert.rejects(core.send(child.childId, { mode: 'steer', message: 'x'.repeat(64 * 1024 + 1) }), { code: 'limit_exceeded' });
});

async function withCapturedWaitTimeouts<T>(fn: (activeTimeouts: () => number) => Promise<T>): Promise<T> {
  const original = globalThis.setTimeout;
  const captured: Array<ReturnType<typeof setTimeout>> = [];
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
    const handle = (original as (...input: unknown[]) => ReturnType<typeof setTimeout>)(handler, delay, ...rest);
    if (delay === 30_000) captured.push(handle);
    return handle;
  }) as unknown as typeof setTimeout;
  try { return await fn(() => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length); }
  finally { globalThis.setTimeout = original; for (const handle of captured) clearTimeout(handle); }
}

test('audit: get cancellation rejects promptly without stopping the child', async () => {
  const { core, engine } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  const abort = new AbortController();
  await withCapturedWaitTimeouts(async () => {
    const waiting = core.get(child.childId, { waitMs: 30_000, cursor: 1 }, abort.signal);
    const outcome = waiting.then(() => 'resolved', () => 'rejected');
    await new Promise(resolve => setTimeout(resolve, 50));
    abort.abort();
    try {
      const raced = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('hung'), 500))]);
      assert.equal(raced, 'rejected');
      assert.equal(engine.runs[0]!.stopCalls, 0);
      assert.equal((await core.get(child.childId)).state, 'running');
    } finally {
      engine.runs[0]!.emit({ type: 'text', text: 'wake' });
      await outcome;
      await core.stop(child.childId, child.runId);
    }
  });
});

test('audit: a get that wakes early leaves no pending wait timeout', async () => {
  const { core, engine } = setup();
  const child = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  await withCapturedWaitTimeouts(async activeTimeouts => {
    const baseline = activeTimeouts();
    const waiting = core.get(child.childId, { waitMs: 30_000, cursor: 1 });
    await new Promise(resolve => setTimeout(resolve, 50));
    engine.runs[0]!.emit({ type: 'tool', name: 'wake', state: 'started' });
    const snapshot = await waiting;
    assert.ok(snapshot.events.length > 0);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(activeTimeouts() <= baseline, 'the 30 second wait timer is cleared after an early wake');
    await core.stop(child.childId, child.runId);
  });
});

async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(predicate(), true, 'expected asynchronous worker transition');
}

async function eventuallyAsync(predicate: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 50 && !(await predicate()); attempt++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(await predicate(), true, 'expected asynchronous worker transition');
}
