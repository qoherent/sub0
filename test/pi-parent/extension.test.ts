import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerPiExtension } from '../../src/pi-parent/extension.js';
import { DelegationService } from '../../src/service/delegation-service.js';
import { fakePi } from './fake-pi-api.js';
import { FAKE_PI_COMMAND, fakePiEnv, kernelWithPort, GLOBAL_MEDIUM_YAML, makeProject, manualPort, piKernel, tempDir, TIERED_YAML, until, useGlobalConfig } from '../helpers.js';

describe('pi extension', () => {
  it('registers subagent and starts a background child on the requested tier', async () => {
    const root = makeProject(TIERED_YAML);
    const { port, started } = manualPort();
    const fake = fakePi(root);
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} }));
    await fake.emit('session_start');
    expect([...fake.tools.keys()].sort()).toEqual(['subagent', 'subzero_await', 'subzero_cancel', 'subzero_continue', 'subzero_tasks']);
    const subagent = fake.tools.get('subagent')!;
    expect(subagent.executionMode).toBe('parallel');
    expect(subagent.prepareLoadout?.({} as any)?.descriptions?.subagent).toMatch(/cheapest capable \(small\).*model: "small"/);
    const reply = await subagent.execute('call', { task: 'review', model: 'cheapest capable' }, undefined, undefined, fake.context as any);
    expect(reply.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/task: sz-/) });
    expect(started).toHaveLength(1);
    started[0]!.settle();
  });
});

describe('pi extension with a global file', () => {
  const STARTER = () => ({ general: ['read'], fallback: ['read'] });

  it('describes the tiers and runs subagent on the global medium for a project with no file', async () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const root = tempDir('subzero-project-');
    const { port, started } = manualPort();
    const fake = fakePi(root);
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port, STARTER), warn: () => {} }));
    await fake.emit('session_start');
    const subagent = fake.tools.get('subagent')!;
    expect(subagent.prepareLoadout?.({} as any)?.descriptions?.subagent).toMatch(/\(medium\): pass model: "medium"/);
    const reply = await subagent.execute('call', { task: 'review', model: 'sonnet' }, undefined, undefined, fake.context as any);
    expect(reply.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/task: sz-/) });
    expect(started).toHaveLength(1);
    started[0]!.settle();
  });

  it('keeps the base description and refuses naming enabled: false when the project is switched off', async () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const root = makeProject('enabled: false\n');
    const { port, started } = manualPort();
    const fake = fakePi(root);
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port, STARTER), warn: () => {} }));
    await fake.emit('session_start');
    const subagent = fake.tools.get('subagent')!;
    expect(subagent.prepareLoadout?.({} as any)?.descriptions?.subagent).toBe('Delegate an isolated task. Await background tasks before using their results. Send a running or finished task more with subzero_continue.');
    expect(await subagent.execute('call', { task: 'x' }, undefined, undefined, fake.context as any)).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/enabled: false/) }] });
    expect(started).toHaveLength(0);
  });
});

describe('pi extension requests', () => {
  it('runs the scripted child on small and makes its task available to await', async () => {
    const root = makeProject(TIERED_YAML);
    const child = fakePiEnv();
    const fake = fakePi(root);
    const kernel = piKernel({ piCommand: FAKE_PI_COMMAND, env: child.env, piAgentDir: tempDir() }).kernel;
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel, warn: () => {} }));
    await fake.emit('session_start');
    const reply = await fake.tools.get('subagent')!.execute('call', { task: 'review', model: 'cheapest capable' }, undefined, undefined, fake.context as any);
    const content = reply.content[0];
    if (!content || content.type !== 'text') throw new Error('expected text');
    const taskId = /sz-[a-z2-7]{6}/.exec(content.text)?.[0];
    expect(taskId).toBeDefined();
    const collected = await fake.tools.get('subzero_await')!.execute('await', { tasks: [taskId], timeout_s: 10 }, undefined, undefined, fake.context as any);
    expect(collected.content[0]).toMatchObject({ text: expect.stringMatching(/status: completed/) });
    const argv = child.log()[0].argv as string[];
    expect(argv[argv.indexOf('--model') + 1]).toBe('local/qwen');
    const listed = await fake.tools.get('subzero_tasks')!.execute('tasks', {}, undefined, undefined, fake.context as any);
    expect(listed.content[0]).toMatchObject({ text: expect.stringContaining(taskId!) });
  });
  it('refuses isolation and management fields without starting a child', async () => {
    const root = makeProject(TIERED_YAML);
    const { port, started } = manualPort();
    const fake = fakePi(root);
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} }));
    await fake.emit('session_start');
    const execute = fake.tools.get('subagent')!.execute;
    for (const args of [{ task: 'x', worktree: true }, { task: 'x', isolation: 'worktree' }, { task: 'x', context: 'fork' }, { task: 'x', action: 'status' }]) {
      expect(await execute('call', args, undefined, undefined, fake.context as any)).toMatchObject({ isError: true });
    }
    expect(started).toHaveLength(0);
  });

  it('reports missing or malformed configuration and an unconfigured phrase tier', async () => {
    const root = makeProject(TIERED_YAML);
    const { port, started } = manualPort();
    const fake = fakePi(root);
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} }));
    await fake.emit('session_start');
    const execute = fake.tools.get('subagent')!.execute;
    const file = path.join(root, '.agents', 'subzero.yaml');
    writeFileSync(file, TIERED_YAML.replace('    large: { host: pi, model: cloud/large, thinking: high }\n', '').replace('    tiers:\n      large: { model: cloud/reviewer-large }\n', ''));
    expect(await execute('call', { task: 'x', model: 'session model' }, undefined, undefined, fake.context as any)).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/unknown tier "large"/) }] });
    writeFileSync(file, 'agents: [');
    expect(await execute('call', { task: 'x' }, undefined, undefined, fake.context as any)).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/malformed/) }] });
    rmSync(file);
    expect(await execute('call', { task: 'x' }, undefined, undefined, fake.context as any)).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/missing.*subzero init/) }] });
    expect(started).toHaveLength(0);
  });

  it('runs unknown model values on the default tier and reports they were unused', async () => {
    const root = makeProject(TIERED_YAML);
    const { port, started } = manualPort();
    const fake = fakePi(root);
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} }));
    await fake.emit('session_start');
    const reply = await fake.tools.get('subagent')!.execute('call', { task: 'x', model: 'other/model', agent: 'delegate' }, undefined, undefined, fake.context as any);
    expect(reply.content[0]).toMatchObject({ text: expect.stringMatching(/model "other\/model" was not used/) });
    expect(started).toHaveLength(1);
    started[0]!.settle();
  });

  it('honors an agent tier when no model is requested', async () => {
    const root = makeProject(TIERED_YAML.replace('  reviewer:\n    description: A reviewer', '  reviewer:\n    tier: small\n    description: A reviewer'));
    const { port, started } = manualPort();
    const models: string[] = [];
    const kernel = kernelWithPort({ start: (request, onEvent) => { models.push(request.agent.model); return port.start(request, onEvent); } });
    const fake = fakePi(root);
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel, warn: () => {} }));
    await fake.emit('session_start');
    await fake.tools.get('subagent')!.execute('call', { task: 'x', agent: 'reviewer' }, undefined, undefined, fake.context as any);
    expect(models).toEqual(['local/qwen']);
    started[0]!.settle();
  });

  it('waits in print mode and returns the whole result', async () => {
    const root = makeProject(TIERED_YAML);
    const { port, started } = manualPort();
    const fake = fakePi(root, 'print');
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} }));
    await fake.emit('session_start');
    const pending = fake.tools.get('subagent')!.execute('call', { task: 'x', async: true }, undefined, undefined, fake.context as any);
    while (!started.length) await new Promise((resolve) => setTimeout(resolve, 1));
    started[0]!.settle({ lastAssistantText: 'whole result' });
    const reply = await pending;
    expect(reply.content[0]).toMatchObject({ text: expect.stringMatching(/whole result[\s\S]*this mode waits/) });
  });

  it('cancels a foreground child when the tool signal is aborted', async () => {
    const root = makeProject(TIERED_YAML);
    const { port, started } = manualPort();
    const fake = fakePi(root);
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} }));
    await fake.emit('session_start');
    const controller = new AbortController();
    const pending = fake.tools.get('subagent')!.execute('call', { task: 'x', async: false }, controller.signal, undefined, fake.context as any);
    while (!started.length) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    expect((await pending).content[0]).toMatchObject({ text: expect.stringMatching(/status: cancelled/) });
  });

  it('cancels a foreground call aborted before its task is registered', async () => {
    const root = makeProject(TIERED_YAML);
    const { port } = manualPort();
    const fake = fakePi(root);
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} }));
    await fake.emit('session_start');
    const controller = new AbortController();
    const pending = fake.tools.get('subagent')!.execute('call', { task: 'x', async: false }, controller.signal, undefined, fake.context as any);
    controller.abort();
    expect((await pending).content[0]).toMatchObject({ text: expect.stringMatching(/status: cancelled/) });
  });

  it('cancels a background task by id', async () => {
    const root = makeProject(TIERED_YAML);
    const { port } = manualPort();
    const fake = fakePi(root);
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} }));
    await fake.emit('session_start');
    const started = await fake.tools.get('subagent')!.execute('call', { task: 'x' }, undefined, undefined, fake.context as any);
    const content = started.content[0];
    if (!content || content.type !== 'text') throw new Error('expected text');
    const task = /sz-[a-z2-7]{6}/.exec(content.text)?.[0];
    expect(task).toBeDefined();
    const reply = await fake.tools.get('subzero_cancel')!.execute('cancel', { task }, undefined, undefined, fake.context as any);
    expect(reply.content[0]).toMatchObject({ text: expect.stringMatching(/status: cancelled/) });
  });

  it('queues simultaneous calls at the model limit', async () => {
    const root = makeProject(TIERED_YAML.replace('  parallel:\n', '  parallel:\n    r9700/Qwen3.8: 2\n'));
    const { port, started } = manualPort();
    const fake = fakePi(root);
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} }));
    await fake.emit('session_start');
    const execute = fake.tools.get('subagent')!.execute;
    const replies = await Promise.all(['one', 'two', 'three'].map((task) => execute(task, { task }, undefined, undefined, fake.context as any)));
    expect(started).toHaveLength(2);
    expect(replies[2]!.content[0]).toMatchObject({ text: expect.stringMatching(/queued, not launched yet/) });
    started[0]!.settle();
    while (started.length < 3) await new Promise((resolve) => setTimeout(resolve, 1));
    started[1]!.settle(); started[2]!.settle();
  });

  it('awaits both background results', async () => {
    const root = makeProject(TIERED_YAML);
    const { port, started } = manualPort();
    const fake = fakePi(root);
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} }));
    await fake.emit('session_start');
    const execute = fake.tools.get('subagent')!.execute;
    const replies = await Promise.all(['one', 'two'].map((task) => execute(task, { task }, undefined, undefined, fake.context as any)));
    const tasks = replies.map((reply) => {
      const content = reply.content[0];
      if (!content || content.type !== 'text') throw new Error('expected text');
      return /sz-[a-z2-7]{6}/.exec(content.text)![0];
    });
    const awaited = fake.tools.get('subzero_await')!.execute('await', { tasks, timeout_s: 10 }, undefined, undefined, fake.context as any);
    started[0]!.settle({ lastAssistantText: 'first result' });
    started[1]!.settle({ lastAssistantText: 'second result' });
    const reply = await awaited;
    expect(reply.content[0]).toMatchObject({ text: expect.stringMatching(/first result[\s\S]*second result/) });
  });
});

describe('pi subzero_continue and early end of a wait', () => {
  const STEER = { type: 'input', text: 'x', source: 'interactive', streamingBehavior: 'steer' };
  const textOf = (reply: { content: { type: string; text?: string }[] }) => {
    const content = reply.content[0];
    if (!content || content.type !== 'text') throw new Error('expected text');
    return content.text!;
  };
  const idOf = (text: string) => /sz-[a-z2-7]{6}/.exec(text)![0];
  const completions = (fake: ReturnType<typeof fakePi>) =>
    (fake.messages as [{ customType: string; content: string }, unknown][]).filter(([message]) => message.customType === 'subzero-completion').map(([message]) => message.content);

  async function session(mode: 'tui' | 'print' = 'tui', yaml = TIERED_YAML) {
    const root = makeProject(yaml);
    const { port, runs } = manualPort({ steers: true, resume: true });
    const fake = fakePi(root, mode);
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} }));
    await fake.emit('session_start');
    const run = (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
      fake.tools.get(name)!.execute('call', args, signal, undefined, fake.context as any);
    /** A background task, answered and settled, with nobody left to collect its notice. */
    const settledTask = async () => {
      const pending = run('subagent', { task: 'first', async: false });
      await until(() => runs.length === 1);
      runs[0]!.emit({ kind: 'prompt_sent' });
      runs[0]!.settle({ lastAssistantText: 'turn one answer' });
      return idOf(textOf(await pending));
    };
    return { root, runs, fake, run, settledTask };
  }

  it('covers R13: a subagent call with async false ends when a steering message is typed, and the child keeps running', async () => {
    const { runs, fake, run } = await session();
    const pending = run('subagent', { task: 'long job', async: false });
    await until(() => runs.length === 1);
    runs[0]!.emit({ kind: 'prompt_sent' });
    await fake.emit('input', STEER);
    const text = textOf(await pending);
    expect(text).toMatch(/task: sz-[a-z2-7]{6}/);
    expect(text).toMatch(/running/);
    expect(text).toMatch(/you sent a message, so this call stopped waiting/);
    expect(runs[0]!.cancelled).toBe(false);
    runs[0]!.settle();
    await fake.emit('session_shutdown', { reason: 'quit' });
  });

  it('covers R13: a subzero_continue call with async false on a settled task ends when a steering message is typed, and the new turn keeps running', async () => {
    const { runs, fake, run, settledTask } = await session();
    const id = await settledTask();
    const pending = run('subzero_continue', { task: id, message: 'more please', async: false });
    await until(() => runs.length === 2);
    runs[1]!.emit({ kind: 'prompt_sent' });
    await fake.emit('input', STEER);
    const text = textOf(await pending);
    expect(text).toContain(id);
    expect(text).toMatch(/new turn: turn 2/);
    expect(text).toMatch(/you sent a message, so this call stopped waiting/);
    expect(runs[1]).toMatchObject({ kind: 'resume', prompt: 'more please', cancelled: false });
    runs[1]!.settle();
    await fake.emit('session_shutdown', { reason: 'quit' });
  });

  it('covers R13: a subzero_await over two running tasks ends when a steering message is typed, and both keep running', async () => {
    const { runs, fake, run } = await session();
    const ids = (await Promise.all(['one', 'two'].map((task) => run('subagent', { task })))).map((reply) => idOf(textOf(reply)));
    await until(() => runs.length === 2);
    const pending = run('subzero_await', { tasks: ids, timeout_s: 600 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fake.emit('input', STEER);
    const text = textOf(await pending);
    for (const id of ids) expect(text).toContain(id);
    expect(text).toMatch(/running/);
    expect(text).toMatch(/you sent a message, so this call stopped waiting/);
    expect(runs.map((r) => r.cancelled)).toEqual([false, false]);
    for (const r of runs) r.settle();
    await fake.emit('session_shutdown', { reason: 'quit' });
  });

  it('covers R13: a wait ended early later yields exactly one completion notice for its turn', async () => {
    const { runs, fake, run } = await session();
    const pending = run('subagent', { task: 'long job', async: false });
    await until(() => runs.length === 1);
    runs[0]!.emit({ kind: 'prompt_sent' });
    await fake.emit('input', STEER);
    const id = idOf(textOf(await pending));
    expect(completions(fake)).toEqual([]);
    runs[0]!.settle({ lastAssistantText: 'finished late' });
    await until(() => completions(fake).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(completions(fake)).toHaveLength(1);
    expect(completions(fake)[0]).toContain(id);
    expect(fake.messages[0]).toMatchObject([{ customType: 'subzero-completion' }, { triggerTurn: true, deliverAs: 'steer' }]);
    await fake.emit('session_shutdown', { reason: 'quit' });
  });

  it('covers R13: a subzero_await ended early yields exactly one completion notice for each task it left running', async () => {
    const { runs, fake, run } = await session();
    const ids = (await Promise.all(['one', 'two'].map((task) => run('subagent', { task })))).map((reply) => idOf(textOf(reply)));
    await until(() => runs.length === 2);
    const pending = run('subzero_await', { tasks: ids, timeout_s: 600 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fake.emit('input', STEER);
    await pending;
    for (const r of runs) r.settle();
    await until(() => completions(fake).length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // A task started in the background already reports itself; ending the await early must not add a second notice.
    for (const id of ids) expect(completions(fake).filter((notice) => notice.startsWith(`task ${id} `))).toHaveLength(1);
    await fake.emit('session_shutdown', { reason: 'quit' });
  });

  it('covers R1: subzero_continue on a running background task replies steered with the task id', async () => {
    const { runs, fake, run } = await session();
    const id = idOf(textOf(await run('subagent', { task: 'long job' })));
    await until(() => runs.length === 1);
    runs[0]!.emit({ kind: 'prompt_sent' });
    const text = textOf(await run('subzero_continue', { task: id, message: 'one more thing' }));
    expect(text).toContain(id);
    expect(text).toMatch(/steered/);
    expect(runs[0]!.steers).toEqual(['one more thing']);
    runs[0]!.settle();
    await until(() => completions(fake).length === 1);
    await fake.emit('session_shutdown', { reason: 'quit' });
  });

  it('covers R1: subzero_continue on a settled task with async true replies new turn 2, and turn 2 settles with one completion notice naming turn 2', async () => {
    const { runs, fake, run, settledTask } = await session();
    const id = await settledTask();
    const text = textOf(await run('subzero_continue', { task: id, message: 'again', async: true }));
    expect(text).toContain(id);
    expect(text).toMatch(/new turn: turn 2/);
    await until(() => runs.length === 2);
    runs[1]!.emit({ kind: 'prompt_sent' });
    runs[1]!.settle({ lastAssistantText: 'turn two answer' });
    await until(() => completions(fake).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(completions(fake)).toHaveLength(1);
    expect(completions(fake)[0]).toContain(id);
    expect(completions(fake)[0]).toMatch(/turn 2/);
    await fake.emit('session_shutdown', { reason: 'quit' });
  });

  it.each([
    ['no streaming behavior', undefined],
    ['followUp', 'followUp'],
  ])('covers R13: an input event with %s ends nothing', async (_name, streamingBehavior) => {
    const { runs, fake, run } = await session();
    let settled = false;
    const pending = run('subagent', { task: 'long job', async: false }).then((reply) => { settled = true; return reply; });
    await until(() => runs.length === 1);
    runs[0]!.emit({ kind: 'prompt_sent' });
    expect(await fake.emit('input', { type: 'input', text: 'x', source: 'interactive', ...(streamingBehavior !== undefined ? { streamingBehavior } : {}) })).toEqual({ action: 'continue' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);
    runs[0]!.settle({ lastAssistantText: 'the real result' });
    const text = textOf(await pending);
    expect(text).toMatch(/the real result/);
    expect(text).not.toMatch(/stopped waiting/);
    await fake.emit('session_shutdown', { reason: 'quit' });
  });

  it('covers R8: a turn opened by a message held for a task that settles first reports one completion notice through the sink', async () => {
    const { runs, fake, run } = await session();
    const id = idOf(textOf(await run('subagent', { task: 'long job' })));
    await until(() => runs.length === 1);
    expect(textOf(await run('subzero_continue', { task: id, message: 'late word' }))).toMatch(/queued/);
    runs[0]!.steerAnswer = 'settled';
    runs[0]!.emit({ kind: 'prompt_sent' });
    runs[0]!.settle({ lastAssistantText: 'turn one answer' });
    await until(() => runs.length === 2);
    expect(runs[1]).toMatchObject({ kind: 'resume', prompt: 'late word' });
    await until(() => completions(fake).length === 1);
    runs[1]!.emit({ kind: 'prompt_sent' });
    runs[1]!.settle({ lastAssistantText: 'turn two answer' });
    await until(() => completions(fake).length === 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const notices = completions(fake);
    expect(notices).toHaveLength(2);
    expect(notices.filter((notice) => /turn 2/.test(notice))).toHaveLength(1);
    await fake.emit('session_shutdown', { reason: 'quit' });
  });

  it('covers R1: in print mode subzero_continue forces a wait and returns the result of turn 2', async () => {
    const { runs, fake, run, settledTask } = await session('print');
    const id = await settledTask();
    const pending = run('subzero_continue', { task: id, message: 'go on' });
    await until(() => runs.length === 2);
    runs[1]!.emit({ kind: 'prompt_sent' });
    runs[1]!.settle({ lastAssistantText: 'turn two answer' });
    const text = textOf(await pending);
    expect(text).toMatch(/new turn: turn 2/);
    expect(text).toMatch(/turn two answer/);
    await fake.emit('session_shutdown', { reason: 'quit' });
  });
});
