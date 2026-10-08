import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { EventInput } from '@subzero/core';
import { SQLiteStore } from '../src/store.ts';
import { coder, limits, queuedRun, records, researcher } from './fixtures/records.ts';

async function tempDb(fn: (dbPath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'subzero-store-'));
  try { await fn(join(dir, 'state.sqlite')); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('persists child, active run, template and model metadata across close and reopen', async () => tempDb(async dbPath => {
  const store = new SQLiteStore(dbPath, { brokerId: 'broker-a' });
  await store.putTemplate(researcher);
  const { child, run, event } = records('persisted');
  const admitted = await store.createChild(child, run, event, limits);
  assert.equal(admitted.kind, 'started');
  await store.close();

  const reopened = new SQLiteStore(dbPath, { brokerId: 'broker-b' });
  assert.deepEqual(await reopened.getChild('persisted'), { ...child, ownerGeneration: 1 });
  assert.equal((await reopened.validateResume('persisted')).kind, 'recovery_required');
  assert.deepEqual(await reopened.getTemplate('researcher'), researcher);
  assert.deepEqual(await reopened.listTemplates(), [researcher]);
  assert.equal((await reopened.listChildren('/workspace')).length, 1);
  await reopened.close();
}));

test('atomically enforces workspace worker and single writer limits across independent connections', async () => tempDb(async dbPath => {
  const a = new SQLiteStore(dbPath, { brokerId: 'a' });
  const b = new SQLiteStore(dbPath, { brokerId: 'b' });
  const create = async (store: SQLiteStore, id: string, write = false) => {
    const value = records(id, write);
    return store.createChild(value.child, value.run, value.event, limits);
  };
  const firstWriters = await Promise.all([create(a, 'writer-a', true), create(b, 'writer-b', true)]);
  assert.equal(firstWriters.filter(value => value.kind === 'started').length, 1);
  assert.equal(firstWriters.filter(value => value.kind === 'workspace_busy').length, 1);
  const reads = await Promise.all([create(a, 'reader-a'), create(b, 'reader-b'), create(a, 'reader-c'), create(b, 'reader-d')]);
  assert.equal(reads.filter(value => value.kind === 'started').length, 3);
  assert.equal(reads.filter(value => value.kind === 'workspace_busy').length, 1);
  await a.close(); await b.close();
}));

test('a failed started event rolls back admission and the same run can be retried', async () => tempDb(async dbPath => {
  const store = new SQLiteStore(dbPath, { brokerId: 'broker-a' });
  const { child, run, event } = records('admission-retry');
  const initial = await store.createChild(child, run, event, limits);
  assert.equal(initial.kind, 'started');
  if (initial.kind !== 'started') return;
  await store.settleRun(child.childId, run.runId, initial.lease.ownerToken,
    { type: 'completed', checkpointId: 'checkpoint-1', artifactId: 'artifact-1', preview: 'done' },
    { childId: child.childId, runId: run.runId, at: '2026-10-07T00:00:01.000Z', type: 'completed', artifactId: 'artifact-1', preview: 'done' }, limits, true);

  const retry = queuedRun(child.childId, 'retry-run');
  const inspect = new DatabaseSync(dbPath);
  inspect.exec(`CREATE TRIGGER reject_retry_start BEFORE INSERT ON events
    WHEN NEW.type = 'run_started' AND NEW.run_id = 'retry-run'
    BEGIN SELECT RAISE(ABORT, 'blocked event insert'); END`);
  await assert.rejects(store.admitRun(child.childId, retry, limits), /blocked event insert/);
  assert.equal((await store.getChild(child.childId))?.state, 'ready');
  assert.equal((await store.getChild(child.childId))?.activeRunId, undefined);
  assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM runs WHERE run_id = 'retry-run'").get()?.count, 0);
  assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = 'retry-run'").get()?.count, 0);

  inspect.exec('DROP TRIGGER reject_retry_start');
  const admitted = await store.admitRun(child.childId, retry, limits);
  assert.equal(admitted.kind, 'started');
  assert.equal((await store.getChild(child.childId))?.activeRunId, retry.runId);
  assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = 'retry-run' AND type = 'run_started'").get()?.count, 1);
  inspect.close();
  await store.close();
}));

test('a failed queued event rolls back queued run admission', async () => tempDb(async dbPath => {
  const store = new SQLiteStore(dbPath, { brokerId: 'broker-a' });
  const { child, run, event } = records('queued-retry', false, 'queued-retry-active');
  const initial = await store.createChild(child, run, event, limits);
  assert.equal(initial.kind, 'started');
  const queued = queuedRun(child.childId, 'queued-retry-run');
  const inspect = new DatabaseSync(dbPath);
  inspect.exec(`CREATE TRIGGER reject_retry_queue BEFORE INSERT ON events
    WHEN NEW.type = 'run_queued' AND NEW.run_id = 'queued-retry-run'
    BEGIN SELECT RAISE(ABORT, 'blocked event insert'); END`);

  await assert.rejects(store.admitRun(child.childId, queued, limits), /blocked event insert/);
  assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM runs WHERE run_id = 'queued-retry-run'").get()?.count, 0);
  assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = 'queued-retry-run'").get()?.count, 0);
  inspect.close();
  await store.close();
}));

test('a failed successor start event rolls back settlement and keeps the successor queued for retry', async () => tempDb(async dbPath => {
  const store = new SQLiteStore(dbPath, { brokerId: 'broker-a' });
  const { child, run, event } = records('successor-retry');
  const initial = await store.createChild(child, run, event, limits);
  assert.equal(initial.kind, 'started');
  if (initial.kind !== 'started') return;
  const successor = queuedRun(child.childId, 'successor-run');
  assert.equal((await store.admitRun(child.childId, successor, limits)).kind, 'queued');

  const inspect = new DatabaseSync(dbPath);
  inspect.exec(`CREATE TRIGGER reject_successor_start BEFORE INSERT ON events
    WHEN NEW.type = 'run_started' AND NEW.run_id = 'successor-run'
    BEGIN SELECT RAISE(ABORT, 'blocked event insert'); END`);
  const terminal: EventInput = { childId: child.childId, runId: run.runId, at: '2026-10-07T00:00:02.000Z', type: 'completed', artifactId: 'artifact-1', preview: 'done' };
  await assert.rejects(store.settleRun(child.childId, run.runId, initial.lease.ownerToken,
    { type: 'completed', checkpointId: 'checkpoint-1', artifactId: 'artifact-1', preview: 'done' }, terminal, limits, true), /blocked event insert/);
  assert.equal((await store.getChild(child.childId))?.activeRunId, run.runId);
  assert.equal((await store.getChild(child.childId))?.state, 'running');
  assert.equal(inspect.prepare('SELECT status FROM runs WHERE run_id = ?').get(run.runId)?.status, 'running');
  assert.equal(inspect.prepare('SELECT status FROM runs WHERE run_id = ?').get(successor.runId)?.status, 'queued');
  assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = ? AND type = 'completed'").get(run.runId)?.count, 0);

  inspect.exec('DROP TRIGGER reject_successor_start');
  const settled = await store.settleRun(child.childId, run.runId, initial.lease.ownerToken,
    { type: 'completed', checkpointId: 'checkpoint-1', artifactId: 'artifact-1', preview: 'done' }, terminal, limits, true);
  assert.deepEqual(settled, { kind: 'next', run: { ...successor, status: 'running' } });
  assert.equal(inspect.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = ? AND type = 'run_started'").get(successor.runId)?.count, 1);
  inspect.close();
  await store.close();
}));

test('unconfirmed worker exit retains ownership and blocks re-admission after broker restart', async () => tempDb(async dbPath => {
  const a = new SQLiteStore(dbPath, { brokerId: 'old-owner' });
  const { child, run, event } = records('ambiguous');
  const admitted = await a.createChild(child, run, event, limits);
  assert.equal(admitted.kind, 'started');
  if (admitted.kind !== 'started') return;
  await a.admitRun(child.childId, queuedRun(child.childId, 'ambiguous-queued'), limits);
  await a.admitRun(child.childId, queuedRun(child.childId, 'ambiguous-queued-2'), limits);
  const settled = await a.settleRun('ambiguous', run.runId, admitted.lease.ownerToken,
    { type: 'interrupted', code: 'exit_unknown' }, { childId: child.childId, runId: run.runId, at: '2026-10-07T00:00:02Z', type: 'interrupted', code: 'exit_unknown' }, limits, false);
  assert.deepEqual(settled, { kind: 'recovery_required' });
  await a.close();
  const b = new SQLiteStore(dbPath, { brokerId: 'new-owner' });
  const validation = await b.validateResume('ambiguous');
  assert.equal(validation.kind, 'recovery_required');
  assert.equal((await b.admitRun('ambiguous', queuedRun('ambiguous', 'later'), limits)).kind, 'recovery_required');
  const inspect = new DatabaseSync(dbPath);
  const queued = (inspect.prepare("SELECT run_id, status, error_code FROM runs WHERE child_id = ? AND status = 'stopped' ORDER BY run_id").all('ambiguous') as { run_id: string; status: string; error_code: string }[])
    .map(row => ({ run_id: row.run_id, status: row.status, error_code: row.error_code }));
  assert.deepEqual(queued, [
    { run_id: 'ambiguous-queued', status: 'stopped', error_code: 'previous_run_interrupted' },
    { run_id: 'ambiguous-queued-2', status: 'stopped', error_code: 'previous_run_interrupted' },
  ]);
  inspect.close();
  const events = await b.readEvents('ambiguous', 0, 20);
  assert.deepEqual(events.events.filter(item => item.runId?.startsWith('ambiguous-queued') && item.type !== 'run_queued').map(item => ({ runId: item.runId, type: item.type, code: 'code' in item ? item.code : undefined })), [
    { runId: 'ambiguous-queued', type: 'interrupted', code: 'previous_run_interrupted' },
    { runId: 'ambiguous-queued-2', type: 'interrupted', code: 'previous_run_interrupted' },
  ]);
  await b.close();
}));

test('settling a run returns queued work without losing it and updates only completed leaves', async () => tempDb(async dbPath => {
  const store = new SQLiteStore(dbPath, { brokerId: 'broker' });
  const { child, run, event } = records('queue');
  const admission = await store.createChild(child, run, event, limits);
  assert.equal(admission.kind, 'started');
  if (admission.kind !== 'started') return;
  await store.admitRun(child.childId, queuedRun(child.childId, 'queue-2'), limits);
  await store.admitRun(child.childId, queuedRun(child.childId, 'queue-3'), limits);
  const settled = await store.settleRun(child.childId, run.runId, admission.lease.ownerToken,
    { type: 'completed', checkpointId: 'leaf-1', artifactId: 'artifact-1', preview: 'done' },
    { childId: child.childId, runId: run.runId, at: '2026-10-07T00:00:02Z', type: 'completed', artifactId: 'artifact-1', preview: 'done' }, limits, true);
  assert.deepEqual(settled, { kind: 'next', run: { ...queuedRun(child.childId, 'queue-2'), status: 'running' } });
  assert.equal((await store.getChild(child.childId))?.lastCompletedLeaf, 'leaf-1');
  const next = await store.getChild(child.childId);
  assert.equal(next?.activeRunId, 'queue-2');
  const second = await store.settleRun(child.childId, 'queue-2', admission.lease.ownerToken,
    { type: 'completed', checkpointId: 'leaf-2', artifactId: 'artifact-2', preview: 'again' },
    { childId: child.childId, runId: 'queue-2', at: '2026-10-07T00:00:03Z', type: 'completed', artifactId: 'artifact-2', preview: 'again' }, limits, true);
  assert.deepEqual(second, { kind: 'next', run: { ...queuedRun(child.childId, 'queue-3'), status: 'running' } });
  assert.equal((await store.getChild(child.childId))?.lastCompletedLeaf, 'leaf-2');
  await store.requestStop(child.childId, 'queue-3', admission.lease.ownerToken);
  await store.close();
}));

test('expected-run stop clears queued work idempotently and emits terminal events atomically', async () => tempDb(async dbPath => {
  const store = new SQLiteStore(dbPath, { brokerId: 'broker' });
  const { child, run, event } = records('stop');
  const admission = await store.createChild(child, run, event, limits);
  assert.equal(admission.kind, 'started');
  if (admission.kind !== 'started') return;
  await store.admitRun(child.childId, queuedRun(child.childId, 'stop-2'), limits);
  await store.admitRun(child.childId, queuedRun(child.childId, 'stop-3'), limits);
  assert.deepEqual(await store.requestStop(child.childId, 'stale', admission.lease.ownerToken), { kind: 'stale' });
  assert.deepEqual(await store.requestStop(child.childId, run.runId, admission.lease.ownerToken), { kind: 'requested' });
  const afterStop = await store.readEvents(child.childId, 0, 20);
  assert.deepEqual(afterStop.events.filter(item => (item.runId === 'stop-2' || item.runId === 'stop-3') && item.type !== 'run_queued').map(item => ({ runId: item.runId, type: item.type, code: 'code' in item ? item.code : undefined })), [
    { runId: 'stop-2', type: 'failed', code: 'previous_run_stopped' },
    { runId: 'stop-3', type: 'failed', code: 'previous_run_stopped' },
  ]);
  assert.deepEqual(await store.requestStop(child.childId, run.runId, admission.lease.ownerToken), { kind: 'requested' });
  const inspect = new DatabaseSync(dbPath);
  const queued = inspect.prepare('SELECT status, error_code FROM runs WHERE run_id = ?').get('stop-2') as { status: string; error_code: string };
  assert.equal(queued.status, 'stopped'); assert.equal(queued.error_code, 'previous_run_stopped');
  inspect.close();
  assert.deepEqual(await store.settleRun(child.childId, run.runId, admission.lease.ownerToken,
    { type: 'stopped' }, { childId: child.childId, runId: run.runId, at: '2026-10-07T00:00:02Z', type: 'stop_confirmed' }, limits, true), { kind: 'idle' });
  assert.equal((await store.getChild(child.childId))?.activeRunId, undefined);
  await store.close();
}));

test('events have durable monotonic cursors, explicit retention gaps, and abortable subscriptions', async () => tempDb(async dbPath => {
  const store = new SQLiteStore(dbPath, { brokerId: 'broker', eventRetention: 2 });
  const { child, run, event } = records('events');
  const admission = await store.createChild(child, run, event, limits);
  assert.equal(admission.kind, 'started');
  await store.appendEvent(child.childId, { childId: child.childId, at: '2026-10-07T00:00:01Z', type: 'text', text: 'one' });
  await store.appendEvent(child.childId, { childId: child.childId, at: '2026-10-07T00:00:02Z', type: 'text', text: 'two' });
  const gap = await store.readEvents(child.childId, 0, 10);
  assert.equal(gap.cursorGap, true);
  assert.equal(gap.oldestCursor, 2);
  assert.deepEqual(gap.events.map(item => item.seq), [2, 3]);
  const controller = new AbortController();
  const subscription = await store.subscribe(child.childId, 3, controller.signal);
  const iterator = subscription[Symbol.asyncIterator]();
  const pending = iterator.next();
  controller.abort();
  assert.deepEqual(await pending, { value: undefined, done: true });
  await store.close();
  const reopened = new SQLiteStore(dbPath, { brokerId: 'reopened', eventRetention: 2 });
  const fourth = await reopened.appendEvent(child.childId, { childId: child.childId, at: '2026-10-07T00:00:03Z', type: 'text', text: 'three' });
  assert.equal(fourth.seq, 4);
  const afterReopen = await reopened.readEvents(child.childId, 3, 10);
  assert.equal(afterReopen.oldestCursor, 3);
  assert.deepEqual(afterReopen.events.map(item => item.seq), [4]);
  await reopened.close();
}));

test('ownership generations reject stale settle calls and resume commits model only after readonly checkpoint inspection', async () => tempDb(async dbPath => {
  const store = new SQLiteStore(dbPath, { brokerId: 'broker' });
  await store.putTemplate(coder);
  const { child, run, event } = records('generation', true);
  const admission = await store.createChild(child, run, event, limits);
  assert.equal(admission.kind, 'started');
  if (admission.kind !== 'started') return;
  assert.deepEqual(await store.settleRun(child.childId, run.runId, 'wrong-token',
    { type: 'failed', code: 'x' }, { childId: child.childId, runId: run.runId, at: '2026-10-07T00:00:01Z', type: 'failed', code: 'x' }, limits, true), { kind: 'stale' });
  await store.settleRun(child.childId, run.runId, admission.lease.ownerToken,
    { type: 'completed', checkpointId: 'leaf', artifactId: 'a', preview: 'p' }, { childId: child.childId, runId: run.runId, at: '2026-10-07T00:00:01Z', type: 'completed', artifactId: 'a', preview: 'p' }, limits, true);
  const inspected = await store.validateResume(child.childId);
  assert.equal(inspected.kind, 'ready');
  if (inspected.kind === 'ready') {
    assert.deepEqual(inspected.child.model, child.model);
    assert.equal(inspected.child.lastCompletedLeaf, 'leaf');
    const resumed = await store.commitResume(child.childId, inspected.generation, { url: 'https://next.example', model: 'next' });
    assert.equal(resumed.kind, 'committed');
    if (resumed.kind === 'committed') {
      assert.deepEqual(resumed.child.model, { url: 'https://next.example', model: 'next' });
      assert.equal(resumed.child.ownerGeneration, inspected.generation + 1);
    }
    assert.deepEqual(await store.commitResume(child.childId, inspected.generation, { url: 'https://stale.example', model: 'stale' }), { kind: 'busy' });
  }
  await store.close();
}));

test('failed runs clear their pending queue and never dispatch it', async () => tempDb(async dbPath => {
  const store = new SQLiteStore(dbPath, { brokerId: 'broker' });
  const { child, run, event } = records('failure-queue');
  const admission = await store.createChild(child, run, event, limits);
  assert.equal(admission.kind, 'started');
  if (admission.kind !== 'started') return;
  await store.settleRun(child.childId, run.runId, admission.lease.ownerToken,
    { type: 'completed', checkpointId: 'leaf-before-failure', artifactId: 'artifact-before-failure', preview: 'done' },
    { childId: child.childId, runId: run.runId, at: '2026-10-07T00:00:01Z', type: 'completed', artifactId: 'artifact-before-failure', preview: 'done' }, limits, true);
  const failedRun = queuedRun(child.childId, 'failure-main');
  const failureAdmission = await store.admitRun(child.childId, failedRun, limits);
  assert.equal(failureAdmission.kind, 'started');
  if (failureAdmission.kind !== 'started') return;
  await store.admitRun(child.childId, queuedRun(child.childId, 'failure-queue-2'), limits);
  await store.admitRun(child.childId, queuedRun(child.childId, 'failure-queue-3'), limits);
  const settled = await store.settleRun(child.childId, failedRun.runId, failureAdmission.lease.ownerToken,
    { type: 'failed', code: 'model_error' }, { childId: child.childId, runId: failedRun.runId, at: '2026-10-07T00:00:02Z', type: 'failed', code: 'model_error' }, limits, true);
  assert.deepEqual(settled, { kind: 'idle' });
  assert.equal((await store.getChild(child.childId))?.activeRunId, undefined);
  assert.equal((await store.getChild(child.childId))?.lastCompletedLeaf, 'leaf-before-failure');
  assert.equal((await store.admitRun(child.childId, queuedRun(child.childId, 'fresh-after-failure'), limits)).kind, 'started');
  const inspect = new DatabaseSync(dbPath);
  const queued = (inspect.prepare("SELECT run_id, status, error_code FROM runs WHERE child_id = ? AND status = 'stopped' AND run_id LIKE 'failure-queue-%' ORDER BY run_id").all(child.childId) as { run_id: string; status: string; error_code: string }[])
    .map(row => ({ run_id: row.run_id, status: row.status, error_code: row.error_code }));
  assert.deepEqual(queued, [
    { run_id: 'failure-queue-2', status: 'stopped', error_code: 'previous_run_failed' },
    { run_id: 'failure-queue-3', status: 'stopped', error_code: 'previous_run_failed' },
  ]);
  inspect.close();
  const events = await store.readEvents(child.childId, 0, 20);
  assert.deepEqual(events.events.filter(item => (item.runId === 'failure-queue-2' || item.runId === 'failure-queue-3') && item.type !== 'run_queued').map(item => ({ runId: item.runId, type: item.type, code: 'code' in item ? item.code : undefined })), [
    { runId: 'failure-queue-2', type: 'failed', code: 'previous_run_failed' },
    { runId: 'failure-queue-3', type: 'failed', code: 'previous_run_failed' },
  ]);
  await store.close();
}));

test('confirmed interrupted runs emit terminal events for every canceled queued run', async () => tempDb(async dbPath => {
  const store = new SQLiteStore(dbPath, { brokerId: 'broker' });
  const { child, run, event } = records('interruption-queue');
  const admission = await store.createChild(child, run, event, limits);
  assert.equal(admission.kind, 'started');
  if (admission.kind !== 'started') return;
  await store.admitRun(child.childId, queuedRun(child.childId, 'interruption-queue-2'), limits);
  await store.admitRun(child.childId, queuedRun(child.childId, 'interruption-queue-3'), limits);
  assert.deepEqual(await store.settleRun(child.childId, run.runId, admission.lease.ownerToken,
    { type: 'interrupted', code: 'worker_interrupted' },
    { childId: child.childId, runId: run.runId, at: '2026-10-07T00:00:02Z', type: 'interrupted', code: 'worker_interrupted' }, limits, true), { kind: 'idle' });
  const events = await store.readEvents(child.childId, 0, 20);
  assert.deepEqual(events.events.filter(item => (item.runId === 'interruption-queue-2' || item.runId === 'interruption-queue-3') && item.type !== 'run_queued').map(item => ({ runId: item.runId, type: item.type, code: 'code' in item ? item.code : undefined })), [
    { runId: 'interruption-queue-2', type: 'interrupted', code: 'previous_run_interrupted' },
    { runId: 'interruption-queue-3', type: 'interrupted', code: 'previous_run_interrupted' },
  ]);
  const inspect = new DatabaseSync(dbPath);
  const queued = (inspect.prepare("SELECT run_id, status, error_code FROM runs WHERE child_id = ? AND status = 'stopped' ORDER BY run_id").all(child.childId) as { run_id: string; status: string; error_code: string }[])
    .map(row => ({ run_id: row.run_id, status: row.status, error_code: row.error_code }));
  assert.deepEqual(queued, [
    { run_id: 'interruption-queue-2', status: 'stopped', error_code: 'previous_run_interrupted' },
    { run_id: 'interruption-queue-3', status: 'stopped', error_code: 'previous_run_interrupted' },
  ]);
  inspect.close();
  await store.close();
}));

test('two independent connections cannot claim the same idle child twice', async () => tempDb(async dbPath => {
  const a = new SQLiteStore(dbPath, { brokerId: 'claim-a' });
  const b = new SQLiteStore(dbPath, { brokerId: 'claim-b' });
  const { child, run, event } = records('single-claim');
  const initial = await a.createChild(child, run, event, limits);
  assert.equal(initial.kind, 'started');
  if (initial.kind !== 'started') return;
  await a.settleRun(child.childId, run.runId, initial.lease.ownerToken,
    { type: 'completed', checkpointId: 'leaf', artifactId: 'a', preview: 'a' },
    { childId: child.childId, runId: run.runId, at: '2026-10-07T00:00:02Z', type: 'completed', artifactId: 'a', preview: 'a' }, limits, true);
  const outcomes = await Promise.all([
    a.admitRun(child.childId, queuedRun(child.childId, 'claim-a-run'), limits),
    b.admitRun(child.childId, queuedRun(child.childId, 'claim-b-run'), limits),
  ]);
  assert.equal(outcomes.filter(value => value.kind === 'started').length, 1);
  assert.equal(outcomes.filter(value => value.kind === 'recovery_required').length, 1);
  const active = (await a.getChild(child.childId))?.activeRunId;
  assert.ok(active === 'claim-a-run' || active === 'claim-b-run');
  await a.close(); await b.close();
}));

test('resume commits use an atomic generation guard across connections', async () => tempDb(async dbPath => {
  const a = new SQLiteStore(dbPath, { brokerId: 'resume-a' });
  const b = new SQLiteStore(dbPath, { brokerId: 'resume-b' });
  const { child, run, event } = records('resume-race');
  const initial = await a.createChild(child, run, event, limits);
  assert.equal(initial.kind, 'started');
  if (initial.kind !== 'started') return;
  await a.settleRun(child.childId, run.runId, initial.lease.ownerToken,
    { type: 'completed', checkpointId: 'leaf', artifactId: 'a', preview: 'a' },
    { childId: child.childId, runId: run.runId, at: '2026-10-07T00:00:02Z', type: 'completed', artifactId: 'a', preview: 'a' }, limits, true);
  const [claimA, claimB] = await Promise.all([a.validateResume(child.childId), b.validateResume(child.childId)]);
  assert.equal(claimA.kind, 'ready'); assert.equal(claimB.kind, 'ready');
  if (claimA.kind !== 'ready' || claimB.kind !== 'ready') return;
  const outcomes = await Promise.all([
    a.commitResume(child.childId, claimA.generation, { url: 'https://a.example', model: 'a' }),
    b.commitResume(child.childId, claimB.generation, { url: 'https://b.example', model: 'b' }),
  ]);
  assert.equal(outcomes.filter(value => value.kind === 'committed').length, 1);
  assert.equal(outcomes.filter(value => value.kind === 'busy').length, 1);
  await a.close(); await b.close();
}));

test('audit: recovering an exited owner stops queued runs and never lets them start after a fresh admission', async () => tempDb(async dbPath => {
  const store = new SQLiteStore(dbPath, { brokerId: 'audit-owner' });
  const inspect = new DatabaseSync(dbPath);
  try {
    const { child, run, event } = records('audit-recover');
    const first = await store.createChild(child, run, event, limits);
    assert.equal(first.kind, 'started');
    if (first.kind !== 'started') return;
    const settledFirst = await store.settleRun(child.childId, run.runId, first.lease.ownerToken,
      { type: 'completed', checkpointId: 'audit-leaf', artifactId: 'audit-artifact', preview: 'done' },
      { childId: child.childId, runId: run.runId, at: '2026-10-07T00:00:02Z', type: 'completed', artifactId: 'audit-artifact', preview: 'done' }, limits, true);
    assert.deepEqual(settledFirst, { kind: 'idle' });

    const active = await store.admitRun(child.childId, queuedRun(child.childId, 'audit-active'), limits);
    assert.equal(active.kind, 'started');
    if (active.kind !== 'started') return;
    assert.equal((await store.admitRun(child.childId, queuedRun(child.childId, 'audit-queued-1'), limits)).kind, 'queued');
    assert.equal((await store.admitRun(child.childId, queuedRun(child.childId, 'audit-queued-2'), limits)).kind, 'queued');

    assert.equal(await store.recoverExitedOwner(child.childId, active.lease.generation, 'audit-active'), true);
    assert.equal((await store.getChild(child.childId))?.lastCompletedLeaf, 'audit-leaf');

    const statuses = inspect.prepare("SELECT run_id, status, error_code FROM runs WHERE run_id LIKE 'audit-queued-%' ORDER BY run_id").all() as { run_id: string; status: string; error_code: string | null }[];
    assert.deepEqual(statuses.map(row => ({ ...row })), [
      { run_id: 'audit-queued-1', status: 'stopped', error_code: 'previous_run_interrupted' },
      { run_id: 'audit-queued-2', status: 'stopped', error_code: 'previous_run_interrupted' },
    ]);
    const events = await store.readEvents(child.childId, 0, 100);
    for (const runId of ['audit-queued-1', 'audit-queued-2']) {
      const terminal = events.events.filter(item => item.runId === runId && item.type !== 'run_queued');
      assert.deepEqual(terminal.map(item => ({ type: item.type, code: 'code' in item ? item.code : undefined })), [{ type: 'interrupted', code: 'previous_run_interrupted' }], runId);
    }

    const validation = await store.validateResume(child.childId);
    assert.equal(validation.kind, 'ready');
    if (validation.kind !== 'ready') return;
    const committed = await store.commitResume(child.childId, validation.generation, child.model);
    assert.equal(committed.kind, 'committed');
    assert.equal((await store.getChild(child.childId))?.activeRunId, undefined);

    const fresh = await store.admitRun(child.childId, queuedRun(child.childId, 'audit-fresh'), limits);
    assert.equal(fresh.kind, 'started');
    if (fresh.kind !== 'started') return;
    const settled = await store.settleRun(child.childId, 'audit-fresh', fresh.lease.ownerToken,
      { type: 'completed', checkpointId: 'audit-leaf-2', artifactId: 'audit-artifact-2', preview: 'fresh' },
      { childId: child.childId, runId: 'audit-fresh', at: '2026-10-07T00:00:05Z', type: 'completed', artifactId: 'audit-artifact-2', preview: 'fresh' }, limits, true);
    assert.deepEqual(settled, { kind: 'idle' });
    assert.equal((await store.getChild(child.childId))?.activeRunId, undefined);
    const after = inspect.prepare("SELECT run_id, status FROM runs WHERE run_id LIKE 'audit-queued-%' ORDER BY run_id").all() as { run_id: string; status: string }[];
    assert.deepEqual(after.map(row => ({ ...row })), [{ run_id: 'audit-queued-1', status: 'stopped' }, { run_id: 'audit-queued-2', status: 'stopped' }]);
  } finally { inspect.close(); await store.close(); }
}));

test('audit: stop request state, queue cancellation, and stop_requested event commit atomically', async () => tempDb(async dbPath => {
  const store = new SQLiteStore(dbPath, { brokerId: 'audit-stop' });
  const inspect = new DatabaseSync(dbPath);
  try {
    const { child, run, event } = records('audit-stop');
    const admission = await store.createChild(child, run, event, limits);
    assert.equal(admission.kind, 'started');
    if (admission.kind !== 'started') return;
    await store.admitRun(child.childId, queuedRun(child.childId, 'audit-stop-queued'), limits);
    const count = (type: string) => (inspect.prepare('SELECT COUNT(*) AS count FROM events WHERE child_id = ? AND type = ?').get(child.childId, type) as { count: number }).count;
    const status = (runId: string) => (inspect.prepare('SELECT status FROM runs WHERE run_id = ?').get(runId) as { status: string }).status;

    inspect.exec(`CREATE TRIGGER reject_stop_requested BEFORE INSERT ON events WHEN NEW.type = 'stop_requested' BEGIN SELECT RAISE(ABORT, 'blocked stop event'); END`);
    await assert.rejects(store.requestStop(child.childId, run.runId, admission.lease.ownerToken), /blocked stop event/);
    assert.equal(status(run.runId), 'running');
    assert.equal(status('audit-stop-queued'), 'queued');
    assert.equal(count('stop_requested'), 0);

    inspect.exec('DROP TRIGGER reject_stop_requested');
    assert.deepEqual(await store.requestStop(child.childId, run.runId, admission.lease.ownerToken), { kind: 'requested' });
    assert.equal(status(run.runId), 'stop_requested');
    assert.equal(status('audit-stop-queued'), 'stopped');
    assert.equal(count('stop_requested'), 1);
    assert.deepEqual(await store.requestStop(child.childId, run.runId, admission.lease.ownerToken), { kind: 'requested' });
    assert.equal(count('stop_requested'), 1, 'a repeated stop does not duplicate the event');
  } finally { inspect.close(); await store.close(); }
}));

test('audit: admission with a stale owner generation is rejected without inserting a run or event', async () => tempDb(async dbPath => {
  const a = new SQLiteStore(dbPath, { brokerId: 'audit-gen-a' });
  const b = new SQLiteStore(dbPath, { brokerId: 'audit-gen-b' });
  const inspect = new DatabaseSync(dbPath);
  try {
    const { child, run, event } = records('audit-generation');
    const first = await a.createChild(child, run, event, limits);
    assert.equal(first.kind, 'started');
    if (first.kind !== 'started') return;
    await a.settleRun(child.childId, run.runId, first.lease.ownerToken,
      { type: 'completed', checkpointId: 'gen-leaf', artifactId: 'gen-artifact', preview: 'done' },
      { childId: child.childId, runId: run.runId, at: '2026-10-07T00:00:02Z', type: 'completed', artifactId: 'gen-artifact', preview: 'done' }, limits, true);
    const observed = (await a.getChild(child.childId))!.ownerGeneration;
    const claim = await b.validateResume(child.childId);
    assert.equal(claim.kind, 'ready');
    if (claim.kind !== 'ready') return;
    assert.equal((await b.commitResume(child.childId, claim.generation, { ...child.model, model: 'model-b' })).kind, 'committed');

    const runCount = () => (inspect.prepare('SELECT COUNT(*) AS count FROM runs WHERE run_id = ?').get('audit-generation-stale') as { count: number }).count;
    const eventCount = () => (inspect.prepare('SELECT COUNT(*) AS count FROM events WHERE run_id = ?').get('audit-generation-stale') as { count: number }).count;
    assert.deepEqual(await a.admitRun(child.childId, queuedRun(child.childId, 'audit-generation-stale'), limits, observed), { kind: 'busy' });
    assert.equal(runCount(), 0);
    assert.equal(eventCount(), 0);

    const current = (await a.getChild(child.childId))!.ownerGeneration;
    assert.equal((await a.admitRun(child.childId, queuedRun(child.childId, 'audit-generation-fresh'), limits, current)).kind, 'started');
  } finally { inspect.close(); await a.close(); await b.close(); }
}));

test('audit: stopping a run whose worker exit was unconfirmed reports recovery_required', async () => tempDb(async dbPath => {
  const store = new SQLiteStore(dbPath, { brokerId: 'audit-unconfirmed-stop' });
  try {
    const { child, run, event } = records('audit-unconfirmed-stop');
    const admission = await store.createChild(child, run, event, limits);
    assert.equal(admission.kind, 'started');
    if (admission.kind !== 'started') return;
    assert.deepEqual(await store.settleRun(child.childId, run.runId, admission.lease.ownerToken,
      { type: 'interrupted', code: 'exit_unknown' }, { childId: child.childId, runId: run.runId, at: '2026-10-07T00:00:02Z', type: 'interrupted', code: 'exit_unknown' }, limits, false), { kind: 'recovery_required' });
    assert.deepEqual(await store.requestStop(child.childId, run.runId, admission.lease.ownerToken), { kind: 'recovery_required' });
  } finally { await store.close(); }
}));
