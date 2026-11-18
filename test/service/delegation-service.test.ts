import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoadError, MissingAgentFileError, ProjectDisabledError, TierError, UnknownAgentError, UnresolvedRootError } from '../../src/config/agent-config.js';
import { unavailableUsage, type ChildPort, type StarterTools } from '../../src/core/types.js';
import { DelegationService, EmptyBriefError, renderBrief } from '../../src/service/delegation-service.js';
import { TaskStore } from '../../src/store/task-store.js';
import { Kernel } from '../../src/kernel/kernel.js';
import { DEFAULT_YAML, FAKE_PI_COMMAND, GENERAL_MEDIUM_YAML, TIERED_YAML, fakePiEnv, isAlive, kernelWithPort, makeProject, manualPort, piKernel, tempDir, until, useGeneralConfig } from '../helpers.js';

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

  it('keeps the second of two runs on a limit-1 endpoint Pending until the first ends, in each way', async () => {
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

  it('runs agents on different endpoints, or on one with no entry, at once', async () => {
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
    expect(await here.collect(taskId)).toMatchObject({ kind: 'other_process', taskId, endpoint: 'cloud' });
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
    expect(frozen[0]).toMatchObject({ name: 'other', host: 'pi', model: 'local/qwen-small', thinking: 'low', endpoint: 'local', parallel: 1 });
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
    expect(second).toMatchObject({ kind: 'queued', endpoint: 'local', place: 1, enqueuedAt: expect.any(String) });
    expect(third).toMatchObject({ kind: 'queued', endpoint: 'local', place: 2 });
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
    expect(byAgent.get('other')).toMatchObject({ status: 'running', queuePlace: 1, endpoint: 'local' });
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
    expect(firstReply).toMatchObject({ kind: 'other_process', endpoint: 'local', startedAt: first.startedAt });
    const secondReply = (await here.collect(second.taskId)) as any;
    expect(secondReply).toMatchObject({ kind: 'other_process', endpoint: 'local', enqueuedAt: second.enqueuedAt });
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
    dead.createTaskRecord({ taskId: 'sz-qdeadd', agent: { name: 'other' } as never, brief: 'b', endpoint: 'local', createdAt: new Date().toISOString() });
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
    const root = makeProject(DEFAULT_YAML.replace(/  general:\n    tools: \[read, bash, write, edit\]\n    timeout: 9\n/, '').replace('endpoints:\n  local:\n    parallel: 1\n', ''));
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

  it('covers AE2: with a general medium and no project file, general runs on the medium model with the starter tools of its host', async () => {
    useGeneralConfig(GENERAL_MEDIUM_YAML);
    const root = tempDir('subzero-project-');
    const frozen: any[] = [];
    const { port } = manualPort();
    const svc = service(root, { start: (request, onEvent) => (frozen.push(request.agent), port.start(request, onEvent)) }, () => STARTER);
    await svc.delegate({ briefText: 'go' }, { wait: false });
    expect(frozen[0]).toMatchObject({ name: 'general', host: 'pi', model: 'local/general-medium', thinking: 'low', tools: ['read', 'bash'], timeout: 1200 });
  });

  it('fails with the host-naming error for a general-only project whose child driver has no starter tools', async () => {
    useGeneralConfig(GENERAL_MEDIUM_YAML);
    const root = tempDir('subzero-project-');
    const err = await service(root, manualPort().port).delegate({ briefText: 'go' }, { wait: false }).catch((e) => e);
    expect(err).toBeInstanceOf(LoadError);
    expect(err.message).toMatch(/host "pi" offers no starter tools/);
    expect(indexLines(root)).toEqual([]);
  });

  it('refuses with a missing-file error and no task when there is no project file and no general medium', async () => {
    const root = tempDir('subzero-project-');
    const err = await service(root, manualPort().port, () => STARTER).delegate({ briefText: 'go' }, { wait: false }).catch((e) => e);
    expect(err).toBeInstanceOf(MissingAgentFileError);
    expect(indexLines(root)).toEqual([]);
  });

  it('covers AE4: enabled false refuses with the disabled error and no task, even with a general medium', async () => {
    useGeneralConfig(GENERAL_MEDIUM_YAML);
    const root = makeProject('enabled: false\n');
    const err = await service(root, manualPort().port, () => STARTER).delegate({ briefText: 'go' }, { wait: false }).catch((e) => e);
    expect(err).toBeInstanceOf(ProjectDisabledError);
    expect(err.message).toMatch(/enabled: false/);
    expect(indexLines(root)).toEqual([]);
  });

  it('keeps the queued scenarios for tiered tasks: the second general:medium task waits at place 1, never started', async () => {
    const root = makeProject(TIERED_YAML.replace('endpoints:\n', 'endpoints:\n  r9700:\n    parallel: 1\n'));
    const { svc, started } = recording(root);
    const first = await svc.delegate({ briefText: 'one', tier: 'medium' }, { wait: false });
    const second = await svc.delegate({ briefText: 'two', tier: 'medium' }, { wait: false });
    expect(first).toMatchObject({ kind: 'started' });
    expect(second).toMatchObject({ kind: 'queued', endpoint: 'r9700', place: 1 });
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
