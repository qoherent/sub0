import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgent, loadAgentFile } from '../../src/config/agent-config.js';
import { readParentSessionId } from '../../src/mcp/parent-session.js';
import { DelegationService } from '../../src/service/delegation-service.js';
import { FAKE_PI_COMMAND, GLOBAL_MEDIUM_YAML, fakePiEnv, piKernel, tempDir, useGlobalConfig } from '../helpers.js';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const EXAMPLE = path.join(REPO, 'examples', 'sigil');
const agentFile = (name: string) => readFileSync(path.join(EXAMPLE, 'agents', name), 'utf8');

/** Remove the one routing name so two definitions can be compared. */
const unroute = (text: string, name: string) => text.replace(`\`${name}\``, '`<route>`');

describe('SigilWiring', () => {
  it('puts the three interpreter agents on the default, low and control tiers of the host pi, sharing the r9700 limit', () => {
    const { entries, tiers } = loadAgentFile(EXAMPLE);
    expect([...entries.keys()].sort()).toEqual(['fallback', 'general', 'sigil-interpreter', 'sigil-interpreter-control', 'sigil-interpreter-low']);
    expect([...tiers.keys()]).toEqual(['medium', 'low', 'control']);
    expect(tiers.get('medium')).toEqual({ host: 'pi', model: 'r9700/Qwen3.8', thinking: 'high' });
    expect(tiers.get('low')).toEqual({ host: 'pi', model: 'r9700/Qwen3.8', thinking: 'low' });
    expect(tiers.get('control')).toEqual({ host: 'pi', model: 'anthropic/claude-sonnet-5-5', thinking: 'high' });
    const qwen = getAgent(EXAMPLE, 'sigil-interpreter');
    expect(qwen).toMatchObject({ host: 'pi', model: 'r9700/Qwen3.8', thinking: 'high', parallel: 1 });
    expect(qwen.tools).toEqual(['read', 'grep', 'find', 'ls', 'write']);
    expect(qwen.skills.map((s) => s.folder)).toEqual([path.join(EXAMPLE, 'skills', 'sigil-understand'), path.join(EXAMPLE, 'skills', 'sigil-egglog')]);
    expect(getAgent(EXAMPLE, 'sigil-interpreter-low')).toMatchObject({ host: 'pi', model: 'r9700/Qwen3.8', thinking: 'low', parallel: 1 });
    expect(getAgent(EXAMPLE, 'sigil-interpreter-control')).toMatchObject({ host: 'pi', model: 'anthropic/claude-sonnet-5-5', thinking: 'high', parallel: null });
  });

  it('keeps the demo reviewer working on the default tier', () => {
    expect(getAgent(path.join(REPO, 'examples', 'demo'), 'reviewer')).toMatchObject({
      host: 'pi',
      model: 'r9700/Qwen3.8',
      thinking: 'low',
      tools: ['read', 'grep', 'find', 'ls'],
      timeout: 600,
      parallel: 1,
    });
  });

  it('keeps the B evaluators identical except for the interpreter they route to, and disallows Agent', () => {
    const b = unroute(agentFile('evaluator-b.md'), 'sigil-interpreter');
    expect(unroute(agentFile('evaluator-b-control.md'), 'sigil-interpreter-control')).toBe(b);
    expect(unroute(agentFile('evaluator-b-low.md'), 'sigil-interpreter-low')).toBe(b);
    expect(b).toMatch(/^disallowedTools: Agent$/m);
    expect(b).toContain('mcp__plugin_subzero_subzero__delegate');
  });

  it('keeps the A evaluators identical except for the interpreter subagent, with the Agent tool', () => {
    const a = unroute(agentFile('evaluator-a.md'), 'interpreter');
    expect(unroute(agentFile('evaluator-a-cheap.md'), 'interpreter-cheap')).toBe(a);
    expect(a).not.toMatch(/disallowedTools/);
    expect(agentFile('interpreter-a-cheap.md')).toMatch(/^model: haiku$/m);
  });

  it('puts the answer-file rule and the brief fields in every evaluator', () => {
    for (const file of ['evaluator-a.md', 'evaluator-b.md']) {
      const text = agentFile(file);
      expect(text).toContain('Write your claim rows to exactly that answer file');
      expect(text).toMatch(/request path, the binding path and every guidance path/);
      expect(text).toMatch(/exact answer file path, and the round/);
    }
  });
});

describe('global file only', () => {
  it('covers AE2: runs one delegation end to end against the fake pi with a global file and no project file', async () => {
    useGlobalConfig(GLOBAL_MEDIUM_YAML);
    const root = tempDir('subzero-project-');
    const fake = fakePiEnv();
    const svc = new DelegationService({
      env: { SUBZERO_PROJECT_DIR: root },
      warn: () => {},
      kernel: piKernel({ piCommand: FAKE_PI_COMMAND, env: fake.env, piAgentDir: tempDir() }).kernel,
    });
    const reply = await svc.delegate({ briefText: 'go' }, { wait: true });
    expect(reply).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    const argv = fake.log()[0].argv as string[];
    expect(argv[argv.indexOf('--model') + 1]).toBe('local/global-medium');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('read,bash,edit,write,grep,find,ls');
  });
});

describe('SessionStart hook', () => {
  it('records the session id that the server reads for the project', () => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: REPO });
    const data = tempDir();
    const project = tempDir();
    execFileSync(process.execPath, [path.join(REPO, 'dist', 'hook.js')], {
      input: JSON.stringify({ session_id: 'abc-123', cwd: project, source: 'startup' }),
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: project },
    });
    expect(readParentSessionId(data, project, process.pid)).toBe('abc-123');
  });
});

describe('SessionStart hook routing output', () => {
  const MEDIUM = `models:
  tiers:
    default: { host: pi, model: local/d, thinking: low }
    medium: { host: pi, model: local/m, thinking: low }
agents:
  general:
    tools: [read]
    timeout: 60
  fallback:
    tools: [read]
    timeout: 60
`;

  function runHook(project: string | undefined, yaml: string | undefined, input: Record<string, unknown> = {}, data = tempDir()) {
    execFileSync(process.execPath, ['build.mjs'], { cwd: REPO });
    if (project !== undefined && yaml !== undefined) {
      mkdirSync(path.join(project, '.agents'), { recursive: true });
      writeFileSync(path.join(project, '.agents', 'subzero.yaml'), yaml);
    }
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PLUGIN_DATA: data };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.SUBZERO_DATA;
    if (project !== undefined) env.CLAUDE_PROJECT_DIR = project;
    const stdout = execFileSync(process.execPath, [path.join(REPO, 'dist', 'hook.js')], {
      input: JSON.stringify({ session_id: 's-1', source: 'startup', ...input }),
      env,
    }).toString();
    return { stdout, data };
  }

  it('prints the routing text as additionalContext JSON and still records the session id when tiers exist', () => {
    const project = tempDir();
    const { stdout, data } = runHook(project, MEDIUM);
    const out = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('mcp__plugin_subzero_subzero__delegate');
    expect(out.hookSpecificOutput.additionalContext).toContain('tier: "medium"');
    expect(out.hookSpecificOutput.additionalContext).toMatch(/delegate\(tier, brief\) in one message; it runs in the background/);
    expect(out.hookSpecificOutput.additionalContext).not.toMatch(/if it returns a task id, collect it/i);
    expect(out.hookSpecificOutput.additionalContext.length).toBeLessThan(3000);
    expect(readParentSessionId(data, project, process.pid)).toBe('s-1');
  });

  it('adds no routing text when it cannot record the session', () => {
    const data = path.join(tempDir(), 'not-a-directory');
    writeFileSync(data, 'file');
    expect(runHook(tempDir(), MEDIUM, {}, data).stdout).toBe('');
  });

  it.each([undefined, null, 42, '', '   '])('adds no routing text for an invalid session id %s', (session_id) => {
    expect(runHook(tempDir(), MEDIUM, { session_id }).stdout).toBe('');
  });

  it('R15: still prints the routing text with routing.hook false', () => {
    const { stdout } = runHook(tempDir(), `routing:\n  hook: false\n${MEDIUM}`);
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain('tier: "medium"');
  });

  it('warns when the required tier is missing and still records the session id', () => {
    const project = tempDir();
    const { stdout, data } = runHook(project, 'endpoints: {}\n');
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toMatch(/medium.*required/);
    expect(readParentSessionId(data, project, process.pid)).toBe('s-1');
  });

  it('warns for a default tier only and prints nothing when the file is absent', () => {
    expect(JSON.parse(runHook(tempDir(), 'models:\n  tiers:\n    default: { host: pi, model: a/b, thinking: low }\n').stdout).hookSpecificOutput.additionalContext).toMatch(/medium.*required/);
    expect(runHook(tempDir(), undefined).stdout).toBe('');
  });

  it('prints a one-line warning as additionalContext for a malformed agent file and exits 0', () => {
    const { stdout } = runHook(tempDir(), 'agents: [oops\n');
    const out = JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext).not.toContain('\n');
    expect(out.hookSpecificOutput.additionalContext).toMatch(/routing is off/i);
  });

  it('AE2: prints the routing text for a project with no file when the global file has a medium tier', () => {
    const global = path.join(tempDir(), 'subzero.yaml');
    writeFileSync(global, 'models:\n  tiers:\n    medium: { host: pi, model: local/gm, thinking: low }\n');
    const prior = process.env.SUBZERO_GLOBAL_CONFIG;
    process.env.SUBZERO_GLOBAL_CONFIG = global;
    try {
      const { stdout } = runHook(tempDir(), undefined);
      expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain('model local/gm');
    } finally {
      process.env.SUBZERO_GLOBAL_CONFIG = prior;
    }
  });

  it('prints nothing with no project directory in the environment or the input', () => {
    expect(runHook(undefined, undefined).stdout).toBe('');
  });

  it('does not fall back to the cwd of the input: with CLAUDE_PROJECT_DIR unset it prints nothing and records no session id', () => {
    const project = tempDir();
    mkdirSync(path.join(project, '.agents'), { recursive: true });
    writeFileSync(path.join(project, '.agents', 'subzero.yaml'), MEDIUM);
    const { stdout, data } = runHook(undefined, undefined, { cwd: project });
    expect(stdout).toBe('');
    expect(readParentSessionId(data, project, process.pid)).toBeUndefined();
    expect(existsSync(path.join(data, 'sessions'))).toBe(false);
  });
});
