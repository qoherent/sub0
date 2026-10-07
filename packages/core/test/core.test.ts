import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSubzero } from '../src/index.ts';
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

test('info and list expose safe metadata and output reads are bounded chunks', async () => {
  const reader = async (artifactId: string, offset: number, length: number) => ({ artifactId, offset, text: 'chunk'.slice(0, length), nextOffset: offset + Math.min(5, length), eof: true });
  const { core } = setup({}, [template], reader);
  const created = await core.spawn({ prompt: 'first', templateId: 'researcher', model: args, workspaceRoot: '/repo' });
  const info = await core.info();
  assert.equal(info.protocolVersion, '0.1');
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
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(responseSchema.$schema, schema.$schema);
  assert.equal(templateSchema.$schema, schema.$schema);
  assert.deepEqual(Object.keys(schema.$defs.credentialModel.properties).sort(), ['api', 'credentialRef', 'model', 'url']);
  assert.equal(schema.$defs.spawn.properties.arguments.required.includes('workspaceRoot'), false);
  assert.equal('workspaceRoot' in schema.$defs.spawn.properties.arguments.properties, false);
  assert.equal(schema.$id, 'urn:subzero:protocol:0.1:operations');
  assert.equal(responseSchema.$id, 'urn:subzero:protocol:0.1:responses');
  assert.equal(templateSchema.$id, 'urn:subzero:protocol:0.1:templates');
  assert.equal(fixture.arguments.model.credentialRef, 'env:SUBZERO_MODEL_KEY');
  assert.equal('key' in fixture.arguments.model, false);
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

test('shutdown waits for an EngineFactory.open already admitted before it closes workers', async () => {
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
  assert.equal(engine.runs[0]?.stopCalls, 1);
  assert.equal((await store.getChild('child-1'))?.state, 'ready');
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
  for (let i = 0; i < 8; i++) engine.runs[0]!.emit({ type: 'text', text: `chunk-${i}` });
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
  const next = await iterator.next();
  assert.equal(next.value?.type, 'text');
  assert.equal(next.value?.text, 'hello');
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

async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(predicate(), true, 'expected asynchronous worker transition');
}

async function eventuallyAsync(predicate: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 50 && !(await predicate()); attempt++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(await predicate(), true, 'expected asynchronous worker transition');
}
