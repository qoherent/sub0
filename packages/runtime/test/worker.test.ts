import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TemplateDefinition, Worker, WorkerEvent } from '@subzero/core';
import { LocalArtifactStore } from '../src/artifacts.ts';
import { loadRuntimeConfig } from '../src/config.ts';
import { PiEngineFactory } from '../src/engine/pi-engine.ts';
import { isBrokerIncarnationLive, writeBrokerReceipt } from '../src/broker-receipt.ts';
import { SQLiteStore } from '../src/store.ts';
import { limits, records } from './fixtures/records.ts';
import { finishStream, sendCompletion, sendToolCall, startFakeProvider } from './fixtures/fake-provider.mjs';

const key = 'synthetic-worker-key-7f1a';

test('unknown broker liveness fails closed, while an explicit closed receipt is portable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-broker-receipt-'));
  const brokerReceiptDir = join(root, 'brokers');
  const brokerId = 'unknown-probe-owner';
  const incarnation = 'unknown-probe-incarnation';
  const receiptPath = join(brokerReceiptDir, `${createHash('sha256').update(`${brokerId}\0${incarnation}`).digest('hex')}.json`);
  try {
    await mkdir(brokerReceiptDir, { recursive: true });
    const base = { brokerId, incarnation, pid: process.pid };
    await writeFile(receiptPath, JSON.stringify({ ...base, state: 'active' }));
    assert.equal(await isBrokerIncarnationLive(brokerReceiptDir, brokerId, incarnation), undefined, 'missing process incarnation is unknown, not proof of death');
    await writeFile(receiptPath, JSON.stringify({ ...base, state: 'closed' }));
    assert.equal(await isBrokerIncarnationLive(brokerReceiptDir, brokerId, incarnation), false, 'clean close is explicit even without a platform process probe');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worker exit proof survives a failed recovery transaction and can be retried', async () => {
  const provider = await startFakeProvider();
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-recovery-proof-'));
  const childId = 'recovery-proof-child';
  const runId = 'recovery-proof-run';
  const brokerId = 'recovery-proof-owner';
  const brokerIncarnation = 'recovery-proof-incarnation';
  const brokerReceiptDir = join(root, 'brokers');
  const { child, run, event } = records(childId, false, runId);
  let worker: Awaited<ReturnType<PiEngineFactory['open']>> | undefined;
  let store = new SQLiteStore(join(root, 'state.sqlite'), { brokerId });
  try {
    await writeBrokerReceipt(brokerReceiptDir, brokerId, 'active', brokerIncarnation);
    const admission = await store.createChild(child, run, event, limits);
    assert.equal(admission.kind, 'started');
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')), brokerId, brokerIncarnation, brokerReceiptDir });
    worker = await factory.open({
      childId, runId, ownerGeneration: admission.kind === 'started' ? admission.lease.generation : undefined,
      workspaceRoot: root,
      templateSnapshot: { id: 'recovery-proof', description: '', instructions: 'Complete.', tools: [], skills: [], mcpServers: [], writeCapable: false },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    });
    const events: WorkerEvent[] = [];
    for await (const item of worker.run({ runId, prompt: 'complete before persistence' })) events.push(item);
    assert.equal(events.at(-1)?.type, 'completed');
    assert.equal((await worker.close()).exitConfirmed, true);
    worker = undefined;

    const childDir = join(root, 'sessions', createHash('sha256').update(childId).digest('hex'));
    const identityPath = join(childDir, 'worker-owner.json');
    const identityBeforeRecovery = await readFile(identityPath);
    assert.equal(await factory.proveWorkerExited(childId, runId, admission.kind === 'started' ? admission.lease.generation : undefined), false, 'the live owner cannot recover its own settle window');
    assert.deepEqual(await readFile(identityPath), identityBeforeRecovery, 'worker exit receipt survives the normal pre-settle window');

    const recoveryFactory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')), brokerId: 'recovery-proof-restart', brokerIncarnation: 'recovery-proof-restart-inc', brokerReceiptDir });
    assert.equal(await recoveryFactory.proveWorkerExited(childId, runId, admission.kind === 'started' ? admission.lease.generation : undefined), false, 'another broker cannot preempt the live owner');
    await writeBrokerReceipt(brokerReceiptDir, brokerId, 'closed', brokerIncarnation);
    assert.equal(await recoveryFactory.proveWorkerExited(childId, runId, admission.kind === 'started' ? admission.lease.generation : undefined), true, 'closed broker receipt permits recovery');
    assert.deepEqual(await readFile(identityPath), identityBeforeRecovery, 'exit proof remains durable until owner recovery commits');

    await store.close();
    await assert.rejects(store.recoverExitedOwner(childId, admission.kind === 'started' ? admission.lease.generation : 0, runId));
    assert.deepEqual(await readFile(identityPath), identityBeforeRecovery, 'failed SQLite recovery does not erase the exit proof');

    store = new SQLiteStore(join(root, 'state.sqlite'), { brokerId: 'recovery-proof-restart' });
    assert.equal(await store.recoverExitedOwner(childId, admission.kind === 'started' ? admission.lease.generation : 0, runId), true);
    assert.deepEqual(await readFile(identityPath), identityBeforeRecovery);
  } finally {
    if (worker) await worker.close();
    await store.close().catch(() => undefined);
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function expectOpenRejected(factory: PiEngineFactory, input: Parameters<PiEngineFactory['open']>[0], pattern: RegExp): Promise<void> {
  let worker: Worker | undefined;
  try { worker = await factory.open(input); }
  catch (error) { assert.match(error instanceof Error ? error.message : String(error), pattern); return; }
  if (worker) await worker.close();
  assert.fail(`Expected PiEngineFactory.open() to reject with ${pattern}.`);
}

test('shutdown during initialization retains a failed worker handle when group exit is unconfirmed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-init-unconfirmed-'));
  const factory = new PiEngineFactory({
    dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')),
    workerEntrypointForTesting: fileURLToPath(new URL('./fixtures/worker-control.mjs', import.meta.url)),
    processGroupGoneForTesting: async () => false,
  } as any);
  let worker: Worker | undefined;
  try {
    const opening = factory.open({
      childId: 'child-init-unconfirmed', workspaceRoot: root,
      templateSnapshot: { id: 'reader', description: '', instructions: 'Answer.', tools: [], skills: [], mcpServers: [], writeCapable: false },
      model: { url: 'http://127.0.0.1:1/v1', model: 'fake-model' }, credential: { key },
    });
    await factory.beginShutdown();
    worker = await opening;
    const events: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'run-init-unconfirmed', prompt: 'not sent to model' })) events.push(event);
    assert.deepEqual(events.at(-1), { type: 'failed', code: 'worker_initialization_failed' });
    assert.equal((await worker.close()).exitConfirmed, false, 'the failed handle reports the unconfirmed process group');
  } finally {
    if (worker) await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a stop control timeout closes the worker process group while RUN has no control deadline', { timeout: 8_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-control-timeout-'));
  const factory = new PiEngineFactory({
    dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')),
    workerEntrypointForTesting: fileURLToPath(new URL('./fixtures/worker-control.mjs', import.meta.url)),
    workerArgumentsForTesting: ['hang-stop'], controlRequestTimeoutMs: 100,
  } as any);
  let worker: Worker | undefined;
  try {
    worker = await factory.open({
      childId: 'child-control-timeout', workspaceRoot: root,
      templateSnapshot: { id: 'reader', description: '', instructions: 'Answer.', tools: [], skills: [], mcpServers: [], writeCapable: false },
      model: { url: 'http://127.0.0.1:1/v1', model: 'fake-model' }, credential: { key },
    });
    const pid = (worker as any).pid as number;
    const runEvents: WorkerEvent[] = [];
    const running = (async () => { for await (const event of worker!.run({ runId: 'run-control-timeout', prompt: 'run until stopped' })) runEvents.push(event); })();
    const startedAt = Date.now();
    while (!runEvents.some(event => event.type === 'text') && Date.now() - startedAt < 2_000) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(runEvents.some(event => event.type === 'text'), 'the long-running operation started');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(runEvents.some(event => ['completed', 'failed', 'stopped', 'interrupted'].includes(event.type)), false, 'RUN is not cut off by the control deadline');
    const stop = await Promise.race([
      worker.stop('run-control-timeout'),
      new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('stop exceeded the test guard')), 4_000); timer.unref(); }),
    ]);
    assert.deepEqual(stop, { confirmed: true }, 'stop reports process-exit confirmation after escalation');
    await running.catch(() => undefined);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && await procState(pid) !== 'gone') await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await procState(pid), 'gone', 'timed-out worker is reaped');
  } finally {
    if (worker) await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Pi worker starts with no tools, uses caller model and in-memory credential, and writes a secret-free artifact', async () => {
  const provider = await startFakeProvider();
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-test-'));
  let worker: Awaited<ReturnType<PiEngineFactory['open']>> | undefined;
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({
      childId: 'child-baseline', workspaceRoot: root,
      templateSnapshot: { id: 'custom-template', description: '', instructions: 'Answer plainly.', tools: [], skills: [], mcpServers: [], writeCapable: false },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    });
    const pid = (worker as unknown as { pid: number }).pid;
    const events: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'run-baseline', prompt: 'hello' })) events.push(event);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, 'completed');
    assert.match(terminal.preview, /fake-provider-ok/);
    assert.deepEqual(provider.requests[0]?.body.tools ?? [], []);
    assert.equal(provider.requests[0]?.authorization, `Bearer ${key}`);
    assert.equal(await factory.validateCheckpoint({
      childId: 'child-baseline', checkpointId: terminal.checkpointId,
      templateSnapshot: { id: 'custom-template', description: '', instructions: 'Answer plainly.', tools: [], skills: [], mcpServers: [], writeCapable: false },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    }), undefined);
    const args = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    const env = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '');
    assert.equal(args.includes(key), false);
    assert.equal(env.includes(key), false);
    const stored = await readdir(join(root, 'sessions'), { recursive: true });
    for (const path of stored) {
      const value = await readFile(join(root, 'sessions', path), 'utf8').catch(() => '');
      assert.equal(value.includes(key), false);
    }
  } finally {
    if (worker) assert.equal((await worker.close()).exitConfirmed, true);
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed existing session metadata rejects reopen without replacing prior metadata or transcript', async () => {
  const provider = await startFakeProvider();
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-metadata-corrupt-'));
  const childId = 'metadata-corrupt-child';
  const template: TemplateDefinition = { id: 'reader', description: '', instructions: 'Answer.', tools: [], skills: [], mcpServers: [], writeCapable: false };
  const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
  let worker: Worker | undefined;
  try {
    worker = await factory.open({ childId, runId: 'metadata-corrupt-run', workspaceRoot: root, templateSnapshot: template, model: { url: provider.endpoint, model: 'fake-model' }, credential: { key } });
    const events: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'metadata-corrupt-run', prompt: 'make a transcript' })) events.push(event);
    assert.equal(events.at(-1)?.type, 'completed');
    assert.equal((await worker.close()).exitConfirmed, true); worker = undefined;
    const childDir = join(root, 'sessions', createHash('sha256').update(childId).digest('hex'));
    const metaFile = join(childDir, 'session-meta.json');
    const sessionPath = (JSON.parse(await readFile(metaFile, 'utf8')) as { sessionFile: string }).sessionFile;
    const transcriptBefore = await readFile(sessionPath);
    await writeFile(metaFile, '{');
    await expectOpenRejected(factory, { childId, runId: 'metadata-corrupt-next', workspaceRoot: root, templateSnapshot: template, model: { url: provider.endpoint, model: 'fake-model' }, credential: { key } }, /session metadata|metadata/i);
    assert.equal(await readFile(metaFile, 'utf8'), '{');
    assert.deepEqual(await readFile(sessionPath), transcriptBefore);
    for (const invalid of [
      '{}',
      JSON.stringify({ sessionFile: sessionPath, workspaceRoot: root, engineVersion: '9.9.9' }),
    ]) {
      await writeFile(metaFile, invalid);
      await expectOpenRejected(factory, { childId, runId: 'metadata-corrupt-next', workspaceRoot: root, templateSnapshot: template, model: { url: provider.endpoint, model: 'fake-model' }, credential: { key } }, /session metadata|worker version/i);
      assert.equal(await readFile(metaFile, 'utf8'), invalid);
      assert.deepEqual(await readFile(sessionPath), transcriptBefore);
    }
  } finally {
    if (worker) await worker.close(); await provider.close(); await rm(root, { recursive: true, force: true });
  }
});

test('unsupported worker adapter and version are rejected before the child data directory or process exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-adapter-'));
  const dataRoot = join(root, 'sessions');
  const childId = 'unsupported-adapter-child';
  const childDir = join(dataRoot, createHash('sha256').update(childId).digest('hex'));
  const factory = new PiEngineFactory({ dataRoot, artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
  const base: TemplateDefinition = { id: 'unsupported', description: '', instructions: 'No run.', tools: [], skills: [], mcpServers: [], writeCapable: false };
  const input = (templateSnapshot: TemplateDefinition) => ({ childId, runId: 'unsupported-run', workspaceRoot: root, templateSnapshot, model: { url: 'http://127.0.0.1:1/v1', model: 'unused' }, credential: { key } });
  try {
    await expectOpenRejected(factory, input({ ...base, workerAdapter: 'acp' }), /worker adapter/i);
    await assert.rejects(access(childDir));
    await expectOpenRejected(factory, input({ ...base, workerVersion: '9.9.9' }), /worker version/i);
    await assert.rejects(access(childDir));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('builtin read results are redacted before they enter live model history and persisted session state', async () => {
  let round = 0;
  const provider = await startFakeProvider({ onRequest(_body, response) {
    if (round++ === 0) sendToolCall(response, 'read', { path: 'credential-in-file.txt' });
    else sendCompletion(response, 'read finished without exposing the file credential');
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-tool-redaction-'));
  const dataRoot = join(root, 'sessions');
  const childId = 'builtin-read-secret';
  const template: TemplateDefinition = { id: 'reader', description: '', instructions: 'Read the named file.', tools: [{ name: 'read', writable: false }], skills: [], mcpServers: [], writeCapable: false };
  let worker: Worker | undefined;
  try {
    await writeFile(join(root, 'credential-in-file.txt'), `synthetic credential ${key}`);
    const factory = new PiEngineFactory({ dataRoot, artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({ childId, runId: 'builtin-read-run', workspaceRoot: root, templateSnapshot: template, model: { url: provider.endpoint, model: 'fake-model' }, credential: { key } });
    const events: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'builtin-read-run', prompt: 'Read credential-in-file.txt and answer safely.' })) events.push(event);
    assert.equal(events.at(-1)?.type, 'completed');
    assert.equal(provider.requests.length, 2);
    assert.match(JSON.stringify(provider.requests[1]?.body.messages), /synthetic credential/);
    assert.match(JSON.stringify(provider.requests[1]?.body.messages), /\[REDACTED\]/);
    assert.equal(JSON.stringify(provider.requests[1]?.body.messages).includes(key), false, 'next provider request contains only redacted tool output');
    assert.equal(JSON.stringify(events).includes(key), false);
    for (const file of await readdir(dataRoot, { recursive: true })) {
      const content = await readFile(join(dataRoot, file), 'utf8').catch(() => '');
      assert.equal(content.includes(key), false, `credential leaked into ${file}`);
    }
  } finally {
    if (worker) await worker.close(); await provider.close(); await rm(root, { recursive: true, force: true });
  }
});

test('compiled runtime starts its emitted worker-child JavaScript entrypoint', async () => {
  const compiled = await import('../dist/index.js');
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-dist-'));
  let worker: Worker | undefined;
  try {
    const factory = new compiled.PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new compiled.LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({
      childId: 'compiled-child', workspaceRoot: root,
      templateSnapshot: { id: 'compiled', description: '', instructions: 'No call is made.', tools: [], skills: [], mcpServers: [], writeCapable: false },
      model: { url: 'http://127.0.0.1:1/v1', model: 'compiled-model' }, credential: { key },
    });
    assert.equal((await worker.close()).exitConfirmed, true);
    worker = undefined;
  } finally {
    if (worker) await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a provider echo of the synthetic API key is redacted before Pi persists it and before artifact storage', async () => {
  const provider = await startFakeProvider({ reply: () => `provider echoed ${key}` });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-key-echo-'));
  let worker: Awaited<ReturnType<PiEngineFactory['open']>> | undefined;
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({
      childId: 'child-key-echo', workspaceRoot: root,
      templateSnapshot: { id: 'reader', description: '', instructions: 'Answer.', tools: [], skills: [], mcpServers: [], writeCapable: false },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    });
    const events: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'run-key-echo', prompt: 'hello' })) events.push(event);
    assert.equal(events.at(-1)?.type, 'completed');
    const terminal = events.at(-1);
    assert.equal(JSON.stringify(events).includes(key), false);
    const artifacts = await readdir(join(root, 'artifacts'));
    for (const artifact of artifacts.filter(file => file.endsWith('.artifact'))) assert.equal((await readFile(join(root, 'artifacts', artifact), 'utf8')).includes(key), false);
    const sessions = await readdir(join(root, 'sessions'), { recursive: true });
    for (const file of sessions) assert.equal((await readFile(join(root, 'sessions', file), 'utf8').catch(() => '')).includes(key), false, `key leaked to ${file}`);
    assert.ok(terminal && terminal.type === 'completed');
  } finally {
    if (worker) assert.equal((await worker.close()).exitConfirmed, true);
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Pi exposes and executes only the exact granted write tool', async () => {
  let round = 0;
  const provider = await startFakeProvider({ onRequest(_body, response) {
    round++;
    if (round === 1) sendToolCall(response, 'write', { path: 'actual-effect.txt', content: 'created by the granted Pi tool' });
    else sendCompletion(response, 'write-finished');
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-grant-'));
  let worker: Awaited<ReturnType<PiEngineFactory['open']>> | undefined;
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({
      childId: 'child-granted', workspaceRoot: root,
      templateSnapshot: { id: 'writer', description: '', instructions: 'Use the granted write tool.', tools: [{ name: 'write', writable: true }], skills: [], mcpServers: [], writeCapable: true },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    });
    const events: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'run-granted', prompt: 'Create actual-effect.txt.' })) events.push(event);
    assert.equal(events.at(-1)?.type, 'completed');
    assert.deepEqual(provider.requests[0]?.body.tools?.map(tool => tool.function.name) ?? [], ['write']);
    assert.match(await readFile(join(root, 'actual-effect.txt'), 'utf8'), /created by the granted Pi tool/);
    const toolResult = provider.requests[1]?.body.messages.find(message => message.role === 'tool');
    assert.ok(toolResult, 'model receives the granted tool result on the next turn');
    assert.equal(round, 2);
  } finally {
    if (worker) assert.equal((await worker.close()).exitConfirmed, true);
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the shipped coder template exposes all seven configured tools and edits a real file', async () => {
  let round = 0;
  const provider = await startFakeProvider({ onRequest(_body, response) {
    if (round++ === 0) sendToolCall(response, 'edit', { path: 'edit-target.txt', edits: [{ oldText: 'before', newText: 'after' }] });
    else sendCompletion(response, 'edit-complete');
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-default-coder-'));
  let worker: Awaited<ReturnType<PiEngineFactory['open']>> | undefined;
  try {
    await writeFile(join(root, 'edit-target.txt'), 'before');
    const runtimeConfig = await loadRuntimeConfig({ dataRoot: root, workspaceRoot: root });
    const coder = runtimeConfig.templates.find(template => template.id === 'coder');
    assert.ok(coder);
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({ childId: 'default-coder', workspaceRoot: root, templateSnapshot: coder, model: { url: provider.endpoint, model: 'fake-model' }, credential: { key } });
    const events: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'run-default-coder', prompt: 'Change before to after.' })) events.push(event);
    assert.equal(events.at(-1)?.type, 'completed');
    assert.deepEqual(provider.requests[0]?.body.tools?.map(tool => tool.function.name) ?? [], ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']);
    assert.equal(await readFile(join(root, 'edit-target.txt'), 'utf8'), 'after');
  } finally {
    if (worker) assert.equal((await worker.close()).exitConfirmed, true);
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the shipped researcher template exposes and executes its four read tools', async () => {
  let round = 0;
  const calls = [
    ['read', { path: 'research-target.txt' }],
    ['grep', { pattern: 'research-marker', path: 'research-target.txt' }],
    ['find', { pattern: 'research-target.txt', path: '.' }],
    ['ls', { path: '.' }],
  ] as const;
  const provider = await startFakeProvider({ onRequest(_body, response) {
    if (round < calls.length) { const [name, args] = calls[round++]!; sendToolCall(response, name, args); }
    else sendCompletion(response, 'research-tools-complete');
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-default-reader-'));
  let worker: Awaited<ReturnType<PiEngineFactory['open']>> | undefined;
  try {
    await writeFile(join(root, 'research-target.txt'), 'a research-marker in a real file');
    const runtimeConfig = await loadRuntimeConfig({ dataRoot: root, workspaceRoot: root });
    const researcher = runtimeConfig.templates.find(template => template.id === 'researcher');
    assert.ok(researcher);
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({ childId: 'default-researcher', workspaceRoot: root, templateSnapshot: researcher, model: { url: provider.endpoint, model: 'fake-model' }, credential: { key } });
    const events: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'run-default-reader', prompt: 'Inspect the workspace.' })) events.push(event);
    assert.equal(events.at(-1)?.type, 'completed');
    assert.deepEqual(provider.requests[0]?.body.tools?.map(tool => tool.function.name) ?? [], ['read', 'grep', 'find', 'ls']);
    assert.equal(provider.requests.length, 5);
    const toolResults = provider.requests.at(-1)?.body.messages.filter(message => message.role === 'tool');
    assert.equal(toolResults?.length, 4);
    assert.match(JSON.stringify(toolResults), /research-marker/);
  } finally {
    if (worker) assert.equal((await worker.close()).exitConfirmed, true);
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an ungranted write tool call cannot modify the workspace', async () => {
  let round = 0;
  const provider = await startFakeProvider({ onRequest(_body, response) {
    if (round++ === 0) sendToolCall(response, 'write', { path: 'blocked-effect.txt', content: 'must not exist' });
    else sendCompletion(response, 'no write tool was available');
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-deny-'));
  let worker: Awaited<ReturnType<PiEngineFactory['open']>> | undefined;
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({
      childId: 'child-denied', workspaceRoot: root,
      templateSnapshot: { id: 'reader', description: '', instructions: 'Read only.', tools: [], skills: [], mcpServers: [], writeCapable: false },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    });
    const events: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'run-denied', prompt: 'Create blocked-effect.txt.' })) events.push(event);
    await assert.rejects(readFile(join(root, 'blocked-effect.txt')));
    assert.deepEqual(provider.requests[0]?.body.tools ?? [], []);
    assert.equal(provider.requests.length, 2);
    assert.ok(events.at(-1)?.type === 'failed' || events.at(-1)?.type === 'completed');
  } finally {
    if (worker) assert.equal((await worker.close()).exitConfirmed, true);
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('stop confirms the run and close reaps an ordinary shell descendant with the worker process group', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-tree-'));
  const pidFile = join(root, 'sleep.pid');
  const provider = await startFakeProvider({ onRequest(_body, response) {
    sendToolCall(response, 'bash', { command: `sleep 45 & echo $! > '${pidFile}'; wait` });
  } });
  let worker: Awaited<ReturnType<PiEngineFactory['open']>> | undefined;
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({
      childId: 'child-tree', workspaceRoot: root,
      templateSnapshot: { id: 'coder', description: '', instructions: 'Run the command.', tools: [{ name: 'bash', writable: true }], skills: [], mcpServers: [], writeCapable: true },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    });
    const runEvents: WorkerEvent[] = [];
    const run = (async () => { for await (const event of worker!.run({ runId: 'run-tree', prompt: 'Run sleep in the background and wait.' })) runEvents.push(event); })();
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      try { await readFile(pidFile, 'utf8'); break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    const shellPid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(shellPid) && shellPid > 1, 'the granted command started its ordinary shell child');
    assert.deepEqual(await worker.stop('run-tree'), { confirmed: true });
    await run;
    assert.equal(runEvents.at(-1)?.type, 'stopped');
    assert.equal((await worker.close()).exitConfirmed, true);
    worker = undefined;
    const killedDeadline = Date.now() + 2_000;
    while (Date.now() < killedDeadline && await procState(shellPid) !== 'gone') await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(await procState(shellPid), 'gone', 'the background process in the worker process group has exited');
  } finally {
    if (worker) await worker.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('completed Pi checkpoint reopens in a new process and branches the durable transcript', async () => {
  const provider = await startFakeProvider({ reply(body) {
    const history = JSON.stringify(body.messages);
    return history.includes('first durable turn') ? 'second turn after reopen' : 'first turn saved';
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-reopen-'));
  let worker: Awaited<ReturnType<PiEngineFactory['open']>> | undefined;
  const snapshot: TemplateDefinition = { id: 'reader', description: '', instructions: 'Answer.', tools: [], skills: [], mcpServers: [], writeCapable: false };
  const model = { url: provider.endpoint, model: 'fake-model' };
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    const open = () => factory.open({ childId: 'reopen-child', workspaceRoot: root, templateSnapshot: snapshot, model, credential: { key } });
    worker = await open();
    const first: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'run-first', prompt: 'first durable turn' })) first.push(event);
    const checkpoint = (first.at(-1) as any).checkpointId as string;
    assert.ok(checkpoint);
    assert.equal((await worker.close()).exitConfirmed, true);
    worker = await open();
    await factory.validateCheckpoint({ childId: 'reopen-child', checkpointId: checkpoint, templateSnapshot: snapshot, model, credential: { key } });
    const second: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'run-second', prompt: 'continue after process reopen', fromCheckpointId: checkpoint })) second.push(event);
    assert.equal((second.at(-1) as any).type, 'completed');
    const history = JSON.stringify(provider.requests[1]?.body.messages);
    assert.match(history, /first durable turn/);
    assert.equal(history.includes('continue after process reopen'), true);
    assert.equal(history.includes('previous attempt was interrupted'), false, 'an ordinary followup is not described as interrupted');
    assert.equal(history.includes('do not repeat any potentially completed action'), false, 'an ordinary followup is not warned against its requested work');
    await assert.rejects(factory.validateCheckpoint({ childId: 'reopen-child', checkpointId: 'no-such-leaf', templateSnapshot: snapshot, model, credential: { key } }), /checkpoint_incompatible/);
  } finally {
    if (worker) assert.equal((await worker.close()).exitConfirmed, true);
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('checkpoint validation is read-only even with a different model and a live owner', async () => {
  const provider = await startFakeProvider();
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-validate-readonly-'));
  const marker = join(root, 'mcp-starts.txt');
  let worker: Worker | undefined;
  const snapshot: TemplateDefinition = {
    id: 'mcp-reader', description: '', instructions: 'Answer.', tools: [], skills: [],
    mcpServers: [{ name: 'local', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-mcp.mjs', import.meta.url)), marker], tools: [], writeCapable: false }], writeCapable: false,
  };
  const model = { url: provider.endpoint, model: 'fake-model' };
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({ childId: 'readonly-validation', workspaceRoot: root, templateSnapshot: snapshot, model, credential: { key } });
    const completed: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'readonly-run', prompt: 'write a completed turn' })) completed.push(event);
    const checkpoint = completed.at(-1);
    assert.ok(checkpoint && checkpoint.type === 'completed');
    const childDir = join(root, 'sessions', (await readdir(join(root, 'sessions')))[0]!);
    const metadataBefore = await readFile(join(childDir, 'session-meta.json'));
    const transcriptPath = JSON.parse(metadataBefore.toString()).sessionFile as string;
    const transcriptBefore = await readFile(transcriptPath);
    const ownerBefore = await readFile(join(childDir, 'worker-owner.json'));
    const mcpStartsBefore = await readFile(marker, 'utf8');
    await assert.rejects(factory.validateCheckpoint({
      childId: 'readonly-validation', checkpointId: 'missing-leaf', templateSnapshot: snapshot,
      model: { url: 'http://127.0.0.1:2/v1', model: 'different-model' }, credential: { key },
    }), /checkpoint_incompatible/);
    assert.deepEqual(await readFile(join(childDir, 'session-meta.json')), metadataBefore);
    assert.deepEqual(await readFile(transcriptPath), transcriptBefore);
    assert.deepEqual(await readFile(join(childDir, 'worker-owner.json')), ownerBefore);
    assert.equal(await readFile(marker, 'utf8'), mcpStartsBefore, 'checkpoint validation does not launch MCP servers');
  } finally {
    if (worker) assert.equal((await worker.close()).exitConfirmed, true);
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('later partial tool call remains in transcript while resume branches from the last completed leaf', { timeout: 12_000 }, async () => {
  let round = 0;
  let partialStarted!: () => void;
  const started = new Promise<void>(resolve => { partialStarted = resolve; });
  let releasePartial!: () => void;
  const release = new Promise<void>(resolve => { releasePartial = resolve; });
  const provider = await startFakeProvider({ async onRequest(_body, response) {
    if (round++ === 0) sendCompletion(response, 'saved checkpoint');
    else if (round === 2) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'partial-call', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'partial-effect.txt', content: 'must not execute' }) } }] }, finish_reason: null }] })}\n\n`);
      response.on('close', releasePartial);
      partialStarted();
      await release;
    } else sendCompletion(response, 'resumed from completed checkpoint');
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-partial-'));
  let worker: Awaited<ReturnType<PiEngineFactory['open']>> | undefined;
  const snapshot: TemplateDefinition = { id: 'coder', description: '', instructions: 'Use tools as granted.', tools: [{ name: 'write', writable: true }], skills: [], mcpServers: [], writeCapable: true };
  const model = { url: provider.endpoint, model: 'fake-model' };
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    const open = () => factory.open({ childId: 'partial-child', workspaceRoot: root, templateSnapshot: snapshot, model, credential: { key } });
    worker = await open();
    const completed: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'run-checkpoint', prompt: 'completed checkpoint turn' })) completed.push(event);
    const checkpoint = completed.at(-1);
    assert.ok(checkpoint && checkpoint.type === 'completed');
    const interrupted: WorkerEvent[] = [];
    const partialRun = (async () => { for await (const event of worker!.run({ runId: 'run-partial', prompt: 'interrupted-tool-call', fromCheckpointId: checkpoint.checkpointId })) interrupted.push(event); })();
    await started;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(await worker.stop('run-partial'), { confirmed: true });
    await partialRun;
    assert.equal(interrupted.at(-1)?.type, 'stopped');
    await assert.rejects(readFile(join(root, 'partial-effect.txt')));
    assert.equal((await worker.close()).exitConfirmed, true);
    worker = await open();
    const recovered: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'run-recovered', prompt: 'continue safely', fromCheckpointId: checkpoint.checkpointId })) recovered.push(event);
    assert.equal(recovered.at(-1)?.type, 'completed');
    assert.equal(provider.requests.length, 3);
    const branchMessages = provider.requests[2]?.body.messages ?? [];
    assert.equal(JSON.stringify(branchMessages).includes('interrupted-tool-call'), false);
    assert.equal(branchMessages.some(message => message.role === 'assistant' && (message.tool_calls ?? []).some(call => !branchMessages.some(other => other.role === 'tool' && other.tool_call_id === (call as any).id))), false);
    const sessionFiles = (await readdir(join(root, 'sessions'), { recursive: true })).filter(name => String(name).endsWith('.jsonl'));
    assert.equal(sessionFiles.length, 1);
    const fullTranscript = await readFile(join(root, 'sessions', sessionFiles[0] as string), 'utf8');
    assert.match(fullTranscript, /interrupted-tool-call/);
    assert.match(fullTranscript, /partial-call/);
  } finally {
    releasePartial();
    if (worker) await worker.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('first-turn interruption is retained on disk but excluded by the next root-branch request', { timeout: 10_000 }, async () => {
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  let releaseFirst!: () => void;
  const release = new Promise<void>(resolve => { releaseFirst = resolve; });
  let calls = 0;
  const provider = await startFakeProvider({ async onRequest(_body, response) {
    if (calls++ === 0) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'partial first turn' }, finish_reason: null }] })}\n\n`);
      response.on('close', () => releaseFirst());
      firstStarted();
      await release;
    } else sendCompletion(response, 'safe root recovery');
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-first-interrupt-'));
  let worker: Awaited<ReturnType<PiEngineFactory['open']>> | undefined;
  const snapshot: TemplateDefinition = { id: 'reader', description: '', instructions: 'Answer.', tools: [], skills: [], mcpServers: [], writeCapable: false };
  const model = { url: provider.endpoint, model: 'fake-model' };
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    const open = () => factory.open({ childId: 'first-interrupt-child', workspaceRoot: root, templateSnapshot: snapshot, model, credential: { key } });
    worker = await open();
    const firstEvents: WorkerEvent[] = [];
    const firstRun = (async () => { for await (const event of worker!.run({ runId: 'run-interrupted-first', prompt: 'interrupted-first-turn' })) firstEvents.push(event); })();
    await started;
    assert.deepEqual(await worker.stop('run-interrupted-first'), { confirmed: true });
    await firstRun;
    assert.equal(firstEvents.at(-1)?.type, 'stopped');
    assert.equal((await worker.close()).exitConfirmed, true);
    worker = await open();
    const recovered: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'run-first-recovery', prompt: 'safe retry after first interruption' })) recovered.push(event);
    assert.equal(recovered.at(-1)?.type, 'completed');
    const recoveredMessages = JSON.stringify(provider.requests[1]?.body.messages);
    assert.match(recoveredMessages, /safe retry after first interruption/);
    assert.equal(recoveredMessages.includes('interrupted-first-turn'), false);
    const transcript = await readdir(join(root, 'sessions'), { recursive: true });
    const jsonl = transcript.filter(path => String(path).endsWith('.jsonl'));
    assert.equal(jsonl.length, 1, 'recovery reuses the original per-child Pi transcript');
    const saved = await readFile(join(root, 'sessions', jsonl[0] as string), 'utf8');
    assert.match(saved, /interrupted-first-turn/, 'append-only session retains the interrupted first prompt');
  } finally {
    releaseFirst();
    if (worker) await worker.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP bridge launches only the declared stdio server and exposes only its selected tool', async () => {
  let round = 0;
  const provider = await startFakeProvider({ onRequest(_body, response) {
    round++;
    if (round === 1) sendToolCall(response, 'allowed_echo', { text: 'bridge-ok' });
    else sendCompletion(response, 'MCP tool returned bridge-ok');
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-mcp-'));
  let worker: Awaited<ReturnType<PiEngineFactory['open']>> | undefined;
  const prior = process.env.SUBZERO_MCP_AUTH;
  process.env.SUBZERO_MCP_AUTH = 'synthetic-mcp-credential';
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({
      childId: 'child-mcp', workspaceRoot: root,
      templateSnapshot: { id: 'mcp-reader', description: '', instructions: 'Use the allowed MCP tool.', tools: [], skills: [], mcpServers: [{ name: 'local', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-mcp.mjs', import.meta.url))], envRefs: ['env:SUBZERO_MCP_AUTH'], tools: ['allowed_echo'], writeCapable: false }], writeCapable: false },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    });
    const events: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'run-mcp', prompt: 'Call the declared MCP tool.' })) events.push(event);
    assert.equal(events.at(-1)?.type, 'completed');
    assert.deepEqual(provider.requests[0]?.body.tools?.map(tool => tool.function.name) ?? [], ['allowed_echo']);
    assert.equal(round, 2);
    const results = provider.requests[1]?.body.messages.filter(message => message.role === 'tool').map(message => message.content).join(' ');
    assert.match(results ?? '', /mcp:bridge-ok;credential:\[REDACTED\]/);
    assert.equal(JSON.stringify(provider.requests).includes('synthetic-mcp-credential'), false);
    const sessions = await readdir(join(root, 'sessions'), { recursive: true });
    for (const file of sessions) assert.equal((await readFile(join(root, 'sessions', file), 'utf8').catch(() => '')).includes('synthetic-mcp-credential'), false);
  } finally {
    if (prior === undefined) delete process.env.SUBZERO_MCP_AUTH; else process.env.SUBZERO_MCP_AUTH = prior;
    if (worker) assert.equal((await worker.close()).exitConfirmed, true);
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing granted MCP tool rejects initialization before model execution and reaps the server', async () => {
  const provider = await startFakeProvider();
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-mcp-missing-'));
  const pidFile = join(root, 'mcp.pid');
  let worker: Worker | undefined;
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    await expectOpenRejected(factory, {
      childId: 'child-mcp-missing', workspaceRoot: root,
      templateSnapshot: { id: 'mcp-reader', description: '', instructions: 'Use the granted tool.', tools: [], skills: [], mcpServers: [{ name: 'local', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-mcp.mjs', import.meta.url)), pidFile, 'missing-grant'], tools: ['missing_grant'], writeCapable: false }], writeCapable: false },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    }, /missing_grant/);
    assert.equal(provider.requests.length, 0, 'the model is not called after the grant mismatch');
    const mcpPid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(mcpPid) && mcpPid > 1, 'the fake MCP server started');
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && await procState(mcpPid) !== 'gone') await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(await procState(mcpPid), 'gone', 'the MCP process is reaped after initialization rejection');
  } finally {
    if (worker) await worker.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('steering is passed to the active Pi session without a second worker queue', { timeout: 10_000 }, async () => {
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let round = 0;
  const provider = await startFakeProvider({ async onRequest(_body, response) {
    if (round++ === 0) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'working' }, finish_reason: null }] })}\n\n`);
      started();
      await gate;
      finishStream(response, 'initial turn finished');
    } else sendCompletion(response, 'steering applied');
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-steer-'));
  let worker: Awaited<ReturnType<PiEngineFactory['open']>> | undefined;
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({
      childId: 'child-steer', workspaceRoot: root,
      templateSnapshot: { id: 'reader', description: '', instructions: 'Answer.', tools: [], skills: [], mcpServers: [], writeCapable: false },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    });
    const events: WorkerEvent[] = [];
    const run = (async () => { for await (const event of worker!.run({ runId: 'run-steer', prompt: 'active-steer-request' })) events.push(event); })();
    await firstStarted;
    await assert.rejects(async () => { for await (const _event of worker!.run({ runId: 'run-duplicate', prompt: 'must not be queued inside Pi' })) { /* drain */ } }, /worker_run_already_active/);
    assert.equal(provider.requests.length, 1, 'the worker rejects a second run while Subzero owns queueing');
    await worker.steer('steer-marker');
    release();
    await run;
    assert.equal(events.at(-1)?.type, 'completed');
    assert.equal(provider.requests.length, 2, 'Pi processed one active turn and one steered turn');
    assert.match(JSON.stringify(provider.requests[1]?.body.messages), /steer-marker/);
  } finally {
    release();
    if (worker) assert.equal((await worker.close()).exitConfirmed, true);
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('broker EOF aborts a pending provider stream and confirms worker process exit', { timeout: 10_000 }, async () => {
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  let closed!: () => void;
  const streamClosed = new Promise<void>(resolve => { closed = resolve; });
  const provider = await startFakeProvider({ async onRequest(_body, response) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'pending' }, finish_reason: null }] })}\n\n`);
    response.on('close', () => { closed(); });
    started();
    await streamClosed;
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-eof-'));
  let worker: Awaited<ReturnType<PiEngineFactory['open']>> | undefined;
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({
      childId: 'child-eof', workspaceRoot: root,
      templateSnapshot: { id: 'reader', description: '', instructions: 'Answer.', tools: [], skills: [], mcpServers: [], writeCapable: false },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    });
    const run = (async () => { for await (const _event of worker!.run({ runId: 'run-eof', prompt: 'hold request open' })) { /* drain */ } })();
    await firstStarted;
    const pid = (worker as unknown as { pid: number }).pid;
    assert.equal((await worker.close()).exitConfirmed, true);
    worker = undefined;
    await run.catch(() => undefined);
    await Promise.race([streamClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('provider did not observe EOF abort')), 2_000))]);
    assert.equal(await procState(pid), 'gone');
  } finally {
    if (worker) await worker.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('audit: provider HTTP 401 ends the run as failed with no completion, checkpoint, or artifact', { timeout: 30_000 }, async () => {
  const provider = await startFakeProvider({ onRequest(_body, response) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }));
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-audit-401-'));
  let worker: Worker | undefined;
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({
      childId: 'audit-401-child', workspaceRoot: root,
      templateSnapshot: { id: 'reader', description: '', instructions: 'Answer.', tools: [], skills: [], mcpServers: [], writeCapable: false },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    });
    const events: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'audit-401-run', prompt: 'hello' })) events.push(event);
    assert.equal(events.at(-1)?.type, 'failed', JSON.stringify(events));
    assert.equal(events.some(event => event.type === 'completed'), false, 'a rejected request never completes');
    assert.equal(events.some(event => 'checkpointId' in event || 'artifactId' in event), false);
    assert.equal(provider.requests.length, 1);
    const artifacts = (await readdir(join(root, 'artifacts')).catch(() => [] as string[])).filter(file => file.endsWith('.artifact'));
    assert.deepEqual(artifacts, []);
  } finally {
    if (worker) await worker.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('audit: a first provider HTTP 503 fails the run without an automatic retry', { timeout: 40_000 }, async () => {
  const provider = await startFakeProvider({ onRequest(_body, response) {
    if (provider.requests.length === 1) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'service unavailable', type: 'server_error' } }));
    } else sendCompletion(response, 'retry succeeded');
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-audit-503-'));
  let worker: Worker | undefined;
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({
      childId: 'audit-503-child', workspaceRoot: root,
      templateSnapshot: { id: 'reader', description: '', instructions: 'Answer.', tools: [], skills: [], mcpServers: [], writeCapable: false },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    });
    const events: WorkerEvent[] = [];
    const running = (async () => { for await (const event of worker!.run({ runId: 'audit-503-run', prompt: 'hello' })) events.push(event); })();
    let guard: NodeJS.Timeout | undefined;
    try {
      await Promise.race([running, new Promise<never>((_resolve, reject) => { guard = setTimeout(() => reject(new Error('run did not reach a terminal event within 30s')), 30_000); })]);
    } finally { clearTimeout(guard); }
    assert.equal(provider.requests.length, 1, `the worker does not automatically retry the request (terminal: ${events.at(-1)?.type})`);
    assert.equal(events.at(-1)?.type, 'failed', JSON.stringify(events));
    assert.equal(events.some(event => event.type === 'completed'), false);
  } finally {
    if (worker) await worker.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('audit: a model key split across two streamed deltas never reaches worker text events', { timeout: 15_000 }, async () => {
  const split = 11;
  const provider = await startFakeProvider({ onRequest(_body, response) {
    const chunk = (delta: object) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(chunk({ role: 'assistant' }));
    response.write(chunk({ content: `before ${key.slice(0, split)}` }));
    response.write(chunk({ content: `${key.slice(split)} after` }));
    finishStream(response, '');
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-audit-split-key-'));
  let worker: Worker | undefined;
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({
      childId: 'audit-split-key-child', workspaceRoot: root,
      templateSnapshot: { id: 'reader', description: '', instructions: 'Answer.', tools: [], skills: [], mcpServers: [], writeCapable: false },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    });
    const events: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'audit-split-key-run', prompt: 'hello' })) events.push(event);
    assert.equal(events.at(-1)?.type, 'completed');
    const text = events.flatMap(event => event.type === 'text' ? [event.text] : []).join('');
    assert.equal(text.includes(key), false, `joined worker text exposed the key: ${text}`);
    assert.match(text, /before/);
    assert.match(text, /after/);
    assert.match(text, /\[REDACTED\]/);
  } finally {
    if (worker) await worker.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('audit: a key in write-tool input is redacted from the written file, live history, events, and persisted state', { timeout: 15_000 }, async () => {
  let round = 0;
  const provider = await startFakeProvider({ onRequest(_body, response) {
    if (round++ === 0) sendToolCall(response, 'write', { path: 'tool-input-secret.txt', content: `credential ${key} end` });
    else sendCompletion(response, 'write finished');
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-audit-write-secret-'));
  let worker: Worker | undefined;
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({
      childId: 'audit-write-secret-child', workspaceRoot: root,
      templateSnapshot: { id: 'writer', description: '', instructions: 'Use the granted write tool.', tools: [{ name: 'write', writable: true }], skills: [], mcpServers: [], writeCapable: true },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    });
    const events: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'audit-write-secret-run', prompt: 'Write the credential file.' })) events.push(event);
    assert.equal(events.at(-1)?.type, 'completed');
    assert.equal(provider.requests.length, 2);
    const written = await readFile(join(root, 'tool-input-secret.txt'), 'utf8');
    assert.equal(written.includes(key), false, 'the file written by the tool contains the literal key');
    assert.match(written, /\[REDACTED\]/);
    assert.equal(JSON.stringify(provider.requests[1]?.body.messages).includes(key), false, 'live model history contains the literal key');
    assert.equal(JSON.stringify(events).includes(key), false);
    for (const dir of ['sessions', 'artifacts']) {
      for (const file of await readdir(join(root, dir), { recursive: true })) {
        assert.equal((await readFile(join(root, dir, file), 'utf8').catch(() => '')).includes(key), false, `key leaked into ${dir}/${file}`);
      }
    }
  } finally {
    if (worker) await worker.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('audit: a granted MCP tool that appears only on a later tools/list page is exposed and executed', { timeout: 15_000 }, async () => {
  let round = 0;
  const provider = await startFakeProvider({ onRequest(_body, response) {
    if (round++ === 0) sendToolCall(response, 'allowed_echo', { text: 'second-page' });
    else sendCompletion(response, 'paged tool finished');
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-audit-mcp-pages-'));
  let worker: Worker | undefined;
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({
      childId: 'audit-mcp-pages-child', workspaceRoot: root,
      templateSnapshot: { id: 'mcp-reader', description: '', instructions: 'Use the granted MCP tool.', tools: [], skills: [], mcpServers: [{ name: 'local', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-mcp.mjs', import.meta.url)), join(root, 'mcp-starts.txt'), 'paged'], tools: ['allowed_echo'], writeCapable: false }], writeCapable: false },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    });
    const events: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'audit-mcp-pages-run', prompt: 'Call the granted MCP tool.' })) events.push(event);
    assert.equal(events.at(-1)?.type, 'completed');
    assert.deepEqual(provider.requests[0]?.body.tools?.map(tool => tool.function.name) ?? [], ['allowed_echo']);
    const results = provider.requests[1]?.body.messages.filter(message => message.role === 'tool').map(message => message.content).join(' ');
    assert.match(results ?? '', /mcp:second-page/);
  } finally {
    if (worker) await worker.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('audit: a worker killed mid-stream releases the held redaction suffix before the interrupted terminal', { timeout: 15_000 }, async () => {
  let held!: () => void;
  const providerHeld = new Promise<void>(resolve => { held = resolve; });
  const provider = await startFakeProvider({ onRequest(_body, response) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: { role: 'assistant', content: `partial ${key.slice(0, 9)}` }, finish_reason: null }] })}\n\n`);
    held();
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-audit-stream-error-'));
  let worker: Worker | undefined;
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({
      childId: 'audit-stream-error-child', workspaceRoot: root,
      templateSnapshot: { id: 'reader', description: '', instructions: 'Answer.', tools: [], skills: [], mcpServers: [], writeCapable: false },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    });
    const pid = (worker as unknown as { pid: number }).pid;
    const events: WorkerEvent[] = [];
    const running = (async () => { for await (const event of worker!.run({ runId: 'audit-stream-error-run', prompt: 'hello' })) events.push(event); })();
    await providerHeld;
    await new Promise(resolve => setTimeout(resolve, 300));
    process.kill(pid, 'SIGKILL');
    await running;
    assert.deepEqual(events.at(-1), { type: 'interrupted', code: 'worker_eof' });
    const text = events.flatMap(event => event.type === 'text' ? [event.text] : []).join('');
    assert.equal(text, `partial ${key.slice(0, 9)}`);
  } finally {
    if (worker) await worker.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('audit: a model key used as a tool-argument property name is redacted from live history and persisted sessions', { timeout: 15_000 }, async () => {
  let round = 0;
  const provider = await startFakeProvider({ onRequest(_body, response) {
    if (round++ === 0) sendToolCall(response, 'write', { path: 'safe.txt', content: 'ordinary', [key]: 'extra' });
    else sendCompletion(response, 'write finished');
  } });
  const root = await mkdtemp(join(tmpdir(), 'subzero-worker-audit-key-name-'));
  let worker: Worker | undefined;
  try {
    const factory = new PiEngineFactory({ dataRoot: join(root, 'sessions'), artifactStore: new LocalArtifactStore(join(root, 'artifacts')) });
    worker = await factory.open({
      childId: 'audit-key-name-child', workspaceRoot: root,
      templateSnapshot: { id: 'writer', description: '', instructions: 'Use the granted write tool.', tools: [{ name: 'write', writable: true }], skills: [], mcpServers: [], writeCapable: true },
      model: { url: provider.endpoint, model: 'fake-model' }, credential: { key },
    });
    const events: WorkerEvent[] = [];
    for await (const event of worker.run({ runId: 'audit-key-name-run', prompt: 'Write the file.' })) events.push(event);
    assert.equal(provider.requests.length, 2);
    assert.equal(JSON.stringify(provider.requests[1]?.body.messages).includes(key), false, 'live model history contains the literal key');
    assert.equal(JSON.stringify(events).includes(key), false);
    for (const file of await readdir(join(root, 'sessions'), { recursive: true })) {
      assert.equal((await readFile(join(root, 'sessions', file), 'utf8').catch(() => '')).includes(key), false, `key leaked into sessions/${file}`);
    }
  } finally {
    if (worker) await worker.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function procState(pid: number): Promise<string> {
  try {
    const content = await readFile(`/proc/${pid}/stat`, 'utf8');
    return content.slice(content.lastIndexOf(')') + 2).split(' ')[0] ?? 'unknown';
  } catch { return 'gone'; }
}
