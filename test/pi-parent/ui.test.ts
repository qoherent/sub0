import { describe, expect, it } from 'vitest';
import { symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerPiExtension } from '../../src/pi-parent/extension.js';
import { DelegationService } from '../../src/service/delegation-service.js';
import { fakePi } from './fake-pi-api.js';
import { FAKE_PI_COMMAND, fakePiEnv, kernelWithPort, makeProject, manualPort, piKernel, tempDir, TIERED_YAML, until } from '../helpers.js';

describe('pi session UI', () => {
  it('shows running and queued children and clears the widget after they finish', async () => {
    const root = makeProject(TIERED_YAML.replace('endpoints:\n', 'endpoints:\n  r9700:\n    parallel: 2\n'));
    const { port, started } = manualPort();
    const fake = fakePi(root);
    const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} });
    registerPiExtension(fake.api, () => service);
    await fake.emit('session_start');
    const execute = fake.tools.get('subagent')!.execute;
    await Promise.all(['a', 'b', 'c'].map((task) => execute(task, { task }, undefined, undefined, fake.context as any)));
    await until(() => (fake.widgets.at(-1)?.length ?? 0) === 3);
    expect(fake.widgets.at(-1)!.join('\n')).toMatch(/medium.*r9700\/Qwen3.8/);
    expect(fake.widgets.at(-1)!.join('\n')).toMatch(/queued.*place 1/);
    started[0]!.settle();
    await until(() => started.length === 3);
    started[1]!.settle(); started[2]!.settle();
    await until(() => fake.widgets.at(-1) === undefined);
    await fake.emit('session_shutdown', { reason: 'quit' });
  });

  it('warns when pi-subagents still supplies a command', async () => {
    const root = makeProject(TIERED_YAML);
    const fake = fakePi(root);
    fake.registeredTools.push({ name: 'subagent', sourceInfo: { path: '/packages/subzero/dist/pi-extension.js' } });
    fake.registeredCommands.push({ name: 'subagents', sourceInfo: { path: '/packages/pi-subagents/index.ts' } });
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(manualPort().port), warn: () => {} }), () => {}, '/packages/subzero/dist/pi-extension.js');
    await fake.emit('session_start');
    expect(fake.notifications.join(' ')).toMatch(/pi-subagents.*owned by subzero/i);
  });

  it('does not create a widget in non-UI mode', async () => {
    const root = makeProject(TIERED_YAML);
    const { port, started } = manualPort();
    const fake = fakePi(root, 'print');
    const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} });
    registerPiExtension(fake.api, () => service);
    await fake.emit('session_start');
    const pending = fake.tools.get('subagent')!.execute('call', { task: 'x' }, undefined, undefined, fake.context as any);
    await until(() => started.length === 1);
    started[0]!.settle();
    await pending;
    await fake.emit('session_shutdown', { reason: 'quit' });
    expect(fake.widgets).toEqual([]);
  });

  it('does not warn when subzero owns the tool and no conflicting command exists', async () => {
    const root = makeProject(TIERED_YAML);
    const fake = fakePi(root);
    const ownFile = '/packages/subzero/pi-extension.js';
    fake.registeredTools.push({ name: 'subagent', sourceInfo: { path: ownFile } });
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(manualPort().port), warn: () => {} }), () => {}, ownFile);
    await fake.emit('session_start');
    expect(fake.notifications).toEqual([]);
  });

  it('recognizes the same extension through a symlinked path', async () => {
    const root = makeProject(TIERED_YAML);
    const dir = tempDir();
    const real = path.join(dir, 'extension.js');
    const alias = path.join(dir, 'alias.js');
    writeFileSync(real, '');
    symlinkSync(real, alias);
    const fake = fakePi(root);
    fake.registeredTools.push({ name: 'subagent', sourceInfo: { path: alias } });
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(manualPort().port), warn: () => {} }), () => {}, real);
    await fake.emit('session_start');
    expect(fake.notifications).toEqual([]);
  });

  it('warns when pi-subagents owns subagent', async () => {
    const root = makeProject(TIERED_YAML);
    const fake = fakePi(root);
    fake.registeredTools.push({ name: 'subagent', sourceInfo: { path: '/packages/pi-subagents/index.js' } });
    registerPiExtension(fake.api, () => new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(manualPort().port), warn: () => {} }), () => {}, '/packages/subzero/index.js');
    await fake.emit('session_start');
    expect(fake.notifications.join(' ')).toMatch(/owned by .*pi-subagents/i);
  });

  it('prints a finished task attach command and refuses an unknown cancellation', async () => {
    const root = makeProject(TIERED_YAML);
    const child = fakePiEnv();
    const fake = fakePi(root);
    const kernel = piKernel({ piCommand: FAKE_PI_COMMAND, env: child.env, piAgentDir: tempDir() }).kernel;
    const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel, warn: () => {} });
    registerPiExtension(fake.api, () => service);
    await fake.emit('session_start');
    await fake.tools.get('subagent')!.execute('run', { task: 'x', async: false }, undefined, undefined, fake.context as any);
    const id = (await service.list('pi-session'))[0]!.taskId;
    const command = fake.commands.get('subzero') as { handler: (args: string, ctx: unknown) => Promise<void> };
    await command.handler(`attach ${id}`, fake.context);
    expect(fake.notifications.at(-1)).toMatch(new RegExp(`--session-dir.*--session-id ${id}`));
    await command.handler('cancel sz-xxxxxx', fake.context);
    expect(fake.notifications.at(-1)).toMatch(/not found|no such task/i);
  });
});
