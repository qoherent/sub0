import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgent } from '../../src/config/agent-config.js';
import type { Result } from '../../src/core/types.js';
import { TaskStore, type ProcessProbe } from '../../src/store/task-store.js';
import { makeProject } from '../helpers.js';

const DEAD = 999_999;

function probe(alive: Record<number, string>, unknown = false): ProcessProbe {
  return { startTime: (pid) => (unknown ? undefined : alive[pid] ?? null) };
}

function setup(options: { owner?: { pid: number; startTime: string }; alive?: Record<number, string> } = {}) {
  const root = makeProject();
  const warnings: string[] = [];
  const store = new TaskStore(root, {
    warn: (m) => warnings.push(m),
    probe: probe(options.alive ?? { [process.pid]: 'now' }),
    owner: options.owner ?? { pid: process.pid, startTime: 'now' },
  });
  const agent = getAgent(root, 'helper');
  const create = (taskId: string, parentSessionId?: string) =>
    store.createTaskRecord({ taskId, agent, brief: 'b', model: agent.model, createdAt: new Date().toISOString(), ...(parentSessionId ? { parentSessionId } : {}) });
  return { root, store, warnings, create };
}

const result = (taskId: string, status: Result['status'] = 'completed'): Result => ({ taskId, agent: 'helper', status, summary: 's' });

describe('TaskStore', () => {
  it('keeps the latest line after three status updates and skips a corrupt last line', () => {
    const { store, warnings, create } = setup();
    create('sz-aaaaaa');
    appendFileSync(store.indexPath, JSON.stringify({ taskId: 'sz-aaaaaa', agent: 'helper', status: 'running', childSession: 'sz-aaaaaa', createdAt: 'x', updatedAt: 'y' }) + '\n');
    store.writeResult('sz-aaaaaa', result('sz-aaaaaa', 'truncated'));
    appendFileSync(store.indexPath, '{"taskId": "sz-aaaa');
    expect(store.readLatest().get('sz-aaaaaa')!.status).toBe('truncated');
    expect(store.readTask('sz-aaaaaa')!.status).toBe('truncated');
    expect(warnings.some((w) => w.includes('corrupt line 4'))).toBe(true);
  });

  it('marks a running task of a dead owner abandoned, and leaves a live owner running', () => {
    const dead = setup({ owner: { pid: DEAD, startTime: 'then' } });
    dead.create('sz-dddddd');
    const liveStore = new TaskStore(dead.root, { probe: probe({ [process.pid]: 'now' }), owner: { pid: process.pid, startTime: 'now' } });
    liveStore.createTaskRecord({ taskId: 'sz-llllll', agent: getAgent(dead.root, 'helper'), brief: 'b', createdAt: new Date().toISOString() });

    expect(liveStore.sweep()).toEqual(['sz-dddddd']);
    expect(liveStore.readTask('sz-dddddd')!.status).toBe('abandoned');
    expect(liveStore.readTask('sz-llllll')!.status).toBe('running');
    // A second sweep appends nothing and changes nothing.
    const lines = readFileSync(liveStore.indexPath, 'utf8').split('\n').filter(Boolean).length;
    expect(liveStore.sweep()).toEqual([]);
    expect(readFileSync(liveStore.indexPath, 'utf8').split('\n').filter(Boolean).length).toBe(lines);
  });

  it('treats an owner alive with another start time as gone', () => {
    const { store, create } = setup({ owner: { pid: process.pid, startTime: 'earlier' }, alive: { [process.pid]: 'now' } });
    create('sz-rrrrrr');
    expect(store.sweep()).toEqual(['sz-rrrrrr']);
  });

  it('never marks a task when the probe cannot tell, or when the owner start time was unknown', () => {
    const { root, create } = setup({ owner: { pid: DEAD, startTime: 'then' } });
    create('sz-uuuuua');
    expect(new TaskStore(root, { probe: probe({}, true) }).sweep()).toEqual([]);
    const unknownOwner = new TaskStore(root, { probe: probe({ [process.pid]: 'now' }), owner: { pid: process.pid, startTime: 'unknown' } });
    unknownOwner.createTaskRecord({ taskId: 'sz-uuuuub', agent: getAgent(root, 'helper'), brief: 'b', createdAt: new Date().toISOString() });
    expect(unknownOwner.sweep()).toEqual(['sz-uuuuua']);
  });

  it('marks nothing when the probe cannot read this process', () => {
    const { root, create } = setup({ owner: { pid: DEAD, startTime: 'then' } });
    create('sz-selfnn');
    const blind: ProcessProbe = { startTime: (pid) => (pid === process.pid ? undefined : null) };
    expect(new TaskStore(root, { probe: blind }).sweep()).toEqual([]);
  });

  it('records the session file of an abandoned task, so it can still be attached', () => {
    const { store, create } = setup({ owner: { pid: DEAD, startTime: 'then' } });
    create('sz-sessnn');
    mkdirSync(store.sessionsFolder, { recursive: true });
    writeFileSync(path.join(store.sessionsFolder, '2026-11-03T00-00-00Z_sz-sessnn.jsonl'), '{}\n');
    store.sweep();
    const line = store.readLatest().get('sz-sessnn')!;
    expect(line.status).toBe('abandoned');
    expect(line.sessionFile).toBe(path.join(store.sessionsFolder, '2026-11-03T00-00-00Z_sz-sessnn.jsonl'));
  });

  it('reads a task whose result was written before its settled line as settled', () => {
    const { store, create } = setup({ owner: { pid: DEAD, startTime: 'then' } });
    create('sz-ssssss');
    // The owner died after writing turns/1.json but before appending its line.
    writeFileSync(path.join(store.taskDir('sz-ssssss'), 'turns', '1.json'), JSON.stringify(result('sz-ssssss')));
    expect(store.sweep()).toEqual([]);
    expect(store.readTask('sz-ssssss')!.status).toBe('completed');
    // An abandoned line after a stored result is ignored by every reader.
    appendFileSync(store.indexPath, JSON.stringify({ taskId: 'sz-ssssss', agent: 'helper', status: 'abandoned', childSession: 'sz-ssssss', createdAt: 'x', updatedAt: 'y' }) + '\n');
    expect(store.readTask('sz-ssssss')!.status).toBe('completed');
    expect(store.list().find((t) => t.taskId === 'sz-ssssss')!.status).toBe('completed');
  });

  it('creates the store folder owner-only with its own .gitignore, leaving the user .gitignore unchanged', () => {
    const { root, store, create } = setup();
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
    create('sz-gggggg');
    store.appendEvent('sz-gggggg', { kind: 'turn_settled' });
    expect(statSync(store.storeFolder).mode & 0o777).toBe(0o700);
    expect(readFileSync(path.join(store.storeFolder, '.gitignore'), 'utf8')).toBe('*\n');
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    expect(status).not.toMatch(/\.agents\/subzero\//);
  });

  it('leaves an existing .gitignore in the store folder unchanged', () => {
    const { store, create } = setup();
    create('sz-hhhhhh');
    writeFileSync(path.join(store.storeFolder, '.gitignore'), 'custom\n');
    create('sz-iiiiii');
    expect(readFileSync(path.join(store.storeFolder, '.gitignore'), 'utf8')).toBe('custom\n');
  });

  it('lists the tasks of one parent session id, or of every one', () => {
    const { store, create } = setup();
    create('sz-pppppa', 'session-1');
    create('sz-pppppb', 'session-2');
    create('sz-pppppc');
    expect(store.list('session-1').map((t) => t.taskId)).toEqual(['sz-pppppa']);
    expect(store.list().length).toBe(3);
  });

  it('writes the launch spec and the event log into the task record', () => {
    const { store, create } = setup();
    create('sz-eeeeee');
    store.writeLaunchSpec('sz-eeeeee', { command: ['pi'], cwd: '/', envNames: ['PI_OFFLINE'], version: '0.87.0', skillFolders: [], thinkingLevel: 'high' });
    store.appendEvent('sz-eeeeee', { kind: 'agent_message', text: 'hi' });
    expect(store.readTaskJson('sz-eeeeee')!.launchSpec!.command).toEqual(['pi']);
    expect(existsSync(path.join(store.taskDir('sz-eeeeee'), 'events.jsonl'))).toBe(true);
  });

  it('keeps the model and enqueue time from the first write and the start time once it is written, with the status still running', () => {
    const { store, create } = setup();
    create('sz-qqqqqa');
    const queued = store.readTask('sz-qqqqqa')!;
    expect(queued).toMatchObject({ status: 'running', model: 'local/qwen' });
    expect(queued.createdAt).toBe(queued.task!.createdAt);
    expect(queued.startedAt).toBeUndefined();
    expect(queued.task!.model).toBe('local/qwen');

    store.writeStartTime('sz-qqqqqa', '2026-01-01T00:00:05.000Z');
    const started = store.readTask('sz-qqqqqa')!;
    expect(started).toMatchObject({ status: 'running', model: 'local/qwen', startedAt: '2026-01-01T00:00:05.000Z', createdAt: queued.createdAt });
    // The settled line that follows keeps what the first lines wrote.
    store.writeResult('sz-qqqqqa', result('sz-qqqqqa'));
    expect(store.readTask('sz-qqqqqa')).toMatchObject({ status: 'completed', model: 'local/qwen', startedAt: '2026-01-01T00:00:05.000Z' });
  });

  it('shows the start time in a listing of a second process, and a task without one stays running there', () => {
    const { root, store, create } = setup();
    create('sz-qqqqqb');
    create('sz-qqqqqc');
    store.writeStartTime('sz-qqqqqb', '2026-01-01T00:00:05.000Z');
    const second = new TaskStore(root, { probe: probe({ [process.pid]: 'now' }) });
    const views = new Map(second.list().map((v) => [v.taskId, v]));
    expect(views.get('sz-qqqqqb')).toMatchObject({ status: 'running', startedAt: '2026-01-01T00:00:05.000Z', model: 'local/qwen' });
    expect(views.get('sz-qqqqqc')).toMatchObject({ status: 'running', model: 'local/qwen' });
    expect(views.get('sz-qqqqqc')!.startedAt).toBeUndefined();
  });

  it('marks a task of a dead owner abandoned when it never got a start time, because its stored status is running', () => {
    const dead = setup({ owner: { pid: DEAD, startTime: 'then' } });
    dead.create('sz-qqqqqd');
    const later = new TaskStore(dead.root, { probe: probe({ [process.pid]: 'now' }), owner: { pid: process.pid, startTime: 'now' } });
    expect(later.readTask('sz-qqqqqd')!.status).toBe('running');
    expect(later.sweep()).toEqual(['sz-qqqqqd']);
    expect(later.readTask('sz-qqqqqd')).toMatchObject({ status: 'abandoned', model: 'local/qwen' });
  });

  describe('turns', () => {
    it('covers R21: a v0.1 record whose turns/1.json is a bare result lists as completed turn 1', () => {
      const { root, store, create } = setup();
      create('sz-vvvvvv');
      store.writeResult('sz-vvvvvv', result('sz-vvvvvv'));
      // Rewrite the turn file the way v0.1 wrote it: the bare result and nothing else.
      writeFileSync(path.join(store.taskDir('sz-vvvvvv'), 'turns', '1.json'), JSON.stringify(result('sz-vvvvvv')));
      const fresh = new TaskStore(root, { probe: probe({ [process.pid]: 'now' }) });
      expect(fresh.readTurns('sz-vvvvvv')).toMatchObject([{ turn: 1, result: { taskId: 'sz-vvvvvv', status: 'completed' } }]);
      expect(fresh.readTask('sz-vvvvvv')).toMatchObject({ status: 'completed', turn: 1, result: { summary: 's' } });
      expect(fresh.list().find((t) => t.taskId === 'sz-vvvvvv')).toMatchObject({ status: 'completed', turn: 1 });
    });

    it('reads a task settled at turn 1 with turn 2 opened as running, and lists turn 2\'s enqueue time, not turn 1\'s start time', () => {
      const { store, create } = setup();
      create('sz-tttttt');
      store.writeStartTime('sz-tttttt', '2026-01-01T00:00:05.000Z');
      store.writeResult('sz-tttttt', result('sz-tttttt'));
      expect(store.claimTurn('sz-tttttt', 2, { message: 'more', enqueuedAt: '2026-01-01T01:00:00.000Z' })).toBe(true);
      const view = store.list().find((t) => t.taskId === 'sz-tttttt')!;
      expect(view).toMatchObject({ status: 'running', turn: 2, enqueuedAt: '2026-01-01T01:00:00.000Z' });
      expect(view.startedAt).toBeUndefined();
      // Turn 1's file is untouched, and the record reads the latest turn.
      expect(store.readTurns('sz-tttttt').map((t) => [t.turn, t.result?.status])).toEqual([[1, 'completed'], [2, undefined]]);
      store.writeStartTime('sz-tttttt', '2026-01-01T01:00:03.000Z', 2);
      expect(store.readTask('sz-tttttt')).toMatchObject({ status: 'running', turn: 2, startedAt: '2026-01-01T01:00:03.000Z', result: null });
      store.writeResult('sz-tttttt', { ...result('sz-tttttt', 'failed'), turn: 2 });
      expect(store.readTask('sz-tttttt')).toMatchObject({ status: 'failed', turn: 2, result: { turn: 2 } });
      expect(store.readTurns('sz-tttttt')[0]!.result!.status).toBe('completed');
    });

    it('answers the second exclusive create of a turn as taken, and the loser writes no index line, so the winner stays the owner', () => {
      const winner = setup({ owner: { pid: process.pid, startTime: 'now' } });
      winner.create('sz-cccccc');
      winner.store.writeResult('sz-cccccc', result('sz-cccccc'));
      const loser = new TaskStore(winner.root, { probe: probe({ [process.pid]: 'now' }), owner: { pid: 4242, startTime: 'other' } });
      expect(winner.store.claimTurn('sz-cccccc', 2, { message: 'a', enqueuedAt: 't1' })).toBe(true);
      const lines = readFileSync(winner.store.indexPath, 'utf8').split('\n').filter(Boolean).length;
      expect(loser.claimTurn('sz-cccccc', 2, { message: 'b', enqueuedAt: 't2' })).toBe(false);
      expect(readFileSync(winner.store.indexPath, 'utf8').split('\n').filter(Boolean).length).toBe(lines);
      expect(loser.readTurns('sz-cccccc')[1]).toMatchObject({ turn: 2, message: 'a', owner: { pid: process.pid } });
      expect(loser.readTask('sz-cccccc')!.owner).toEqual({ pid: process.pid, startTime: 'now' });
    });

    it('lets a takeover claim make the new owner\'s sweep leave the running turn alone, and the dead old owner no longer mark it abandoned', () => {
      const dead = setup({ owner: { pid: DEAD, startTime: 'then' } });
      dead.create('sz-oooooo');
      dead.store.writeResult('sz-oooooo', result('sz-oooooo'));
      const newcomer = new TaskStore(dead.root, { probe: probe({ [process.pid]: 'now' }), owner: { pid: process.pid, startTime: 'now' } });
      expect(newcomer.claimTurn('sz-oooooo', 2, { message: 'again', enqueuedAt: 't' })).toBe(true);
      expect(newcomer.readTask('sz-oooooo')!.owner).toEqual({ pid: process.pid, startTime: 'now' });
      expect(newcomer.sweep()).toEqual([]);
      expect(newcomer.readTask('sz-oooooo')!.status).toBe('running');
    });

    it('marks a task abandoned when the owner of its running turn 2 is dead, although turn 1 holds a result', () => {
      const dead = setup({ owner: { pid: DEAD, startTime: 'then' } });
      dead.create('sz-aaaaab');
      dead.store.writeResult('sz-aaaaab', result('sz-aaaaab'));
      dead.store.claimTurn('sz-aaaaab', 2, { message: 'm', enqueuedAt: 't' });
      const later = new TaskStore(dead.root, { probe: probe({ [process.pid]: 'now' }), owner: { pid: process.pid, startTime: 'now' } });
      expect(later.sweep()).toEqual(['sz-aaaaab']);
      expect(later.readTask('sz-aaaaab')).toMatchObject({ status: 'abandoned', turn: 2 });
    });

    it('keeps the latest owner line and the first line\'s creation time', () => {
      const first = setup({ owner: { pid: 111, startTime: 'one' } });
      first.create('sz-llllla', 'parent-1');
      const created = first.store.readLatest().get('sz-llllla')!.createdAt;
      first.store.writeResult('sz-llllla', result('sz-llllla'));
      const second = new TaskStore(first.root, { probe: probe({ [process.pid]: 'now' }), owner: { pid: 222, startTime: 'two' } });
      second.claimTurn('sz-llllla', 2, { message: 'm', enqueuedAt: 't' });
      const line = second.readLatest().get('sz-llllla')!;
      expect(line.owner).toEqual({ pid: 222, startTime: 'two' });
      expect(line.createdAt).toBe(created);
      expect(line.parentSessionId).toBe('parent-1');
    });

    it('writes and reads the collected marker of each turn, and a fresh reader counts only marked turns as collected', () => {
      const { root, store, create } = setup();
      create('sz-mmmmmm');
      store.writeResult('sz-mmmmmm', result('sz-mmmmmm'));
      store.claimTurn('sz-mmmmmm', 2, { message: 'm', enqueuedAt: 't' });
      store.writeResult('sz-mmmmmm', { ...result('sz-mmmmmm'), turn: 2 });
      expect(store.uncollectedTurns('sz-mmmmmm').map((t) => t.turn)).toEqual([1, 2]);
      store.markCollected('sz-mmmmmm', 1);
      store.markCollected('sz-mmmmmm', 1);
      const fresh = new TaskStore(root, { probe: probe({ [process.pid]: 'now' }) });
      expect(fresh.isCollected('sz-mmmmmm', 1)).toBe(true);
      expect(fresh.isCollected('sz-mmmmmm', 2)).toBe(false);
      expect(fresh.uncollectedTurns('sz-mmmmmm').map((t) => t.turn)).toEqual([2]);
    });

    it('keeps the tier in task.json and shows it on a task loaded from its record', () => {
      const { store } = setup();
      store.createTaskRecord({ taskId: 'sz-tiertt', agent: getAgent(setup().root, 'helper'), brief: 'b', tier: 'small', createdAt: new Date().toISOString() });
      expect(store.readTask('sz-tiertt')!.task!.tier).toBe('small');
    });

    it('records the opening message, replayed messages, start time and stop reason in the turn file', () => {
      const { store, create } = setup();
      create('sz-ffffff');
      store.writeResult('sz-ffffff', result('sz-ffffff'));
      store.claimTurn('sz-ffffff', 2, { message: 'now', replayed: ['old one', 'old two'], enqueuedAt: 't' });
      store.writeStartTime('sz-ffffff', 'start', 2);
      store.writeStopReason('sz-ffffff', 2, 'session_end');
      expect(store.readTurns('sz-ffffff')[1]).toMatchObject({ turn: 2, message: 'now', replayed: ['old one', 'old two'], enqueuedAt: 't', startedAt: 'start', stopReason: 'session_end' });
    });
  });
});
