import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgent } from '../../src/config/agent-config.js';
import { TaskCore } from '../../src/core/task-core.js';
import { unavailableUsage, type ChildOutcome, type ChildPort, type ChildRunRequest, type DomainEvent } from '../../src/core/types.js';
import { TaskStore } from '../../src/store/task-store.js';
import { SessionMissingError } from '../../src/core/types.js';
import { makeProject, manualPort, until } from '../helpers.js';

/** A child port whose runs the test settles by hand. */
function scriptedPort() {
  const runs: {
    emit: (e: DomainEvent) => void;
    settle: (o: ChildOutcome) => void;
    cancelled: boolean;
    brief: string;
    request: ChildRunRequest;
  }[] = [];
  const port: ChildPort = {
    start(request, onEvent) {
      let settle!: (o: ChildOutcome) => void;
      const outcome = new Promise<ChildOutcome>((r) => (settle = r));
      const run = { emit: onEvent, settle, cancelled: false, brief: request.brief, request };
      runs.push(run);
      return {
        outcome,
        cancel: () => {
          run.cancelled = true;
          settle({ lastAssistantText: null, status: 'cancelled', usage: unavailableUsage('stopped') });
        },
      };
    },
  };
  return { port, runs };
}

function setup() {
  const root = makeProject();
  const store = new TaskStore(root, { warn: () => {} });
  const { port, runs } = scriptedPort();
  const core = new TaskCore({ projectRoot: root, store });
  return { root, store, core, port, runs, agent: getAgent(root, 'helper') };
}

const usage = unavailableUsage('n/a');

describe('TaskCore', () => {
  it('keeps the child run Pending until released, then passes the brief to the port', () => {
    const { core, port, runs, agent } = setup();
    const task = core.start({ agent, port, brief: 'do it' });
    expect(task.state).toBe('Pending');
    expect(runs.length).toBe(0);
    task.release();
    expect(task.state).toBe('Starting');
    expect(runs[0]!.brief).toBe('do it');
  });

  it('hands the port the project root, the sessions folder and the driver-files folder of the task on each start', () => {
    const { core, port, runs, agent, root, store } = setup();
    const a = core.start({ agent, port, brief: 'a' });
    const b = core.start({ agent, port, brief: 'b' });
    a.release();
    b.release();
    expect(runs[0]!.request).toMatchObject({
      taskId: a.taskId,
      projectRoot: root,
      sessionsFolder: store.sessionsFolder,
      driverFilesFolder: store.driverFilesFolder(a.taskId),
    });
    expect(runs[1]!.request.driverFilesFolder).toBe(store.driverFilesFolder(b.taskId));
    expect(runs[1]!.request.driverFilesFolder).not.toBe(runs[0]!.request.driverFilesFolder);
  });

  it('keeps a long summary whole, whatever its status, and puts the task id first', async () => {
    for (const status of ['completed', 'truncated'] as const) {
      const { core, port, runs, agent } = setup();
      const task = core.start({ agent, port, brief: 'b' });
      task.release();
      const text = '```ts\n' + 'line\n'.repeat(12_000);
      runs[0]!.settle({ lastAssistantText: text, status, usage });
      const result = await task.result;
      expect(Object.keys(result)[0]).toBe('taskId');
      expect(result.status).toBe(status);
      expect(result.summary).toBe(text);
    }
  });

  it('gives a failed run its failure kind and a cancelled run none', async () => {
    const { core, port, runs, agent } = setup();
    const a = core.start({ agent, port, brief: 'b' });
    a.release();
    runs[0]!.settle({ lastAssistantText: 'x', status: 'failed', failureKind: 'error', message: 'boom', usage });
    expect(await a.result).toMatchObject({ status: 'failed', failureKind: 'error', message: 'boom' });
    expect(a.state).toBe('Failed');

    const b = core.start({ agent, port, brief: 'b' });
    b.release();
    const cancelled = await b.cancel();
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.failureKind).toBeUndefined();
    expect(b.state).toBe('Cancelled');
  });

  it('never starts a child for a task cancelled while Pending', async () => {
    const { core, port, runs, agent, store } = setup();
    const task = core.start({ agent, port, brief: 'b' });
    const result = await task.cancel();
    task.release();
    expect(runs.length).toBe(0);
    expect(result).toEqual({ taskId: task.taskId, agent: 'helper', status: 'cancelled' });
    expect(store.readTask(task.taskId)!.status).toBe('cancelled');
  });

  it('writes the launch spec of the run started event before the run settles', async () => {
    const { core, port, runs, agent, store } = setup();
    const task = core.start({ agent, port, brief: 'b' });
    task.release();
    const launchSpec = { command: ['pi', '--mode', 'rpc'], cwd: '/p', envNames: ['PI_OFFLINE'], version: '0.87.0', skillFolders: [], thinkingLevel: 'high' };
    runs[0]!.emit({ kind: 'run_started', launchSpec });
    expect(store.readTaskJson(task.taskId)!.launchSpec).toEqual(launchSpec);
    expect(store.readTask(task.taskId)!.status).toBe('running');
    runs[0]!.emit({ kind: 'skills_verified', skills: ['alpha'] });
    expect(task.state).toBe('Starting');
    runs[0]!.emit({ kind: 'prompt_sent' });
    expect(task.state).toBe('Live');
  });

  it('produces exactly one result and writes it to the task record', async () => {
    const { core, port, runs, agent, store } = setup();
    const task = core.start({ agent, port, brief: 'b' });
    task.release();
    runs[0]!.settle({ lastAssistantText: 'ok', status: 'completed', usage });
    await task.result;
    await task.cancel();
    expect(store.readResult(task.taskId)!.status).toBe('completed');
    expect((await task.result).status).toBe('completed');
  });

  it('fills an unavailable usage and an empty summary when the driver fails', async () => {
    const root = makeProject();
    const port: ChildPort = { start: () => ({ outcome: Promise.reject(new Error('boom')), cancel: () => {} }) };
    const core = new TaskCore({ projectRoot: root, store: new TaskStore(root, { warn: () => {} }), warn: () => {} });
    const task = core.start({ agent: getAgent(root, 'helper'), port, brief: 'b' });
    task.release();
    const result = await task.result;
    expect(result).toMatchObject({ status: 'failed', failureKind: 'crashed', summary: '' });
    expect(result.usage!.totalTokens).toMatchObject({ unavailable: expect.any(String) });
  });

  it('carries no changed-files field in the result', async () => {
    const { core, port, runs, agent } = setup();
    const task = core.start({ agent, port, brief: 'b' });
    task.release();
    runs[0]!.settle({ lastAssistantText: 'ok', status: 'completed', usage });
    const result = await task.result;
    expect(Object.keys(result).sort()).toEqual(['agent', 'durationMs', 'status', 'summary', 'taskId', 'usage']);
  });
});

const steering = () => manualPort({ steers: true, resume: true });
const DEAD_OWNER = { pid: 999_999, startTime: 'then' };

/** A started, prompted, released task on a port that steers and resumes. */
function prompted() {
  const root = makeProject();
  const store = new TaskStore(root, { warn: () => {} });
  const { port, runs } = steering();
  const core = new TaskCore({ projectRoot: root, store, warn: () => {} });
  const task = core.start({ agent: getAgent(root, 'helper'), port, brief: 'the brief' });
  return { root, store, core, port, runs, task };
}

describe('TaskCore follow-up messages', () => {
  it('covers R2: a message to a Pending task answers queued and reaches steer right after prompt_sent', async () => {
    const { task, runs } = prompted();
    const reply = await task.followUp('hold me');
    expect(reply.outcome).toBe('queued');
    task.release();
    expect(runs[0]!.steers).toEqual([]);
    runs[0]!.emit({ kind: 'prompt_sent' });
    await until(() => runs[0]!.steers.length === 1);
    expect(runs[0]!.steers).toEqual(['hold me']);
  });

  it('covers R3: a message to a Live run answers steered, and the turn settles with one result', async () => {
    const { task, runs, store } = prompted();
    task.release();
    runs[0]!.emit({ kind: 'prompt_sent' });
    const reply = await task.followUp('new info');
    expect(reply.outcome).toBe('steered');
    expect(runs[0]!.steers).toEqual(['new info']);
    runs[0]!.settle({ lastAssistantText: 'done with the info' });
    expect((await task.result).summary).toBe('done with the info');
    expect(task.turns).toHaveLength(1);
    expect(store.readTurns(task.taskId)).toHaveLength(1);
  });

  it('delivers held messages in the order received, before a message that arrives while they are being delivered', async () => {
    const { task, runs } = prompted();
    await task.followUp('one');
    await task.followUp('two');
    task.release();
    runs[0]!.steerAnswer = async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'delivered' as const;
    };
    runs[0]!.emit({ kind: 'prompt_sent' });
    const late = task.followUp('three');
    expect((await late).outcome).toBe('steered');
    expect(runs[0]!.steers).toEqual(['one', 'two', 'three']);
  });

  it('records that a held message was delivered only when its steer answers, so a message still pending when the process dies is undelivered', async () => {
    const { task, runs, store } = prompted();
    await task.followUp('held one');
    task.release();
    let answer: ((value: 'delivered') => void) | undefined;
    runs[0]!.steerAnswer = () => new Promise((resolve) => (answer = resolve));
    runs[0]!.emit({ kind: 'prompt_sent' });
    const record = () => store.undeliveredMessages(store.readTurn(task.taskId, 1)!, store.readEvents(task.taskId));
    await until(() => answer !== undefined);
    // The prompt went out and the steer is on its way: the process could die here.
    expect(record()).toEqual(['held one']);
    answer!('delivered');
    await until(() => record().length === 0);
    expect(store.readEvents(task.taskId).filter((e) => e.kind === 'held_message_handled')).toMatchObject([{ text: 'held one', answer: 'delivered', turn: 1 }]);
  });

  it('records a held message answered settled as handled only once the next turn holds it', async () => {
    const { task, runs, store } = prompted();
    await task.followUp('late message');
    task.release();
    runs[0]!.steerAnswer = 'settled';
    runs[0]!.emit({ kind: 'prompt_sent' });
    runs[0]!.settle({ lastAssistantText: 'turn one answer' });
    await task.turns[0]!.result;
    await until(() => runs.length === 2);
    expect(store.readTurn(task.taskId, 2)).toMatchObject({ viaHeld: true, message: 'late message' });
    expect(store.undeliveredMessages(store.readTurn(task.taskId, 1)!, store.readEvents(task.taskId))).toEqual([]);
    expect(store.readEvents(task.taskId).filter((e) => e.kind === 'held_message_handled')).toMatchObject([{ text: 'late message', answer: 'settled', turn: 1 }]);
  });

  it('covers R9: a held message whose run settles after prompt_sent but before delivery opens turn 2 with it as the prompt', async () => {
    const { task, runs } = prompted();
    await task.followUp('late message');
    task.release();
    runs[0]!.steerAnswer = 'settled';
    runs[0]!.emit({ kind: 'prompt_sent' });
    runs[0]!.settle({ lastAssistantText: 'turn one answer' });
    await task.turns[0]!.result;
    await until(() => runs.length === 2);
    expect(task.latest.number).toBe(2);
    expect(runs[1]).toMatchObject({ kind: 'resume', prompt: 'late message' });
    runs[1]!.emit({ kind: 'prompt_sent' });
    runs[1]!.settle({ lastAssistantText: 'turn two answer' });
    expect(await task.latest.result).toMatchObject({ taskId: task.taskId, turn: 2, summary: 'turn two answer' });
  });

  it('covers R9: a held message whose run fails skill_mismatch before its prompt is not delivered, the result says so, and no turn opens', async () => {
    const { task, runs } = prompted();
    await task.followUp('never reaches it');
    task.release();
    runs[0]!.settle({ status: 'failed', failureKind: 'skill_mismatch', lastAssistantText: null });
    const result = await task.result;
    expect(result).toMatchObject({ status: 'failed', failureKind: 'skill_mismatch', heldNotDelivered: 1 });
    expect(runs).toHaveLength(1);
    expect(task.latest.number).toBe(1);
  });

  it('counts a held message the steer answered stopping as not delivered when the run still completes, and opens no turn 2', async () => {
    const { task, runs } = prompted();
    expect(await task.followUp('held one')).toMatchObject({ outcome: 'queued' });
    task.release();
    runs[0]!.steerAnswer = 'stopping';
    runs[0]!.emit({ kind: 'prompt_sent' });
    runs[0]!.settle({ lastAssistantText: 'done' });
    expect(await task.result).toMatchObject({ status: 'completed', heldNotDelivered: 1 });
    expect(runs).toHaveLength(1);
    expect(task.latest.number).toBe(1);
  });

  it('counts a held message answered settled as not delivered when the run was cancelled, and starts no new run', async () => {
    const { task, runs } = prompted();
    expect(await task.followUp('held one')).toMatchObject({ outcome: 'queued' });
    task.release();
    runs[0]!.steerAnswer = 'settled';
    runs[0]!.emit({ kind: 'prompt_sent' });
    runs[0]!.settle({ status: 'cancelled' });
    expect(await task.result).toMatchObject({ status: 'cancelled', heldNotDelivered: 1 });
    expect(runs).toHaveLength(1);
    expect(task.latest.number).toBe(1);
  });

  it('covers R2: a message to a task cancelled while Pending releases it with the brief, then steers the message', async () => {
    const { task, runs } = prompted();
    await task.cancel();
    const reply = await task.followUp('start it now');
    expect(reply).toMatchObject({ outcome: 'new_turn' });
    expect(reply.turn!.number).toBe(2);
    reply.turn!.release();
    expect(runs[0]).toMatchObject({ kind: 'start', prompt: 'the brief' });
    runs[0]!.emit({ kind: 'prompt_sent' });
    await until(() => runs[0]!.steers.length === 1);
    expect(runs[0]!.steers).toEqual(['start it now']);
  });

  it('covers R10: a turn abandoned before its prompt has its messages replayed, in order, before the next message', async () => {
    const dead = prompted();
    const first = dead.task;
    first.release();
    dead.runs[0]!.emit({ kind: 'prompt_sent' });
    dead.runs[0]!.settle({});
    await first.result;
    // Turn 2 opens in a process that then dies, with a second message held for it.
    const owner = new TaskStore(dead.root, { warn: () => {}, owner: DEAD_OWNER });
    const ownerCore = new TaskCore({ projectRoot: dead.root, store: owner, warn: () => {} });
    const loaded = ownerCore.load(first.taskId, dead.port)!;
    const opened = await loaded.followUp('first lost');
    expect(opened.outcome).toBe('new_turn');
    expect(await loaded.followUp('second lost')).toMatchObject({ outcome: 'queued' });

    // A later process takes the task over.
    const store = new TaskStore(dead.root, { warn: () => {} });
    const { port, runs } = steering();
    const core = new TaskCore({ projectRoot: dead.root, store, warn: () => {} });
    const task = core.load(first.taskId, port)!;
    const reply = await task.followUp('third');
    expect(reply).toMatchObject({ outcome: 'new_turn', replayed: 2 });
    expect(reply.turn!.number).toBe(3);
    reply.turn!.release();
    expect(runs[0]).toMatchObject({ kind: 'resume', prompt: 'first lost' });
    runs[0]!.emit({ kind: 'prompt_sent' });
    await until(() => runs[0]!.steers.length === 2);
    expect(runs[0]!.steers).toEqual(['second lost', 'third']);
    expect(store.readTurns(first.taskId)[2]).toMatchObject({ turn: 3, message: 'third', replayed: ['first lost', 'second lost'] });
  });

  it('answers not delivered, and opens no turn, when the steer answers stopping', async () => {
    const { task, runs } = prompted();
    task.release();
    runs[0]!.emit({ kind: 'prompt_sent' });
    runs[0]!.steerAnswer = 'stopping';
    expect(await task.followUp('too late')).toMatchObject({ outcome: 'not_delivered' });
    expect(task.turns).toHaveLength(1);
  });

  it('opens a new turn when the steer answers that the run had already settled', async () => {
    const { task, runs } = prompted();
    task.release();
    runs[0]!.emit({ kind: 'prompt_sent' });
    runs[0]!.steerAnswer = () => {
      // The driver learns of the settle first; the outcome follows.
      queueMicrotask(() => runs[0]!.settle({ lastAssistantText: 'finished' }));
      return 'settled';
    };
    const reply = await task.followUp('just missed');
    expect(reply).toMatchObject({ outcome: 'new_turn' });
    expect(reply.turn!.number).toBe(2);
    expect((await task.turns[0]!.result).summary).toBe('finished');
  });

  it('answers not delivered for a Pending task and for a never-started release when the port cannot steer', async () => {
    const root = makeProject();
    const core = new TaskCore({ projectRoot: root, store: new TaskStore(root, { warn: () => {} }), warn: () => {} });
    const { port } = manualPort({ resume: true });
    const task = core.start({ agent: getAgent(root, 'helper'), port, brief: 'b' });
    expect(await task.followUp('held?')).toMatchObject({ outcome: 'not_delivered' });
    await task.cancel();
    expect(await task.followUp('release?')).toMatchObject({ outcome: 'not_delivered' });
    expect(task.turns).toHaveLength(1);
  });

  it('answers not delivered for a settled task whose port cannot resume', async () => {
    const root = makeProject();
    const core = new TaskCore({ projectRoot: root, store: new TaskStore(root, { warn: () => {} }), warn: () => {} });
    const { port, runs } = manualPort({ steers: true });
    const task = core.start({ agent: getAgent(root, 'helper'), port, brief: 'b' });
    task.release();
    runs[0]!.emit({ kind: 'prompt_sent' });
    runs[0]!.settle();
    await task.result;
    expect(await task.followUp('again')).toMatchObject({ outcome: 'not_delivered' });
  });

  it('fires the listeners of turn 2 once when it settles, and those of turn 1 not again', async () => {
    const { task, runs } = prompted();
    task.release();
    runs[0]!.emit({ kind: 'prompt_sent' });
    let first = 0;
    task.turns[0]!.onStateChange(() => first++);
    runs[0]!.settle();
    await task.result;
    const settledAtOne = first;
    const reply = await task.followUp('again');
    let second: string[] = [];
    reply.turn!.onStateChange((s) => second.push(s));
    reply.turn!.release();
    runs[1]!.emit({ kind: 'prompt_sent' });
    runs[1]!.settle();
    await reply.turn!.result;
    expect(first).toBe(settledAtOne);
    expect(second.filter((s) => s === 'Settled')).toHaveLength(1);
  });

  it('continues a task loaded from its record with turn 2, and never sends the brief again', async () => {
    const { root, task: original, runs: originalRuns } = prompted();
    original.release();
    originalRuns[0]!.emit({ kind: 'prompt_sent' });
    originalRuns[0]!.settle();
    await original.result;
    const store = new TaskStore(root, { warn: () => {} });
    const { port, runs } = steering();
    const loaded = new TaskCore({ projectRoot: root, store, warn: () => {} }).load(original.taskId, port)!;
    const reply = await loaded.followUp('what next?');
    expect(reply).toMatchObject({ outcome: 'new_turn' });
    reply.turn!.release();
    expect(reply.turn!.number).toBe(2);
    expect(runs[0]).toMatchObject({ kind: 'resume', prompt: 'what next?' });
    expect(runs[0]!.prompt).not.toBe('the brief');
  });

  it('covers R5: a continuation runs on the frozen agent definition, whatever the agent file now says', async () => {
    const { root, task: original, runs: originalRuns } = prompted();
    original.release();
    originalRuns[0]!.emit({ kind: 'prompt_sent' });
    originalRuns[0]!.settle();
    await original.result;
    const file = path.join(root, '.agents', 'subzero.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('model: local/qwen,', 'model: local/other,'));
    const store = new TaskStore(root, { warn: () => {} });
    const { port, runs } = steering();
    const loaded = new TaskCore({ projectRoot: root, store, warn: () => {} }).load(original.taskId, port)!;
    const reply = await loaded.followUp('go on');
    reply.turn!.release();
    expect(runs[0]!.request.agent).toMatchObject({ model: 'local/qwen', thinking: 'high' });
  });

  it('opens turn 2 with the steering messages the driver reports unread at settle, in order', async () => {
    const { task, runs } = prompted();
    task.release();
    runs[0]!.emit({ kind: 'prompt_sent' });
    runs[0]!.settle({ unreadSteers: ['unread one', 'unread two'] });
    await task.turns[0]!.result;
    await until(() => runs.length === 2);
    expect(runs[1]).toMatchObject({ kind: 'resume', prompt: 'unread one' });
    runs[1]!.emit({ kind: 'prompt_sent' });
    await until(() => runs[1]!.steers.length === 1);
    expect(runs[1]!.steers).toEqual(['unread two']);
  });

  it('records the session-end stop reason on the turn of a run stopped by a session cancel', async () => {
    const { task, runs, store } = prompted();
    task.release();
    runs[0]!.emit({ kind: 'prompt_sent' });
    await task.cancel('session_end');
    expect(store.readTurns(task.taskId)[0]).toMatchObject({ stopReason: 'session_end', result: { status: 'cancelled' } });
  });

  it('writes the brief event and each follow-up message whole with its outcome to the event log', async () => {
    const { task, runs, store } = prompted();
    await task.followUp('held message');
    task.release();
    runs[0]!.emit({ kind: 'prompt_sent' });
    await until(() => runs[0]!.steers.length === 1);
    await task.followUp('live message');
    const events = store.readEvents(task.taskId);
    expect(events[0]).toMatchObject({ kind: 'brief', text: 'the brief' });
    expect(events.filter((e) => e.kind === 'follow_up_message')).toMatchObject([
      { text: 'held message', outcome: 'queued', turn: 1 },
      { text: 'live message', outcome: 'steered', turn: 1 },
    ]);
  });

  it('releases a task with its brief and holds the message when the driver says the child session is gone', async () => {
    const { root, task: original, runs: originalRuns } = prompted();
    original.release();
    originalRuns[0]!.emit({ kind: 'prompt_sent' });
    originalRuns[0]!.settle();
    await original.result;
    const store = new TaskStore(root, { warn: () => {} });
    const { port, runs } = manualPort({
      steers: true,
      resume: (request) => {
        throw new SessionMissingError(request.taskId);
      },
    });
    const loaded = new TaskCore({ projectRoot: root, store, warn: () => {} }).load(original.taskId, port)!;
    const reply = await loaded.followUp('after the loss');
    reply.turn!.release();
    expect(runs[0]).toMatchObject({ kind: 'start', prompt: 'the brief' });
    runs[0]!.emit({ kind: 'prompt_sent' });
    await until(() => runs[0]!.steers.length === 1);
    expect(runs[0]!.steers).toEqual(['after the loss']);
  });

  it('answers not delivered, taken, when another process claimed the turn first', async () => {
    const { root, task: original, runs } = prompted();
    original.release();
    runs[0]!.emit({ kind: 'prompt_sent' });
    runs[0]!.settle();
    await original.result;
    const other = new TaskStore(root, { warn: () => {}, owner: { pid: process.pid, startTime: 'elsewhere' } });
    expect(other.claimTurn(original.taskId, 2, { message: 'theirs', enqueuedAt: 't' })).toBe(true);
    expect(await original.followUp('mine')).toMatchObject({ outcome: 'not_delivered', taken: true });
    expect(original.turns).toHaveLength(1);
  });
  it('marks the brief as the prompt in the turn file of a turn released with the brief, and in no other', async () => {
    const { task, runs, store } = prompted();
    await task.cancel();
    const reply = await task.followUp('start it now');
    expect(store.readTurns(task.taskId)[1]).toMatchObject({ turn: 2, message: 'start it now', briefPrompt: true });
    reply.turn!.release();
    runs[0]!.emit({ kind: 'prompt_sent' });
    runs[0]!.settle();
    await reply.turn!.result;
    const next = await task.followUp('later');
    expect(store.readTurns(task.taskId)[2]).toMatchObject({ turn: 3, message: 'later' });
    expect(store.readTurns(task.taskId)[2]!.briefPrompt).toBeUndefined();
    expect(next.outcome).toBe('new_turn');
  });

  it('marks the brief as the prompt in the turn file when the child session is gone', async () => {
    const { root, task: original, runs: originalRuns } = prompted();
    original.release();
    originalRuns[0]!.emit({ kind: 'prompt_sent' });
    originalRuns[0]!.settle();
    await original.result;
    const store = new TaskStore(root, { warn: () => {} });
    const { port } = manualPort({
      steers: true,
      resume: (request) => {
        throw new SessionMissingError(request.taskId);
      },
    });
    const loaded = new TaskCore({ projectRoot: root, store, warn: () => {} }).load(original.taskId, port)!;
    const reply = await loaded.followUp('after the loss');
    expect(store.readTurns(original.taskId)[1]!.briefPrompt).toBeUndefined();
    reply.turn!.release();
    expect(store.readTurns(original.taskId)[1]).toMatchObject({ turn: 2, message: 'after the loss', briefPrompt: true });
  });

  it('records for a front end that the stop of a turn was reported, once', async () => {
    const { core, task, runs, store } = prompted();
    task.release();
    runs[0]!.emit({ kind: 'prompt_sent' });
    await task.cancel('session_end');
    expect(store.isReported(task.taskId, 1)).toBe(false);
    core.recordStopReported(task.taskId, 1);
    core.recordStopReported(task.taskId, 1);
    expect(store.isReported(task.taskId, 1)).toBe(true);
  });

  it('covers R10: every message of a turn that held messages opened is replayed when that turn dies before its prompt', async () => {
    const { root, task, runs } = prompted();
    task.release();
    runs[0]!.emit({ kind: 'prompt_sent' });
    runs[0]!.settle({ unreadSteers: ['unread one', 'unread two'] });
    await until(() => runs.length === 2);
    // Turn 2 never sends its prompt, and its process is gone; a later process takes the task over.
    const store = new TaskStore(root, { warn: () => {} });
    const { port, runs: laterRuns } = steering();
    const loaded = new TaskCore({ projectRoot: root, store, warn: () => {} }).load(task.taskId, port)!;
    const reply = await loaded.followUp('third');
    expect(reply).toMatchObject({ outcome: 'new_turn', replayed: 2 });
    reply.turn!.release();
    expect(laterRuns[0]).toMatchObject({ kind: 'resume', prompt: 'unread one' });
    laterRuns[0]!.emit({ kind: 'prompt_sent' });
    await until(() => laterRuns[0]!.steers.length === 2);
    expect(laterRuns[0]!.steers).toEqual(['unread two', 'third']);
  });
});
