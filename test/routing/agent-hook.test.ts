import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { decideAgentSpawn, type HookContext, type SpawnInput } from '../../src/routing/routing.js';
import { readCallMarker, removeReadinessMarker, writeCallMarker, writeReadinessMarker } from '../../src/mcp/parent-session.js';
import { GLOBAL_MEDIUM_YAML, isAlive, tempDir, until, useGlobalConfig } from '../helpers.js';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const HOOK = path.join(REPO, 'dist', 'agent-hook.js');
const DELEGATE = 'mcp__plugin_subzero_subzero__delegate';

const tier = (name: string, model: string) => `    ${name}: { host: pi, model: ${model}, thinking: low }\n`;
const GENERAL = 'agents:\n  general:\n    tools: [read, bash]\n    timeout: 60\n  fallback:\n    tools: [read]\n    timeout: 60\n';
const config = (names: string[], extra = '') =>
  `${extra}models:\n  tiers:\n${tier('default', 'local/d')}${names.map((n) => tier(n, `local/${n}`)).join('')}${GENERAL}`;

function project(yaml?: string): string {
  const root = tempDir();
  if (yaml !== undefined) {
    mkdirSync(path.join(root, '.agents'), { recursive: true });
    writeFileSync(path.join(root, '.agents', 'subzero.yaml'), yaml);
  }
  return root;
}

/** A project with a live marker whose recorded parent is this test process's parent (an ancestor of the hook logic). */
function setup(yaml: string | undefined, marker = true) {
  const root = project(yaml);
  const data = tempDir();
  if (marker) writeReadinessMarker(data, root, process.pid, process.ppid);
  const ctx = (sessionId = 's-1'): HookContext => ({ projectRoot: root, dataDir: data, sessionId });
  return { root, data, ctx };
}

const spawnOf = (prompt: string, extra: Partial<SpawnInput> = {}): SpawnInput => ({ prompt, description: 'review things', ...extra });

describe('decideAgentSpawn', () => {
  it('ignores the task mode an older server wrote into its readiness marker: the deny reason still asks for wait false', () => {
    const { root, data, ctx } = setup(config(['medium']));
    const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
    const file = path.join(data, 'ready', key, `${process.pid}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), taskMode: true }));
    const out = decideAgentSpawn(spawnOf('review', { model: 'sonnet' }), ctx());
    expect(out.decision).toBe('deny');
    if (out.decision === 'deny') expect(out.reason).toMatch(/wait: false, then collect it with the await tool/);
  });
  it('AE5: denies a generic sonnet spawn toward medium, naming delegate, tier and wait false', () => {
    const { ctx } = setup(config(['medium']));
    const out = decideAgentSpawn(spawnOf('do the review', { model: 'sonnet', subagent_type: 'general-purpose' }), ctx());
    expect(out.decision).toBe('deny');
    if (out.decision !== 'deny') return;
    expect(out.reason).toContain(DELEGATE);
    expect(out.reason).toContain('tier: "medium"');
    expect(out.reason).toContain('wait: false');
    expect(out.reason).toContain('do the review');
    expect(out.reason).toMatch(/routing rule, not an error/);
    expect(out.reason).toMatch(/do not call Agent again/);
    expect(out.reason).toContain('passback');
  });

  it('AE2: with large configured, a spawn with no model and no agent type is denied toward large', () => {
    const { ctx } = setup(config(['medium', 'large']));
    const out = decideAgentSpawn(spawnOf('p'), ctx());
    expect(out).toMatchObject({ decision: 'deny', tier: 'large' });
  });

  it('AE6: allows a named specialist agent with sonnet', () => {
    const { ctx } = setup(config(['medium']));
    expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet', subagent_type: 'Explore' }), ctx()).decision).toBe('allow');
  });

  it('treats subagent_type claude and general-purpose as generic', () => {
    const { ctx } = setup(config(['medium']));
    expect(decideAgentSpawn(spawnOf('a', { model: 'sonnet', subagent_type: 'claude' }), ctx()).decision).toBe('deny');
    expect(decideAgentSpawn(spawnOf('b', { model: 'sonnet', subagent_type: 'general-purpose' }), ctx()).decision).toBe('deny');
  });

  it('honours the generic agent list of the routing settings', () => {
    const { ctx } = setup(config(['medium'], 'routing:\n  generic_agents: [worker]\n'));
    expect(decideAgentSpawn(spawnOf('a', { model: 'sonnet', subagent_type: 'general-purpose' }), ctx()).decision).toBe('allow');
    expect(decideAgentSpawn(spawnOf('b', { model: 'sonnet', subagent_type: 'worker' }), ctx()).decision).toBe('deny');
  });

  it('AE9: allows a worktree-isolated spawn and a fork, even after the prompt was denied', () => {
    const { ctx } = setup(config(['medium']));
    expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), ctx()).decision).toBe('deny');
    expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet', isolation: 'worktree' }), ctx()).decision).toBe('allow');
    expect(decideAgentSpawn(spawnOf('p', { subagent_type: 'fork' }), ctx()).decision).toBe('allow');
    expect(decideAgentSpawn(spawnOf('q', { model: 'sonnet', isolation: 'worktree' }), ctx()).decision).toBe('allow');
  });

  it('allows a remote-isolated spawn, and treats a fork flag without the fork agent type as a generic spawn', () => {
    const { ctx } = setup(config(['medium']));
    expect(decideAgentSpawn(spawnOf('r', { model: 'sonnet', isolation: 'remote' }), ctx()).decision).toBe('allow');
    expect(decideAgentSpawn(spawnOf('s', { model: 'sonnet', isolation: '' }), ctx()).decision).toBe('deny');
    const flagged = { ...spawnOf('t', { model: 'sonnet' }), fork: true } as SpawnInput;
    expect(decideAgentSpawn(flagged, ctx()).decision).toBe('deny');
  });

  it('AE8: after a denied sonnet spawn the same prompt is denied with no model and with haiku; a different prompt with haiku is allowed', () => {
    const { ctx } = setup(config(['medium']));
    const first = decideAgentSpawn(spawnOf('same', { model: 'sonnet' }), ctx());
    const noModel = decideAgentSpawn(spawnOf('same'), ctx());
    const haiku = decideAgentSpawn(spawnOf('same', { model: 'haiku' }), ctx());
    expect(first.decision).toBe('deny');
    expect(noModel).toEqual(first);
    expect(haiku).toEqual(first);
    expect(decideAgentSpawn(spawnOf('other', { model: 'haiku' }), ctx()).decision).toBe('allow');
  });

  it('AE7: allows everything with no marker, with a marker of a dead pid, and with a marker of a live non-ancestor parent', async () => {
    expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), setup(config(['medium']), false).ctx()).decision).toBe('allow');

    const dead = setup(config(['medium']), false);
    const gone = spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => gone.once('exit', r));
    writeReadinessMarker(dead.data, dead.root, gone.pid!, process.ppid);
    expect(isAlive(gone.pid!)).toBe(false);
    expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), dead.ctx()).decision).toBe('allow');

    const stranger = setup(config(['medium']), false);
    const sleeper = spawn('sleep', ['30']);
    try {
      writeReadinessMarker(stranger.data, stranger.root, process.pid, sleeper.pid!);
      expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), stranger.ctx()).decision).toBe('allow');
    } finally {
      sleeper.kill();
    }
  });

  it('with two markers for one project, removing one still leaves the hook denying while the other is live with an ancestor parent', () => {
    const { root, data, ctx } = setup(config(['medium']), false);
    const a = spawn('sleep', ['30']);
    const b = spawn('sleep', ['30']);
    try {
      writeReadinessMarker(data, root, a.pid!, process.ppid);
      writeReadinessMarker(data, root, b.pid!, process.ppid);
      expect(decideAgentSpawn(spawnOf('a', { model: 'sonnet' }), ctx()).decision).toBe('deny');
      removeReadinessMarker(data, root, a.pid!);
      expect(decideAgentSpawn(spawnOf('b', { model: 'sonnet' }), ctx()).decision).toBe('deny');
      removeReadinessMarker(data, root, b.pid!);
      expect(decideAgentSpawn(spawnOf('c', { model: 'sonnet' }), ctx()).decision).toBe('allow');
    } finally {
      a.kill();
      b.kill();
    }
  });

  it('allows everything with a broken config file', () => {
    const { ctx } = setup('agents: [oops\n');
    expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), ctx()).decision).toBe('allow');
  });

  it('denies a generic sonnet spawn toward the global medium when the project has no file', () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const out = decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), setup(undefined).ctx());
    expect(out.decision).toBe('deny');
    if (out.decision === 'deny') expect(out.reason).toContain('tier: "medium"');
  });

  it('covers AE4: allows everything when the project says enabled false, with a global medium or a broken global file', () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), setup('enabled: false\n').ctx()).decision).toBe('allow');
    useGlobalConfig('agents: [oops\n');
    expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), setup('enabled: false\n').ctx()).decision).toBe('allow');
  });

  it('allows everything with a broken global file', () => {
    useGlobalConfig('agents: [oops\n');
    expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), setup(undefined).ctx()).decision).toBe('allow');
  });

  it('allows everything with routing.hook false', () => {
    const { ctx } = setup(config(['medium'], 'routing:\n  hook: false\n'));
    expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), ctx()).decision).toBe('allow');
  });

  it('allows everything with no tier word configured, and for a default-only config', () => {
    expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), setup(config([])).ctx()).decision).toBe('allow');
    expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), setup(config(['custom'])).ctx()).decision).toBe('allow');
    expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), setup(undefined).ctx()).decision).toBe('allow');
  });

  it('allows a haiku spawn when small is not configured', () => {
    const a = setup(config(['medium']));
    expect(decideAgentSpawn(spawnOf('p', { model: 'haiku' }), a.ctx()).decision).toBe('allow');
  });

  it('opus and fable: allowed when their prompt was not denied, denied when it was', () => {
    const { ctx } = setup(config(['medium', 'large']));
    expect(decideAgentSpawn(spawnOf('fresh', { model: 'opus' }), ctx()).decision).toBe('allow');
    expect(decideAgentSpawn(spawnOf('fresh', { model: 'fable' }), ctx()).decision).toBe('allow');
    expect(decideAgentSpawn(spawnOf('seen', { model: 'sonnet' }), ctx())).toMatchObject({ decision: 'deny', tier: 'medium' });
    expect(decideAgentSpawn(spawnOf('seen', { model: 'opus' }), ctx())).toMatchObject({ decision: 'deny', tier: 'medium' });
    expect(decideAgentSpawn(spawnOf('seen', { model: 'fable' }), ctx())).toMatchObject({ decision: 'deny', tier: 'medium' });
  });

  it('deny memory also denies a named agent whose prompt was denied earlier', () => {
    const { ctx } = setup(config(['medium']));
    decideAgentSpawn(spawnOf('seen', { model: 'sonnet' }), ctx());
    expect(decideAgentSpawn(spawnOf('seen', { model: 'sonnet', subagent_type: 'Explore' }), ctx()).decision).toBe('deny');
  });

  it('a denied prompt whose recorded tier is no longer routable follows the generic and alias rules instead', () => {
    const { root, ctx } = setup(config(['medium', 'small']));
    expect(decideAgentSpawn(spawnOf('p', { model: 'haiku' }), ctx()).decision).toBe('deny');
    writeFileSync(path.join(root, '.agents', 'subzero.yaml'), config(['medium', 'large']));
    // The deny memory holds small, which is gone: opus is not mapped, so it is allowed.
    expect(decideAgentSpawn(spawnOf('p', { model: 'opus' }), ctx()).decision).toBe('allow');
    // A generic spawn with no model maps to large and is denied by the alias table.
    expect(decideAgentSpawn(spawnOf('p'), ctx())).toMatchObject({ decision: 'deny', tier: 'large' });
  });

  it('keeps the deny memory per session id', () => {
    const { ctx } = setup(config(['medium']));
    expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), ctx('s-1')).decision).toBe('deny');
    expect(decideAgentSpawn(spawnOf('p', { model: 'opus' }), ctx('s-2')).decision).toBe('allow');
    expect(decideAgentSpawn(spawnOf('p', { model: 'opus' }), ctx('s-1')).decision).toBe('deny');
  });

  it('never sweeps the folder of the current session: an aged resumed session is still denied and remembered', () => {
    const { data, ctx } = setup(config(['medium']));
    decideAgentSpawn(spawnOf('one', { model: 'sonnet' }), ctx('resumed'));
    decideAgentSpawn(spawnOf('one', { model: 'sonnet' }), ctx('other'));
    const root = path.join(data, 'sessions', 'deny');
    const folders = readdirSync(root);
    expect(folders).toHaveLength(2);
    const eightDays = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    for (const f of folders) utimesSync(path.join(root, f), eightDays, eightDays);

    expect(decideAgentSpawn(spawnOf('two', { model: 'sonnet' }), ctx('resumed'))).toMatchObject({ decision: 'deny', tier: 'medium' });
    const left = readdirSync(root);
    expect(left).toHaveLength(1); // the other session's old folder was swept, the current one was kept
    expect(readdirSync(path.join(root, left[0]!))).toHaveLength(2);
    // remembered: the same prompt with an unmapped model is still denied
    expect(decideAgentSpawn(spawnOf('two', { model: 'opus' }), ctx('resumed'))).toMatchObject({ decision: 'deny', tier: 'medium' });
  });

  it('waits for a resumed session and rechecks its age before cleanup', async () => {
    const { data, ctx } = setup(config(['medium']));
    expect(decideAgentSpawn(spawnOf('one', { model: 'sonnet' }), ctx('resumed')).decision).toBe('deny');
    const root = path.join(data, 'sessions', 'deny');
    const old = readdirSync(root)[0]!;
    const eightDays = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    utimesSync(path.join(root, old), eightDays, eightDays);
    const lock = path.join(data, 'sessions', 'deny-locks', `${old}.lock`);
    const ready = path.join(data, 'holder-ready');
    const helper = "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'ready');setTimeout(()=>{fs.writeFileSync(process.argv[2],'new');process.exit(0)},350)";
    const program = process.platform === 'darwin' ? 'lockf' : 'flock';
    const args = process.platform === 'darwin'
      ? ['-k', '-t', '2', lock, process.execPath, '-e', helper, ready, path.join(root, old, 'fresh')]
      : ['-w', '2', lock, process.execPath, '-e', helper, ready, path.join(root, old, 'fresh')];
    const holder = spawn(program, args, { detached: true, stdio: 'ignore' });
    try {
      await until(() => existsSync(ready));
      expect(decideAgentSpawn(spawnOf('other', { model: 'sonnet' }), ctx('other')).decision).toBe('deny');
      expect(existsSync(path.join(root, old))).toBe(true);
      expect(decideAgentSpawn(spawnOf('one', { model: 'opus' }), ctx('resumed')).decision).toBe('deny');
    } finally { try { process.kill(-holder.pid!, 'SIGTERM'); } catch { /* already exited */ } }
  });

  it('does not remember an allowed spawn when cleanup cannot acquire a lock', async () => {
    const { data, ctx } = setup(config(['medium']));
    expect(decideAgentSpawn(spawnOf('old', { model: 'sonnet' }), ctx('old-session')).decision).toBe('deny');
    const root = path.join(data, 'sessions', 'deny');
    const old = readdirSync(root)[0]!;
    const eightDays = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    utimesSync(path.join(root, old), eightDays, eightDays);
    const lock = path.join(data, 'sessions', 'deny-locks', `${old}.lock`);
    const ready = path.join(data, 'holder-ready');
    const helper = "require('node:fs').writeFileSync(process.argv[1],'ready');setTimeout(()=>process.exit(0),5000)";
    const program = process.platform === 'darwin' ? 'lockf' : 'flock';
    const args = process.platform === 'darwin'
      ? ['-k', '-t', '2', lock, process.execPath, '-e', helper, ready]
      : ['-w', '2', lock, process.execPath, '-e', helper, ready];
    const holder = spawn(program, args, { detached: true, stdio: 'ignore' });
    try {
      await until(() => existsSync(ready));
      expect(decideAgentSpawn(spawnOf('new', { model: 'sonnet' }), ctx('new-session')).decision).toBe('allow');
    } finally { try { process.kill(-holder.pid!, 'SIGKILL'); } catch { /* already exited */ } }
    expect(decideAgentSpawn(spawnOf('new', { model: 'opus' }), ctx('new-session')).decision).toBe('allow');
  }, 10_000);

  it('records each denial as its own create-only entry, and sweeps session folders older than seven days on a write', () => {
    const { data, ctx } = setup(config(['medium']));
    decideAgentSpawn(spawnOf('one', { model: 'sonnet' }), ctx('old-session'));
    const root = path.join(data, 'sessions', 'deny');
    const oldDir = readdirSync(root)[0]!;
    const eightDays = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    utimesSync(path.join(root, oldDir), eightDays, eightDays);
    decideAgentSpawn(spawnOf('one', { model: 'sonnet' }), ctx('new-session'));
    const left = readdirSync(root);
    expect(left).not.toContain(oldDir);
    expect(left).toHaveLength(1);
    decideAgentSpawn(spawnOf('two', { model: 'sonnet' }), ctx('new-session'));
    decideAgentSpawn(spawnOf('two', { model: 'haiku' }), ctx('new-session'));
    expect(readdirSync(path.join(root, left[0]!))).toHaveLength(2);
    expect(statSync(path.join(root, left[0]!)).isDirectory()).toBe(true);
  });

  describe('AE12 pass-back', () => {
    it('allows a passback of a denied prompt, still denies the same prompt with another description', () => {
      const { ctx } = setup(config(['medium']));
      expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), ctx()).decision).toBe('deny');
      expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet', description: 'passback review' }), ctx()).decision).toBe('allow');
      expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet', description: 'passbackdoor' }), ctx()).decision).toBe('deny');
      expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet', description: 'review passback' }), ctx()).decision).toBe('deny');
      expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet', description: 'review' }), ctx()).decision).toBe('deny');
    });

    it('denies and records a passback of a prompt never denied, like any other spawn', () => {
      const { ctx } = setup(config(['medium']));
      expect(decideAgentSpawn(spawnOf('fresh', { model: 'sonnet', description: 'passback x' }), ctx())).toMatchObject({ decision: 'deny', tier: 'medium' });
      // It was recorded: a later passback of it is allowed.
      expect(decideAgentSpawn(spawnOf('fresh', { model: 'sonnet', description: 'passback x' }), ctx()).decision).toBe('allow');
    });

    it('allows a passback of a denied prompt whatever tier the entry keeps, even one no longer routable', () => {
      const { root, ctx } = setup(config(['medium']));
      decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), ctx());
      writeFileSync(path.join(root, '.agents', 'subzero.yaml'), config(['large']));
      expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet', description: 'passback' }), ctx()).decision).toBe('allow');
    });

    it('does not remember a passback across sessions', () => {
      const { ctx } = setup(config(['medium']));
      decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), ctx('s-1'));
      expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet', description: 'passback' }), ctx('s-2')).decision).toBe('deny');
    });

    it('allows a passback with isolation or as a fork, with the hook off, and with the server down', () => {
      const { ctx } = setup(config(['medium']));
      decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), ctx());
      expect(decideAgentSpawn(spawnOf('p', { description: 'passback', isolation: 'worktree' }), ctx()).decision).toBe('allow');
      expect(decideAgentSpawn(spawnOf('p', { description: 'passback', subagent_type: 'fork' }), ctx()).decision).toBe('allow');
      const off = setup(config(['medium'], 'routing:\n  hook: false\n'));
      expect(decideAgentSpawn(spawnOf('p', { description: 'passback' }), off.ctx()).decision).toBe('allow');
      const down = setup(config(['medium']), false);
      expect(decideAgentSpawn(spawnOf('p', { description: 'passback' }), down.ctx()).decision).toBe('allow');
    });
  });

  it('allows when the input has no prompt or the data folder cannot be written', () => {
    const { root, ctx } = setup(config(['medium']));
    expect(decideAgentSpawn({ model: 'sonnet' }, ctx()).decision).toBe('allow');
    const blocked = tempDir();
    writeFileSync(path.join(blocked, 'sessions'), 'a file where a folder should be');
    writeReadinessMarker(tempDir(), root, process.pid, process.ppid);
    const broken: HookContext = { projectRoot: root, dataDir: blocked, sessionId: 's' };
    expect(decideAgentSpawn(spawnOf('p', { model: 'sonnet' }), broken).decision).toBe('allow');
  });
});

describe('built PreToolUse hook', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: REPO });
  });

  function env(root: string, data: string): NodeJS.ProcessEnv {
    const e: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_DATA: data };
    delete e.SUBZERO_DATA;
    return e;
  }

  function input(toolInput: Record<string, unknown>, sessionId = 's-1', toolName = 'Agent'): string {
    return JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sessionId, tool_name: toolName, tool_input: toolInput });
  }

  /** Run the hook as a child of this process, so this process is one of its ancestors. */
  function run(root: string, data: string, stdin: string) {
    return execFileSync(process.execPath, [HOOK], { input: stdin, env: env(root, data) }).toString();
  }

  function runAsync(root: string, data: string, stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child: ChildProcess = spawn(process.execPath, [HOOK], { env: env(root, data), stdio: ['pipe', 'pipe', 'inherit'] });
      let out = '';
      child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
      child.once('error', reject);
      child.once('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
      child.stdin!.end(stdin);
    });
  }

  it('denies with the PreToolUse hookSpecificOutput shape for a generic sonnet spawn when this process is the recorded parent', () => {
    const root = project(config(['medium']));
    const data = tempDir();
    writeReadinessMarker(data, root, process.pid, process.pid);
    const out = JSON.parse(run(root, data, input({ description: 'review', prompt: 'look at the code', model: 'sonnet' }))) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(`${DELEGATE}`);
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('tier: "medium"');
  });

  it('covers the Task tool name and the real ancestor walk: a marker parent that is not an ancestor allows', () => {
    const root = project(config(['medium']));
    const data = tempDir();
    const sleeper = spawn('sleep', ['30']);
    try {
      writeReadinessMarker(data, root, process.pid, sleeper.pid!);
      expect(run(root, data, input({ prompt: 'x', model: 'sonnet' }, 's-1', 'Task'))).toBe('');
    } finally {
      sleeper.kill();
    }
  });

  it('allows with no marker, for Explore, for isolation, and with the hook off', () => {
    const root = project(config(['medium']));
    const data = tempDir();
    expect(run(root, data, input({ prompt: 'x', model: 'sonnet' }))).toBe('');
    writeReadinessMarker(data, root, process.pid, process.pid);
    expect(run(root, data, input({ prompt: 'x', model: 'sonnet', subagent_type: 'Explore' }))).toBe('');
    expect(run(root, data, input({ prompt: 'x', model: 'sonnet', isolation: 'worktree' }))).toBe('');
    const off = project(config(['medium'], 'routing:\n  hook: false\n'));
    writeReadinessMarker(data, off, process.pid, process.pid);
    expect(run(off, data, input({ prompt: 'x', model: 'sonnet' }))).toBe('');
  });

  it('fails open for malformed Agent fields, including a remembered prompt', () => {
    const root = project(config(['medium']));
    const data = tempDir();
    writeReadinessMarker(data, root, process.pid, process.pid);
    expect(run(root, data, input({ prompt: 'remembered', model: 'sonnet' }))).not.toBe('');
    for (const isolation of [true, 1, { kind: 'worktree' }]) {
      expect(run(root, data, input({ prompt: 'remembered', model: 'sonnet', isolation }))).toBe('');
    }
    expect(run(root, data, input({ prompt: 'new', model: 'sonnet', description: 42 }))).toBe('');
    expect(run(root, data, input({ prompt: 'new', model: { value: 'sonnet' } }))).toBe('');
    expect(run(root, data, input({ prompt: 'new', model: 'sonnet' }, '   '))).toBe('');
  });

  it('exits 0 with no output for malformed stdin, empty stdin, no session id and a missing project', () => {
    const root = project(config(['medium']));
    const data = tempDir();
    writeReadinessMarker(data, root, process.pid, process.pid);
    expect(run(root, data, 'not json {')).toBe('');
    expect(run(root, data, '')).toBe('');
    expect(run(root, data, JSON.stringify({ tool_name: 'Agent', tool_input: { prompt: 'x', model: 'sonnet' } }))).toBe('');
    expect(run(root, data, JSON.stringify({ session_id: 's', tool_name: 'Agent' }))).toBe('');
    const noProject = execFileSync(process.execPath, [HOOK], {
      input: input({ prompt: 'x', model: 'sonnet' }),
      env: { ...env(root, data), CLAUDE_PROJECT_DIR: '' },
    }).toString();
    expect(noProject).toBe('');
  });

  it('resolves the project only from CLAUDE_PROJECT_DIR: the input cwd is not a fallback', () => {
    const root = project(config(['medium']));
    const data = tempDir();
    writeReadinessMarker(data, root, process.pid, process.pid);
    const stdin = JSON.stringify({ session_id: 's-1', cwd: root, tool_name: 'Agent', tool_input: { prompt: 'x', model: 'sonnet' } });
    const e = env(root, data);
    expect(JSON.parse(run(root, data, stdin)).hookSpecificOutput.permissionDecision).toBe('deny');
    delete e.CLAUDE_PROJECT_DIR;
    expect(execFileSync(process.execPath, [HOOK], { input: stdin, env: e }).toString()).toBe('');
    e.CLAUDE_PROJECT_DIR = '${CLAUDE_PROJECT_DIR}';
    expect(execFileSync(process.execPath, [HOOK], { input: stdin, env: e }).toString()).toBe('');
  });

  it('denies six distinct prompts from six concurrent hook processes, and all six again on retry', async () => {
    const root = project(config(['medium']));
    const data = tempDir();
    writeReadinessMarker(data, root, process.pid, process.pid);
    const prompts = Array.from({ length: 6 }, (_, i) => `reviewer prompt ${i}`);
    const first = await Promise.all(prompts.map((p) => runAsync(root, data, input({ prompt: p, model: 'sonnet' }))));
    for (const out of first) expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
    const retry = await Promise.all(prompts.map((p) => runAsync(root, data, input({ prompt: p, model: 'haiku' }))));
    for (const out of retry) expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readdirSync(path.join(data, 'sessions', 'deny', readdirSync(path.join(data, 'sessions', 'deny'))[0]!))).toHaveLength(6);
  });

  it('keeps concurrent routing responsive while cleaning expired sessions', async () => {
    const root = project(config(['medium']));
    const data = tempDir();
    writeReadinessMarker(data, root, process.pid, process.pid);
    const deny = path.join(data, 'sessions', 'deny');
    mkdirSync(deny, { recursive: true });
    const old = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    for (let i = 0; i < 3; i++) {
      const folder = path.join(deny, `old-${i}`);
      mkdirSync(folder);
      utimesSync(folder, old, old);
    }
    const replies = await Promise.all(Array.from({ length: 6 }, (_, i) => runAsync(root, data, input({ prompt: `new-${i}`, model: 'sonnet' }))));
    for (const reply of replies) expect(JSON.parse(reply).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('AE12: allows a passback of a denied prompt through the built hook', () => {
    const root = project(config(['medium']));
    const data = tempDir();
    writeReadinessMarker(data, root, process.pid, process.pid);
    expect(run(root, data, input({ prompt: 'p', model: 'sonnet', description: 'review' }))).not.toBe('');
    expect(run(root, data, input({ prompt: 'p', model: 'sonnet', description: 'passback review' }))).toBe('');
    expect(run(root, data, input({ prompt: 'p', model: 'sonnet', description: 'review' }))).not.toBe('');
  });

  it('keeps the bundle as small as the SessionStart hook: no MCP SDK or server code in it', () => {
    expect(readFileSync(HOOK, 'utf8')).not.toContain('modelcontextprotocol');
    expect(statSync(HOOK).size).toBeLessThan(statSync(path.join(REPO, 'dist', 'hook.js')).size + 50_000);
  });
});

describe('hooks.json and the server readiness marker', () => {
  it('registers PreToolUse with matcher Agent|Task and subzero tools, pointing at a file that the build emits', () => {
    const hooks = JSON.parse(execFileSync('cat', [path.join(REPO, 'hooks', 'hooks.json')]).toString()) as {
      hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
    };
    const entry = hooks.hooks.PreToolUse[0]!;
    expect(entry.matcher.split('|')).toEqual(['Agent', 'Task', ...['delegate', 'continue', 'await'].map((t) => `mcp__plugin_subzero_subzero__${t}`)]);
    expect(entry.hooks[0]!.command).toContain('bin/subzero\" --bundle agent-hook');
    expect(existsSync(HOOK)).toBe(true);
  });

  it('the server writes its marker with its pid and parent pid once the project resolves, and removes it on exit', async () => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: REPO });
    const root = project(config(['medium']));
    const data = tempDir();
    const server = spawn(process.execPath, [path.join(REPO, 'dist', 'server.js')], {
      cwd: tempDir(),
      env: { ...process.env, SUBZERO_PROJECT_DIR: root, SUBZERO_DATA: data },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const send = (msg: object) => server.stdin.write(JSON.stringify(msg) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const markerDir = (): string[] => {
      const base = path.join(data, 'ready');
      return existsSync(base) ? readdirSync(base).flatMap((k) => readdirSync(path.join(base, k)).map((f) => path.join(base, k, f))) : [];
    };
    await until(() => markerDir().length === 1, 10_000);
    const file = markerDir()[0]!;
    expect(path.basename(file)).toBe(`${server.pid}.json`);
    expect(JSON.parse(execFileSync('cat', [file]).toString())).toMatchObject({ pid: server.pid, ppid: process.pid });

    // A hook run as a child of this process finds the marker and denies.
    const out = execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: 's', tool_name: 'Agent', tool_input: { prompt: 'z', model: 'sonnet' } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, SUBZERO_DATA: data },
    }).toString();
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');

    const exited = new Promise((r) => server.once('exit', r));
    server.stdin.end();
    await exited;
    expect(markerDir()).toEqual([]);
    rmSync(data, { recursive: true, force: true });
  });
});

describe('PreToolUse call markers for subzero tools', () => {
  const AWAIT = 'mcp__plugin_subzero_subzero__await';

  beforeAll(() => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: REPO });
  });

  function run(root: string, data: string, stdin: string): string {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_DATA: data };
    delete env.SUBZERO_DATA;
    return execFileSync(process.execPath, [HOOK], { input: stdin, env }).toString();
  }
  const call = (extra: Record<string, unknown>) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's-1', tool_name: AWAIT, tool_input: { ids: ['sz-1'] }, ...extra });
  const callsFolder = (data: string, root: string) =>
    path.join(data, 'sessions', createHash('sha256').update(root).digest('hex').slice(0, 16), 'calls');

  it('writes a call marker naming the subagent for an await call with an agent id, and allows the call', () => {
    const root = project(config(['medium']));
    const data = tempDir();
    expect(run(root, data, call({ tool_use_id: 'toolu_01abc', agent_id: 'agent-7', agent_type: 'general-purpose' }))).toBe('');
    expect(readCallMarker(data, root, 'toolu_01abc')).toEqual({ agentId: 'agent-7' });
  });

  it('writes a call marker with no agent for the same call from the main conversation, keyed by the tool-use id', () => {
    const root = project(config(['medium']));
    const data = tempDir();
    expect(run(root, data, call({ tool_use_id: 'toolu_01main' }))).toBe('');
    expect(readCallMarker(data, root, 'toolu_01main')).toEqual({});
    expect(readdirSync(callsFolder(data, root))).toEqual(['toolu_01main.json']);
    expect(readCallMarker(data, root, 'toolu_other')).toBeUndefined();
  });

  it('marks delegate and continue calls too', () => {
    const root = project(config(['medium']));
    const data = tempDir();
    for (const tool of ['delegate', 'continue']) {
      expect(run(root, data, call({ tool_name: `mcp__plugin_subzero_subzero__${tool}`, tool_use_id: `toolu_${tool}`, agent_id: 'a' }))).toBe('');
      expect(readCallMarker(data, root, `toolu_${tool}`)).toEqual({ agentId: 'a' });
    }
  });

  it('writes no marker and allows for an unrelated MCP tool or a call with no tool-use id', () => {
    const root = project(config(['medium']));
    const data = tempDir();
    expect(run(root, data, call({ tool_name: 'mcp__other__await', tool_use_id: 'toolu_x' }))).toBe('');
    expect(run(root, data, call({ tool_name: 'mcp__plugin_subzero_subzero__tasks', tool_use_id: 'toolu_y' }))).toBe('');
    expect(run(root, data, call({}))).toBe('');
    expect(run(root, data, call({ tool_use_id: '../escape' }))).toBe('');
    expect(existsSync(path.join(data, 'sessions'))).toBe(false);
  });

  it('allows the call when the data folder cannot be written', () => {
    const root = project(config(['medium']));
    const blocked = tempDir();
    writeFileSync(path.join(blocked, 'sessions'), 'a file where a folder should be');
    expect(run(root, blocked, call({ tool_use_id: 'toolu_z' }))).toBe('');
  });

  it('removes call markers older than an hour when a new one is written', () => {
    const root = project(config(['medium']));
    const data = tempDir();
    writeCallMarker(data, root, 'toolu_old');
    writeCallMarker(data, root, 'toolu_recent');
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    utimesSync(path.join(callsFolder(data, root), 'toolu_old.json'), old, old);
    writeCallMarker(data, root, 'toolu_new', 'a');
    expect(readdirSync(callsFolder(data, root)).sort()).toEqual(['toolu_new.json', 'toolu_recent.json']);
  });
});
