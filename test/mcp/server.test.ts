import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { formatListing } from '../../src/mcp/format.js';
import { writeCallMarker, writePromptMarker } from '../../src/mcp/parent-session.js';
import { createSubzeroServer } from '../../src/mcp/server.js';
import { DelegationService } from '../../src/service/delegation-service.js';
import type { TaskView } from '../../src/store/task-store.js';
import { FAKE_PI, FAKE_PI_COMMAND, TIERED_YAML, fakePiEnv, isAlive, kernelWithPort, GLOBAL_MEDIUM_YAML, makeProject, manualPort, piKernel, tempDir, until, useGlobalConfig } from '../helpers.js';

const REPO = path.resolve(import.meta.dirname, '..', '..');

async function connect(scenario: Record<string, unknown> = {}, env: NodeJS.ProcessEnv | null = null, sessionId?: string, yaml?: string) {
  const root = makeProject(yaml);
  const fake = fakePiEnv(scenario);
  const service = new DelegationService({
    env: env ?? { SUBZERO_PROJECT_DIR: root },
    roots: () => [],
    warn: () => {},
    kernel: piKernel({ piCommand: FAKE_PI_COMMAND, env: fake.env, piAgentDir: tempDir(), abortWaitMs: 300, killWaitMs: 300 }).kernel,
  });
  const server = createSubzeroServer({ service, parentSessionId: () => sessionId, progress: { minIntervalMs: 10, heartbeatMs: 200 } });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = (name: string, args: Record<string, unknown>, options: Parameters<Client['callTool']>[2] = {}) =>
    client.callTool({ name, arguments: args }, CallToolResultSchema, options);
  const textOf = (r: any) => r.content.map((c: any) => c.text).join('\n') as string;
  return { root, fake, service, client, call, textOf };
}

/** What `connectManual` can switch on: steering and resume ports, and a plugin data dir for wake and prompt markers. */
interface ManualOptions {
  steers?: boolean;
  resume?: boolean;
  /** Give the server a wake data dir, so it arms wake markers and watches the prompt marker. */
  wake?: boolean;
}

/** A server whose children the test settles by hand, on an endpoint that runs one at a time. */
async function connectManual(yaml?: string, sessionId?: string | (() => string | undefined), extra: ManualOptions = {}) {
  const root = makeProject(yaml);
  const { port, started } = manualPort({ ...(extra.steers ? { steers: true } : {}), ...(extra.resume ? { resume: true } : {}) });
  const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, roots: () => [], warn: () => {}, kernel: kernelWithPort(port) });
  const wakeDataDir = extra.wake ? tempDir('subzero-wake-data-') : undefined;
  const server = createSubzeroServer({
    service,
    parentSessionId: () => typeof sessionId === 'function' ? sessionId() : sessionId,
    progress: { minIntervalMs: 10, heartbeatMs: 200 },
    ...(wakeDataDir !== undefined ? { wakeDataDir } : {}),
  });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  if (wakeDataDir !== undefined) await service.start();
  const call = (name: string, args: Record<string, unknown>, options: Parameters<Client['callTool']>[2] = {}) =>
    client.callTool({ name, arguments: args }, CallToolResultSchema, options);
  /** A call that carries the tool-use id Claude Code puts in the request's _meta. */
  const callWithId = (toolUseId: string, name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args, _meta: { 'claudecode/toolUseId': toolUseId } }, CallToolResultSchema);
  const textOf = (r: any) => r.content.map((c: any) => c.text).join('\n') as string;
  const idIn = (text: string) => /sz-[a-z2-7]{6}/.exec(text)![0];
  return { root, service, started, call, callWithId, client, textOf, idIn, wakeDataDir };
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
/** The folder of one wake marker: keyed by the task id for turn 1 and `taskId#N` for turn N. */
const wakeFolder = (dataDir: string, root: string, session: string, key: string) => path.join(dataDir, 'wake', sha(root), sha(session), sha(key));
const wakeStarted = (dataDir: string, root: string, session: string, key: string) => existsSync(wakeFolder(dataDir, root, session, key));
/** The JSON a finished wake marker holds, read without claiming it; undefined while it has none. */
function wakeDone(dataDir: string, root: string, session: string, key: string): { notice: string; collectedMarker: string } | undefined {
  try { return JSON.parse(readFileSync(path.join(wakeFolder(dataDir, root, session, key), 'done'), 'utf8')); } catch { return undefined; }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ClaudeMcpServer', () => {
  it('cancels the previous session when a new session is observed on a request', async () => {
    let current = 'session-a';
    const { call, service } = await connectManual(TIERED_YAML, () => current);
    await call('delegate', { agent: 'free', brief: 'one', wait: false });
    current = 'session-b';
    await call('tasks', {});
    expect((await service.list('session-a'))[0]?.status).toBe('cancelled');
  });
  it('detects a session change on the live-task timer without a request', async () => {
    let current = 'session-a';
    const { call, service } = await connectManual(TIERED_YAML, () => current);
    vi.useFakeTimers();
    try {
      await call('delegate', { agent: 'free', brief: 'one', wait: false });
      current = 'session-b';
      await vi.advanceTimersByTimeAsync(5001);
      expect((await service.list('session-a'))[0]?.status).toBe('cancelled');
    } finally {
      vi.useRealTimers();
    }
  });
  it('cancels every task of the current session and leaves other sessions running', async () => {
    const { call, textOf, service, started } = await connectManual(TIERED_YAML, 'session-a');
    await call('delegate', { agent: 'free', brief: 'one', wait: false });
    await call('delegate', { agent: 'free', brief: 'two', wait: false });
    const other = await service.delegate({ agent: 'free', briefText: 'other', parentSessionId: 'session-b' }, { wait: false });
    if (other.kind === 'result') throw new Error('expected live task');
    expect(textOf(await call('cancel', {}))).toMatch(/2.*cancel/i);
    expect((await service.list('session-a')).map((task) => task.status)).toEqual(['cancelled', 'cancelled']);
    expect((await service.collect(other.taskId)).kind).toBe('running');
    started[2]!.settle();
  });

  it('does not cancel every task when the session is unknown', async () => {
    const { call, textOf, started } = await connectManual(TIERED_YAML);
    await call('delegate', { agent: 'free', brief: 'one', wait: false });
    expect(textOf(await call('cancel', {}))).toMatch(/session.*unknown/i);
    started[0]!.settle();
  });
  it('passes back a delegation when the agent file is missing', async () => {
    const { root, call, textOf, service } = await connect();
    rmSync(path.join(root, '.agents', 'subzero.yaml'));
    const result: any = await call('delegate', { brief: 'go', wait: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/missing.*subzero init.*Agent tool.*passback/s);
    expect(await service.list()).toEqual([]);
  });
  it('exposes five tools and only delegate and await are always loaded', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['await', 'cancel', 'continue', 'delegate', 'tasks']);
    for (const tool of tools) expect(Boolean(tool._meta?.['anthropic/alwaysLoad'])).toBe(tool.name === 'delegate' || tool.name === 'await');
    expect(client.getInstructions()).toMatch(/self-contained brief/);
    expect(client.getInstructions()).toMatch(/cannot see this conversation/);
    expect(client.getInstructions()).not.toMatch(/configured/i);
  });

  it('sends progress for domain events and heartbeats, without agent text, then returns the result', async () => {
    const turn = [
      { emit: { type: 'tool_execution_start', toolName: 'read', args: { path: 'src/a.ts' } } },
      { sleep: 60 },
      { emit: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'PRIVATE THOUGHT' }], stopReason: 'stop' } } },
      { sleep: 500 },
      { emit: { type: 'agent_settled' } },
    ];
    const { call, textOf } = await connect({ turn, lastText: 'summary here' });
    const messages: string[] = [];
    const result = await call('delegate', { agent: 'helper', brief: 'go', wait: true }, { onprogress: (p) => messages.push(p.message ?? '') });
    const text = textOf(result);
    expect(text.split('\n')[0]).toMatch(/^task: sz-[a-z2-7]{6} · helper · status: completed/);
    expect(text).toContain('summary here');
    expect(messages.some((m) => m.startsWith('helper · tool_activity read src/a.ts · '))).toBe(true);
    expect(messages.filter((m) => m.includes('agent_message')).length).toBeGreaterThan(1); // heartbeat repeats it
    expect(messages.join('\n')).not.toContain('PRIVATE');
  });

  it('returns the task id at once with wait false, and await returns nothing while it is live', async () => {
    const { call, textOf } = await connect({ turn: [{ sleep: 800 }, { emit: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], stopReason: 'stop' } } }, { emit: { type: 'agent_settled' } }] });
    const started = textOf(await call('delegate', { agent: 'helper', brief: 'go', wait: false }));
    const taskId = /sz-[a-z2-7]{6}/.exec(started)![0];
    expect(started).toMatch(/running, started \d{4}-\d{2}-\d{2}T[\d:.]+Z \(\d+s ago\)/);
    expect(textOf(await call('await', { tasks: [taskId], timeout_s: 0.05 }))).toMatch(/running, started \d{4}-/);
    expect(textOf(await call('await', { tasks: [taskId], timeout_s: 10 }))).toMatch(/status: completed/);
  });

  it('cancels the task of a waited call on notifications/cancelled', async () => {
    const { call, fake, service } = await connect({ turn: [{ hang: true }] });
    const abort = new AbortController();
    const pending = call('delegate', { agent: 'helper', brief: 'go', wait: true }, { signal: abort.signal }).catch(() => 'aborted');
    await until(() => fake.log().some((l) => l.command === 'prompt'));
    abort.abort();
    expect(await pending).toBe('aborted');
    const [task] = await service.list();
    await until(() => service.store.readTask(task!.taskId)!.status === 'cancelled');
    await until(() => !isAlive(fake.log()[0].pid));
  });

  it.each([false, true])('cancels %s other session tasks when a waited delegate is aborted', async (late) => {
    const { call, service, started } = await connectManual(TIERED_YAML, 'session-a');
    await call('delegate', { agent: 'free', brief: 'background', wait: false });
    const clock = vi.spyOn(Date, 'now');
    const initial = Date.now();
    clock.mockReturnValue(initial);
    try {
      const abort = new AbortController();
      const pending = call('delegate', { agent: 'free', brief: 'waited', wait: true }, { signal: abort.signal }).catch(() => undefined);
      await until(() => started.length === 2);
      if (late) clock.mockReturnValue(initial + 120_001);
      abort.abort();
      await pending;
      await until(() => service.store.readTask(started[1]!.taskId)?.status === 'cancelled');
      if (!late) await until(() => service.store.readTask(started[0]!.taskId)?.status === 'cancelled');
      expect(service.store.readTask(started[0]!.taskId)?.status).toBe(late ? 'running' : 'cancelled');
    } finally {
      clock.mockRestore();
      started[0]!.settle();
    }
  });

  it.each([false, true])('cancels session tasks on a waited await only before 120 seconds (late: %s)', async (late) => {
    const { call, textOf, idIn, service, started } = await connectManual(TIERED_YAML, 'session-a');
    const ids = [idIn(textOf(await call('delegate', { agent: 'free', brief: 'one', wait: false }))),
      idIn(textOf(await call('delegate', { agent: 'free', brief: 'two', wait: false })))];
    const clock = vi.spyOn(Date, 'now');
    const initial = Date.now();
    clock.mockReturnValue(initial);
    try {
      const abort = new AbortController();
      const pending = call('await', { tasks: ids, timeout_s: 30 }, { signal: abort.signal }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (late) clock.mockReturnValue(initial + 120_001);
      abort.abort();
      await pending;
      if (!late) await until(() => ids.every((id) => service.store.readTask(id)?.status === 'cancelled'));
      expect(ids.map((id) => service.store.readTask(id)?.status)).toEqual(late ? ['running', 'running'] : ['cancelled', 'cancelled']);
    } finally {
      clock.mockRestore();
      started.forEach((task) => task.settle());
    }
  });

  it('returns the unresolved root error as a tool error that says not to retry', async () => {
    const { call } = await connect({}, {});
    const result: any = await call('delegate', { agent: 'helper', brief: 'go', wait: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/SUBZERO_PROJECT_DIR/);
    expect(result.content[0].text).toMatch(/do not retry/);
  });

  it('lists only the tasks of the current parent session id, and every task when it is unknown', async () => {
    const known = await connect({}, null, 'session-1');
    await known.call('delegate', { agent: 'helper', brief: 'go', wait: true });
    await known.service.delegate({ agent: 'free', briefText: 'x', parentSessionId: 'session-2' }, { wait: true });
    const listing = known.textOf(await known.call('tasks', {}));
    expect(listing.split('\n').filter((l) => l.startsWith('sz-')).length).toBe(1);
    expect(listing).not.toMatch(/could not identify/);

    const unknown = await connect();
    await unknown.call('delegate', { agent: 'helper', brief: 'go', wait: true });
    expect(unknown.textOf(await unknown.call('tasks', {}))).toMatch(/could not identify this conversation/);
  });

  it('replies started to the first of three no-wait delegates and queued at places 1 and 2 to the others', async () => {
    const { call, textOf, started } = await connectManual();
    const first = textOf(await call('delegate', { agent: 'helper', brief: 'one', wait: false }));
    const second = textOf(await call('delegate', { agent: 'other', brief: 'two', wait: false }));
    const third = textOf(await call('delegate', { agent: 'other', brief: 'three', wait: false }));
    expect(first).toMatch(/^task: sz-[a-z2-7]{6} · running, started \d{4}-[\d\-T:.Z]+ \(\d+s ago\)/);
    expect(second).toContain("queued, not launched yet: no child is running; it starts when model local/qwen has room (place 1 in this session's queue, waiting ");
    expect(third).toContain("place 2 in this session's queue");
    for (const reply of [second, third]) expect(reply).not.toMatch(/running, started|still running|\bstarted\b/);
    expect(started.length).toBe(1);
  });

  it('shows queued with its place and wait in tasks(task), never running, and moves the place when the first one is cancelled', async () => {
    const { call, textOf, idIn } = await connectManual();
    await call('delegate', { agent: 'helper', brief: 'one', wait: false });
    const second = idIn(textOf(await call('delegate', { agent: 'other', brief: 'two', wait: false })));
    const third = idIn(textOf(await call('delegate', { agent: 'other', brief: 'three', wait: false })));
    const shown = textOf(await call('tasks', { task: third }));
    expect(shown).toMatch(/queued, not launched yet: .* \(place 2 in this session's queue, waiting \d+s\)/);
    expect(shown).not.toMatch(/running, started|still running|\bstarted\b/);
    expect(textOf(await call('cancel', { task: second }))).toMatch(/cancelled/);
    expect(textOf(await call('tasks', { task: third }))).toContain("place 1 in this session's queue");
    const listing = textOf(await call('tasks', {}));
    expect(listing.split('\n').find((l) => l.startsWith(third))).toMatch(/queued, not launched yet/);
    expect(listing.split('\n').find((l) => l.startsWith(third))).not.toMatch(/running, started|still running|\bstarted\b/);
  });

  it('returns the queued line, not still running, from await with a short timeout on a queued task, and running with a start time after release', async () => {
    const { call, textOf, idIn, started } = await connectManual();
    await call('delegate', { agent: 'helper', brief: 'one', wait: false });
    const second = idIn(textOf(await call('delegate', { agent: 'other', brief: 'two', wait: false })));
    const waiting = textOf(await call('await', { tasks: [second], timeout_s: 0.05 }));
    expect(waiting).toContain('queued, not launched yet');
    expect(waiting).not.toMatch(/running, started|still running|\bstarted\b/);
    started[0]!.settle();
    await until(() => started.length === 2);
    expect(textOf(await call('await', { tasks: [second], timeout_s: 0.05 }))).toMatch(/running, started \d{4}-[\d\-T:.Z]+ \(\d+s ago\)/);
    started[1]!.settle();
    expect(textOf(await call('await', { tasks: [second], timeout_s: 5 }))).toMatch(/status: completed/);
  });

  it('shows a task queued in another process as queued with its wait and no place', async () => {
    const owner = await connectManual();
    await owner.call('delegate', { agent: 'helper', brief: 'one', wait: false });
    const second = owner.idIn(owner.textOf(await owner.call('delegate', { agent: 'other', brief: 'two', wait: false })));
    const { port } = manualPort();
    const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: owner.root }, roots: () => [], warn: () => {}, kernel: kernelWithPort(port) });
    const server = createSubzeroServer({ service, parentSessionId: () => undefined });
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const text = (r: any) => r.content.map((c: any) => c.text).join('\n') as string;
    const shown = text(await client.callTool({ name: 'tasks', arguments: { task: second } }, CallToolResultSchema));
    expect(shown).toMatch(/queued, not launched yet: .*model local\/qwen .*waiting \d+s/);
    expect(shown).not.toMatch(/place \d|this session's queue|running, started|still running|\bstarted\b/);
    expect(shown).toMatch(/another process/);
    const listing = text(await client.callTool({ name: 'tasks', arguments: {} }, CallToolResultSchema));
    expect(listing.split('\n').find((l) => l.startsWith(second))).toMatch(/queued, not launched yet/);
  });

  it('sends progress that says waiting while queued and stops saying it after release', async () => {
    const { call, textOf, idIn, started } = await connectManual();
    await call('delegate', { agent: 'helper', brief: 'one', wait: false });
    const messages: string[] = [];
    const pending = call('delegate', { agent: 'other', brief: 'two', wait: true }, { onprogress: (p) => messages.push(p.message ?? '') });
    await until(() => messages.some((m) => m.includes('waiting')));
    started[0]!.settle();
    await until(() => started.length === 2);
    await until(() => messages.some((m) => m.includes('running')));
    const mark = messages.length;
    await new Promise((r) => setTimeout(r, 500)); // heartbeats continue every 200 ms
    expect(messages.length).toBeGreaterThan(mark);
    expect(messages.slice(messages.findIndex((m) => m.includes('running'))).some((m) => m.includes('waiting'))).toBe(false);
    started[1]!.settle();
    expect(textOf(await pending)).toMatch(/status: completed/);
  });

  it('caps a listing of 60 tasks at 50, keeps every running task, and says 10 were left out', () => {
    const views: TaskView[] = Array.from({ length: 60 }, (_, i) => ({
      taskId: `sz-${String(i).padStart(6, 'a')}`,
      agent: 'helper',
      status: i % 20 === 0 ? 'running' : 'completed',
      ...(i % 20 === 0 ? { startedAt: new Date(2026, 0, 1, 0, i, 5).toISOString() } : {}),
      createdAt: new Date(2026, 0, 1, 0, i).toISOString(),
      enqueuedAt: new Date(2026, 0, 1, 0, i).toISOString(),
      updatedAt: '',
    }));
    const lines = formatListing(views, true).split('\n');
    const rows = lines.filter((l) => l.startsWith('sz-'));
    expect(rows.length).toBe(50);
    expect(rows.slice(0, 3).every((r) => r.includes('· running, started '))).toBe(true);
    expect(lines.at(-1)).toMatch(/^10 tasks were left out; any task can still be read by its task id/);
  });
});

describe('ClaudeMcpServer tiers, general, fallback and await bounds', () => {
  it('maps the delegate alias and tier phrase to the general agent on small', async () => {
    const { call, textOf, fake } = await connect({}, null, undefined, TIERED_YAML);
    const reply: any = await call('delegate', { agent: 'delegate', tier: 'cheapest capable', brief: 'go', wait: true });
    expect(reply.isError).not.toBe(true);
    expect(textOf(reply)).toMatch(/general:small.*status: completed/);
    const argv = fake.log()[0].argv;
    expect(argv[argv.indexOf('--model') + 1]).toBe('local/qwen');
  });

  it('passes an unmatched tier value back to Claude without creating a task', async () => {
    const { call, textOf, service } = await connect({}, null, undefined, TIERED_YAML);
    const reply: any = await call('delegate', { tier: 'other/model', brief: 'go', wait: true });
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toMatch(/other\/model.*Agent tool.*passback/s);
    expect(await service.list()).toEqual([]);
  });

  it('passes back a tier phrase whose tier is not configured', async () => {
    const yaml = TIERED_YAML.replace('    large: { host: pi, model: cloud/large, thinking: high }\n', '').replace('    tiers:\n      large: { model: cloud/reviewer-large }\n', '');
    const { call, textOf, service } = await connect({}, null, undefined, yaml);
    const reply: any = await call('delegate', { tier: 'session model', brief: 'go', wait: true });
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toMatch(/unknown tier "large".*Agent tool.*passback/s);
    expect(await service.list()).toEqual([]);
  });
  const taskIdOf = (text: string) => /sz-[a-z2-7]{6}/.exec(text)![0];

  it('delegate takes an optional agent and a tier, and requires only the brief', async () => {
    const { client } = await connect({}, null, undefined, TIERED_YAML);
    const delegate = (await client.listTools()).tools.find((t) => t.name === 'delegate')!;
    const schema = delegate.inputSchema as any;
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['agent', 'tier', 'brief']));
    expect(schema.required).toEqual(['brief']);
  });

  it('runs general on the tier model and records general:<tier>, for medium and tier:medium alike', async () => {
    const { call, textOf, fake } = await connect({}, null, undefined, TIERED_YAML);
    for (const tier of ['medium', 'tier:medium']) {
      const text = textOf(await call('delegate', { brief: 'go', tier, wait: true }));
      expect(text.split('\n')[0]).toMatch(/^task: sz-[a-z2-7]{6} · general:medium · status: completed/);
    }
    const launches = fake.log().filter((l) => l.argv);
    expect(launches.length).toBe(2);
    for (const l of launches) {
      expect(l.argv[l.argv.indexOf('--model') + 1]).toBe('r9700/Qwen3.8');
      expect(l.argv[l.argv.indexOf('--tools') + 1].split(',')).toEqual(expect.arrayContaining(['bash', 'write', 'edit']));
    }
  });

  it('covers AE11: no agent and no tier runs general on its default model and records general', async () => {
    const { call, textOf, fake } = await connect({}, null, undefined, TIERED_YAML);
    const text = textOf(await call('delegate', { brief: 'go', wait: true }));
    expect(text.split('\n')[0]).toMatch(/^task: sz-[a-z2-7]{6} · general · status: completed/);
    const argv = fake.log()[0].argv;
    expect(argv[argv.indexOf('--model') + 1]).toBe('r9700/Qwen3.8');
    const named = textOf(await call('delegate', { agent: 'general', brief: 'go', wait: true }));
    expect(named.split('\n')[0]).toMatch(/· general · status: completed/);
  });

  it('runs a named agent at a tier with its override, and as today without one', async () => {
    const { call, textOf, fake } = await connect({}, null, undefined, TIERED_YAML);
    const tiered = textOf(await call('delegate', { agent: 'reviewer', tier: 'large', brief: 'go', wait: true }));
    expect(tiered.split('\n')[0]).toMatch(/· reviewer:large · status: completed/);
    const plain = textOf(await call('delegate', { agent: 'reviewer', brief: 'go', wait: true }));
    expect(plain.split('\n')[0]).toMatch(/· reviewer · status: completed/);
    const models = fake.log().filter((l) => l.argv).map((l) => l.argv[l.argv.indexOf('--model') + 1]);
    expect(models).toEqual(['cloud/reviewer-large', 'r9700/Qwen3.8']);
  });

  it('returns an unknown tier as a tool error that lists the tiers and points to a pass-back, and launches nothing', async () => {
    const { call, textOf, fake, service } = await connect({}, null, undefined, TIERED_YAML);
    const result: any = await call('delegate', { brief: 'go', tier: 'huge', wait: true });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/unknown tier "huge"; configured tiers: default, medium, small, cloud, large, far/);
    expect(text).toMatch(/Agent tool/);
    expect(text).toMatch(/passback/);
    expect(fake.log()).toEqual([]);
    expect(await service.list()).toEqual([]);
  });

  it('returns a tier whose host has no driver as a tool error naming the host and the supported hosts, and launches nothing', async () => {
    const { call, textOf, fake, service } = await connect({}, null, undefined, TIERED_YAML);
    const result: any = await call('delegate', { agent: 'reviewer', brief: 'go', tier: 'far', wait: true });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/"claude".*supported hosts: pi/s);
    expect(text).toMatch(/configured tiers: /);
    expect(text).toMatch(/Agent tool/);
    expect(text).toMatch(/passback/);
    expect(fake.log()).toEqual([]);
    expect(await service.list()).toEqual([]);
  });

  it('covers AE10: an unknown name runs fallback with its tools and says it is not configured, waiting or not', async () => {
    const { call, textOf, fake, service } = await connect({}, null, undefined, TIERED_YAML);
    const waited = textOf(await call('delegate', { agent: 'reviewr', brief: 'go', wait: true }));
    expect(waited.split('\n')[0]).toMatch(/^task: sz-[a-z2-7]{6} · fallback · status: completed/);
    expect(waited).toMatch(/reviewr.*not configured/);
    const noWait = textOf(await call('delegate', { agent: 'reviewr', brief: 'go', wait: false }));
    expect(noWait).toMatch(/^task: sz-[a-z2-7]{6}/);
    expect(noWait).toMatch(/reviewr.*not configured/);
    const argv = fake.log()[0].argv;
    expect(argv[argv.indexOf('--tools') + 1]).toBe('read,grep');
    // Naming fallback itself gives no notice.
    const named = textOf(await call('delegate', { agent: 'fallback', brief: 'go', wait: true }));
    expect(named).toMatch(/· fallback · status: completed/);
    expect(named).not.toMatch(/not configured/);
    expect((await service.list()).map((v) => v.agent)).toEqual(['fallback', 'fallback', 'fallback']);
  });

  it('runs the built-in fallback and general when the file has neither, with the starter tools of the pi driver', async () => {
    const bare = await connect({}, null, undefined, makeProjectYamlWithoutGeneral().replace(/  fallback:\n    tools: \[read, grep\]\n    timeout: 8\n/, ''));
    const unknown = bare.textOf(await bare.call('delegate', { agent: 'reviewr', brief: 'go', wait: true }));
    expect(unknown.split('\n')[0]).toMatch(/^task: sz-[a-z2-7]{6} · fallback · status: completed/);
    expect(unknown).toMatch(/reviewr.*not configured/);
    const general = bare.textOf(await bare.call('delegate', { brief: 'go', wait: true }));
    expect(general.split('\n')[0]).toMatch(/· general · status: completed/);
    const tools = bare.fake.log().filter((l) => l.argv).map((l) => l.argv[l.argv.indexOf('--tools') + 1]);
    expect(tools).toEqual(['read,grep,find,ls', 'read,bash,edit,write,grep,find,ls']);
  });

  it('covers AE2: runs delegate on the global medium with only a global file, and lists its tiers', async () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const { root, call, textOf, fake, client } = await connect();
    rmSync(path.join(root, '.agents', 'subzero.yaml'));
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'delegate')!.description).toContain('medium → local/global-medium (host pi)');
    const reply = textOf(await call('delegate', { tier: 'medium', brief: 'go', wait: true }));
    expect(reply.split('\n')[0]).toMatch(/· general:medium · status: completed/);
    const argv = fake.log()[0].argv;
    expect(argv[argv.indexOf('--model') + 1]).toBe('local/global-medium');
  });

  it('covers AE4: passes back a delegation when the project says enabled false, naming enabled: false', async () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const { root, call, textOf, service, fake } = await connect();
    writeFileSync(path.join(root, '.agents', 'subzero.yaml'), 'enabled: false\n');
    for (const args of [{ brief: 'go' }, { brief: 'go', tier: 'medium' }]) {
      const result: any = await call('delegate', args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/enabled: false.*Agent tool.*passback/s);
    }
    expect(fake.log()).toEqual([]);
    expect(await service.list()).toEqual([]);
  });

  it('passes back a delegation when there is no project file and no global medium', async () => {
    const { root, call, textOf } = await connect();
    rmSync(path.join(root, '.agents', 'subzero.yaml'));
    const result: any = await call('delegate', { brief: 'go', tier: 'medium', wait: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/missing.*Agent tool.*passback/s);
  });

  it('keeps queued replies for tiered tasks: the second general:medium task is queued, never started', async () => {
    const { call, textOf, started } = await connectManual(TIERED_YAML.replace('  parallel:\n', '  parallel:\n    r9700/Qwen3.8: 1\n'));
    const first = textOf(await call('delegate', { brief: 'one', tier: 'medium', wait: false }));
    const second = textOf(await call('delegate', { brief: 'two', tier: 'tier:medium', wait: false }));
    expect(first).toMatch(/running, started/);
    expect(second).toContain("queued, not launched yet: no child is running; it starts when model r9700/Qwen3.8 has room (place 1 in this session's queue");
    expect(second).not.toMatch(/running, started|\bstarted\b/);
    const listing = textOf(await call('tasks', {}));
    expect(listing.split('\n').find((l) => l.includes(taskIdOf(second)))).toMatch(/general:medium · queued, not launched yet/);
    expect(started.length).toBe(1);
  });

  it('describes delegate from a fresh config read, listing each routable tier with its host and model', async () => {
    const { client, root } = await connect({}, null, undefined, TIERED_YAML);
    const description = async () => (await client.listTools()).tools.find((t) => t.name === 'delegate')!.description!;
    const first = await description();
    expect(first).toContain('medium → r9700/Qwen3.8');
    expect(first).toMatch(/large → cloud\/large/);
    expect(first).toMatch(/medium → r9700\/Qwen3.8 \(host pi\)/);
    // The tier whose host has no driver is not routable.
    expect(first).not.toMatch(/far →/);
    writeFileSync(
      path.join(root, '.agents', 'subzero.yaml'),
      TIERED_YAML.replace('medium: { host: pi, model: r9700/Qwen3.8, thinking: medium }', 'medium: { host: pi, model: gpu/Other-9, thinking: medium }'),
    );
    const second = await description();
    expect(second).toContain('medium → gpu/Other-9');
    expect(second).not.toContain('r9700/Qwen3.8');
  });

  it('lists the tools with the static description when the config is broken or the project is off, and with the tiers when only general is missing', async () => {
    const { client, root } = await connect({}, null, undefined, TIERED_YAML);
    const delegateText = async () => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['await', 'cancel', 'continue', 'delegate', 'tasks']);
      return tools.find((t) => t.name === 'delegate')!.description!;
    };
    writeFileSync(path.join(root, '.agents', 'subzero.yaml'), 'agents: [');
    const broken = await delegateText();
    expect(broken).toMatch(/Delegate a task to a subzero agent/);
    expect(broken).not.toMatch(/→/);
    writeFileSync(path.join(root, '.agents', 'subzero.yaml'), 'enabled: false\n');
    expect(await delegateText()).toBe(broken);
    useGlobalConfig('agents: [');
    writeFileSync(path.join(root, '.agents', 'subzero.yaml'), TIERED_YAML);
    expect(await delegateText()).toBe(broken);
    writeFileSync(path.join(root, '.agents', 'subzero.yaml'), 'enabled: false\n');
    expect(await delegateText()).toBe(broken);
    writeFileSync(path.join(root, '.agents', 'subzero.yaml'), makeProjectYamlWithoutGeneral());
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    expect(await delegateText()).toMatch(/medium → r9700\/Qwen3.8 \(host pi\)/);
  });

  it('returns a 20,000-character final message whole from delegate, tasks and await', async () => {
    const long = 'FINDING-'.repeat(2500);
    const { call, textOf } = await connect({ lastText: long }, null, undefined, TIERED_YAML);
    const waited = textOf(await call('delegate', { agent: 'free', brief: 'go', wait: true }));
    expect(waited).toContain(`summary:\n${long}\nusage:`);
    const id = taskIdOf(waited);
    expect(textOf(await call('tasks', { task: id }))).toContain(`summary:\n${long}\nusage:`);
    const later = taskIdOf(textOf(await call('delegate', { agent: 'free', brief: 'go', wait: false })));
    const awaited = textOf(await call('await', { tasks: [later], timeout_s: 20 }));
    expect(awaited).toContain(`summary:\n${long}\nusage:`);
    for (const reply of [waited, awaited]) expect(reply).not.toMatch(/\[cut|\[subzero|bounded/);
  });

  it('covers F1: await over six 9,000-character results returns the first five whole and defers the sixth', async () => {
    const long = 'FINDING-'.repeat(1125);
    const { call, textOf } = await connect({ lastText: long }, null, undefined, TIERED_YAML);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(taskIdOf(textOf(await call('delegate', { agent: 'free', brief: `go ${i}`, wait: false }))));
    const joined = textOf(await call('await', { tasks: ids, timeout_s: 20 }));
    expect(joined.length).toBeLessThanOrEqual(50_000);
    expect(joined).not.toMatch(/\[cut|\[subzero|bounded/);
    const sections = joined.split('\n\n');
    expect(sections.length).toBe(6);
    ids.forEach((id, i) => expect(sections[i]!.startsWith(`task: ${id}`), id).toBe(true));
    for (const section of sections.slice(0, 5)) expect(section).toContain(`status: completed\nsummary:\n${long}\nusage:`);
    expect(sections[5]).toBe(
      `task: ${ids[5]} · free · completed · result not shown here (reply size); read it whole with tasks(${ids[5]})`,
    );
  });

  it('returns a first await result whole even when alone it exceeds 50,000 characters, and defers the next', async () => {
    const long = 'FINDING-'.repeat(7000);
    const { call, textOf } = await connect({ lastText: long }, null, undefined, TIERED_YAML);
    const a = taskIdOf(textOf(await call('delegate', { agent: 'free', brief: 'a', wait: false })));
    const b = taskIdOf(textOf(await call('delegate', { agent: 'free', brief: 'b', wait: false })));
    const joined = textOf(await call('await', { tasks: [a, b], timeout_s: 20 }));
    expect(joined.startsWith(`task: ${a}`)).toBe(true);
    expect(joined).toContain(`summary:\n${long}\nusage:`);
    expect(joined.length).toBeGreaterThan(56_000);
    expect(joined.endsWith(`\n\ntask: ${b} · free · completed · result not shown here (reply size); read it whole with tasks(${b})`)).toBe(true);
  });

  it("tells the child the reply budget in the brief of the server's delegations", async () => {
    const { call, textOf, service } = await connect({}, null, undefined, TIERED_YAML);
    const id = taskIdOf(textOf(await call('delegate', { agent: 'free', brief: 'go', expected_output: 'A list.', wait: true })));
    expect(service.store.readTask(id)!.task!.brief).toBe(
      'go\n\n## Expected output\n\nA list.\n\n' +
        '## Reply size\n\nKeep your final reply under 48,000 characters. It is returned to the parent whole, never cut.',
    );
  });

  it('returns a short result whole in an await, with no pointer', async () => {
    const { call, textOf } = await connect({ lastText: 'short result' }, null, undefined, TIERED_YAML);
    const a = taskIdOf(textOf(await call('delegate', { agent: 'free', brief: 'a', wait: false })));
    const b = taskIdOf(textOf(await call('delegate', { agent: 'free', brief: 'b', wait: false })));
    const joined = textOf(await call('await', { tasks: [a, b], timeout_s: 20 }));
    expect(joined).not.toMatch(/tasks\(/);
    expect(joined.match(/short result/g)!.length).toBe(2);
  });
});

function makeProjectYamlWithoutGeneral(): string {
  return TIERED_YAML.replace(/  general:\n    tools: \[read, bash, write, edit\]\n    timeout: 9\n/, '');
}

describe('ClaudeMcpServer process', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: REPO });
  });

  it('reports the plugin version from package.json in its server info', async () => {
    const { version } = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { version: string };
    const server = spawn(process.execPath, [path.join(REPO, 'dist', 'server.js')], {
      cwd: tempDir(),
      env: { ...process.env, SUBZERO_PROJECT_DIR: makeProject(), SUBZERO_DATA: tempDir() },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    server.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
    await until(() => out.includes('\n'), 10_000);
    const exited = new Promise((r) => server.once('exit', r));
    server.stdin.end();
    await exited;
    const reply = JSON.parse(out.split('\n')[0]!) as { result: { serverInfo: { name: string; version: string } } };
    expect(reply.result.serverInfo).toEqual({ name: 'subzero', version });
  });

  it('leaves no process of a live child run behind when its stdin closes', async () => {
    const root = makeProject();
    const fake = fakePiEnv({ turn: [{ grandchild: true }, { hang: true }] });
    const server = spawn(process.execPath, [path.join(REPO, 'dist', 'server.js')], {
      cwd: tempDir(),
      env: { ...fake.env, SUBZERO_PROJECT_DIR: root, SUBZERO_PI: FAKE_PI, PI_CODING_AGENT_DIR: tempDir(), SUBZERO_DATA: tempDir() },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const send = (msg: object) => server.stdin.write(JSON.stringify(msg) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate', arguments: { agent: 'helper', brief: 'go' } } });
    await until(() => fake.log().some((l) => l.command === 'prompt'), 10_000);
    const pi = fake.log()[0].pid;
    const grandchild = fake.log().find((l) => l.grandchild)?.grandchild;
    const exited = new Promise((r) => server.once('exit', r));
    server.stdin.end();
    await exited;
    await until(() => !isAlive(pi) && (grandchild === undefined || !isAlive(grandchild)), 10_000);
  });
});

describe('ClaudeMcpServer continue, early end and wake markers by turn', () => {
  const SESSION = 'session-a';
  type Manual = Awaited<ReturnType<typeof connectManual>>;

  /** A task of this conversation that no server call made, so no wake marker exists for it yet. */
  async function directTask(h: Manual, brief = 'one', session = SESSION): Promise<string> {
    const reply = await h.service.delegate({ agent: 'free', briefText: brief, parentSessionId: session }, { wait: false });
    if (reply.kind === 'result') throw new Error('expected a live task');
    return reply.taskId;
  }
  /** Mark a call as made by the main conversation (or a subagent) and record that the user typed after `at`. */
  function userTyped(h: Manual, toolUseId: string, options: { call?: boolean; agentId?: string; at?: number } = {}) {
    if (options.call !== false) writeCallMarker(h.wakeDataDir!, h.service.projectRoot!, toolUseId, options.agentId);
    writePromptMarker(h.wakeDataDir!, h.service.projectRoot!, SESSION, options.at ?? Date.now() + 5);
  }
  const started = (h: Manual, key: string) => wakeStarted(h.wakeDataDir!, h.service.projectRoot!, SESSION, key);
  const done = (h: Manual, key: string) => wakeDone(h.wakeDataDir!, h.service.projectRoot!, SESSION, key);
  /** Settle a run and wait until its task has no running turn. */
  async function settled(h: Manual, index: number, taskId: string) {
    h.started[index]!.settle();
    await until(() => h.service.runningTurn(taskId) === undefined);
  }
  const awaitCall = (h: Manual, toolUseId: string, tasks: string[]) => {
    const state = { returned: false };
    const pending = h.callWithId(toolUseId, 'await', { tasks, timeout_s: 30 }).then((r) => { state.returned = true; return r; });
    return { state, pending };
  };

  it('covers R16: the server instructions tell the parent when to use continue', async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toMatch(/continue tool/);
    expect(client.getInstructions()).toMatch(/steers a running child/);
  });

  it('covers R16: continue on a task of another conversation answers not delivered and names that', async () => {
    const h = await connectManual(TIERED_YAML, SESSION, { steers: true, resume: true, wake: true });
    const id = await directTask(h, 'theirs', 'session-b');
    const text = h.textOf(await h.call('continue', { task: id, message: 'hello', wait: true }));
    expect(text).toMatch(new RegExp(`^task: ${id} · not delivered: .*belongs to another conversation`));
    expect(h.started[0]!.steers).toEqual([]);
    h.started[0]!.settle();
  });

  it('covers R16: continue from a conversation that could not be identified answers not delivered and says so', async () => {
    const h = await connectManual(TIERED_YAML, undefined, { steers: true, resume: true, wake: true });
    const id = await directTask(h);
    const text = h.textOf(await h.call('continue', { task: id, message: 'hello', wait: true }));
    expect(text).toMatch(new RegExp(`^task: ${id} · not delivered: this conversation could not be identified`));
    h.started[0]!.settle();
  });

  it('covers R16: continue with wait false on a settled task replies new turn, and the wake marker of turn 2 later names turn 2 and its collected marker', async () => {
    const h = await connectManual(TIERED_YAML, SESSION, { steers: true, resume: true, wake: true });
    const id = h.idIn(h.textOf(await h.call('delegate', { agent: 'free', brief: 'first', wait: false })));
    await settled(h, 0, id);
    const text = h.textOf(await h.call('continue', { task: id, message: 'go on', wait: false }));
    expect(text).toMatch(new RegExp(`^task: ${id} · new turn: turn 2 started from your message`));
    expect(h.started).toHaveLength(2);
    expect(started(h, `${id}#2`)).toBe(true);
    expect(done(h, `${id}#2`)).toBeUndefined();
    h.started[1]!.settle({ lastAssistantText: 'second answer' });
    await until(() => done(h, `${id}#2`) !== undefined);
    const marker = done(h, `${id}#2`)!;
    expect(marker.notice).toMatch(/turn 2/);
    expect(marker.notice).toContain('second answer');
    expect(marker.collectedMarker).toBe(h.service.collectedMarkerPath(id, 2));
    expect(marker.collectedMarker).toMatch(/turns[\\/]2\.collected$/);
  });

  it('runs delegate and continue in the background when they set no wait: each returns at once and the new turn arms its wake marker', async () => {
    const h = await connectManual(TIERED_YAML, SESSION, { steers: true, resume: true, wake: true });
    const started = h.textOf(await h.call('delegate', { agent: 'free', brief: 'first' }));
    expect(started).toMatch(/^task: sz-[a-z2-7]{6} · running/);
    const id = h.idIn(started);
    await settled(h, 0, id);
    const reply = h.textOf(await h.call('continue', { task: id, message: 'go on' }));
    expect(reply).toMatch(new RegExp(`^task: ${id} · new turn: turn 2`));
    expect(h.started).toHaveLength(2);
    expect(h.started[1]!.cancelled).toBe(false);
    h.started[1]!.settle();
  });

  it('covers R16: a continue with wait true waits for the new turn and returns its result naming turn 2', async () => {
    const h = await connectManual(TIERED_YAML, SESSION, { steers: true, resume: true, wake: true });
    const id = h.idIn(h.textOf(await h.call('delegate', { agent: 'free', brief: 'first', wait: false })));
    await settled(h, 0, id);
    let returned = false;
    const pending = h.call('continue', { task: id, message: 'go on', wait: true }).then((r) => { returned = true; return r; });
    await until(() => h.started.length === 2);
    await sleep(60);
    expect(returned).toBe(false);
    h.started[1]!.settle({ lastAssistantText: 'the second answer' });
    const text = h.textOf(await pending);
    expect(text).toMatch(new RegExp(`^task: ${id} · new turn: turn 2 started`));
    expect(text).toMatch(/task: sz-[a-z2-7]{6} · turn 2 · .* · status: completed/);
    expect(text).toContain('the second answer');
  });

  it('covers R16: a waited continue sends progress notifications naming the task agent, as a waited delegate does', async () => {
    const h = await connectManual(TIERED_YAML, SESSION, { steers: true, resume: true, wake: true });
    const id = h.idIn(h.textOf(await h.call('delegate', { agent: 'free', brief: 'first', wait: false })));
    await settled(h, 0, id);
    const messages: string[] = [];
    const pending = h.call('continue', { task: id, message: 'go on', wait: true }, { onprogress: (p) => messages.push(p.message ?? '') });
    await until(() => h.started.length === 2);
    await until(() => messages.length > 0);
    expect(messages[0]).toMatch(/free/);
    const mark = messages.length;
    await sleep(500); // the heartbeat repeats the latest line every 200 ms
    expect(messages.length).toBeGreaterThan(mark);
    h.started[1]!.settle({ lastAssistantText: 'the second answer' });
    expect(h.textOf(await pending)).toContain('the second answer');
  });

  it('covers R14: a waited await over two running tasks returns their status lines when the user types, leaves both running and arms a wake marker for each', async () => {
    const h = await connectManual(TIERED_YAML, SESSION, { wake: true });
    const one = await directTask(h, 'one');
    const two = await directTask(h, 'two');
    expect(started(h, one) || started(h, two)).toBe(false);
    const { state, pending } = awaitCall(h, 'toolu_typed', [one, two]);
    await sleep(60);
    expect(state.returned).toBe(false);
    userTyped(h, 'toolu_typed');
    const text = h.textOf(await pending);
    expect(text).toMatch(new RegExp(`task: ${one} · running, started`));
    expect(text).toMatch(new RegExp(`task: ${two} · running, started`));
    expect(text).toMatch(/the user sent a message/);
    expect(h.service.runningTurn(one)).toBe(1);
    expect(h.service.runningTurn(two)).toBe(1);
    expect(started(h, one)).toBe(true);
    expect(started(h, two)).toBe(true);
    h.started[0]!.settle({ lastAssistantText: 'result one' });
    h.started[1]!.settle({ lastAssistantText: 'result two' });
    await until(() => done(h, one) !== undefined && done(h, two) !== undefined);
    expect(done(h, one)!.notice).toContain('result one');
    expect(done(h, two)!.notice).toContain('result two');
  });

  it('covers R15: the same await keeps waiting when the call marker carries an agent id', async () => {
    const h = await connectManual(TIERED_YAML, SESSION, { wake: true });
    const one = await directTask(h, 'one');
    const two = await directTask(h, 'two');
    const { state, pending } = awaitCall(h, 'toolu_sub', [one, two]);
    userTyped(h, 'toolu_sub', { agentId: 'agent-7' });
    await sleep(500);
    expect(state.returned).toBe(false);
    expect(started(h, one) || started(h, two)).toBe(false);
    h.started[0]!.settle({ lastAssistantText: 'result one' });
    h.started[1]!.settle({ lastAssistantText: 'result two' });
    const text = h.textOf(await pending);
    expect(text).toContain('result one');
    expect(text).toContain('result two');
    expect(text).not.toMatch(/the user sent a message/);
  });

  it('keeps a waited call waiting when the prompt marker changes and no call marker is found', async () => {
    const h = await connectManual(TIERED_YAML, SESSION, { wake: true });
    const one = await directTask(h, 'one');
    const { state, pending } = awaitCall(h, 'toolu_unmarked', [one]);
    userTyped(h, 'toolu_unmarked', { call: false });
    await sleep(500);
    expect(state.returned).toBe(false);
    expect(started(h, one)).toBe(false);
    h.started[0]!.settle({ lastAssistantText: 'late result' });
    expect(h.textOf(await pending)).toContain('late result');
  });

  it('does not end a wait for a prompt marker older than the call start', async () => {
    const h = await connectManual(TIERED_YAML, SESSION, { wake: true });
    const one = await directTask(h, 'one');
    const { state, pending } = awaitCall(h, 'toolu_old', [one]);
    userTyped(h, 'toolu_old', { at: Date.now() - 10_000 });
    await sleep(500);
    expect(state.returned).toBe(false);
    expect(started(h, one)).toBe(false);
    h.started[0]!.settle({ lastAssistantText: 'late result' });
    expect(h.textOf(await pending)).toContain('late result');
  });

  it('covers R14: an await ended early over a settled and a running task returns the settled result whole, then the status line', async () => {
    const h = await connectManual(TIERED_YAML, SESSION, { wake: true });
    const finished = await directTask(h, 'finished');
    const running = await directTask(h, 'running');
    h.started[0]!.settle({ lastAssistantText: 'the finished answer' });
    await until(() => h.service.runningTurn(finished) === undefined);
    const { pending } = awaitCall(h, 'toolu_mixed', [finished, running]);
    await sleep(60);
    userTyped(h, 'toolu_mixed');
    const text = h.textOf(await pending);
    const resultAt = text.indexOf(`task: ${finished}`);
    const statusAt = text.indexOf(`task: ${running} · running, started`);
    expect(resultAt).toBeGreaterThanOrEqual(0);
    expect(text).toMatch(new RegExp(`task: ${finished} .*status: completed`));
    expect(text).toContain('the finished answer');
    expect(statusAt).toBeGreaterThan(resultAt);
    expect(started(h, running)).toBe(true);
    expect(started(h, finished)).toBe(false);
    h.started[1]!.settle();
  });

  it('collecting turn 1 clears turn 1\'s wake marker and leaves the marker of turn 2', async () => {
    const h = await connectManual(TIERED_YAML, SESSION, { steers: true, resume: true, wake: true });
    const id = h.idIn(h.textOf(await h.call('delegate', { agent: 'free', brief: 'first', wait: false })));
    await settled(h, 0, id);
    await until(() => done(h, id) !== undefined);
    await h.call('continue', { task: id, message: 'go on', wait: false });
    expect(started(h, `${id}#2`)).toBe(true);
    const text = h.textOf(await h.call('tasks', { task: id }));
    expect(text).toMatch(new RegExp(`^task: ${id} · free · status: completed`));
    expect(text).toMatch(new RegExp(`task: ${id} · free · running, started`));
    expect(started(h, id)).toBe(false);
    expect(started(h, `${id}#2`)).toBe(true);
    h.started[1]!.settle({ lastAssistantText: 'second answer' });
    await until(() => done(h, `${id}#2`) !== undefined);
    expect(done(h, `${id}#2`)!.notice).toMatch(/turn 2/);
  });

  it('does not return again a turn whose result the wake hook already delivered', async () => {
    const h = await connectManual(TIERED_YAML, SESSION, { wake: true });
    const id = await directTask(h);
    await settled(h, 0, id);
    // What the wake hook does when it claims the turn's result.
    writeFileSync(h.service.collectedMarkerPath(id, 1)!, '');
    const text = h.textOf(await h.call('await', { tasks: [id], timeout_s: 1 }));
    expect(text).toMatch(new RegExp(`^task: ${id} · turn 1 already reached you`));
    expect(text).not.toMatch(/status: completed\nsummary/);
  });

  it('covers R14: a waited delegate ended early returns the task id with its status line and the typed note, and the wake marker of turn 1 wakes with the result', async () => {
    const h = await connectManual(TIERED_YAML, SESSION, { wake: true });
    let returned = false;
    const pending = h.callWithId('toolu_delegate', 'delegate', { agent: 'free', brief: 'long job', wait: true }).then((r) => { returned = true; return r; });
    await until(() => h.started.length === 1);
    await sleep(60);
    expect(returned).toBe(false);
    userTyped(h, 'toolu_delegate');
    const text = h.textOf(await pending);
    const id = h.idIn(text);
    expect(text).toMatch(new RegExp(`^task: ${id} · running, started`));
    expect(text).toMatch(/the user sent a message/);
    expect(text).toMatch(/the child keeps running/);
    expect(h.service.runningTurn(id)).toBe(1);
    expect(h.started[0]!.cancelled).toBe(false);
    expect(started(h, id)).toBe(true);
    expect(done(h, id)).toBeUndefined();
    h.started[0]!.settle({ lastAssistantText: 'long job done' });
    await until(() => done(h, id) !== undefined);
    expect(done(h, id)!.notice).toContain('long job done');
    expect(done(h, id)!.collectedMarker).toMatch(/turns[\\/]1\.collected$/);
  });

  it('covers R14: a waited continue that opens a new turn is ended early the same way and arms the wake marker for that turn', async () => {
    const h = await connectManual(TIERED_YAML, SESSION, { steers: true, resume: true, wake: true });
    const id = h.idIn(h.textOf(await h.call('delegate', { agent: 'free', brief: 'first', wait: false })));
    await settled(h, 0, id);
    let returned = false;
    const pending = h.callWithId('toolu_continue', 'continue', { task: id, message: 'go on', wait: true }).then((r) => { returned = true; return r; });
    await until(() => h.started.length === 2);
    await sleep(60);
    expect(returned).toBe(false);
    userTyped(h, 'toolu_continue');
    const text = h.textOf(await pending);
    expect(text).toMatch(new RegExp(`^task: ${id} · new turn: turn 2 started`));
    expect(text).toMatch(/running, started/);
    expect(text).toMatch(/the user sent a message/);
    expect(h.service.runningTurn(id)).toBe(2);
    expect(started(h, `${id}#2`)).toBe(true);
    h.started[1]!.settle({ lastAssistantText: 'second answer' });
    await until(() => done(h, `${id}#2`) !== undefined);
    expect(done(h, `${id}#2`)!.notice).toMatch(/turn 2/);
    expect(done(h, `${id}#2`)!.notice).toContain('second answer');
  });
});
