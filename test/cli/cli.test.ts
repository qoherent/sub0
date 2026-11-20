import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/cli.js';
import { getAgent } from '../../src/config/agent-config.js';
import { unavailableUsage } from '../../src/core/types.js';
import { Kernel } from '../../src/kernel/kernel.js';
import { TaskStore } from '../../src/store/task-store.js';
import { DEFAULT_YAML, FAKE_PI_COMMAND, fakePiEnv, kernelWithPort, makeProject, piKernel, tempDir } from '../helpers.js';

function cli(root: string, scenario: Record<string, unknown> = {}) {
  const fake = fakePiEnv(scenario);
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) =>
    runCli(argv, { out: (t) => out.push(t), err: (t) => err.push(t) }, {
      env: { SUBZERO_PROJECT_DIR: root },
      warn: () => {},
      interactive: false,
      kernel: piKernel({ piCommand: FAKE_PI_COMMAND, env: fake.env, piAgentDir: tempDir() }).kernel,
    });
  return { run, out, err, fake };
}

describe('Cli', () => {
  it('subzero run writes task.json, events.jsonl, turns/1.json and an index line, and prints the result', async () => {
    const root = makeProject();
    const { run, out } = cli(root);
    expect(await run('run', '--agent', 'helper', 'do', 'the', 'thing')).toBe(0);
    expect(out.join('\n')).toMatch(/^task: (sz-[a-z2-7]{6}) · helper · status: completed/);
    const taskId = /sz-[a-z2-7]{6}/.exec(out[0]!)![0];
    const dir = path.join(root, '.agents', 'subzero', 'tasks', taskId);
    for (const file of ['task.json', 'events.jsonl', path.join('turns', '1.json')]) expect(existsSync(path.join(dir, file))).toBe(true);
    const index = readFileSync(path.join(root, '.agents', 'subzero', 'index.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(index.map((l) => JSON.parse(l).status)).toEqual(['running', 'completed']);
    expect(JSON.parse(index[0]!).parentSessionId).toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(dir, 'task.json'), 'utf8')).brief).toBe('do the thing');
  });

  it('prints a long final message whole and tells the child no reply size', async () => {
    const root = makeProject();
    const long = 'FINDING-'.repeat(2500);
    const { run, out } = cli(root, { lastText: long });
    expect(await run('run', '--agent', 'helper', 'go')).toBe(0);
    const text = out.join('\n');
    expect(text).toContain(`summary:\n${long}\nusage:`);
    expect(text).not.toMatch(/\[subzero|cut/);
    const taskId = /sz-[a-z2-7]{6}/.exec(text)![0];
    const record = JSON.parse(readFileSync(path.join(root, '.agents', 'subzero', 'tasks', taskId, 'task.json'), 'utf8'));
    expect(record.brief).toBe('go');
    expect(record.brief).not.toMatch(/Reply size/);
  });

  it('says on stdout that the named agent is not configured when the fallback agent ran instead', async () => {
    const root = makeProject(DEFAULT_YAML);
    const { run, out } = cli(root);
    expect(await run('run', '--agent', 'reviewr', 'x')).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/^task: sz-[a-z2-7]{6} · fallback · status: completed\nnotice: the agent "reviewr" is not configured, so the fallback agent ran instead; configured agents: /);
    const { run: run2, out: out2 } = cli(root);
    expect(await run2('run', '--agent', 'helper', 'x')).toBe(0);
    expect(out2.join('\n')).not.toMatch(/notice:/);
  });

  it('runs general with no --agent option, and a lone argument is always the brief', async () => {
    const root = makeProject(DEFAULT_YAML);
    const { run, out } = cli(root);
    expect(await run('run', 'helper')).toBe(0);
    expect(out[0]).toMatch(/^task: sz-[a-z2-7]{6} · general · status: completed/);
    const taskId = /sz-[a-z2-7]{6}/.exec(out[0]!)![0];
    expect(JSON.parse(readFileSync(path.join(root, '.agents', 'subzero', 'tasks', taskId, 'task.json'), 'utf8')).brief).toBe('helper');
  });

  it('runs general at the default tier with the host, model and thinking of that tier', async () => {
    const root = makeProject(DEFAULT_YAML);
    const { run, out } = cli(root);
    await run('run', 'go');
    const taskId = /sz-[a-z2-7]{6}/.exec(out[0]!)![0];
    const frozen = JSON.parse(readFileSync(path.join(root, '.agents', 'subzero', 'tasks', taskId, 'task.json'), 'utf8')).agent;
    expect(frozen).toMatchObject({ name: 'general', host: 'pi', model: 'local/qwen', thinking: 'high' });
  });

  it('with no --agent and no general entry runs the built-in general agent with the starter tools of pi', async () => {
    const root = makeProject(DEFAULT_YAML.replace(/  general:\n    tools: \[read, bash, write, edit\]\n    timeout: 9\n/, ''));
    const { run, out, fake } = cli(root);
    expect(await run('run', 'do it')).toBe(0);
    expect(out[0]).toMatch(/^task: sz-[a-z2-7]{6} · general · status: completed/);
    const argv = fake.log()[0].argv as string[];
    expect(argv[argv.indexOf('--tools') + 1]).toBe('read,bash,edit,write,grep,find,ls');
  });

  it('prints the usage when run has no brief or an unknown option', async () => {
    const { run, err } = cli(makeProject());
    expect(await run('run', '--agent', 'helper')).toBe(2);
    expect(await run('run', '--agnt', 'helper', 'x')).toBe(2);
    expect(err.join('\n')).toMatch(/usage/);
  });

  it('lists tasks with id, agent, status and creation time', async () => {
    const root = makeProject();
    const { run, out } = cli(root);
    await run('run', '--agent', 'helper', 'x');
    out.length = 0;
    expect(await run('tasks')).toBe(0);
    expect(out[0]).toMatch(/^sz-[a-z2-7]{6} {2}helper {2}completed {2}\d{4}-/);
  });

  it('lists a task with no start time as queued, not launched, and one with a start time as running', async () => {
    const root = makeProject();
    const store = new TaskStore(root);
    const agent = { name: 'helper' } as never;
    store.createTaskRecord({ taskId: 'sz-queued', agent, brief: 'b', createdAt: new Date().toISOString() });
    store.createTaskRecord({ taskId: 'sz-runnin', agent, brief: 'b', createdAt: new Date().toISOString() });
    store.writeStartTime('sz-runnin', new Date().toISOString());
    const { run, out } = cli(root);
    expect(await run('tasks')).toBe(0);
    const queued = out.find((l) => l.startsWith('sz-queued'))!;
    expect(queued).toMatch(/queued, not launched yet/);
    expect(queued).not.toMatch(/running, started/);
    expect(out.find((l) => l.startsWith('sz-runnin'))).toMatch(/running, started /);
  });

  it('refuses attach on a queued task as not launched yet, and on a started one as running', async () => {
    const root = makeProject();
    const store = new TaskStore(root);
    const agent = { name: 'helper' } as never;
    store.createTaskRecord({ taskId: 'sz-queued', agent, brief: 'b', createdAt: new Date().toISOString() });
    store.createTaskRecord({ taskId: 'sz-runnin', agent, brief: 'b', createdAt: new Date().toISOString() });
    store.writeStartTime('sz-runnin', new Date().toISOString());
    const { run, err } = cli(root);
    expect(await run('attach', 'sz-queued')).toBe(1);
    expect(err.at(-1)).toMatch(/task sz-queued is queued, not launched yet/);
    expect(err.at(-1)).not.toMatch(/task sz-queued is running/);
    expect(await run('attach', 'sz-runnin')).toBe(1);
    expect(err.at(-1)).toMatch(/task sz-runnin is running, started .* ago\)/);
  });

  it('builds the attach command from the launch spec of a settled task', async () => {
    const root = makeProject();
    const { run, out } = cli(root);
    await run('run', '--agent', 'helper', 'x');
    const taskId = /sz-[a-z2-7]{6}/.exec(out[0]!)![0];
    out.length = 0;
    expect(await run('attach', taskId)).toBe(0);
    expect(out[0]).toContain(`--session-id ${taskId}`);
    expect(out[0]).not.toMatch(/--mode rpc|--session /);
  });

  it('refuses attach while the task is running, and when no launch spec was recorded', async () => {
    const root = makeProject();
    const store = new TaskStore(root);
    store.createTaskRecord({ taskId: 'sz-runnin', agent: { name: 'helper' } as never, brief: 'b', createdAt: new Date().toISOString() });
    const { run, err } = cli(root);
    expect(await run('attach', 'sz-runnin')).toBe(1);
    expect(err.at(-1)).toMatch(/is running/);

    store.writeResult('sz-runnin', { taskId: 'sz-runnin', agent: 'helper', status: 'failed', failureKind: 'skill_mismatch' });
    expect(await run('attach', 'sz-runnin')).toBe(1);
    expect(err.at(-1)).toMatch(/no launch spec was recorded/);
  });

  it('exports the child session with pi --export', async () => {
    const root = makeProject();
    const { run, out } = cli(root);
    await run('run', '--agent', 'helper', 'x');
    const taskId = /sz-[a-z2-7]{6}/.exec(out[0]!)![0];
    const html = path.join(tempDir(), 'out.html');
    expect(await run('show', taskId, '-o', html)).toBe(0);
    expect(readFileSync(html, 'utf8')).toContain(`${taskId}.jsonl`);
  });

  it('says that an abandoned task has no result', async () => {
    const root = makeProject();
    new TaskStore(root, { owner: { pid: 999_999, startTime: 'then' } }).createTaskRecord({
      taskId: 'sz-abandd',
      agent: { name: 'helper' } as never,
      brief: 'b',
      createdAt: new Date().toISOString(),
    });
    const { run, out } = cli(root);
    await run('show', 'sz-abandd');
    expect(out[0]).toMatch(/abandoned.*no result/);
  });

  describe('init', () => {
    const FULL = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
    const READ_ONLY = ['read', 'grep', 'find', 'ls'];
    const agentFile = (root: string) => path.join(root, '.agents', 'subzero.yaml');

    it('creates the agent file from a model alone, with the one registered host (AE13)', async () => {
      const root = tempDir();
      const { run, out } = cli(root);
      expect(await run('init', 'r9700/Qwen3.8')).toBe(0);
      expect(out.join('\n')).toMatch(/added.*medium.*general.*fallback/s);
      expect(getAgent(root, 'general')).toMatchObject({ host: 'pi', model: 'r9700/Qwen3.8', thinking: 'medium', timeout: 1200, tools: FULL, skills: [] });
      expect(getAgent(root, 'fallback')).toMatchObject({ tools: READ_ONLY, timeout: 1200 });
    });

    it('takes --timeout, --thinking and --host', async () => {
      const root = tempDir();
      const { run } = cli(root);
      expect(await run('init', 'm/x', '--host', 'pi', '--timeout', '90', '--thinking', 'high')).toBe(0);
      expect(getAgent(root, 'general')).toMatchObject({ thinking: 'high', timeout: 90 });
    });

    it('changes nothing when run again, and says all three entries are already there', async () => {
      const root = tempDir();
      const { run, out } = cli(root);
      await run('init', 'm/x');
      const before = readFileSync(agentFile(root), 'utf8');
      out.length = 0;
      expect(await run('init', 'm/y')).toBe(0);
      expect(readFileSync(agentFile(root), 'utf8')).toBe(before);
      expect(out.join('\n')).toMatch(/all three entries.*already there/);
    });

    it('adds only the fallback agent beside an existing general agent, leaving its lines alone', async () => {
      const text = `models:\n  tiers:\n    medium: { host: pi, model: a/b, thinking: low }\nagents:\n  general:\n    tools: [read]\n    timeout: 7\n`;
      const root = makeProject(text);
      const { run, out } = cli(root);
      expect(await run('init', 'm/x')).toBe(0);
      expect(readFileSync(agentFile(root), 'utf8').startsWith(text)).toBe(true);
      expect(getAgent(root, 'general')).toMatchObject({ timeout: 7, tools: ['read'], model: 'a/b' });
      expect(getAgent(root, 'fallback').tools).toEqual(READ_ONLY);
      expect(out.join('\n')).toMatch(/added.*fallback/s);
    });

    it('refuses naming both hosts, exits non-zero and writes nothing when default is on another host', async () => {
      const text = `models:\n  tiers:\n    medium: { host: claude, model: a/b, thinking: low }\nagents:\n  general:\n    tools: [read]\n    timeout: 7\n`;
      const root = makeProject(text);
      const { run, err } = cli(root);
      expect(await run('init', 'm/x', '--host', 'pi')).toBe(1);
      expect(err.join('\n')).toMatch(/claude.*pi/);
      expect(readFileSync(agentFile(root), 'utf8')).toBe(text);
    });

    it('adds the default tier to a file that holds agents and no default tier', async () => {
      const text = `agents:\n  general:\n    tools: [read]\n    timeout: 7\n`;
      const root = makeProject(text);
      const { run } = cli(root);
      expect(await run('init', 'm/x')).toBe(0);
      expect(getAgent(root, 'general').model).toBe('m/x');
    });

    it('prints the load error, exits non-zero and writes nothing when the file does not load', async () => {
      const text = `models:\n  tiers:\n    medium: { host: pi, model: a/b, thinking: low }\nagents:\n  a:\n    description: d\n    tools: [read]\n`;
      const root = makeProject(text);
      const { run, err } = cli(root);
      expect(await run('init', 'm/x')).toBe(1);
      expect(err.join('\n')).toMatch(/agent "a": timeout/);
      expect(readFileSync(agentFile(root), 'utf8')).toBe(text);
    });

    it('prints exactly what it added for a model alone (AE1)', async () => {
      const root = tempDir();
      const { run, out, err } = cli(root);
      expect(await run('init', 'local/qwen')).toBe(0);
      expect(out).toEqual(['added the medium tier, the general agent, the fallback agent']);
      expect(err).toEqual([]);
      expect(getAgent(root, 'general')).toMatchObject({ model: 'local/qwen', thinking: 'medium' });
    });

    it('without a model, points to the guided init of both parents and writes nothing', async () => {
      const root = tempDir();
      const { run, out, err } = cli(root);
      expect(await run('init')).toBe(2);
      const message = err.join('\n');
      expect(message).toContain('/subzero:init');
      expect(message).toContain('/subzero init');
      expect(message).toMatch(/Claude Code/);
      expect(message).toMatch(/\bpi\b/);
      err.length = 0;
      expect(await run('init', '--thinking', 'high')).toBe(2);
      expect(err.join('\n')).toContain('/subzero:init');
      expect(out).toEqual([]);
      expect(existsSync(agentFile(root))).toBe(false);
    });

    it('refuses without a model, with a bad timeout or a bad thinking level, writing nothing', async () => {
      const root = tempDir();
      const { run, err } = cli(root);
      expect(await run('init')).toBe(2);
      expect(await run('init', 'm/x', '--timeout', 'soon')).toBe(2);
      expect(await run('init', 'm/x', '--thinking', 'deep')).toBe(2);
      expect(err.join('\n')).toMatch(/thinking.*off, minimal, low, medium, high, xhigh, max/);
      expect(existsSync(agentFile(root))).toBe(false);
    });

    function withKernel(root: string, kernel: Kernel) {
      const err: string[] = [];
      const run = (...argv: string[]) =>
        runCli(argv, { out: () => {}, err: (t) => err.push(t) }, { env: { SUBZERO_PROJECT_DIR: root }, warn: () => {}, interactive: false, kernel });
      return { run, err };
    }

    it('refuses when no host is registered', async () => {
      const root = tempDir();
      const { run, err } = withKernel(root, new Kernel());
      expect(await run('init', 'm/x')).toBe(1);
      expect(err.join('\n')).toMatch(/no host is registered/);
      expect(existsSync(agentFile(root))).toBe(false);
    });

    it('refuses naming every supported host when several are registered and none is given, or the host is unsupported', async () => {
      const root = tempDir();
      const kernel = new Kernel();
      const driver = { port: { start: () => { throw new Error('unused'); } }, starterTools: () => ({ general: ['g'], fallback: ['f'] }) };
      kernel.registerChildDriver('pi', driver);
      kernel.registerChildDriver('codex', driver);
      const { run, err } = withKernel(root, kernel);
      expect(await run('init', 'm/x')).toBe(1);
      expect(err.at(-1)).toMatch(/pi, codex/);
      expect(await run('init', 'm/x', '--host', 'acp')).toBe(1);
      expect(err.at(-1)).toMatch(/"acp".*pi, codex/);
      expect(existsSync(agentFile(root))).toBe(false);
      expect(await run('init', 'm/x', '--host', 'codex')).toBe(0);
      expect(getAgent(root, 'general')).toMatchObject({ host: 'codex', tools: ['g'] });
      expect(getAgent(root, 'fallback').tools).toEqual(['f']);
    });

    describe('the prerequisites check (AE2)', () => {
      const withPi = (root: string, piCommand: string[]) => {
        const out: string[] = [];
        const err: string[] = [];
        const run = (...argv: string[]) =>
          runCli(argv, { out: (t) => out.push(t), err: (t) => err.push(t) }, {
            env: { SUBZERO_PROJECT_DIR: root },
            warn: () => {},
            interactive: false,
            kernel: piKernel({ piCommand, piAgentDir: tempDir() }).kernel,
          });
        return { run, out, err };
      };

      it('says pi is missing and what to do, exits non-zero and writes nothing, when the pi command does not exist', async () => {
        const root = tempDir();
        const { run, out, err } = withPi(root, [path.join(tempDir(), 'no-such-pi')]);
        expect(await run('init', 'm/x')).toBe(1);
        expect(err.join('\n')).toMatch(/pi.*not found.*install pi and run `subzero init` again/s);
        expect(out).toEqual([]);
        expect(existsSync(agentFile(root))).toBe(false);
      });

      it('fails the same way when the pi command exits non-zero, leaving an existing agent file as it was', async () => {
        const text = `agents:\n  general:\n    tools: [read]\n    timeout: 7\n`;
        const root = makeProject(text);
        const broken = path.join(tempDir(), 'broken-pi.mjs');
        writeFileSync(broken, 'process.exit(3);\n');
        const { run, err } = withPi(root, [process.execPath, broken]);
        expect(await run('init', 'm/x')).toBe(1);
        expect(err.join('\n')).toMatch(/pi.*did not run.*install pi and run `subzero init` again/s);
        expect(readFileSync(agentFile(root), 'utf8')).toBe(text);
      });

      it('passes with the fake pi and writes the starter entries as before', async () => {
        const root = tempDir();
        const { run, err } = withPi(root, FAKE_PI_COMMAND);
        expect(await run('init', 'm/x')).toBe(0);
        expect(err).toEqual([]);
        expect(getAgent(root, 'general')).toMatchObject({ host: 'pi', model: 'm/x', tools: FULL });
      });

      it('lets init continue when the child driver of the host has no check', async () => {
        const root = tempDir();
        const kernel = new Kernel();
        kernel.registerChildDriver('pi', { port: { start: () => { throw new Error('unused'); } }, starterTools: () => ({ general: ['g'], fallback: ['f'] }) });
        const { run } = withKernel(root, kernel);
        expect(await run('init', 'm/x')).toBe(0);
        expect(getAgent(root, 'general').tools).toEqual(['g']);
      });

      it('stops with the message of the check of the chosen host only, before writing', async () => {
        const root = tempDir();
        const kernel = new Kernel();
        const starterTools = () => ({ general: ['g'], fallback: ['f'] });
        const port = { start: () => { throw new Error('unused'); } };
        kernel.registerChildDriver('pi', { port, starterTools, prerequisites: () => 'pi is not here' });
        kernel.registerChildDriver('codex', { port, starterTools, prerequisites: () => undefined });
        const { run, err } = withKernel(root, kernel);
        expect(await run('init', 'm/x', '--host', 'pi')).toBe(1);
        expect(err.join('\n')).toContain('pi is not here');
        expect(existsSync(agentFile(root))).toBe(false);
        expect(await run('init', 'm/x', '--host', 'codex')).toBe(0);
      });

      it('keeps the unsupported-host error for a host nobody registered', async () => {
        const root = tempDir();
        const { run, err } = withPi(root, [path.join(tempDir(), 'no-such-pi')]);
        expect(await run('init', 'm/x', '--host', 'acp')).toBe(1);
        expect(err.join('\n')).toMatch(/"acp".*not supported/);
        expect(existsSync(agentFile(root))).toBe(false);
      });
    });

    it('refuses naming the host when its child driver offers no starter tools', async () => {
      const root = tempDir();
      const { run, err } = withKernel(root, kernelWithPort({ start: () => { throw new Error('unused'); } }));
      expect(await run('init', 'm/x')).toBe(1);
      expect(err.join('\n')).toMatch(/host "?pi"? offers no starter tools/);
      expect(existsSync(agentFile(root))).toBe(false);
    });
  });

  describe('through the driver registry', () => {
    /** A settled task of the host pi, with a launch spec and a child session, written by hand. */
    function settledTask(root: string) {
      const store = new TaskStore(root);
      const agent = { name: 'helper', host: 'pi' } as never;
      store.createTaskRecord({ taskId: 'sz-settle', agent, brief: 'b', createdAt: new Date().toISOString() });
      store.writeLaunchSpec('sz-settle', { command: ['x', '--mode', 'rpc'], cwd: root, envNames: [], version: '1', skillFolders: [], thinkingLevel: 'low' });
      store.writeResult('sz-settle', { taskId: 'sz-settle', agent: 'helper', status: 'completed', usage: unavailableUsage('n/a') }, { sessionFile: '/s/sz-settle.jsonl' });
    }
    const bare = (root: string) => {
      const out: string[] = [];
      const err: string[] = [];
      const run = (...argv: string[]) =>
        runCli(argv, { out: (t) => out.push(t), err: (t) => err.push(t) }, {
          env: { SUBZERO_PROJECT_DIR: root },
          warn: () => {},
          interactive: false,
          kernel: kernelWithPort({ start: () => { throw new Error('no child is started here'); } }),
        });
      return { run, out, err };
    };

    it('refuses attach and show naming the host when its driver offers neither', async () => {
      const root = makeProject();
      settledTask(root);
      const { run, err } = bare(root);
      expect(await run('attach', 'sz-settle')).toBe(1);
      expect(err.at(-1)).toMatch(/host pi offers no attach command/);
      expect(await run('show', 'sz-settle')).toBe(1);
      expect(err.at(-1)).toMatch(/host pi offers no session export/);
    });

    it('refuses attach and show naming the host and the supported hosts when no driver is registered for it', async () => {
      const root = makeProject();
      settledTask(root);
      const err: string[] = [];
      const run = (...argv: string[]) =>
        runCli(argv, { out: () => {}, err: (t) => err.push(t) }, { env: { SUBZERO_PROJECT_DIR: root }, warn: () => {}, interactive: false, kernel: new Kernel() });
      expect(await run('attach', 'sz-settle')).toBe(1);
      expect(err.at(-1)).toMatch(/"pi".*supported hosts: \(none\)/);
      expect(await run('show', 'sz-settle')).toBe(1);
      expect(err.at(-1)).toMatch(/"pi".*supported hosts: \(none\)/);
    });
  });
});
