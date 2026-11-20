import { describe, expect, it, vi } from 'vitest';
import { registerPiExtension } from '../../src/pi-parent/extension.js';
import { DelegationService } from '../../src/service/delegation-service.js';
import { fakePi } from './fake-pi-api.js';
import { kernelWithPort, makeProject, manualPort, TIERED_YAML, until } from '../helpers.js';

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
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]).toMatchObject([{ content: expect.stringMatching(/3.*stopped/) }, { triggerTurn: false, deliverAs: 'nextTurn' }]);
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
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]).toMatchObject([{ content: expect.stringMatching(/3.*stopped/) }, { triggerTurn: false, deliverAs: 'nextTurn' }]);
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
