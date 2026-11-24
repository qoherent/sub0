import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoadError, MissingAgentFileError, ProjectDisabledError, TierError, UnknownAgentError, UnresolvedRootError } from '../../src/config/agent-config.js';
import { unavailableUsage, type ChildPort, type StarterTools } from '../../src/core/types.js';
import { DelegationService, EmptyBriefError, renderBrief, type DelegateReply } from '../../src/service/delegation-service.js';
import { describeTaskReply } from '../../src/service/status-text.js';
import { TaskStore } from '../../src/store/task-store.js';
import { Kernel } from '../../src/kernel/kernel.js';
import { DEFAULT_YAML, FAKE_PI_COMMAND, GLOBAL_MEDIUM_YAML, TIERED_YAML, fakePiEnv, isAlive, kernelWithPort, makeProject, manualPort, piKernel, tempDir, until, useDefaultGlobalConfig, useGlobalConfig } from '../helpers.js';

function service(root: string, port: ChildPort, starterTools?: () => StarterTools) {
  return new DelegationService({
    env: { SUBZERO_PROJECT_DIR: root },
    warn: () => {},
    kernel: kernelWithPort(port, starterTools),
  });
}

/** What a child driver offers for the built-in general and fallback agents. */
const STARTER: StarterTools = { general: ['read', 'bash'], fallback: ['read'] };

const indexLines = (root: string) => {
  const file = path.join(root, '.agents', 'subzero', 'index.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
};

describe('DelegationService', () => {
  it('records cancellation when a child does not stop before shutdown expires', async () => {
    const root = makeProject();
    const svc = service(root, { start: () => ({ outcome: new Promise(() => {}), cancel: () => {} }) });
    const reply = await svc.delegate({ agent: 'helper', briefText: 'stuck', parentSessionId: 'A' }, { wait: false });
    if (reply.kind === 'result') throw new Error('expected live task');
    expect(await svc.shutdown(10)).toBe(false);
    expect(svc.store.readTask(reply.taskId)?.status).toBe('cancelled');
    expect(await svc.collect(reply.taskId)).toMatchObject({ kind: 'result', result: { status: 'cancelled' } });
  });
  it('marks the result of a cancelled live task collected, so a later collect does not deliver it again', async () => {
    const { port } = manualPort();
    const svc = service(makeProject(), port);
    const reply = await svc.delegate({ agent: 'helper', briefText: 'x', parentSessionId: 'A' }, { wait: false });
    if (reply.kind === 'result') throw new Error('expected live task');
    expect(await svc.cancel(reply.taskId)).toMatchObject({ kind: 'result', result: { status: 'cancelled' } });
    expect(await svc.collect(reply.taskId, { onlyNew: true })).toMatchObject({ kind: 'delivered', status: 'cancelled' });
  });
  it('cancels only live and queued tasks of the selected session', async () => {
    const { port, started } = manualPort();
    const svc = service(makeProject(), port);
    const a = await svc.delegate({ agent: 'helper', briefText: 'a', parentSessionId: 'A' }, { wait: false });
    const queued = await svc.delegate({ agent: 'other', briefText: 'queued', parentSessionId: 'A' }, { wait: false });
    const otherA = await svc.delegate({ agent: 'free', briefText: 'a2', parentSessionId: 'A' }, { wait: false });
    const b = await svc.delegate({ agent: 'free', briefText: 'b', parentSessionId: 'B' }, { wait: false });
    if (a.kind === 'result' || queued.kind === 'result' || otherA.kind === 'result' || b.kind === 'result') throw new Error('expected live tasks');
    expect((await svc.listLiveSession('A')).map((task) => task.taskId).sort()).toEqual([a.taskId, queued.taskId, otherA.taskId].sort());
    const notice = await svc.notice(a.taskId, 'completed', 'A', 'subzero_await');
    expect(notice).toContain(queued.taskId);
    expect(notice).toContain(otherA.taskId);
    expect(notice).not.toContain(b.taskId);
    expect(await svc.notice(a.taskId, 'cancelled', 'A', 'subzero_await')).toMatch(/stopped.*no action/i);
    expect(await svc.cancelSession(undefined)).toEqual({ kind: 'unknown_session', taskIds: [], count: 0 });
    expect(await svc.cancelSession('A')).toEqual({ kind: 'cancelled', taskIds: [a.taskId, queued.taskId, otherA.taskId], count: 3 });
    expect((await svc.collect(a.taskId))).toMatchObject({ kind: 'result', result: { status: 'cancelled' } });
    expect((await svc.collect(queued.taskId))).toMatchObject({ kind: 'result', result: { status: 'cancelled' } });
    expect((await svc.collect(otherA.taskId))).toMatchObject({ kind: 'result', result: { status: 'cancelled' } });
    expect((await svc.collect(b.taskId)).kind).toBe('running');
    started[2]!.settle();
  });
  it('returns the load error while the agent file is malformed and writes no task record', async () => {
    const root = makeProject();
    writeFileSync(path.join(root, '.agents', 'subzero.yaml'), 'agents: [');
    const svc = service(root, manualPort().port);
    await expect(svc.delegate({ agent: 'helper', briefText: 'b' }, { wait: false })).rejects.toBeInstanceOf(LoadError);
    expect(existsSync(path.join(root, '.agents', 'subzero'))).toBe(false);
  });

  it('refuses an empty brief text whatever its files hold', async () => {
    const svc = service(makeProject(), manualPort().port);
    await expect(svc.delegate({ agent: 'helper', briefText: '  ', files: ['a'] }, { wait: false })).rejects.toBeInstanceOf(EmptyBriefError);
  });

  it('returns the unresolved root error until a root is known, then runs the start-up sweep', async () => {
    const env: NodeJS.ProcessEnv = {};
    const root = makeProject();
    // A task of a dead owner process, left running in the index.
    const dead = new TaskStore(root, { owner: { pid: 999_999, startTime: 'then' } });
    dead.createTaskRecord({ taskId: 'sz-dddddd', agent: { name: 'helper' } as never, brief: 'b', createdAt: new Date().toISOString() });
    const svc = new DelegationService({ env, roots: () => [], warn: () => {}, kernel: kernelWithPort(manualPort().port) });
    await expect(svc.delegate({ agent: 'helper', briefText: 'b' }, { wait: false })).rejects.toBeInstanceOf(UnresolvedRootError);
    expect(svc.projectRoot).toBeUndefined();
    env.SUBZERO_PROJECT_DIR = root;
    await svc.start();
    expect(svc.projectRoot).toBe(root);
    expect(svc.store.readTask('sz-dddddd')!.status).toBe('abandoned');
    // The root does not change once resolved.
    env.SUBZERO_PROJECT_DIR = tempDir();
    await svc.start();
    expect(svc.projectRoot).toBe(root);
  });

  it('renders files and the expected output after the unchanged brief text', () => {
    expect(renderBrief({ briefText: 'Do X.', files: ['a.ts', 'b.ts'], expectedOutput: 'A list.' })).toBe(
      'Do X.\n\n## Files\n\n- a.ts\n- b.ts\n\n## Expected output\n\nA list.',
    );
    expect(renderBrief({ briefText: 'Do X.' })).toBe('Do X.');
  });

  it('renders the reply size after the files and the expected output only when a reply budget is given', () => {
    expect(renderBrief({ briefText: 'Do X.', files: ['a.ts'], expectedOutput: 'A list.', replyBudgetChars: 48_000 })).toBe(
      'Do X.\n\n## Files\n\n- a.ts\n\n## Expected output\n\nA list.\n\n' +
        '## Reply size\n\nKeep your final reply under 48,000 characters. It is returned to the parent whole, never cut.',
    );
    expect(renderBrief({ briefText: 'Do X.', replyBudgetChars: 1000 })).toBe(
      'Do X.\n\n## Reply size\n\nKeep your final reply under 1,000 characters. It is returned to the parent whole, never cut.',
    );
    expect(renderBrief({ briefText: 'Do X.', files: ['a.ts'] })).not.toMatch(/Reply size/);
  });

  it('covers R17: tiers that name one model share its limit, and a model on the same endpoint with no entry does not', async () => {
    const root = makeProject(DEFAULT_YAML.replace('    cloud: { host: pi, model: cloud/model, thinking: low }', '    cloud: { host: pi, model: local/qwen-free, thinking: low }'));
    const { port, started } = manualPort();
    const svc = service(root, port);
    await svc.delegate({ agent: 'helper', briefText: 'medium' }, { wait: false });
    const sameModel = await svc.delegate({ agent: 'other', briefText: 'small tier, same model' }, { wait: false });
    const otherModel = await svc.delegate({ agent: 'free', briefText: 'same endpoint, other model' }, { wait: false });
    expect(sameModel).toMatchObject({ kind: 'queued', model: 'local/qwen', place: 1 });
    expect(otherModel).toMatchObject({ kind: 'started' });
    expect(started.length).toBe(2);
  });

  it('reads the limit again at each admission, so a limit raised between two delegations applies to the second', async () => {
    const root = makeProject();
    const { port, started } = manualPort();
    const svc = service(root, port);
    await svc.delegate({ agent: 'helper', briefText: 'one' }, { wait: false });
    writeFileSync(path.join(root, '.agents', 'subzero.yaml'), DEFAULT_YAML.replace('    local/qwen: 1', '    local/qwen: 2'));
    const second = await svc.delegate({ agent: 'other', briefText: 'two' }, { wait: false });
    expect(second).toMatchObject({ kind: 'started' });
    expect(started.length).toBe(2);
  });

  it('keeps the second of two runs on a limit-1 model Pending until the first ends, in each way', async () => {
    for (const end of ['settle', 'fail', 'cancel'] as const) {
      const { port, started } = manualPort();
      const svc = service(makeProject(), port);
      const first = await svc.delegate({ agent: 'helper', briefText: 'one' }, { wait: false });
      const states: string[] = [];
      const second = svc.delegate({ agent: 'other', briefText: 'two' }, { wait: true, onState: (s) => states.push(s) });
      await until(() => states.length > 0);
      expect(started.length).toBe(1);
      expect(states).toEqual(['Pending']);
      if (end === 'settle') started[0]!.settle();
      if (end === 'fail') started[0]!.settle({ status: 'failed', failureKind: 'timeout' });
      if (end === 'cancel') await svc.cancel((first as { taskId: string }).taskId);
      await until(() => started.length === 2);
      started[1]!.settle();
      expect((await second).kind).toBe('result');
    }
  });

  it('does not report Pending for a run released at once', async () => {
    const { port } = manualPort();
    const svc = service(makeProject(), port);
    const states: string[] = [];
    await svc.delegate({ agent: 'free', briefText: 'one' }, { wait: false, onState: (s) => states.push(s) });
    expect(states).toEqual(['Starting']);
  });

  it('starts no child for a Pending run that is cancelled', async () => {
    const { port, started } = manualPort();
    const svc = service(makeProject(), port);
    await svc.delegate({ agent: 'helper', briefText: 'one' }, { wait: false });
    const second = (await svc.delegate({ agent: 'other', briefText: 'two' }, { wait: false })) as { taskId: string };
    const reply = await svc.cancel(second.taskId);
    expect(reply).toMatchObject({ kind: 'result', result: { status: 'cancelled' } });
    started[0]!.settle();
    await new Promise((r) => setTimeout(r, 50));
    expect(started.length).toBe(1);
  });

  it('runs agents on different models, or on one with no limit, at once', async () => {
    const { port, started } = manualPort();
    const svc = service(makeProject(), port);
    await svc.delegate({ agent: 'helper', briefText: 'one' }, { wait: false });
    await svc.delegate({ agent: 'free', briefText: 'two' }, { wait: false });
    await svc.delegate({ agent: 'free', briefText: 'three' }, { wait: false });
    expect(started.length).toBe(3);
  });

  it('does not count a child run of another process', async () => {
    const root = makeProject();
    const other = service(root, manualPort().port);
    await other.delegate({ agent: 'helper', briefText: 'elsewhere' }, { wait: false });
    const { port, started } = manualPort();
    const svc = service(root, port);
    await svc.delegate({ agent: 'helper', briefText: 'here' }, { wait: false });
    expect(started.length).toBe(1);
  });

  it('says that a task whose owner died after start-up is abandoned, since the sweep runs again', async () => {
    const root = makeProject();
    const svc = service(root, manualPort().port);
    await svc.start();
    new TaskStore(root, { owner: { pid: 999_999, startTime: 'then' } }).createTaskRecord({
      taskId: 'sz-latedd',
      agent: { name: 'helper' } as never,
      brief: 'b',
      createdAt: new Date().toISOString(),
    });
    expect(await svc.collect('sz-latedd')).toEqual({ kind: 'abandoned', taskId: 'sz-latedd' });
  });

  it('collects the stored result after a restart, and says an abandoned task has none', async () => {
    const root = makeProject();
    const { port, started } = manualPort();
    const first = service(root, port);
    const { taskId } = (await first.delegate({ agent: 'free', briefText: 'b' }, { wait: false })) as { taskId: string };
    started[0]!.settle({ lastAssistantText: 'stored' });
    await until(() => indexLines(root).length === 2);
    const restarted = service(root, manualPort().port);
    expect(await restarted.collect(taskId)).toMatchObject({ kind: 'result', result: { summary: 'stored' } });
    // A cancel of a settled task returns its stored result unchanged.
    expect(await restarted.cancel(taskId)).toMatchObject({ kind: 'result', result: { status: 'completed' } });
  });

  it('reports a running task of another live process and changes nothing', async () => {
    const root = makeProject();
    const owner = service(root, manualPort().port);
    const { taskId } = (await owner.delegate({ agent: 'free', briefText: 'b' }, { wait: false })) as { taskId: string };
    const here = service(root, manualPort().port);
    const before = indexLines(root).length;
    expect(await here.cancel(taskId)).toMatchObject({ kind: 'other_process', taskId });
    expect(await here.collect(taskId)).toMatchObject({ kind: 'other_process', taskId, model: 'cloud/model' });
    expect(indexLines(root).length).toBe(before);
    expect(here.store.readTask(taskId)!.status).toBe('running');
  });

  it('lists the tasks of one parent session id after the sweep', async () => {
    const svc = service(makeProject(), manualPort().port);
    await svc.delegate({ agent: 'free', briefText: 'a', parentSessionId: 's1' }, { wait: false });
    await svc.delegate({ agent: 'free', briefText: 'b', parentSessionId: 's2' }, { wait: false });
    expect((await svc.list('s1')).length).toBe(1);
    expect((await svc.list()).length).toBe(2);
  });

  it('kills a child run that ignores every stop once the shutdown deadline passes', async () => {
    const root = makeProject();
    const fake = fakePiEnv({ turn: [{ hang: true }], ignoreAbort: true, ignoreStdinEnd: true, ignoreSigterm: true });
    const { kernel, driver } = piKernel({ piCommand: FAKE_PI_COMMAND, env: fake.env, piAgentDir: tempDir() });
    const svc = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, warn: () => {}, kernel });
    await svc.delegate({ agent: 'helper', briefText: 'go' }, { wait: false });
    await until(() => fake.log().some((l) => l.command === 'prompt'));
    // As the entry point does: the service reports what outlived the deadline, the driver kills it.
    expect(await svc.shutdown(300)).toBe(false);
    driver.killAll();
    await until(() => !isAlive(fake.log()[0].pid));
  });

  it('runs a delegation end to end on the fake pi', async () => {
    const root = makeProject();
    const fake = fakePiEnv();
    const svc = new DelegationService({
      env: { SUBZERO_PROJECT_DIR: root },
      warn: () => {},
      kernel: piKernel({ piCommand: FAKE_PI_COMMAND, env: fake.env, piAgentDir: tempDir() }).kernel,
    });
    const events: string[] = [];
    const reply = await svc.delegate({ agent: 'helper', briefText: 'go' }, { wait: true, onEvent: (e) => events.push(e.kind) });
    expect(reply).toMatchObject({ kind: 'result', result: { status: 'completed', summary: 'Done: wrote the answer.' } });
    expect(events).toContain('skills_verified');
  });

  it('hands the child port the folders of the project, the sessions and the driver files of the task', async () => {
    const root = makeProject();
    let request: any;
    const port: ChildPort = {
      start(r) {
        request = r;
        return { outcome: Promise.resolve({ lastAssistantText: 'ok', status: 'completed', usage: unavailableUsage('n/a') }), cancel() {} };
      },
    };
    const svc = service(root, port);
    await svc.delegate({ agent: 'helper', briefText: 'go' }, { wait: true });
    expect(request).toMatchObject({
      projectRoot: root,
      sessionsFolder: path.join(root, '.agents', 'subzero', 'sessions'),
      driverFilesFolder: path.join(root, '.agents', 'subzero', 'tasks', request.taskId),
    });
  });

  it('hands the child port the extensions of the merged config, none when the global file names none', async () => {
    const root = makeProject();
    const requests: any[] = [];
    const port: ChildPort = {
      start(r) {
        requests.push(r);
        return { outcome: Promise.resolve({ lastAssistantText: 'ok', status: 'completed', usage: unavailableUsage('n/a') }), cancel() {} };
      },
    };
    await service(root, port).delegate({ agent: 'helper', briefText: 'go' }, { wait: true });
    expect(requests[0].childHostOptions ?? {}).toEqual({});
    const ext = path.join(tempDir(), 'ext.ts');
    writeFileSync(ext, '');
    useDefaultGlobalConfig(`hosts:\n  pi:\n    extensions:\n      - ${ext}\n${GLOBAL_MEDIUM_YAML}`);
    await service(root, port).delegate({ agent: 'helper', briefText: 'go' }, { wait: true });
    expect(requests[1].childHostOptions).toEqual({ extensions: [ext] });
  });

  it('records the extensions in the launch spec of the task record on the fake pi', async () => {
    const root = makeProject();
    const ext = path.join(tempDir(), 'ext.ts');
    writeFileSync(ext, '');
    useDefaultGlobalConfig(`hosts:\n  pi:\n    extensions:\n      - ${ext}\n`);
    const fake = fakePiEnv();
    const svc = new DelegationService({
      env: { SUBZERO_PROJECT_DIR: root },
      warn: () => {},
      kernel: piKernel({ piCommand: FAKE_PI_COMMAND, env: fake.env, piAgentDir: tempDir() }).kernel,
    });
    const reply = await svc.delegate({ agent: 'helper', briefText: 'go' }, { wait: true });
    if (reply.kind !== 'result') throw new Error('expected a result');
    const command: string[] = svc.store.readTask(reply.result.taskId)!.task!.launchSpec!.command;
    expect(command.slice(command.indexOf('-ne'), command.indexOf('-ne') + 3)).toEqual(['-ne', '-nc', '-np']);
    expect(command.slice(command.indexOf('-e'), command.indexOf('-e') + 2)).toEqual(['-e', ext]);
    expect(fake.log()[0].argv).toContain(ext);
  });

  it('refuses a host with no registered driver, naming the host and the supported hosts, and makes no task', async () => {
    const root = makeProject();
    const kernel = new Kernel();
    const svc = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, warn: () => {}, kernel });
    await expect(svc.delegate({ agent: 'helper', briefText: 'go' }, { wait: false })).rejects.toThrow(/"pi".*supported hosts: \(none\)/s);
    expect(await svc.list()).toEqual([]);
    expect(indexLines(root)).toEqual([]);
  });
  it('freezes the definition resolved at the tier of the agent, with its host from the tier', async () => {
    const root = makeProject();
    const { port } = manualPort();
    const frozen: any[] = [];
    const svc = service(root, { start: (request, onEvent) => (frozen.push(request.agent), port.start(request, onEvent)) });
    await svc.delegate({ agent: 'other', briefText: 'go' }, { wait: false });
    expect(frozen[0]).toMatchObject({ name: 'other', host: 'pi', model: 'local/qwen', thinking: 'low', parallel: 1 });
  });

  it('runs general when no agent is named, and names the host when its driver has no starter tools for a missing general entry', async () => {
    const withGeneral = makeProject(DEFAULT_YAML);
    const frozen: any[] = [];
    const { port } = manualPort();
    const svc = service(withGeneral, { start: (request, onEvent) => (frozen.push(request.agent), port.start(request, onEvent)) });
    await svc.delegate({ briefText: 'go' }, { wait: false });
    expect(frozen[0]).toMatchObject({ name: 'general', model: 'local/qwen', tools: ['read', 'bash', 'write', 'edit'], timeout: 9 });

    const noGeneral = DEFAULT_YAML.replace(/  general:\n    tools: \[read, bash, write, edit\]\n    timeout: 9\n/, '');
    const bare = service(makeProject(noGeneral), manualPort().port);
    await expect(bare.delegate({ briefText: 'go' }, { wait: false })).rejects.toThrow(/child driver of the host "pi" offers no starter tools/);
  });

  it('returns the tier error, naming the host and the supported hosts, when the tier host has no driver, and makes no task', async () => {
    const root = makeProject(DEFAULT_YAML.replace('cloud: { host: pi,', 'cloud: { host: claude,'));
    const svc = service(root, manualPort().port);
    const err = await svc.delegate({ agent: 'free', briefText: 'go' }, { wait: false }).catch((e) => e);
    expect(err).toBeInstanceOf(TierError);
    expect(err.message).toMatch(/"cloud".*"claude".*supported hosts: pi/s);
    expect(indexLines(root)).toEqual([]);
  });

});

describe('DelegationService queued and started status', () => {
  const idOf = (reply: { taskId?: string }) => reply.taskId!;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('answers started for the first of three no-wait delegations and queued at places 1 and 2 for the others', async () => {
    const { port, started } = manualPort();
    const svc = service(makeProject(), port);
    const first = await svc.delegate({ agent: 'helper', briefText: 'one' }, { wait: false });
    const second = await svc.delegate({ agent: 'other', briefText: 'two' }, { wait: false });
    const third = await svc.delegate({ agent: 'other', briefText: 'three' }, { wait: false });
    expect(first).toMatchObject({ kind: 'started', startedAt: expect.any(String) });
    expect(second).toMatchObject({ kind: 'queued', model: 'local/qwen', place: 1, enqueuedAt: expect.any(String) });
    expect(third).toMatchObject({ kind: 'queued', model: 'local/qwen', place: 2 });
    expect(started.length).toBe(1);
    // A queued reply never carries a start time.
    expect(second).not.toHaveProperty('startedAt');
  });

  it('reports the next task running with a start time later than its enqueue time once the running one settles', async () => {
    const { port, started } = manualPort();
    const svc = service(makeProject(), port);
    await svc.delegate({ agent: 'helper', briefText: 'one' }, { wait: false });
    const second = (await svc.delegate({ agent: 'other', briefText: 'two' }, { wait: false })) as any;
    await pause(30);
    expect(await svc.collect(second.taskId)).toMatchObject({ kind: 'queued', place: 1 });
    started[0]!.settle();
    await until(() => started.length === 2);
    const running = (await svc.collect(second.taskId)) as any;
    expect(running.kind).toBe('running');
    expect(Date.parse(running.startedAt)).toBeGreaterThan(Date.parse(second.enqueuedAt));
    expect(running).not.toHaveProperty('place');
  });

  it('lists a queued task with its place and a released one with its start time', async () => {
    const { port } = manualPort();
    const svc = service(makeProject(), port);
    await svc.delegate({ agent: 'helper', briefText: 'one' }, { wait: false });
    await svc.delegate({ agent: 'other', briefText: 'two' }, { wait: false });
    const views = await svc.list();
    const byAgent = new Map(views.map((v) => [v.agent, v]));
    expect(byAgent.get('helper')).toMatchObject({ status: 'running', startedAt: expect.any(String) });
    expect(byAgent.get('helper')!.queuePlace).toBeUndefined();
    expect(byAgent.get('other')).toMatchObject({ status: 'running', queuePlace: 1, model: 'local/qwen' });
    expect(byAgent.get('other')!.startedAt).toBeUndefined();
  });

  it('removes a cancelled queued task from the queue and moves the next one to place 1', async () => {
    const { port, started } = manualPort();
    const svc = service(makeProject(), port);
    await svc.delegate({ agent: 'helper', briefText: 'one' }, { wait: false });
    const second = await svc.delegate({ agent: 'other', briefText: 'two' }, { wait: false });
    const third = await svc.delegate({ agent: 'other', briefText: 'three' }, { wait: false });
    expect(await svc.cancel(idOf(second as any))).toMatchObject({ kind: 'result', result: { status: 'cancelled' } });
    expect(await svc.collect(idOf(third as any))).toMatchObject({ kind: 'queued', place: 1 });
    expect(started.length).toBe(1);
  });

  it('starts the timeout of a queued task at its release, so a task queued longer than its timeout still runs', async () => {
    const yaml = DEFAULT_YAML.replace('    tier: small\n    skills: [alpha]\n    tools: [read]\n    timeout: 30', '    tier: small\n    skills: [alpha]\n    tools: [read]\n    timeout: 0.8');
    const root = makeProject(yaml);
    const fake = fakePiEnv();
    const pi = piKernel({ piCommand: FAKE_PI_COMMAND, env: fake.env, piAgentDir: tempDir() }).kernel.childPort('pi');
    // The first start is held by hand; later ones run on the fake pi, whose child lives far shorter than the timeout.
    const manual = manualPort();
    let starts = 0;
    const kernel = kernelWithPort({ start: (request, onEvent) => (starts++ === 0 ? manual.port.start(request, onEvent) : pi.start(request, onEvent)) });
    const svc = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, warn: () => {}, kernel });
    await svc.delegate({ agent: 'helper', briefText: 'holds the endpoint' }, { wait: false });
    const waiting = svc.delegate({ agent: 'other', briefText: 'queued' }, { wait: true });
    await pause(1200); // longer than the 0.8 s timeout of the queued agent
    manual.started[0]!.settle();
    expect(await waiting).toMatchObject({ kind: 'result', result: { status: 'completed', summary: 'Done: wrote the answer.' } });
  });

  it('persists the start time at release so a second process sees it, and shows a task still queued elsewhere as queued with no place', async () => {
    const root = makeProject();
    const { port } = manualPort();
    const owner = service(root, port);
    const first = (await owner.delegate({ agent: 'helper', briefText: 'one' }, { wait: false })) as any;
    const second = (await owner.delegate({ agent: 'other', briefText: 'two' }, { wait: false })) as any;
    const here = service(root, manualPort().port);
    const firstReply = (await here.collect(first.taskId)) as any;
    expect(firstReply).toMatchObject({ kind: 'other_process', model: 'local/qwen', startedAt: first.startedAt });
    const secondReply = (await here.collect(second.taskId)) as any;
    expect(secondReply).toMatchObject({ kind: 'other_process', model: 'local/qwen', enqueuedAt: second.enqueuedAt });
    expect(secondReply.startedAt).toBeUndefined();
    const views = new Map((await here.list()).map((v) => [v.taskId, v]));
    expect(views.get(first.taskId)).toMatchObject({ status: 'running', startedAt: first.startedAt });
    expect(views.get(second.taskId)).toMatchObject({ status: 'running' });
    expect(views.get(second.taskId)!.startedAt).toBeUndefined();
    expect(views.get(second.taskId)!.queuePlace).toBeUndefined();
  });

  it('marks the queued task of a dead process abandoned, because its stored status is running', async () => {
    const root = makeProject();
    const dead = new TaskStore(root, { owner: { pid: 999_999, startTime: 'then' } });
    dead.createTaskRecord({ taskId: 'sz-qdeadd', agent: { name: 'other' } as never, brief: 'b', model: 'local/qwen', createdAt: new Date().toISOString() });
    const svc = service(root, manualPort().port);
    expect(await svc.collect('sz-qdeadd')).toEqual({ kind: 'abandoned', taskId: 'sz-qdeadd' });
  });
});

describe('DelegationService tiers, general and fallback', () => {
  /** A service that records each frozen agent definition and settles nothing by itself. */
  function recording(root: string) {
    const frozen: any[] = [];
    const { port, started } = manualPort();
    const svc = service(root, { start: (request, onEvent) => (frozen.push(request.agent), port.start(request, onEvent)) });
    return { svc, frozen, started };
  }

  it('runs general on the tier model and records general:<tier>, and accepts tier:<tier> the same way', async () => {
    const root = makeProject(TIERED_YAML);
    const { svc, frozen } = recording(root);
    await svc.delegate({ briefText: 'go', tier: 'medium' }, { wait: false });
    await svc.delegate({ briefText: 'go', tier: 'tier:medium' }, { wait: false });
    for (const f of frozen) {
      expect(f).toMatchObject({ name: 'general:medium', host: 'pi', model: 'r9700/Qwen3.8', thinking: 'medium', tools: ['read', 'bash', 'write', 'edit'] });
    }
    const agents = (await svc.list()).map((v) => v.agent);
    expect(agents).toEqual(['general:medium', 'general:medium']);
  });

  it('covers AE11: no agent and no tier, or the agent general, runs general on its default model and records general', async () => {
    const { svc, frozen, started } = recording(makeProject(TIERED_YAML));
    const none = await svc.delegate({ briefText: 'go' }, { wait: false });
    started[0]!.settle(); // the default endpoint runs one child at a time
    const named = await svc.delegate({ agent: 'general', briefText: 'go' }, { wait: false });
    expect(frozen[0]).toMatchObject({ name: 'general', model: 'r9700/Qwen3.8' });
    expect(frozen[1]).toMatchObject({ name: 'general', model: 'r9700/Qwen3.8' });
    expect(none).not.toHaveProperty('notice');
    expect(named).not.toHaveProperty('notice');
  });

  it('runs a named agent at a tier with its own override, and records <agent>:<tier>', async () => {
    const { svc, frozen } = recording(makeProject(TIERED_YAML));
    await svc.delegate({ agent: 'reviewer', briefText: 'go', tier: 'large' }, { wait: false });
    await svc.delegate({ agent: 'reviewer', briefText: 'go' }, { wait: false });
    expect(frozen[0]).toMatchObject({ name: 'reviewer:large', model: 'cloud/reviewer-large', thinking: 'high' });
    expect(frozen[1]).toMatchObject({ name: 'reviewer', model: 'r9700/Qwen3.8' });
  });

  it('returns the tier error for an unknown tier or a tier host with no driver, and makes no task', async () => {
    const root = makeProject(TIERED_YAML);
    const svc = service(root, manualPort().port);
    const unknown = await svc.delegate({ briefText: 'go', tier: 'huge' }, { wait: false }).catch((e) => e);
    expect(unknown).toBeInstanceOf(TierError);
    expect(unknown.message).toMatch(/"huge".*configured tiers: .*medium/s);
    const far = await svc.delegate({ agent: 'reviewer', briefText: 'go', tier: 'far' }, { wait: false }).catch((e) => e);
    expect(far).toBeInstanceOf(TierError);
    expect(far.message).toMatch(/"claude".*supported hosts: pi/s);
    expect(indexLines(root)).toEqual([]);
  });

  it('covers AE10: an unknown name runs fallback with its tools, records fallback and carries the notice, waiting or not', async () => {
    const { svc, frozen, started } = recording(makeProject(TIERED_YAML));
    const noWait = (await svc.delegate({ agent: 'reviewr', briefText: 'go' }, { wait: false })) as any;
    expect(frozen[0]).toMatchObject({ name: 'fallback', tools: ['read', 'grep'], timeout: 8 });
    expect(noWait.notice).toMatch(/reviewr.*not configured/);
    started[0]!.settle(); // the default endpoint runs one child at a time
    const waited = svc.delegate({ agent: 'reviewr', briefText: 'go' }, { wait: true });
    await until(() => started.length === 2);
    started[1]!.settle();
    const reply = (await waited) as any;
    expect(reply).toMatchObject({ kind: 'result', result: { agent: 'fallback' } });
    expect(reply.notice).toMatch(/reviewr.*not configured/);
  });

  it('names fallback itself with no notice, and records fallback:<tier> when a tier is named', async () => {
    const { svc, frozen } = recording(makeProject(TIERED_YAML));
    const reply = await svc.delegate({ agent: 'fallback', briefText: 'go' }, { wait: false });
    expect(reply).not.toHaveProperty('notice');
    expect(frozen[0]).toMatchObject({ name: 'fallback', tools: ['read', 'grep'] });
    await svc.delegate({ agent: 'reviewr', briefText: 'go', tier: 'medium' }, { wait: false });
    expect(frozen[1]).toMatchObject({ name: 'fallback:medium', model: 'r9700/Qwen3.8' });
  });

  it('runs the built-in fallback with its notice for an unknown name when the file has no fallback entry', async () => {
    const root = makeProject(TIERED_YAML.replace(/  fallback:\n    tools: \[read, grep\]\n    timeout: 8\n/, ''));
    const frozen: any[] = [];
    const { port } = manualPort();
    const svc = service(root, { start: (request, onEvent) => (frozen.push(request.agent), port.start(request, onEvent)) }, () => STARTER);
    const reply: any = await svc.delegate({ agent: 'reviewr', briefText: 'go' }, { wait: false });
    expect(frozen[0]).toMatchObject({ name: 'fallback', tools: ['read'], timeout: 1200 });
    expect(reply.notice).toMatch(/the agent "reviewr" is not configured, so the fallback agent ran instead/);
  });

  it('fails with the host-naming error and no task for a missing general or fallback when the driver has no starter tools', async () => {
    const root = makeProject(TIERED_YAML.replace(/  fallback:\n    tools: \[read, grep\]\n    timeout: 8\n/, ''));
    const svc = service(root, manualPort().port);
    const err = await svc.delegate({ agent: 'reviewr', briefText: 'go' }, { wait: false }).catch((e) => e);
    expect(err).toBeInstanceOf(LoadError);
    expect(err.message).toMatch(/host "pi" offers no starter tools.*fallback/);
    expect(indexLines(root)).toEqual([]);
  });

  it('fills a missing general from the starter tools of the driver, for no agent, general and a tier alike', async () => {
    const root = makeProject(DEFAULT_YAML.replace(/  general:\n    tools: \[read, bash, write, edit\]\n    timeout: 9\n/, '').replace('  parallel:\n    local/qwen: 1\n', ''));
    const frozen: any[] = [];
    const { port } = manualPort();
    const svc = service(root, { start: (request, onEvent) => (frozen.push(request.agent), port.start(request, onEvent)) }, () => STARTER);
    for (const delegation of [{ briefText: 'go' }, { agent: 'general', briefText: 'go' }, { briefText: 'go', tier: 'small' }]) {
      await svc.delegate(delegation, { wait: false });
    }
    expect(frozen.map((f) => [f.name, f.tools, f.timeout])).toEqual([
      ['general', ['read', 'bash'], 1200],
      ['general', ['read', 'bash'], 1200],
      ['general:small', ['read', 'bash'], 1200],
    ]);
  });

  it('covers AE2: with a global medium and no project file, general runs on the medium model with the starter tools of its host', async () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const root = tempDir('subzero-project-');
    const frozen: any[] = [];
    const { port } = manualPort();
    const svc = service(root, { start: (request, onEvent) => (frozen.push(request.agent), port.start(request, onEvent)) }, () => STARTER);
    await svc.delegate({ briefText: 'go' }, { wait: false });
    expect(frozen[0]).toMatchObject({ name: 'general', host: 'pi', model: 'local/global-medium', thinking: 'low', tools: ['read', 'bash'], timeout: 1200 });
  });

  it('fails with the host-naming error for a global-only project whose child driver has no starter tools', async () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const root = tempDir('subzero-project-');
    const err = await service(root, manualPort().port).delegate({ briefText: 'go' }, { wait: false }).catch((e) => e);
    expect(err).toBeInstanceOf(LoadError);
    expect(err.message).toMatch(/host "pi" offers no starter tools/);
    expect(indexLines(root)).toEqual([]);
  });

  it('refuses with a missing-file error and no task when there is no project file and no global medium', async () => {
    const root = tempDir('subzero-project-');
    const err = await service(root, manualPort().port, () => STARTER).delegate({ briefText: 'go' }, { wait: false }).catch((e) => e);
    expect(err).toBeInstanceOf(MissingAgentFileError);
    expect(indexLines(root)).toEqual([]);
  });

  it('covers AE4: enabled false refuses with the disabled error and no task, even with a global medium', async () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const root = makeProject('enabled: false\n');
    const err = await service(root, manualPort().port, () => STARTER).delegate({ briefText: 'go' }, { wait: false }).catch((e) => e);
    expect(err).toBeInstanceOf(ProjectDisabledError);
    expect(err.message).toMatch(/enabled: false/);
    expect(indexLines(root)).toEqual([]);
  });

  it('keeps the queued scenarios for tiered tasks: the second general:medium task waits at place 1, never started', async () => {
    const root = makeProject(TIERED_YAML.replace('  parallel:\n', '  parallel:\n    r9700/Qwen3.8: 1\n'));
    const { svc, started } = recording(root);
    const first = await svc.delegate({ briefText: 'one', tier: 'medium' }, { wait: false });
    const second = await svc.delegate({ briefText: 'two', tier: 'medium' }, { wait: false });
    expect(first).toMatchObject({ kind: 'started' });
    expect(second).toMatchObject({ kind: 'queued', model: 'r9700/Qwen3.8', place: 1 });
    expect(started.length).toBe(1);
    expect(await svc.list()).toEqual(
      expect.arrayContaining([expect.objectContaining({ agent: 'general:medium', queuePlace: 1 })]),
    );
    started[0]!.settle();
    await until(() => started.length === 2);
    expect(await svc.collect((second as any).taskId)).toMatchObject({ kind: 'running' });
  });

  it('launches a general child on the fake pi with bash, write and edit among its tools and the tier model', async () => {
    const root = makeProject(TIERED_YAML);
    const fake = fakePiEnv();
    const svc = new DelegationService({
      env: { SUBZERO_PROJECT_DIR: root },
      warn: () => {},
      kernel: piKernel({ piCommand: FAKE_PI_COMMAND, env: fake.env, piAgentDir: tempDir() }).kernel,
    });
    const reply = (await svc.delegate({ briefText: 'go', tier: 'medium' }, { wait: true })) as any;
    expect(reply.result.agent).toBe('general:medium');
    const argv: string[] = fake.log()[0].argv;
    expect(argv[argv.indexOf('--model') + 1]).toBe('r9700/Qwen3.8');
    const tools = argv[argv.indexOf('--tools') + 1]!.split(',');
    expect(tools).toEqual(expect.arrayContaining(['bash', 'write', 'edit']));
  });
});

describe('DelegationService continue', () => {
  const live = () => manualPort({ steers: true, resume: true });
  const ids = (reply: DelegateReply) => (reply.kind === 'result' ? reply.result.taskId : reply.taskId);

  /** A task of conversation A, prompted and settled once, with its service. */
  async function settledTask(options: { yaml?: string } = {}) {
    const root = makeProject(options.yaml);
    const { port, started } = live();
    const svc = service(root, port);
    const reply = await svc.delegate({ agent: 'helper', briefText: 'first', parentSessionId: 'A' }, { wait: false });
    started[0]!.emit({ kind: 'prompt_sent' });
    started[0]!.settle({ lastAssistantText: 'turn one answer' });
    await until(() => svc.store.readTask(ids(reply))?.status === 'completed');
    return { root, port, started, svc, taskId: ids(reply) };
  }

  it('covers R4: a continuation from another conversation answers not delivered, with no result', async () => {
    const { svc, taskId, started } = await settledTask();
    const reply = await svc.continue({ taskId, message: 'hello', parentSessionId: 'B' }, { wait: false });
    expect(reply).toMatchObject({ kind: 'not_delivered', taskId, reason: expect.stringMatching(/another conversation/) });
    // The first line of the result text, never the result itself.
    expect((reply as { status?: string }).status).toBe(`task: ${taskId} · helper · status: completed`);
    expect(JSON.stringify(reply)).not.toContain('turn one answer');
    expect(started).toHaveLength(1);
    expect(svc.store.readTurns(taskId)).toHaveLength(1);
  });

  it('answers that the conversation could not be identified when no session id is given, or the task has none', async () => {
    const { svc, taskId } = await settledTask();
    expect(await svc.continue({ taskId, message: 'm' }, { wait: false })).toMatchObject({ kind: 'not_delivered', reason: expect.stringMatching(/could not be identified/) });
    const orphan = await svc.delegate({ agent: 'helper', briefText: 'no session' }, { wait: false });
    expect(orphan).toMatchObject({ continuable: false });
    expect(await svc.continue({ taskId: ids(orphan), message: 'm', parentSessionId: 'A' }, { wait: false })).toMatchObject({
      kind: 'not_delivered',
      reason: expect.stringMatching(/could not be identified/),
    });
  });

  it('names an unknown task id in the error of a continuation', async () => {
    const { svc } = await settledTask();
    await expect(svc.continue({ taskId: 'sz-nosuch', message: 'm', parentSessionId: 'A' }, { wait: false })).rejects.toThrow(/sz-nosuch/);
  });

  it('covers R4: drops a task whose latest turn another process now owns, and reads it from the task record', async () => {
    const root = makeProject();
    const { port, started } = live();
    const svc = new DelegationService({
      env: { SUBZERO_PROJECT_DIR: root },
      warn: () => {},
      kernel: kernelWithPort(port),
      store: { probe: { startTime: (pid) => (pid === process.pid ? 'now' : pid === 4242 ? 'other' : null) }, owner: { pid: process.pid, startTime: 'now' } },
    });
    const reply = await svc.delegate({ agent: 'helper', briefText: 'first', parentSessionId: 'A' }, { wait: false });
    const taskId = ids(reply);
    started[0]!.emit({ kind: 'prompt_sent' });
    started[0]!.settle({ lastAssistantText: 'turn one answer' });
    await until(() => svc.store.readTask(taskId)?.status === 'completed');
    const other = new TaskStore(root, { warn: () => {}, owner: { pid: 4242, startTime: 'other' } });
    expect(other.claimTurn(taskId, 2, { message: 'from elsewhere', enqueuedAt: new Date().toISOString() })).toBe(true);
    const registry = (svc as unknown as { registry: Map<string, unknown> }).registry;
    expect(registry.has(taskId)).toBe(true);
    // A listing drops it, and the next read comes from the task record, whose latest turn runs in the other process.
    await svc.list('A');
    expect(registry.has(taskId)).toBe(false);
    expect(await svc.collect(taskId)).toMatchObject({ kind: 'results', then: { kind: 'other_process' } });
    const refused = await svc.continue({ taskId, message: 'mine', parentSessionId: 'A' }, { wait: false });
    expect(refused).toMatchObject({ kind: 'not_delivered', reason: expect.stringMatching(/running in another process/) });
    expect(svc.store.readTurns(taskId)).toHaveLength(2);
    expect(started).toHaveLength(1);
  });

  it('gives the status line of a task whose latest turn runs in another live process', async () => {
    const root = makeProject();
    const other = new TaskStore(root, { warn: () => {}, owner: { pid: 4242, startTime: 'other' } });
    const agent = (await import('../../src/config/agent-config.js')).getAgent(root, 'helper');
    other.createTaskRecord({ taskId: 'sz-runnng', agent, brief: 'b', model: agent.model, parentSessionId: 'A', createdAt: new Date().toISOString() });
    const { port } = live();
    const svc = new DelegationService({
      env: { SUBZERO_PROJECT_DIR: root },
      warn: () => {},
      kernel: kernelWithPort(port),
      store: { probe: { startTime: (pid) => (pid === process.pid ? 'now' : pid === 4242 ? 'other' : null) }, owner: { pid: process.pid, startTime: 'now' } },
    });
    const refused = await svc.continue({ taskId: 'sz-runnng', message: 'no', parentSessionId: 'A' }, { wait: false });
    expect(refused).toMatchObject({ kind: 'not_delivered', status: expect.stringMatching(/^queued, not launched yet: .*waiting/) });
  });

  it('covers R4: takes over a settled task whose owner process is alive elsewhere, and refuses a running turn in a live other owner', async () => {
    const root = makeProject();
    const other = new TaskStore(root, { warn: () => {}, owner: { pid: 4242, startTime: 'other' } });
    const agent = (await import('../../src/config/agent-config.js')).getAgent(root, 'helper');
    const record = (taskId: string) => other.createTaskRecord({ taskId, agent, brief: 'b', model: agent.model, parentSessionId: 'A', createdAt: new Date().toISOString() });
    record('sz-settld');
    other.appendEvent('sz-settld', { kind: 'prompt_sent' }, 1);
    other.writeResult('sz-settld', { taskId: 'sz-settld', agent: 'helper', status: 'completed', summary: 'done' });
    record('sz-runnng');
    const { port, started } = live();
    const svc = new DelegationService({
      env: { SUBZERO_PROJECT_DIR: root },
      warn: () => {},
      kernel: kernelWithPort(port),
      store: { probe: { startTime: (pid) => (pid === process.pid ? 'now' : pid === 4242 ? 'other' : null) }, owner: { pid: process.pid, startTime: 'now' } },
    });
    const taken = await svc.continue({ taskId: 'sz-settld', message: 'take it', parentSessionId: 'A' }, { wait: false });
    expect(taken).toMatchObject({ kind: 'new_turn', turn: 2 });
    expect(started).toHaveLength(1);
    expect(svc.store.readTask('sz-settld')!.owner).toEqual({ pid: process.pid, startTime: 'now' });
    const refused = await svc.continue({ taskId: 'sz-runnng', message: 'no', parentSessionId: 'A' }, { wait: false });
    expect(refused).toMatchObject({ kind: 'not_delivered', reason: expect.stringMatching(/running in another process/) });
    expect(svc.store.readTurns('sz-runnng')).toHaveLength(1);
  });

  it('refuses a running turn of another process when the probe cannot tell whether that process is alive', async () => {
    const root = makeProject();
    const other = new TaskStore(root, { warn: () => {}, owner: { pid: 4242, startTime: 'other' } });
    const agent = (await import('../../src/config/agent-config.js')).getAgent(root, 'helper');
    other.createTaskRecord({ taskId: 'sz-unsure', agent, brief: 'b', model: agent.model, parentSessionId: 'A', createdAt: new Date().toISOString() });
    other.appendEvent('sz-unsure', { kind: 'prompt_sent' }, 1);
    const { port, started } = live();
    const svc = new DelegationService({
      env: { SUBZERO_PROJECT_DIR: root },
      warn: () => {},
      kernel: kernelWithPort(port),
      store: { probe: { startTime: (pid) => (pid === process.pid ? 'now' : undefined) }, owner: { pid: process.pid, startTime: 'now' } },
    });
    const refused = await svc.continue({ taskId: 'sz-unsure', message: 'no', parentSessionId: 'A' }, { wait: false });
    expect(refused).toMatchObject({ kind: 'not_delivered', reason: expect.stringMatching(/running in another process/) });
    expect(svc.store.readTurns('sz-unsure')).toHaveLength(1);
    expect(started).toHaveLength(0);
  });

  it('covers R8: a held message that opens turn 2 reaches the parent as turn 1\'s result, the opened-turn line and turn 2\'s status', async () => {
    const root = makeProject();
    const { port, started } = live();
    const svc = service(root, port);
    const first = await svc.delegate({ agent: 'helper', briefText: 'first', parentSessionId: 'A' }, { wait: false });
    const taskId = ids(first);
    expect(await svc.continue({ taskId, message: 'held', parentSessionId: 'A' }, { wait: false })).toMatchObject({ kind: 'queued' });
    started[0]!.steerAnswer = 'settled';
    started[0]!.emit({ kind: 'prompt_sent' });
    started[0]!.settle({ lastAssistantText: 'turn one answer' });
    await until(() => started.length === 2);
    const reply = await svc.collect(taskId);
    expect(reply).toMatchObject({ kind: 'results', results: [{ result: { summary: 'turn one answer' }, openedTurn: 2 }], then: { kind: 'running' } });
    const text = describeTaskReply(reply, undefined, { collect: 'await', cancel: 'cancel' });
    expect(text.indexOf('turn one answer')).toBeLessThan(text.indexOf('opened turn 2'));
    expect(text.indexOf('opened turn 2')).toBeLessThan(text.indexOf('running, started'));
    // Once turn 2 settles, a second collect returns only turn 2.
    started[1]!.emit({ kind: 'prompt_sent' });
    started[1]!.settle({ lastAssistantText: 'turn two answer' });
    await until(() => svc.store.readTask(taskId)?.status === 'completed' && svc.store.readTask(taskId)?.turn === 2);
    const second = await svc.collect(taskId);
    expect(second).toMatchObject({ kind: 'result', result: { turn: 2, summary: 'turn two answer' } });
    expect(await svc.collect(taskId, { onlyNew: true })).toMatchObject({ kind: 'delivered', turn: 2 });
  });

  it('returns only turn 2 from a fresh service that loads a task with turn 1 collected and turn 2 settled', async () => {
    const { root, port, started, svc, taskId } = await settledTask();
    expect(await svc.collect(taskId)).toMatchObject({ kind: 'result', result: { summary: 'turn one answer' } });
    const reply = await svc.continue({ taskId, message: 'go on', parentSessionId: 'A' }, { wait: false });
    expect(reply).toMatchObject({ kind: 'new_turn', turn: 2 });
    started[1]!.emit({ kind: 'prompt_sent' });
    started[1]!.settle({ lastAssistantText: 'turn two answer' });
    await until(() => svc.store.readTask(taskId)?.turn === 2 && svc.store.readTask(taskId)?.status === 'completed');
    const fresh = service(root, port);
    expect(await fresh.collect(taskId)).toMatchObject({ kind: 'result', result: { turn: 2, summary: 'turn two answer' } });
  });

  it('steers a running task although the agent file no longer loads, and a new turn answers not delivered with the load error and claims no turn', async () => {
    const { root, svc, started, taskId } = await settledTask();
    const reply = await svc.continue({ taskId, message: 'turn two', parentSessionId: 'A' }, { wait: false });
    expect(reply).toMatchObject({ kind: 'new_turn' });
    started[1]!.emit({ kind: 'prompt_sent' });
    writeFileSync(path.join(root, '.agents', 'subzero.yaml'), 'agents: [broken');
    expect(await svc.continue({ taskId, message: 'live', parentSessionId: 'A' }, { wait: false })).toMatchObject({ kind: 'steered' });
    started[1]!.settle();
    await until(() => svc.store.readTask(taskId)?.status === 'completed' && svc.store.readTask(taskId)?.turn === 2);
    const blocked = await svc.continue({ taskId, message: 'turn three', parentSessionId: 'A' }, { wait: false });
    expect(blocked).toMatchObject({ kind: 'not_delivered', reason: expect.stringMatching(/configuration does not load/) });
    expect(svc.store.readTurns(taskId)).toHaveLength(2);
  });

  it('leaves no state listener on any of 20 settled turns of one task', async () => {
    const { svc, started, taskId } = await settledTask();
    for (let n = 2; n <= 20; n++) {
      const reply = await svc.continue({ taskId, message: `m${n}`, parentSessionId: 'A' }, { wait: false });
      expect(reply).toMatchObject({ kind: 'new_turn', turn: n });
      started[n - 1]!.emit({ kind: 'prompt_sent' });
      started[n - 1]!.settle();
      await until(() => svc.store.readTask(taskId)?.turn === n && svc.store.readTask(taskId)?.status === 'completed');
    }
    // The registry holds the task with every turn; none keeps a listener of the limiter.
    const task = (svc as unknown as { registry: Map<string, { turns: { stateListenerCount: number }[] }> }).registry.get(taskId)!;
    expect(task.turns).toHaveLength(20);
    expect(task.turns.map((t) => t.stateListenerCount)).toEqual(new Array(20).fill(0));
  });

  it('opens exactly one turn for two continuations in one tick, the second holding into it', async () => {
    const { svc, started, taskId } = await settledTask();
    const [one, two] = await Promise.all([
      svc.continue({ taskId, message: 'one', parentSessionId: 'A' }, { wait: false }),
      svc.continue({ taskId, message: 'two', parentSessionId: 'A' }, { wait: false }),
    ]);
    expect([one.kind, two.kind].sort()).toEqual(['new_turn', 'queued']);
    expect(svc.store.readTurns(taskId)).toHaveLength(2);
    expect(started).toHaveLength(2);
    started[1]!.emit({ kind: 'prompt_sent' });
    await until(() => started[1]!.steers.length === 1);
    expect(started[1]!.steers).toEqual(['two']);
  });

  it('does not hold the task\'s chain while a waited continue waits for its turn, so a second continue joins that turn', async () => {
    const { svc, started, taskId } = await settledTask();
    let firstDone = false;
    const first = svc.continue({ taskId, message: 'one', parentSessionId: 'A' }, { wait: true }).then((reply) => {
      firstDone = true;
      return reply;
    });
    await until(() => started.length === 2);
    const second = await svc.continue({ taskId, message: 'two', parentSessionId: 'A' }, { wait: false });
    expect(['queued', 'steered']).toContain(second.kind);
    expect(firstDone).toBe(false);
    started[1]!.emit({ kind: 'prompt_sent' });
    await until(() => started[1]!.steers.length === 1);
    expect(started[1]!.steers).toEqual(['two']);
    started[1]!.settle({ lastAssistantText: 'turn two answer' });
    expect(await first).toMatchObject({ kind: 'new_turn', turn: 2, status: { kind: 'result', result: { turn: 2, summary: 'turn two answer' } } });
  });

  it('prevents the turn from starting when a session cancel arrives while the continuation is being delivered', async () => {
    const { svc, started, taskId } = await settledTask();
    const pending = svc.continue({ taskId, message: 'too late', parentSessionId: 'A' }, { wait: false });
    await svc.cancelSession('A');
    expect(await pending).toMatchObject({ kind: 'not_delivered', reason: expect.stringMatching(/cancelled/) });
    expect(started).toHaveLength(1);
    expect(svc.store.readTurns(taskId)).toHaveLength(1);
  });

  it('cancels the turn it just claimed when a session cancel lands while the message is steered into a run that then ends', async () => {
    const { port, started } = live();
    const svc = service(makeProject(), port);
    const first = await svc.delegate({ agent: 'helper', briefText: 'first', parentSessionId: 'A' }, { wait: false });
    const taskId = ids(first);
    started[0]!.emit({ kind: 'prompt_sent' });
    // The run answers "settled" only after the conversation was cancelled, so the message goes on to claim a new turn.
    started[0]!.steerAnswer = async (): Promise<'settled'> => {
      await svc.cancelSession('A');
      return 'settled';
    };
    const reply = await svc.continue({ taskId, message: 'racing', parentSessionId: 'A' }, { wait: false });
    expect(reply).toMatchObject({ kind: 'not_delivered', reason: expect.stringMatching(/cancelled/) });
    // No run starts for the turn the claim opened, and that turn does not stay running.
    expect(started).toHaveLength(1);
    const turns = svc.store.readTurns(taskId);
    expect(turns).toHaveLength(2);
    expect(turns[1]!.result).toMatchObject({ status: 'cancelled' });
    expect(await svc.collect(taskId, { onlyNew: true })).not.toMatchObject({ kind: 'running' });
  });

  it('ends a waited delegate with the until signal, returns its status line, and the child keeps running', async () => {
    const { port, started } = live();
    const svc = service(makeProject(), port);
    const typing = new AbortController();
    const waiting = svc.delegate({ agent: 'helper', briefText: 'long', parentSessionId: 'A' }, { wait: true, until: typing.signal });
    await until(() => started.length === 1);
    typing.abort();
    const reply = await waiting;
    expect(reply).toMatchObject({ kind: 'started' });
    expect(started[0]!.cancelled).toBe(false);
    started[0]!.emit({ kind: 'prompt_sent' });
    started[0]!.settle({ lastAssistantText: 'finished later' });
    expect(await svc.waitForCompletion(ids(reply))).toMatchObject({ kind: 'result', result: { summary: 'finished later' } });
  });

  it('waits through a held-message turn with followOn: both results, turn 2 last, both turns collected', async () => {
    const { port, started } = live();
    const svc = service(makeProject(), port);
    const waiting = svc.delegate({ agent: 'helper', briefText: 'first', parentSessionId: 'A' }, { wait: true, followOn: true });
    await until(() => started.length === 1);
    const taskId = (await svc.list('A'))[0]!.taskId;
    expect(await svc.continue({ taskId, message: 'held', parentSessionId: 'A' }, { wait: false })).toMatchObject({ kind: 'queued' });
    started[0]!.steerAnswer = 'settled';
    started[0]!.emit({ kind: 'prompt_sent' });
    started[0]!.settle({ lastAssistantText: 'turn one answer' });
    await until(() => started.length === 2);
    started[1]!.emit({ kind: 'prompt_sent' });
    started[1]!.settle({ lastAssistantText: 'turn two answer' });
    const reply = await waiting;
    expect(reply).toMatchObject({ kind: 'result', result: { turn: 2, summary: 'turn two answer' }, results: [{ summary: 'turn one answer' }, { turn: 2 }] });
    expect(svc.store.isCollected(taskId, 1)).toBe(true);
    expect(svc.store.isCollected(taskId, 2)).toBe(true);
    expect(await svc.collect(taskId, { onlyNew: true })).toMatchObject({ kind: 'delivered', turn: 2 });
  });

  it('keeps turn 1\'s result when the until signal ends a followOn wait while turn 2 still runs', async () => {
    const { port, started } = live();
    const svc = service(makeProject(), port);
    const typing = new AbortController();
    const waiting = svc.delegate({ agent: 'helper', briefText: 'first', parentSessionId: 'A' }, { wait: true, followOn: true, until: typing.signal });
    await until(() => started.length === 1);
    const taskId = (await svc.list('A'))[0]!.taskId;
    expect(await svc.continue({ taskId, message: 'held', parentSessionId: 'A' }, { wait: false })).toMatchObject({ kind: 'queued' });
    started[0]!.steerAnswer = 'settled';
    started[0]!.emit({ kind: 'prompt_sent' });
    started[0]!.settle({ lastAssistantText: 'turn one answer' });
    await until(() => started.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    typing.abort();
    const reply = await waiting;
    expect(reply).toMatchObject({ kind: 'result', result: { summary: 'turn one answer' } });
    expect(svc.store.isCollected(taskId, 1)).toBe(true);
    expect(started[1]!.cancelled).toBe(false);
    started[1]!.settle();
  });

  it('reports a turn that held messages opened through the notice sink, when it opens and once when it settles', async () => {
    const { port, started } = live();
    const svc = service(makeProject(), port);
    const heard: string[] = [];
    svc.onNotice((n) => heard.push(`${n.phase}:${n.turn}`));
    const first = await svc.delegate({ agent: 'helper', briefText: 'first', parentSessionId: 'A' }, { wait: false });
    await svc.continue({ taskId: ids(first), message: 'held', parentSessionId: 'A' }, { wait: false });
    started[0]!.steerAnswer = 'settled';
    started[0]!.emit({ kind: 'prompt_sent' });
    started[0]!.settle();
    await until(() => started.length === 2);
    started[1]!.emit({ kind: 'prompt_sent' });
    started[1]!.settle({ lastAssistantText: 'second' });
    await until(() => heard.includes('settled:2'));
    expect(heard).toEqual(['opened:2', 'settled:2']);
  });

  it('opens a new turn on an abandoned task and names this process as its owner', async () => {
    const root = makeProject();
    const dead = new TaskStore(root, { warn: () => {}, owner: { pid: 999_999, startTime: 'then' } });
    const agent = (await import('../../src/config/agent-config.js')).getAgent(root, 'helper');
    dead.createTaskRecord({ taskId: 'sz-abandn', agent, brief: 'b', model: agent.model, parentSessionId: 'A', createdAt: new Date().toISOString() });
    dead.appendEvent('sz-abandn', { kind: 'prompt_sent' }, 1);
    const { port, started } = live();
    const svc = service(root, port);
    const reply = await svc.continue({ taskId: 'sz-abandn', message: 'pick this up', parentSessionId: 'A' }, { wait: false });
    expect(reply).toMatchObject({ kind: 'new_turn', turn: 2 });
    expect(started[0]).toMatchObject({ kind: 'resume', prompt: 'pick this up' });
    expect(svc.store.readTask('sz-abandn')!.owner!.pid).toBe(process.pid);
  });
});
