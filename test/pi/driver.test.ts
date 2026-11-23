import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgent, type AgentDefinition } from '../../src/config/agent-config.js';
import { SessionMissingError, type ChildOutcome, type DomainEvent } from '../../src/core/types.js';
import { PiDriver, type PiDriverOptions } from '../../src/pi/driver.js';
import { childRpcArgs } from '../../src/pi/launch.js';
import type { ChildRunRequest } from '../../src/core/types.js';
import { DEFAULT_YAML, FAKE_PI_COMMAND, fakePiEnv, isAlive, makeProject, tempDir, until } from '../helpers.js';

/** What TaskCore hands the child port on each start. */
function request(root: string, agent: AgentDefinition, brief: string, taskId = 'sz-abcdef', sessions = 'sessions'): ChildRunRequest {
  return {
    taskId,
    agent,
    brief,
    projectRoot: root,
    sessionsFolder: path.join(root, '.agents', 'subzero', sessions),
    driverFilesFolder: path.join(root, '.agents', 'subzero', 'tasks', taskId),
  };
}

function setup(scenario: Record<string, unknown> = {}, agentName = 'helper', patch: Partial<AgentDefinition> = {}) {
  const root = makeProject();
  const fake = fakePiEnv(scenario);
  const logs: string[] = [];
  const driver = new PiDriver({
    piCommand: FAKE_PI_COMMAND,
    env: fake.env,
    piAgentDir: tempDir(),
    abortWaitMs: 300,
    killWaitMs: 300,
    log: (m) => logs.push(m),
  });
  const agent = { ...getAgent(root, agentName), ...patch };
  const events: DomainEvent[] = [];
  const start = (brief = 'the brief') => driver.start(request(root, agent, brief), (e) => events.push(e));
  return { root, fake, driver, agent, events, logs, start };
}

/** Extension files that exist, since the driver refuses to start pi for one that does not. */
function extensionFiles(...names: string[]): string[] {
  const dir = tempDir();
  return names.map((name) => {
    const file = path.join(dir, name);
    writeFileSync(file, 'export default function () {}\n');
    return file;
  });
}

const commandsSent = (log: any[]) => log.filter((l) => l.command).map((l) => l.command);

describe('PiDriver', () => {
  it('verifies exactly the declared skills, sends the brief and settles with the last assistant text', async () => {
    const { start, events, fake, root } = setup();
    const outcome = await start().outcome;
    expect(outcome).toMatchObject({ status: 'completed', lastAssistantText: 'Done: wrote the answer.' });
    expect(outcome.usage.totalTokens).toBe(1500);
    expect(commandsSent(fake.log())).toEqual(['get_state', 'get_commands', 'prompt', 'get_last_assistant_text', 'get_session_stats']);
    expect(fake.log().find((l) => l.command === 'prompt').message).toBe('the brief');
    expect(events.map((e) => e.kind)).toEqual(['run_started', 'skills_verified', 'prompt_sent', 'agent_message', 'turn_settled', 'run_exited']);
    const spec = (events[0] as Extract<DomainEvent, { kind: 'run_started' }>).launchSpec;
    expect(spec.cwd).toBe(root);
    expect(spec.envNames).toEqual(['PI_OFFLINE', 'PI_TELEMETRY']);
    expect(spec.thinkingLevel).toBe('high');
    expect(spec.version).toBe('0.87.0');
    expect(spec.skillFolders).toEqual([
      path.join(root, '.agents', 'subzero', 'tasks', 'sz-abcdef', 'skills', 'alpha'),
      path.join(root, '.agents', 'subzero', 'tasks', 'sz-abcdef', 'skills', 'beta'),
    ]);
    expect(JSON.stringify(spec)).not.toContain('the brief');
    const argv = fake.log()[0];
    expect(argv.env).toEqual({ PI_OFFLINE: '1', PI_TELEMETRY: '0' });
  });

  it('starts the child with the requested extensions after the isolation flags and records them in the launch spec', async () => {
    const { driver, agent, root, events, fake } = setup();
    const [one] = extensionFiles('one.ts');
    await driver.start({ ...request(root, agent, 'the brief'), childHostOptions: { extensions: [one] } }, (e) => events.push(e)).outcome;
    const argv: string[] = fake.log()[0].argv;
    expect(argv.slice(0, childRpcArgs().length + 2)).toEqual([...childRpcArgs(), '-e', one]);
    const spec = (events[0] as Extract<DomainEvent, { kind: 'run_started' }>).launchSpec;
    expect(spec.command.slice(FAKE_PI_COMMAND.length)).toEqual(argv);
    expect(spec.command).toContain(one);
  });

  it('fails the run without starting pi when an extension names no file, naming the path', async () => {
    const { driver, agent, root, fake } = setup();
    const gone = path.join(tempDir(), 'gone.ts');
    const outcome = await driver.start({ ...request(root, agent, 'the brief'), childHostOptions: { extensions: [gone] } }, () => {}).outcome;
    expect(outcome).toMatchObject({ status: 'failed', failureKind: 'error' });
    expect(JSON.stringify(outcome)).toContain(gone);
    expect(fake.log()).toEqual([]);
  });

  it('adds no -e when the request names no extensions', async () => {
    const { start, events, fake } = setup();
    await start().outcome;
    expect(fake.log()[0].argv).not.toContain('-e');
    expect((events[0] as Extract<DomainEvent, { kind: 'run_started' }>).launchSpec.command).not.toContain('-e');
  });

  const exits = (events: DomainEvent[]) => events.filter((e) => e.kind === 'run_exited');

  it('emits run_exited exactly once, after turn_settled, on a settled run', async () => {
    const { start, events } = setup();
    await start().outcome;
    expect(exits(events)).toHaveLength(1);
    expect(events.at(-1)!.kind).toBe('run_exited');
  });

  it('emits run_exited exactly once when the skills do not match', async () => {
    const { start, events } = setup({ extraSkills: ['brave-search'] });
    await start().outcome;
    expect(exits(events)).toHaveLength(1);
    expect(events.at(-1)!.kind).toBe('run_exited');
  });

  it('emits run_exited exactly once when pi refuses the prompt', async () => {
    const { start, events } = setup({ refusePrompt: true });
    await start().outcome;
    expect(exits(events)).toHaveLength(1);
    expect(events.at(-1)!.kind).toBe('run_exited');
  });

  it('emits run_exited exactly once on a crash and on a timeout', async () => {
    const crash = setup({ turn: [{ exit: 3 }] });
    await crash.start().outcome;
    expect(exits(crash.events)).toHaveLength(1);
    const timedOut = setup({ turn: [{ hang: true }], ignoreAbort: true, ignoreStdinEnd: true }, 'helper', { timeout: 0.6 });
    await timedOut.start().outcome;
    expect(exits(timedOut.events)).toHaveLength(1);
  });

  it('buffers message deltas into one agent message', async () => {
    const { start, events } = setup();
    await start().outcome;
    expect(events.filter((e) => e.kind === 'agent_message')).toEqual([{ kind: 'agent_message', text: 'Done: wrote the answer.' }]);
  });

  it('fails as skill_mismatch naming an extra skill, sends no prompt and kills the process', async () => {
    const { start, fake } = setup({ extraSkills: ['brave-search'] });
    const outcome = await start().outcome;
    expect(outcome).toMatchObject({ status: 'failed', failureKind: 'skill_mismatch' });
    expect(outcome.message).toMatch(/extra skill brave-search/);
    expect(commandsSent(fake.log())).not.toContain('prompt');
    expect(isAlive(fake.log()[0].pid)).toBe(false);
  });

  it('fails as skill_mismatch naming a skill pi did not load', async () => {
    const { start } = setup({ dropSkills: ['beta'] });
    expect((await start().outcome).message).toMatch(/missing skill beta/);
  });

  it('fails as skill_mismatch before spawn when a skill folder is missing', async () => {
    const { start, fake, root, events } = setup();
    rmSync(path.join(root, '.agents', 'skills', 'beta'), { recursive: true });
    const outcome = await start().outcome;
    expect(outcome).toMatchObject({ status: 'failed', failureKind: 'skill_mismatch' });
    expect(outcome.message).toMatch(/missing skill folder: beta/);
    expect(fake.log()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('settles only at agent_settled, not at agent_end', async () => {
    const turn = [
      { emit: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }], stopReason: 'stop' } } },
      { emit: { type: 'agent_end', messages: [], willRetry: true } },
      { sleep: 100 },
      { emit: { type: 'auto_retry_start', attempt: 1 } },
      { emit: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }], stopReason: 'length' } } },
      { emit: { type: 'agent_end', messages: [], willRetry: false } },
      { emit: { type: 'agent_settled' } },
    ];
    const { start, events } = setup({ turn, lastText: 'second' });
    const outcome = await start().outcome;
    expect(outcome).toMatchObject({ status: 'truncated', lastAssistantText: 'second' });
    expect(events.map((e) => e.kind)).toContain('retrying');
  });

  it('maps the stop reasons error and aborted', async () => {
    const errorTurn = [
      { emit: { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'rate limited' } } },
      { emit: { type: 'agent_settled' } },
    ];
    expect(await setup({ turn: errorTurn }).start().outcome).toMatchObject({ status: 'failed', failureKind: 'error', message: 'rate limited' });
    const abortedTurn = [
      { emit: { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted' } } },
      { emit: { type: 'agent_settled' } },
    ];
    const aborted = await setup({ turn: abortedTurn }).start().outcome;
    expect(aborted.status).toBe('cancelled');
    expect(aborted.failureKind).toBeUndefined();
  });

  it('fails with error "no assistant message" when the run settles without one', async () => {
    const outcome = await setup({ turn: [{ emit: { type: 'agent_settled' } }] }).start().outcome;
    expect(outcome).toMatchObject({ status: 'failed', failureKind: 'error', message: 'no assistant message' });
  });

  it('ends as timeout and leaves no process of the group, including a grandchild', async () => {
    const { start, fake } = setup({ turn: [{ grandchild: true }, { hang: true }], ignoreAbort: true, ignoreStdinEnd: true }, 'helper', { timeout: 0.6 });
    const outcome = await start().outcome;
    expect(outcome).toMatchObject({ status: 'failed', failureKind: 'timeout' });
    const log = fake.log();
    expect(commandsSent(log)).toEqual(expect.arrayContaining(['clear_queue', 'abort']));
    const pi = log[0].pid;
    const grandchild = log.find((l) => l.grandchild).grandchild;
    await until(() => !isAlive(pi) && !isAlive(grandchild));
  });

  it('ends as crashed with the stderr tail when pi exits non-zero mid-turn', async () => {
    const { start, events } = setup({ turn: [{ exit: 3, stderr: 'segfault in model loader\n' }] });
    const outcome = await start().outcome;
    expect(outcome).toMatchObject({ status: 'failed', failureKind: 'crashed' });
    expect(events).toContainEqual({ kind: 'stderr_tail', text: 'segfault in model loader' });
  });

  it('ends as error naming the model when pi does not know it', async () => {
    const { start } = setup({ exitBeforeReady: { code: 1, stderr: 'Model "local/qwen" not found\n' } });
    expect(await start().outcome).toMatchObject({ status: 'failed', failureKind: 'error', message: 'unknown model: local/qwen' });
  });

  it('cancels a live turn with clear_queue then abort, and the status comes from the cancel', async () => {
    const { start, fake } = setup({ turn: [{ hang: true }] });
    const run = start();
    await until(() => commandsSent(fake.log()).includes('prompt'));
    run.cancel();
    const outcome = await run.outcome;
    expect(outcome.status).toBe('cancelled');
    expect(outcome.failureKind).toBeUndefined();
    const sent = commandsSent(fake.log());
    expect(sent.indexOf('clear_queue')).toBeLessThan(sent.indexOf('abort'));
    await until(() => !isAlive(fake.log()[0].pid));
  });

  it('kills the group when pi ignores abort, stdin EOF and SIGTERM', async () => {
    const { start, fake } = setup({ turn: [{ hang: true }], ignoreAbort: true, ignoreStdinEnd: true, ignoreSigterm: true });
    const run = start();
    await until(() => commandsSent(fake.log()).includes('prompt'));
    run.cancel();
    expect((await run.outcome).status).toBe('cancelled');
    await until(() => !isAlive(fake.log()[0].pid));
  });

  it('lets the first termination win and ignores a cancel after settlement', async () => {
    const { start } = setup();
    const run = start();
    const outcome: ChildOutcome = await run.outcome;
    run.cancel();
    expect(outcome.status).toBe('completed');
  });

  it('logs and ignores an unrecognized pi event, and carries the tool and its path', async () => {
    const turn = [
      { emit: { type: 'brand_new_event', x: 1 } },
      { emit: { type: 'entry_appended', entry: {} } },
      { emit: { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'write', args: { path: 'run/answer.json', content: 'SECRET' } } },
      { emit: { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'write', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false } },
      { emit: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } } },
      { emit: { type: 'agent_settled' } },
    ];
    const { start, logs, events } = setup({ turn });
    expect((await start().outcome).status).toBe('completed');
    expect(logs.some((l) => l.includes('brand_new_event'))).toBe(true);
    expect(logs.some((l) => l.includes('entry_appended'))).toBe(false);
    expect(events).toContainEqual({ kind: 'tool_activity', phase: 'start', tool: 'write', path: 'run/answer.json' });
    // pi sends no args on the end event; the path is carried over from the start.
    expect(events).toContainEqual({ kind: 'tool_activity', phase: 'end', tool: 'write', path: 'run/answer.json', isError: false });
    expect(JSON.stringify(events)).not.toContain('SECRET');
  });

  it('records a warning and still starts when SYSTEM.md exists', async () => {
    const agentDir = tempDir();
    writeFileSync(path.join(agentDir, 'SYSTEM.md'), 'be someone else');
    const root = makeProject();
    const fake = fakePiEnv();
    const driver = new PiDriver({ piCommand: FAKE_PI_COMMAND, env: fake.env, piAgentDir: agentDir });
    const events: DomainEvent[] = [];
    const outcome = await driver.start(request(root, getAgent(root, 'helper'), 'b', 'sz-abcdef', 's'), (e) => events.push(e)).outcome;
    expect(events[0]).toMatchObject({ kind: 'warning' });
    expect(outcome.status).toBe('completed');
  });

  it('decodes a message with U+2028 and a split multi-byte character from pi', async () => {
    const message = { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'a b ✓' }], stopReason: 'stop' } };
    const raw = JSON.stringify(message) + '\n';
    const splitAt = Buffer.from(raw).indexOf(0xe2) + 1;
    const { start, events } = setup({ turn: [{ raw, splitAt }, { emit: { type: 'agent_settled' } }], lastText: 'a b ✓' });
    expect((await start().outcome).lastAssistantText).toBe('a b ✓');
    expect(events).toContainEqual({ kind: 'agent_message', text: 'a b ✓' });
  });

  it('compares by the frontmatter name pi uses, not the skills-map key', async () => {
    const yaml = DEFAULT_YAML.replace('alpha: ./skills/alpha', 'web: ./skills/alpha').replace('skills: [alpha, beta]', 'skills: [web, beta]').replace('skills: [alpha]', 'skills: [web]');
    const root = makeProject(yaml);
    const fake = fakePiEnv();
    const driver = new PiDriver({ piCommand: FAKE_PI_COMMAND, env: fake.env, piAgentDir: tempDir() });
    const outcome = await driver.start(request(root, getAgent(root, 'helper'), 'b', 'sz-abcdef', 's'), () => {}).outcome;
    expect(outcome.status).toBe('completed');
  });

  it('kills the detached shells of pi on timeout, as pi bash spawns them', async () => {
    const { start, fake } = setup(
      { turn: [{ grandchild: 'detached' }, { hang: true }], ignoreAbort: true, ignoreStdinEnd: true, ignoreSigterm: true },
      'helper',
      { timeout: 0.6 },
    );
    expect((await start().outcome).failureKind).toBe('timeout');
    const grandchild = fake.log().find((l) => l.grandchild).grandchild;
    await until(() => !isAlive(grandchild) && !isAlive(fake.log()[0].pid));
  });

  it('stops the detached shells of pi on cancel when pi itself exits on stdin EOF', async () => {
    const { start, fake } = setup({ turn: [{ grandchild: 'detached' }, { hang: true }], ignoreAbort: true });
    const run = start();
    await until(() => fake.log().some((l) => l.grandchild));
    run.cancel();
    expect((await run.outcome).status).toBe('cancelled');
    const grandchild = fake.log().find((l) => l.grandchild).grandchild;
    await until(() => !isAlive(grandchild) && !isAlive(fake.log()[0].pid));
  });

  it('reports a lost pipe as crashed even when pi then exits cleanly', async () => {
    const outcome = await setup({ turn: [{ closeStdout: true }, { hang: true }] }).start().outcome;
    expect(outcome).toMatchObject({ status: 'failed', failureKind: 'crashed', message: 'lost the pipe to pi' });
  });

  it('fails as skill_mismatch when two declared folders share one frontmatter name', async () => {
    const root = makeProject();
    writeFileSync(path.join(root, '.agents', 'skills', 'beta', 'SKILL.md'), '---\nname: alpha\n---\nB.\n');
    const fake = fakePiEnv({ dropSkills: ['beta'] });
    const driver = new PiDriver({ piCommand: FAKE_PI_COMMAND, env: fake.env, piAgentDir: tempDir() });
    const outcome = await driver.start(request(root, getAgent(root, 'helper'), 'b', 'sz-abcdef', 's'), () => {}).outcome;
    expect(outcome).toMatchObject({ status: 'failed', failureKind: 'skill_mismatch' });
  });

  it('does not hang when pi closes its stdout but keeps running', async () => {
    const { start, fake } = setup({ turn: [{ closeStdout: true }, { hang: true }], ignoreStdinEnd: true });
    const outcome = await start().outcome;
    expect(outcome).toMatchObject({ status: 'failed', failureKind: 'crashed' });
    await until(() => !isAlive(fake.log()[0].pid));
  });

  it('fails with error "no assistant message" when pi exits cleanly before settling with none', async () => {
    expect(await setup({ turn: [{ exit: 0 }] }).start().outcome).toMatchObject({ status: 'failed', failureKind: 'error', message: 'no assistant message' });
  });

  it('names the model when pi started on an unknown id and the run errors', async () => {
    const turn = [
      { emit: { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '404 model' } } },
      { emit: { type: 'agent_settled' } },
    ];
    const outcome = await setup({ turn, stderrAtStart: 'Warning: Model "qwen" not found for provider "local". Using custom model id.\n' }).start().outcome;
    expect(outcome.message).toBe('unknown model: local/qwen: 404 model');
  });

  it('keeps the skill overlay after the run', async () => {
    const { start, root } = setup();
    await start().outcome;
    const overlay = path.join(root, '.agents', 'subzero', 'tasks', 'sz-abcdef', 'skills', 'alpha', 'SKILL.md');
    expect(existsSync(overlay)).toBe(true);
  });

  it('takes its folders from the child port: the sessions folder, the overlay in the driver-files folder and the cwd', async () => {
    const { start, events, root } = setup();
    await start().outcome;
    const spec = (events.find((e) => e.kind === 'run_started') as any).launchSpec;
    expect(spec.cwd).toBe(root);
    expect(spec.command.join(' ')).toContain(`--session-dir ${path.join(root, '.agents', 'subzero', 'sessions')}`);
    expect(spec.skillFolders.every((f: string) => f.startsWith(path.join(root, '.agents', 'subzero', 'tasks', 'sz-abcdef', 'skills')))).toBe(true);
  });

  it('offers its child port, attach command, session export and starter tools as the child driver', () => {
    const driver = new PiDriver({ piCommand: FAKE_PI_COMMAND });
    expect(driver.starterTools()).toEqual({
      general: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
      fallback: ['read', 'grep', 'find', 'ls'],
    });
    expect(typeof driver.port.start).toBe('function');
    expect(typeof driver.port.resume).toBe('function');
    expect(driver.port.steers).toBe(true);
    expect(driver.attachCommand({ command: ['pi', '--mode', 'rpc', '--session-id', 'sz-abcdef'], cwd: '/p', envNames: [], version: '1', skillFolders: [], thinkingLevel: 'low' })).toEqual(['pi', '--session-id', 'sz-abcdef']);
    expect(typeof driver.sessionExport).toBe('function');
  });

  describe('steering, resume and per-turn usage', () => {
    const settle = [{ emit: { type: 'turn_end', message: {}, toolResults: [] } }, { emit: { type: 'agent_end', messages: [], willRetry: false } }, { emit: { type: 'agent_settled' } }];
    const promptSent = (fake: { log(): any[] }) => commandsSent(fake.log()).includes('prompt');
    const steersSent = (fake: { log(): any[] }) => fake.log().filter((l) => l.command === 'steer').map((l) => l.message);
    const usageOf = (stats: { input: number; output: number; total: number }, cost: number, context: number) => ({
      tokens: { input: stats.input, output: stats.output, cacheRead: 0, cacheWrite: 0, total: stats.total },
      cost,
      contextUsage: { tokens: context, contextWindow: 131072, percent: 1 },
    });

    it('answers delivered to a steer during an awaitSteer step, echoes it in the final text and settles once', async () => {
      const { start, fake, events } = setup({ turn: [{ awaitSteer: true }, ...settle] });
      const run = start();
      await until(() => promptSent(fake));
      expect(await run.steer!('use tabs')).toBe('delivered');
      const outcome = await run.outcome;
      expect(outcome).toMatchObject({ status: 'completed', lastAssistantText: 'Steered: use tabs' });
      expect(outcome.unreadSteers).toBeUndefined();
      expect(steersSent(fake)).toEqual(['use tabs']);
      expect(events.filter((e) => e.kind === 'turn_settled')).toHaveLength(1);
      expect(exits(events)).toHaveLength(1);
    });

    it('answers settled to a steer after agent_settled and sends nothing to pi', async () => {
      const { start, fake } = setup();
      const run = start();
      await run.outcome;
      expect(await run.steer!('too late')).toBe('settled');
      expect(steersSent(fake)).toEqual([]);
    });

    it('reports the steers pi accepted after its last queue check and settled without reading as unread, in order', async () => {
      const { start, fake } = setup({ turn: [{ acceptSteerUnread: true }, { emit: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } } }, ...settle] });
      const run = start();
      await until(() => promptSent(fake));
      expect(await Promise.all([run.steer!('first'), run.steer!('second')])).toEqual(['delivered', 'delivered']);
      const outcome = await run.outcome;
      expect(outcome).toMatchObject({ status: 'completed', unreadSteers: ['first', 'second'] });
    });

    it('answers stopping to a steer while a cancel is in progress and sends nothing to pi', async () => {
      const { start, fake } = setup({ turn: [{ hang: true }], ignoreAbort: true });
      const run = start();
      await until(() => promptSent(fake));
      run.cancel();
      expect(await run.steer!('too late')).toBe('stopping');
      expect((await run.outcome).status).toBe('cancelled');
      expect(steersSent(fake)).toEqual([]);
    });

    it('restarts the timeout for a delivered steer: at 1 of 1.5 seconds, the run does not time out at 1.5', async () => {
      const { start, fake } = setup({ turn: [{ awaitSteer: true }, { sleep: 900 }, ...settle] }, 'helper', { timeout: 1.5 });
      const run = start();
      await until(() => promptSent(fake));
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(await run.steer!('keep going')).toBe('delivered');
      const outcome = await run.outcome;
      expect(outcome.status).toBe('completed');
      expect(commandsSent(fake.log())).not.toContain('abort');
    });

    it('resumes a session with the same flags and no --session, and the child recalls turn 1', async () => {
      const { driver, agent, root, fake, events } = setup({ turn: [{ echoSession: true }, ...settle] });
      const first = await driver.start(request(root, agent, 'first brief'), () => {}).outcome;
      expect(first).toMatchObject({ status: 'completed', lastAssistantText: 'Session: empty; now: first brief' });
      const run = driver.port.resume!(request(root, agent, 'first brief'), 'second message', (e) => events.push(e));
      const outcome = await run.outcome;
      const launches = fake.log().filter((l) => l.argv);
      expect(launches).toHaveLength(2);
      expect(launches[1].argv).toEqual(launches[0].argv);
      expect(launches[1].argv).toContain('--session-id');
      expect(launches[1].argv).toContain(path.join(root, '.agents', 'subzero', 'sessions'));
      expect(launches[1].argv).not.toContain('--session');
      const prompts = fake.log().filter((l) => l.command === 'prompt').map((l) => l.message);
      expect(prompts).toEqual(['first brief', 'second message']);
      expect(outcome).toMatchObject({ status: 'completed', lastAssistantText: 'Session: prompt first brief; now: second message' });
      expect(events.map((e) => e.kind)).toContain('prompt_sent');
    });

    it('throws SessionMissingError synchronously from a resume with no session file, and starts no process', () => {
      const { driver, agent, root, fake } = setup();
      expect(() => driver.port.resume!(request(root, agent, 'brief'), 'message', () => {})).toThrow(SessionMissingError);
      expect(fake.log()).toEqual([]);
    });

    it('reports a resumed turn usage as the cumulative stats minus the baseline read before its prompt, and context as read', async () => {
      const turn1 = usageOf({ input: 1000, output: 200, total: 1200 }, 0.5, 1200);
      const turn2 = usageOf({ input: 1500, output: 300, total: 1800 }, 0.25, 3000);
      const { driver, agent, root, fake } = setup({ turn: settle, launches: [{ stats: turn1 }, { stats: turn2 }] });
      const first = await driver.start(request(root, agent, 'brief'), () => {}).outcome;
      expect(first.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cost: 0.5, contextTokens: 1200 });
      const second = await driver.port.resume!(request(root, agent, 'brief'), 'again', () => {}).outcome;
      expect(second.usage).toMatchObject({ inputTokens: 1500, outputTokens: 300, totalTokens: 1800, cost: 0.25, contextTokens: 3000, contextWindow: 131072 });
      const log = fake.log();
      const resumed = commandsSent(log.slice(log.findLastIndex((l) => l.argv)));
      expect(resumed).toEqual(['get_state', 'get_commands', 'get_session_stats', 'prompt', 'get_last_assistant_text', 'get_session_stats']);
    });

    it('reports prompt_sent after skill verification and never for a skill-mismatch run', async () => {
      const ok = setup();
      await ok.start().outcome;
      expect(ok.events.map((e) => e.kind).slice(0, 3)).toEqual(['run_started', 'skills_verified', 'prompt_sent']);
      const mismatch = setup({ extraSkills: ['brave-search'] });
      await mismatch.start().outcome;
      expect(mismatch.events.map((e) => e.kind)).not.toContain('prompt_sent');
      const refused = setup({ refusePrompt: true });
      await refused.start().outcome;
      expect(refused.events.map((e) => e.kind)).not.toContain('prompt_sent');
    });
  });

  describe('prerequisites', () => {
    it('passes when the pi command answers --version', () => {
      expect(new PiDriver({ piCommand: FAKE_PI_COMMAND }).prerequisites()).toBeUndefined();
    });

    it('names pi, says it was not found and to install it and run subzero init again, when it cannot start', () => {
      const message = new PiDriver({ piCommand: [path.join(tempDir(), 'no-such-pi')] }).prerequisites();
      expect(message).toMatch(/pi was not found/);
      expect(message).toMatch(/install pi and run `subzero init` again/);
    });

    it('says pi did not run, and to install it and run subzero init again, when it exits non-zero', () => {
      const broken = path.join(tempDir(), 'broken-pi.mjs');
      writeFileSync(broken, 'process.exit(3);\n');
      const message = new PiDriver({ piCommand: [process.execPath, broken] }).prerequisites();
      expect(message).toMatch(/pi did not run/);
      expect(message).toMatch(/install pi and run `subzero init` again/);
    });
  });
});

const MODELS = [
  {
    id: 'qwen',
    name: 'Qwen',
    api: 'openai-completions',
    provider: 'local',
    baseUrl: 'http://localhost:8080/v1',
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh' },
    input: ['text'],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: 'model',
    name: 'Cloud model',
    api: 'anthropic-messages',
    provider: 'cloud',
    baseUrl: 'https://cloud.example',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 16384,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
];

function modelDriver(scenario: Record<string, unknown> = {}, options: Partial<PiDriverOptions> = {}) {
  const fake = fakePiEnv(scenario);
  const driver = new PiDriver({ piCommand: FAKE_PI_COMMAND, env: fake.env, killWaitMs: 300, log: () => {}, ...options });
  return { fake, driver };
}

const levelsOf = async (model: Record<string, unknown>) => {
  const [listed] = await modelDriver({ models: [{ id: 'm', provider: 'p', ...model }] }).driver.listModels();
  return listed!.thinkingLevels;
};

describe('PiDriver model listing', () => {
  it('maps each model pi offers to its subzero name, endpoint, thinking levels, limits, input kinds and cost', async () => {
    const models = await modelDriver({ models: MODELS }).driver.listModels();
    expect(models).toEqual([
      {
        name: 'local/qwen',
        endpoint: 'local',
        reasoning: true,
        thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
        contextWindow: 131072,
        maxTokens: 8192,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        name: 'cloud/model',
        endpoint: 'cloud',
        reasoning: false,
        thinkingLevels: ['off'],
        contextWindow: 200000,
        maxTokens: 16384,
        input: ['text', 'image'],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
    ]);
  });

  it('offers only off for a model without reasoning (AE6)', async () => {
    expect(await levelsOf({ reasoning: false, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } })).toEqual(['off']);
  });

  it('offers off to high for a reasoning model whose map marks xhigh and max null', async () => {
    expect(await levelsOf({ reasoning: true, thinkingLevelMap: { xhigh: null, max: null } })).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
  });

  it('offers off to high for a reasoning model with no map, and adds xhigh or max only when the map gives them a value', async () => {
    expect(await levelsOf({ reasoning: true })).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(await levelsOf({ reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } })).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(await levelsOf({ reasoning: true, thinkingLevelMap: { max: 'max' } })).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'max']);
  });

  it('leaves out a level below xhigh that the map marks null', async () => {
    expect(await levelsOf({ reasoning: true, thinkingLevelMap: { minimal: null, low: 'low' } })).toEqual(['off', 'low', 'medium', 'high']);
  });

  it('keeps the endpoint to the text before the first slash of the name', async () => {
    const [model] = await modelDriver({ models: [{ id: 'org/model', provider: 'router', reasoning: false }] }).driver.listModels();
    expect(model).toMatchObject({ name: 'router/org/model', endpoint: 'router', input: [] });
    expect(model!.cost).toBeUndefined();
  });

  it('runs the configured pi command with the children\'s environment and isolation flags, offline and without a session', async () => {
    const { driver, fake } = modelDriver({ models: MODELS });
    await driver.listModels();
    const [start] = fake.log();
    expect(start.argv).toEqual([...childRpcArgs(), '--no-session']);
    expect(start.argv).not.toContain('-e');
    expect(start.env).toEqual({ PI_OFFLINE: '1', PI_TELEMETRY: '0' });
    expect(commandsSent(fake.log())).toEqual(['get_available_models']);
    await until(() => !isAlive(start.pid));
  });

  it('loads the named extensions with -e after the isolation flags, and keeps -ne', async () => {
    const { driver, fake } = modelDriver({ models: MODELS });
    const [one, two] = extensionFiles('one.ts', 'two.ts');
    await driver.listModels({ childHostOptions: { extensions: [one, two] } });
    const [start] = fake.log();
    expect(start.argv).toEqual([...childRpcArgs(), '-e', one, '-e', two, '--no-session']);
    expect(start.argv).toContain('-ne');
  });

  it('rejects without starting pi when an extension names no file', async () => {
    const { driver, fake } = modelDriver({ models: MODELS });
    const gone = path.join(tempDir(), 'gone.ts');
    await expect(driver.listModels({ childHostOptions: { extensions: [gone] } })).rejects.toThrow(gone);
    expect(fake.log()).toEqual([]);
  });

  it('fails with a timeout error, not a hang, when pi never answers, and leaves no pi running', async () => {
    const { driver, fake } = modelDriver({ hangModels: true, ignoreStdinEnd: true }, { listTimeoutMs: 300 });
    await expect(driver.listModels()).rejects.toThrow(/pi did not list its models within/);
    await until(() => !isAlive(fake.log()[0].pid));
  });

  it('fails naming pi provider setup when pi offers no models', async () => {
    await expect(modelDriver({ models: [] }).driver.listModels()).rejects.toThrow(/pi provider/);
  });

  it('fails, never returning an empty list, when pi exits before it answers', async () => {
    const { driver } = modelDriver({ exitBeforeReady: { code: 2, stderr: 'config is broken\n' } });
    await expect(driver.listModels()).rejects.toThrow(/exited.*code 2.*config is broken/);
  });

  it('fails when pi prints a line that is not JSON', async () => {
    await expect(modelDriver({ modelsRaw: 'this is not json\n' }).driver.listModels()).rejects.toThrow(/not JSON/);
  });

  it('fails when the model list is malformed', async () => {
    await expect(modelDriver({ models: 'nope' }).driver.listModels()).rejects.toThrow(/malformed/);
    await expect(modelDriver({ models: [{ provider: 'local' }] }).driver.listModels()).rejects.toThrow(/malformed/);
  });

  it('fails with pi\'s reason when pi refuses the request', async () => {
    await expect(modelDriver({ refuseModels: 'no catalog' }).driver.listModels()).rejects.toThrow(/no catalog/);
  });

  it('fails naming the command when pi cannot start', async () => {
    const missing = path.join(tempDir(), 'no-such-pi');
    await expect(new PiDriver({ piCommand: [missing] }).listModels()).rejects.toThrow(/could not start pi/);
  });
});

describe('PiDriver model check', () => {
  it('reports answered for a model that replies, from a one-turn run with the children\'s flags, no tools and no session', async () => {
    const { driver, fake } = modelDriver();
    expect(await driver.checkModel({ model: 'local/qwen', thinking: 'high' })).toEqual({ ok: true });
    const [start] = fake.log();
    expect(start.argv).toEqual([...childRpcArgs(), '--model', 'local/qwen', '--thinking', 'high', '--no-tools', '--no-session']);
    expect(start.env).toEqual({ PI_OFFLINE: '1', PI_TELEMETRY: '0' });
    const prompts = fake.log().filter((l) => l.command === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0].message).toMatch(/\S/);
    await until(() => !isAlive(start.pid));
  });

  it('reports failed with the unknown-model kind for a model pi does not know (AE7)', async () => {
    const { driver } = modelDriver({ unknownModels: ['nowhere/missing'] });
    expect(await driver.checkModel({ model: 'nowhere/missing', thinking: 'off' })).toEqual({
      ok: false,
      kind: 'unknown_model',
      message: 'unknown model: nowhere/missing',
    });
  });

  it('reports the unknown-model kind when pi only warns and the turn then errors', async () => {
    const turn = [
      { emit: { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '404 model' } } },
      { emit: { type: 'agent_settled' } },
    ];
    const { driver } = modelDriver({ turn, stderrAtStart: 'Warning: Model "qwen9" not found for provider "local". Using custom model id.\n' });
    const result = await driver.checkModel({ model: 'local/qwen9', thinking: 'off' });
    expect(result).toMatchObject({ ok: false, kind: 'unknown_model' });
    expect((result as { message: string }).message).toMatch(/^unknown model: local\/qwen9: 404 model$/);
  });

  it('reports failed with pi\'s reason on one line when the turn errors', async () => {
    const turn = [
      { emit: { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '401 Unauthorized:\ninvalid key' } } },
      { emit: { type: 'agent_settled' } },
    ];
    expect(await modelDriver({ turn }).driver.checkModel({ model: 'cloud/model', thinking: 'low' })).toEqual({
      ok: false,
      kind: 'failed',
      message: '401 Unauthorized: invalid key',
    });
  });

  it('reports failed with the stderr reason when pi exits on an auth error', async () => {
    const turn = [{ exit: 1, stderr: 'Error: No API key found for provider "cloud".\nRun /login.\n' }];
    const result = await modelDriver({ turn }).driver.checkModel({ model: 'cloud/model', thinking: 'low' });
    expect(result).toMatchObject({ ok: false, kind: 'failed' });
    expect((result as { message: string }).message).toMatch(/No API key found for provider "cloud"/);
    expect((result as { message: string }).message).not.toMatch(/\n/);
  });

  it('reports failed when the run settles without an assistant message', async () => {
    const result = await modelDriver({ turn: [{ emit: { type: 'agent_settled' } }] }).driver.checkModel({ model: 'local/qwen', thinking: 'off' });
    expect(result).toEqual({ ok: false, kind: 'failed', message: 'no assistant message' });
  });

  it('reports a timeout when pi never settles, and leaves no pi running', async () => {
    const { driver, fake } = modelDriver({ turn: [{ hang: true }], ignoreAbort: true, ignoreStdinEnd: true, ignoreSigterm: true }, { checkTimeoutMs: 300 });
    const result = await driver.checkModel({ model: 'local/qwen', thinking: 'off' });
    expect(result).toMatchObject({ ok: false, kind: 'timeout' });
    expect((result as { message: string }).message).toMatch(/no answer within/);
    await until(() => !isAlive(fake.log()[0].pid));
  });

  it('kills pi when the check is aborted, and no process stays running', async () => {
    const { driver, fake } = modelDriver({ turn: [{ hang: true }], ignoreAbort: true, ignoreStdinEnd: true, ignoreSigterm: true });
    const controller = new AbortController();
    const pending = driver.checkModel({ model: 'local/qwen', thinking: 'off', signal: controller.signal });
    await until(() => commandsSent(fake.log()).includes('prompt'));
    controller.abort();
    expect(await pending).toEqual({ ok: false, kind: 'cancelled', message: 'the check was cancelled' });
    await until(() => !isAlive(fake.log()[0].pid));
  });

  it('starts no pi when the signal is already aborted', async () => {
    const { driver, fake } = modelDriver();
    const controller = new AbortController();
    controller.abort();
    expect(await driver.checkModel({ model: 'local/qwen', thinking: 'off', signal: controller.signal })).toMatchObject({ ok: false, kind: 'cancelled' });
    expect(fake.log()).toEqual([]);
  });

  it('loads the named extensions with -e after the isolation flags, and adds none when the list is empty', async () => {
    const { driver, fake } = modelDriver();
    const [one] = extensionFiles('one.ts');
    await driver.checkModel({ model: 'local/qwen', thinking: 'high', childHostOptions: { extensions: [one] } });
    expect(fake.log()[0].argv).toEqual([...childRpcArgs(), '-e', one, '--model', 'local/qwen', '--thinking', 'high', '--no-tools', '--no-session']);
    const empty = modelDriver();
    await empty.driver.checkModel({ model: 'local/qwen', thinking: 'high', childHostOptions: { extensions: [] } });
    expect(empty.fake.log()[0].argv).not.toContain('-e');
  });

  it('fails without starting pi when an extension names no file', async () => {
    const { driver, fake } = modelDriver();
    const gone = path.join(tempDir(), 'gone.ts');
    const result = await driver.checkModel({ model: 'local/qwen', thinking: 'off', childHostOptions: { extensions: [gone] } });
    expect(result).toMatchObject({ ok: false, kind: 'failed' });
    expect(JSON.stringify(result)).toContain(gone);
    expect(fake.log()).toEqual([]);
  });

  it('runs in the given project root', async () => {
    const root = tempDir();
    const { driver, fake } = modelDriver();
    await driver.checkModel({ model: 'local/qwen', thinking: 'off', projectRoot: root });
    expect(fake.log()[0].cwd).toBe(root);
  });

  it('reports failed naming the command when pi cannot start', async () => {
    const missing = path.join(tempDir(), 'no-such-pi');
    const result = await new PiDriver({ piCommand: [missing] }).checkModel({ model: 'local/qwen', thinking: 'off' });
    expect(result).toMatchObject({ ok: false, kind: 'failed' });
    expect((result as { message: string }).message).toMatch(/could not start pi/);
  });
});
