import { describe, expect, it, vi } from 'vitest';
import { TaskCore } from '../../src/core/task-core.js';
import { registerPiExtension } from '../../src/pi-parent/extension.js';
import { DelegationService } from '../../src/service/delegation-service.js';
import { TaskStore } from '../../src/store/task-store.js';
import { fakePi } from './fake-pi-api.js';
import { kernelWithPort, makeProject, manualPort, TIERED_YAML, until } from '../helpers.js';

const textOf = (reply: { content: { type: string; text?: string }[] }) => reply.content[0]!.text!;
const idOf = (text: string) => /sz-[a-z2-7]{6}/.exec(text)![0];
const stopped = (fake: ReturnType<typeof fakePi>) =>
  (fake.messages as [{ customType: string; content: string }, unknown][]).filter(([message]) => message.customType === 'subzero-reload-report').map(([message]) => message.content);

describe('pi session lifecycle', () => {
  it('cancels a background task when the session switches', async () => {
    const root = makeProject(TIERED_YAML);
    const { port } = manualPort();
    const fake = fakePi(root);
    const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} });
    registerPiExtension(fake.api, () => service);
    await fake.emit('session_start');
    const started = await fake.tools.get('subagent')!.execute('call', { task: 'x' }, undefined, undefined, fake.context as any);
    const content = started.content[0];
    if (!content || content.type !== 'text') throw new Error('expected text');
    const id = /sz-[a-z2-7]{6}/.exec(content.text)![0];
    await fake.emit('session_shutdown', { reason: 'new' });
    expect(await service.collect(id)).toMatchObject({ kind: 'result', result: { status: 'cancelled' } });
    expect(fake.notifications.join(' ')).toMatch(/1.*cancel/i);
    expect(fake.messages).toEqual([]);
  });

  it('wakes the model with a completion notice listing the other live tasks', async () => {
    const root = makeProject(TIERED_YAML);
    const { port, started } = manualPort();
    const fake = fakePi(root);
    const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} });
    registerPiExtension(fake.api, () => service);
    await fake.emit('session_start');
    const execute = fake.tools.get('subagent')!.execute;
    const replies = await Promise.all(['one', 'two', 'three'].map((task) => execute(task, { task }, undefined, undefined, fake.context as any)));
    const ids = replies.map((reply) => {
      const content = reply.content[0];
      if (!content || content.type !== 'text') throw new Error('expected text');
      return /sz-[a-z2-7]{6}/.exec(content.text)![0];
    });
    started[0]!.settle();
    await until(() => fake.messages.length === 1);
    const [message, options] = fake.messages[0] as [{ content: string }, unknown];
    expect(message.content).toContain(ids[0]);
    expect(message.content).toContain(ids[1]);
    expect(message.content).toContain(ids[2]);
    expect(message.content).toMatch(/wait/i);
    expect(options).toEqual({ triggerTurn: true, deliverAs: 'steer' });
    await fake.emit('session_shutdown', { reason: 'quit' });
  });

  it('cancels every session task on an aborted turn without triggering a turn', async () => {
    const root = makeProject(TIERED_YAML);
    const { port } = manualPort();
    const fake = fakePi(root);
    const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} });
    registerPiExtension(fake.api, () => service);
    await fake.emit('session_start');
    const execute = fake.tools.get('subagent')!.execute;
    await Promise.all(['one', 'two', 'three'].map((task) => execute(task, { task }, undefined, undefined, fake.context as any)));
    await fake.emit('agent_settled', { aborted: true });
    expect((await service.list('pi-session')).map((task) => task.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    // One stop notice for each stopped task, none of them a turn trigger.
    const ids = (await service.list('pi-session')).map((task) => task.taskId);
    expect(fake.messages).toHaveLength(3);
    for (const id of ids) {
      expect((fake.messages as [{ content: string }, unknown][]).filter(([message]) => message.content.includes(id))).toHaveLength(1);
    }
    for (const message of fake.messages) {
      expect(message).toMatchObject([{ customType: 'subzero-stopped', content: expect.stringMatching(/was stopped; no action is needed/) }, { triggerTurn: false, deliverAs: 'nextTurn' }]);
    }
  });

  it('cancels all session children when an await is aborted', async () => {
    const root = makeProject(TIERED_YAML);
    const { port } = manualPort();
    const fake = fakePi(root);
    const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} });
    registerPiExtension(fake.api, () => service);
    await fake.emit('session_start');
    const execute = fake.tools.get('subagent')!.execute;
    const replies = await Promise.all(['one', 'two'].map((task) => execute(task, { task }, undefined, undefined, fake.context as any)));
    const content = replies[0]!.content[0];
    if (!content || content.type !== 'text') throw new Error('expected text');
    const id = /sz-[a-z2-7]{6}/.exec(content.text)![0];
    const controller = new AbortController();
    const pending = fake.tools.get('subzero_await')!.execute('await', { tasks: [id], timeout_s: 600 }, controller.signal, undefined, fake.context as any);
    controller.abort();
    expect((await pending).content[0]).toMatchObject({ text: expect.stringMatching(/status: cancelled/) });
    await vi.waitFor(async () => expect((await service.list('pi-session')).map((task) => task.status)).toEqual(['cancelled', 'cancelled']));
  });

  it('notifies on child failure without exposing its result', async () => {
    const root = makeProject(TIERED_YAML);
    const { port, started } = manualPort();
    const fake = fakePi(root);
    const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} });
    registerPiExtension(fake.api, () => service);
    await fake.emit('session_start');
    await fake.tools.get('subagent')!.execute('call', { task: 'x' }, undefined, undefined, fake.context as any);
    started[0]!.settle({ status: 'failed', failureKind: 'error', message: 'private output' });
    await until(() => fake.messages.length === 1);
    expect(fake.messages[0]).toMatchObject([{ content: expect.stringMatching(/failed/) }, { triggerTurn: true, deliverAs: 'steer' }]);
    expect(JSON.stringify(fake.messages)).not.toContain('private output');
  });

  it('does not cancel children on a normally settled turn', async () => {
    const root = makeProject(TIERED_YAML);
    const { port, started } = manualPort();
    const fake = fakePi(root);
    const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} });
    registerPiExtension(fake.api, () => service);
    await fake.emit('session_start');
    await fake.tools.get('subagent')!.execute('call', { task: 'x' }, undefined, undefined, fake.context as any);
    await fake.emit('agent_settled', { aborted: false });
    expect((await service.list('pi-session'))[0]?.status).toBe('running');
    started[0]!.settle();
    await fake.emit('session_shutdown', { reason: 'quit' });
  });

  it('coalesces a foreground abort and the settled event into one stop notice', async () => {
    const root = makeProject(TIERED_YAML);
    const { port, started } = manualPort();
    const fake = fakePi(root);
    const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} });
    registerPiExtension(fake.api, () => service);
    await fake.emit('session_start');
    const execute = fake.tools.get('subagent')!.execute;
    await Promise.all(['one', 'two'].map((task) => execute(task, { task }, undefined, undefined, fake.context as any)));
    const controller = new AbortController();
    const foreground = execute('three', { task: 'three', async: false }, controller.signal, undefined, fake.context as any);
    await until(() => started.length === 3);
    controller.abort();
    await Promise.all([foreground, fake.emit('agent_settled', { aborted: true })]);
    expect((await service.list('pi-session')).map((task) => task.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    // One stop notice for each stopped task, none of them a turn trigger.
    const ids = (await service.list('pi-session')).map((task) => task.taskId);
    expect(fake.messages).toHaveLength(3);
    for (const id of ids) {
      expect((fake.messages as [{ content: string }, unknown][]).filter(([message]) => message.content.includes(id))).toHaveLength(1);
    }
    for (const message of fake.messages) {
      expect(message).toMatchObject([{ customType: 'subzero-stopped', content: expect.stringMatching(/was stopped; no action is needed/) }, { triggerTurn: false, deliverAs: 'nextTurn' }]);
    }
  });

  it('cancels idle children from the command without waking the model', async () => {
    const root = makeProject(TIERED_YAML);
    const { port } = manualPort();
    const fake = fakePi(root);
    const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} });
    registerPiExtension(fake.api, () => service);
    await fake.emit('session_start');
    const execute = fake.tools.get('subagent')!.execute;
    await Promise.all(['one', 'two'].map((task) => execute(task, { task }, undefined, undefined, fake.context as any)));
    const command = fake.commands.get('subzero') as { handler: (args: string, ctx: unknown) => Promise<void> };
    await command.handler('cancel', fake.context);
    expect((await service.list('pi-session')).map((task) => task.status)).toEqual(['cancelled', 'cancelled']);
    expect(fake.notifications.join(' ')).toMatch(/2.*cancel/i);
    expect(fake.messages[0]).toMatchObject([{}, { triggerTurn: false, deliverAs: 'nextTurn' }]);
  });

  it('records cancellation and kills a child that ignores shutdown', async () => {
    const root = makeProject(TIERED_YAML);
    const fake = fakePi(root);
    const port = { start: () => ({ outcome: new Promise<never>(() => {}), cancel: () => {} }) };
    const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} });
    const kill = vi.fn();
    registerPiExtension(fake.api, () => service, kill);
    await fake.emit('session_start');
    await fake.tools.get('subagent')!.execute('call', { task: 'x' }, undefined, undefined, fake.context as any);
    vi.useFakeTimers();
    try {
      const shutdown = fake.emit('session_shutdown', { reason: 'new' });
      await vi.advanceTimersByTimeAsync(8001);
      await shutdown;
      expect(kill).toHaveBeenCalledOnce();
      expect((await service.list('pi-session'))[0]?.status).toBe('cancelled');
      expect(fake.messages).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pi reload report of stopped turns', () => {
  const LIMITED = TIERED_YAML.replace('  parallel:\n', '  parallel:\n    r9700/Qwen3.8: 1\n');

  /** One pi process over a project root: the store is on disk, so a second one is a reload. */
  async function process_(root: string, reason?: 'reload' | 'resume' | 'startup') {
    const { port, runs } = manualPort({ steers: true, resume: true });
    const fake = fakePi(root);
    const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} });
    registerPiExtension(fake.api, () => service);
    await fake.emit('session_start', reason !== undefined ? { reason } : {});
    const run = (name: string, args: Record<string, unknown>) => fake.tools.get(name)!.execute('call', args, undefined, undefined, fake.context as any);
    return { runs, fake, run, service };
  }

  it('covers R10: a reload after a session end that cancelled a task queued behind another reports it once with its held message, and a second reload reports nothing', async () => {
    const root = makeProject(LIMITED);
    const first = await process_(root);
    const ids = [idOf(textOf(await first.run('subagent', { task: 'one' }))), idOf(textOf(await first.run('subagent', { task: 'two' })))];
    await until(() => first.runs.length === 1);
    expect(textOf(await first.run('subzero_continue', { task: ids[1], message: 'the lost message' }))).toMatch(/queued/);
    await first.fake.emit('session_shutdown', { reason: 'reload' });

    const second = await process_(root, 'reload');
    expect(stopped(second.fake)).toHaveLength(1);
    const [report] = stopped(second.fake);
    expect(report).toContain(ids[1]);
    expect(report).toContain('the lost message');
    expect(second.fake.messages[0]).toMatchObject([{ customType: 'subzero-reload-report' }, { triggerTurn: false, deliverAs: 'steer' }]);
    await second.fake.emit('session_start', { reason: 'reload' });
    expect(stopped(second.fake)).toHaveLength(1);
    const third = await process_(root, 'reload');
    expect(stopped(third.fake)).toEqual([]);
    await second.fake.emit('session_shutdown', { reason: 'quit' });
    await third.fake.emit('session_shutdown', { reason: 'quit' });
  });

  it('covers R10: a reload after a session end that cancelled a task whose run never sent its prompt reports the task and its held message', async () => {
    const root = makeProject(TIERED_YAML);
    const first = await process_(root);
    const id = idOf(textOf(await first.run('subagent', { task: 'one' })));
    await until(() => first.runs.length === 1);
    expect(textOf(await first.run('subzero_continue', { task: id, message: 'never delivered words' }))).toMatch(/queued/);
    await first.fake.emit('session_shutdown', { reason: 'new' });

    const second = await process_(root, 'resume');
    expect(stopped(second.fake)).toHaveLength(1);
    expect(stopped(second.fake)[0]).toContain(id);
    expect(stopped(second.fake)[0]).toContain('never delivered words');
    await second.fake.emit('session_shutdown', { reason: 'quit' });
  });

  it('covers R10: a reload reports an abandoned turn 2 as "<id> (turn 2)" with its message once, and a second reload reports nothing', async () => {
    const root = makeProject(TIERED_YAML);
    const first = await process_(root);
    const id = idOf(textOf(await first.run('subagent', { task: 'one' })));
    await until(() => first.runs.length === 1);
    first.runs[0]!.emit({ kind: 'prompt_sent' });
    first.runs[0]!.settle({ lastAssistantText: 'turn one answer' });
    await until(() => first.service.store.readTask(id)?.status === 'completed');
    await first.fake.emit('session_shutdown', { reason: 'quit' });
    // Turn 2 opens in a process that dies before its prompt reaches the child.
    const dead = new TaskStore(root, { warn: () => {}, owner: { pid: 999_999, startTime: 'then' } });
    const deadCore = new TaskCore({ projectRoot: root, store: dead, warn: () => {} });
    const { port } = manualPort({ steers: true, resume: true });
    expect(await deadCore.load(id, port)!.followUp('the abandoned message')).toMatchObject({ outcome: 'new_turn' });

    const second = await process_(root, 'reload');
    expect(stopped(second.fake)).toHaveLength(1);
    const report = stopped(second.fake)[0]!;
    expect(report).toContain(`${id} (turn 2)`);
    expect(report.split('the abandoned message')).toHaveLength(2);
    await second.fake.emit('session_shutdown', { reason: 'quit' });
    const third = await process_(root, 'reload');
    expect(stopped(third.fake)).toEqual([]);
    await third.fake.emit('session_shutdown', { reason: 'quit' });
  });

  it('covers R10: a task the user cancelled with subzero_cancel is never listed by a later reload', async () => {
    const root = makeProject(TIERED_YAML);
    const first = await process_(root);
    const id = idOf(textOf(await first.run('subagent', { task: 'one' })));
    await until(() => first.runs.length === 1);
    expect(textOf(await first.run('subzero_cancel', { task: id }))).toMatch(/status: cancelled/);
    await first.fake.emit('session_shutdown', { reason: 'reload' });

    const second = await process_(root, 'reload');
    expect(stopped(second.fake)).toEqual([]);
    await second.fake.emit('session_shutdown', { reason: 'quit' });
  });

  it('covers R10: a session start that is not a reload or a resume reports nothing', async () => {
    const root = makeProject(TIERED_YAML);
    const first = await process_(root);
    const id = idOf(textOf(await first.run('subagent', { task: 'one' })));
    await until(() => first.runs.length === 1);
    await first.fake.emit('session_shutdown', { reason: 'quit' });
    const second = await process_(root, 'startup');
    expect(stopped(second.fake)).toEqual([]);
    await second.fake.emit('session_shutdown', { reason: 'quit' });
    // The turn was not reported by the plain start, so a reload still lists it.
    const third = await process_(root, 'reload');
    expect(stopped(third.fake)).toHaveLength(1);
    expect(stopped(third.fake)[0]).toContain(id);
    await third.fake.emit('session_shutdown', { reason: 'quit' });
  });
});
