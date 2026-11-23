import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerPiExtension } from '../../src/pi-parent/extension.js';
import { DelegationService } from '../../src/service/delegation-service.js';
import { fakePi } from './fake-pi-api.js';
import { FAKE_PI_COMMAND, fakePiEnv, kernelWithPort, GLOBAL_MEDIUM_YAML, makeProject, manualPort, piKernel, tempDir, TIERED_YAML, useGlobalConfig } from '../helpers.js';

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
