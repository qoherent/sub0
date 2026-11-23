#!/usr/bin/env node
// A scripted stand-in for pi 1.5.2 in RPC mode. The scenario comes from the JSON in
// FAKE_PI_SCENARIO; every command received is appended to FAKE_PI_LOG.
//
// Beyond the single scripted turn (scenario.turn):
//  - steer: queues the message (disposition 'queued', or scenario.steerDisposition 'handled' to
//    take it at once), announces the queue with a queue_update event.
//  - step { awaitSteer: true }: waits for a steer, reads it (queue_update with an empty queue) and
//    echoes it in an assistant message, so it is part of the final text before agent_settled.
//  - step { acceptSteerUnread: true }: waits for a steer and leaves it queued, announcing the queue
//    again: the steer arrived after pi's last queue check, so the turn settles without reading it.
//  - step { echoSession: true }: an assistant message that echoes the earlier prompts and steers
//    of the session (from the session file) and the current prompt.
//  - the session file (<session-dir>/2026-11-03_<session-id>.jsonl) keeps prompts, steers and the
//    usage of each prompt across launches of the same --session-id; get_session_stats is
//    cumulative over it, as pi's is.
//  - scenario.launches: a list of scenario overrides (turn, stats, lastText), one per prompt
//    already in the session: the first prompt uses entry 0, a resumed second prompt entry 1.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const scenario = JSON.parse(process.env.FAKE_PI_SCENARIO ?? '{}');
const logFile = process.env.FAKE_PI_LOG;

if (args.includes('--version')) {
  process.stdout.write(`${scenario.version ?? '0.87.0'}\n`);
  process.exit(0);
}

if (args.includes('--export')) {
  const i = args.indexOf('--export');
  writeFileSync(args[i + 2] ?? 'out.html', `<html>${args[i + 1]}</html>`);
  process.exit(0);
}

function log(entry) {
  if (logFile) appendFileSync(logFile, JSON.stringify(entry) + '\n');
}
log({ argv: args, env: { PI_OFFLINE: process.env.PI_OFFLINE, PI_TELEMETRY: process.env.PI_TELEMETRY }, pid: process.pid, cwd: process.cwd() });

// Like pi with a model on a provider it does not know: it says so and exits.
const modelArg = args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined;
if (modelArg !== undefined && (scenario.unknownModels ?? []).includes(modelArg)) {
  process.stderr.write(`Model "${modelArg}" not found\n`);
  process.exit(1);
}

if (scenario.stderrAtStart) process.stderr.write(scenario.stderrAtStart);
if (scenario.exitBeforeReady) {
  process.stderr.write(scenario.exitBeforeReady.stderr ?? '');
  process.exit(scenario.exitBeforeReady.code ?? 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
// Write raw text, possibly split across chunks, to test framing.
const sendRaw = async (text, splitAt) => {
  const buf = Buffer.from(text, 'utf8');
  if (splitAt === undefined) return process.stdout.write(buf);
  process.stdout.write(buf.subarray(0, splitAt));
  await sleep(20);
  process.stdout.write(buf.subarray(splitAt));
};

const skillArgs = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--skill') skillArgs.push(args[i + 1]);
// Like pi 0.87: a skill is named by its SKILL.md frontmatter, else its folder, and
// get_commands carries no path for it.
const skillName = (dir) => {
  try {
    const m = /^---\n[\s\S]*?^name:\s*(.+)$/m.exec(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
    if (m) return m[1].trim();
  } catch {}
  return path.basename(dir);
};
const loadedSkills = [
  ...skillArgs
    .filter((dir) => !(scenario.dropSkills ?? []).includes(path.basename(dir)))
    .map((dir) => ({ name: `skill:${skillName(dir)}`, source: 'skill' })),
  ...(scenario.extraSkills ?? []).map((name) => ({ name: `skill:${name}`, source: 'skill' })),
];

const flagValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sessionId = flagValue('--session-id');
const sessionDir = flagValue('--session-dir');
let aborted = false;
let lastStopReason = null;
let turnRunning = null;
let lastEcho = null;
let currentLaunch = scenario;
let currentPrompt = null;
const steerQueue = [];

// The session file, as pi writes it: created with the first prompt, kept across launches.
const sessionFile = path.join(sessionDir ?? '.', `2026-11-03_${sessionId}.jsonl`);
const readSession = () => {
  try {
    return readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const writeSession = (entry) => {
  // A launch with no session flags (a model listing or check) keeps no session file.
  if (sessionDir === undefined || sessionId === undefined) return;
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  appendFileSync(sessionFile, JSON.stringify(entry) + '\n');
};
const defaultStats = {
  tokens: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, total: 1500 },
  cost: 0,
  contextUsage: { tokens: 1500, contextWindow: 131072, percent: 1.1 },
};
// What this launch scripts: the scenario, with the override of the prompt it is about to run.
let promptsBefore = readSession().filter((e) => e.kind === 'prompt').length;
const launchScenario = () => ({ ...scenario, ...(scenario.launches?.[promptsBefore] ?? {}) });
// Cumulative over the session, like pi's: tokens and cost add up, context use is the latest.
const cumulativeStats = () => {
  const turns = readSession().filter((e) => e.kind === 'prompt').map((e) => e.usage);
  const sum = (pick) => turns.reduce((total, u) => total + (pick(u) ?? 0), 0);
  return {
    tokens: {
      input: sum((u) => u.tokens?.input),
      output: sum((u) => u.tokens?.output),
      cacheRead: sum((u) => u.tokens?.cacheRead),
      cacheWrite: sum((u) => u.tokens?.cacheWrite),
      total: sum((u) => u.tokens?.total),
    },
    cost: sum((u) => u.cost),
    contextUsage: turns.length > 0 ? turns.at(-1).contextUsage : { tokens: 0, contextWindow: 131072, percent: 0 },
  };
};

const defaultTurn = [
  { emit: { type: 'agent_start' } },
  { emit: { type: 'turn_start' } },
  { emit: { type: 'message_start', message: { role: 'assistant', content: [] } } },
  { emit: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Done: ' } } },
  { emit: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'wrote the answer.' } } },
  { emit: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done: wrote the answer.' }], stopReason: 'stop' } } },
  { emit: { type: 'turn_end', message: {}, toolResults: [] } },
  { emit: { type: 'agent_end', messages: [], willRetry: false } },
  { emit: { type: 'agent_settled' } },
];

// Like pi's get_available_models: full model objects.
const defaultModels = [
  { id: 'qwen', name: 'Qwen', api: 'openai-completions', provider: 'local', baseUrl: 'http://localhost:8080/v1', reasoning: true, input: ['text'], contextWindow: 131072, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
];

const emitAssistant = (text) => {
  lastEcho = text;
  lastStopReason = 'stop';
  send({ type: 'message_start', message: { role: 'assistant', content: [] } });
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
};
const announceQueue = () => send({ type: 'queue_update', steering: [...steerQueue], followUp: [] });
const waitForSteer = async () => {
  while (!aborted && steerQueue.length === 0) await sleep(10);
};

async function runTurn(steps) {
  for (const step of steps) {
    if (aborted) break;
    if (step.awaitSteer) {
      await waitForSteer();
      if (aborted) break;
      const read = steerQueue.splice(0, steerQueue.length);
      announceQueue();
      emitAssistant(`Steered: ${read.join(' | ')}`);
    } else if (step.acceptSteerUnread) {
      await waitForSteer();
      announceQueue();
    } else if (step.echoSession) {
      const earlier = readSession().filter((e) => e.kind === 'prompt' || e.kind === 'steer');
      const before = earlier.slice(0, earlier.findLastIndex((e) => e.kind === 'prompt'));
      emitAssistant(`Session: ${before.map((e) => `${e.kind} ${e.message}`).join(' | ') || 'empty'}; now: ${currentPrompt}`);
    } else if (step.emit) {
      if (step.emit.type === 'message_end' && step.emit.message?.role === 'assistant') lastStopReason = step.emit.message.stopReason;
      send(step.emit);
    } else if (step.raw !== undefined) await sendRaw(step.raw, step.splitAt);
    else if (step.sleep) await sleep(step.sleep);
    else if (step.hang) await new Promise(() => {});
    else if (step.exit !== undefined) {
      if (step.stderr) process.stderr.write(step.stderr);
      process.exit(step.exit);
    } else if (step.grandchild) {
      // 'detached' mimics pi's bash tool, whose shells get their own process group.
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: step.grandchild === 'detached' });
      log({ grandchild: child.pid });
    } else if (step.closeStdout) {
      process.stdout.end();
    }
  }
}

async function handle(cmd) {
  log({ command: cmd.type, message: cmd.message });
  const reply = (data, success = true, error) =>
    send({ id: cmd.id, type: 'response', command: cmd.type, success, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) });
  switch (cmd.type) {
    case 'get_state':
      if (scenario.stateDelay) await sleep(scenario.stateDelay);
      return reply({ sessionId, sessionFile: path.join(sessionDir, `2026-11-03_${sessionId}.jsonl`), thinkingLevel: 'high', isStreaming: false });
    case 'get_commands':
      return reply({ commands: [...loadedSkills, { name: 'llama', source: 'extension' }] });
    case 'prompt': {
      if (scenario.refusePrompt) return reply(undefined, false, 'nope');
      const launch = (currentLaunch = launchScenario());
      currentPrompt = cmd.message;
      writeSession({ kind: 'prompt', message: cmd.message, usage: launch.stats ?? defaultStats });
      promptsBefore += 1;
      reply({ disposition: 'started' });
      turnRunning = runTurn(launch.turn ?? defaultTurn);
      return;
    }
    case 'steer': {
      if (scenario.refuseSteer) return reply(undefined, false, scenario.refuseSteer);
      writeSession({ kind: 'steer', message: cmd.message });
      if (scenario.steerDisposition === 'handled') return reply({ disposition: 'handled' });
      steerQueue.push(cmd.message);
      reply({ disposition: 'queued' });
      announceQueue();
      return;
    }
    case 'get_last_assistant_text':
      return reply({ text: currentLaunch.lastText ?? lastEcho ?? (lastStopReason === null ? null : 'Done: wrote the answer.') });
    case 'get_session_stats':
      return reply(cumulativeStats());
    case 'get_available_models':
      if (scenario.hangModels) return;
      if (scenario.modelsRaw !== undefined) return sendRaw(scenario.modelsRaw);
      if (scenario.refuseModels) return reply(undefined, false, scenario.refuseModels);
      return reply({ models: scenario.models ?? defaultModels });
    case 'clear_queue':
      return reply({ steering: [], followUp: [] });
    case 'abort':
      if (scenario.ignoreAbort) return;
      aborted = true;
      lastStopReason = 'aborted';
      return reply();
    default:
      return reply(undefined, false, `unknown command ${cmd.type}`);
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line.trim()) void handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => {
  log({ stdin: 'end' });
  if (scenario.ignoreStdinEnd) return;
  process.exit(0);
});
if (scenario.ignoreSigterm) process.on('SIGTERM', () => log({ signal: 'SIGTERM' }));
// Keep the process alive while it waits for commands.
setInterval(() => {}, 1 << 30);
