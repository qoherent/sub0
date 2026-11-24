import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../helpers.js';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const SHIM_SOURCE = path.join(REPO, 'bin', 'subzero');
const SYSTEM_PATH = '/usr/bin:/bin';

/** A stub bundle: prints a JSON record of how it was run, then exits with STUB_STATUS. */
const STUB_BUNDLE = `
process.stdout.write(JSON.stringify({
  bundle: import.meta.filename.split('/').pop(),
  args: process.argv.slice(2),
  projectDir: process.env.SUBZERO_PROJECT_DIR ?? null,
}) + '\\n');
process.exit(Number(process.env.STUB_STATUS ?? 0));
`;

/** A plugin-like tree: the shim copied into bin/ with stub bundles in dist/. */
function pluginTree(): string {
  const root = tempDir('subzero-shim-');
  mkdirSync(path.join(root, 'bin'));
  mkdirSync(path.join(root, 'dist'));
  copyFileSync(SHIM_SOURCE, path.join(root, 'bin', 'subzero'));
  chmodSync(path.join(root, 'bin', 'subzero'), 0o755);
  for (const name of ['cli', 'server', 'hook', 'agent-hook', 'wake-hook', 'prompt-hook']) writeFileSync(path.join(root, 'dist', `${name}.js`), STUB_BUNDLE);
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  return root;
}

/** A directory holding a `node` shell script that reports `version` and otherwise runs the real node. */
function stubNode(version: string): string {
  const dir = tempDir('subzero-stubnode-');
  const file = path.join(dir, 'node');
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nexec "${process.execPath}" "$@"\n`);
  chmodSync(file, 0o755);
  return dir;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runShim(shim: string, args: string[], env: Record<string, string | undefined>, cwd = tempDir()): Run {
  const result = spawnSync('sh', [shim, ...args], {
    cwd,
    encoding: 'utf8',
    env: { HOME: process.env.HOME, SUBZERO_GLOBAL_CONFIG: process.env.SUBZERO_GLOBAL_CONFIG, ...env } as NodeJS.ProcessEnv,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const REAL_NODE_PATH = `${path.dirname(process.execPath)}:${SYSTEM_PATH}`;
const record = (run: Run) => JSON.parse(run.stdout.trim()) as { bundle: string; args: string[]; projectDir: string | null };

describe('bin/subzero shim', () => {
  it('exists and is executable', () => {
    expect(existsSync(SHIM_SOURCE)).toBe(true);
    expect(readFileSync(SHIM_SOURCE, 'utf8').startsWith('#!/bin/sh\n')).toBe(true);
    expect(spawnSync('test', ['-x', SHIM_SOURCE]).status).toBe(0);
  });

  it('passes its arguments to dist/cli.js under a Node 22 or later and returns the exit status', () => {
    const root = pluginTree();
    const path_ = `${stubNode('v22.3.0')}:${SYSTEM_PATH}`;
    const ok = runShim(path.join(root, 'bin', 'subzero'), ['init', 'local/qwen', '--thinking', 'low'], { PATH: path_ });
    expect(ok.status).toBe(0);
    expect(record(ok)).toMatchObject({ bundle: 'cli.js', args: ['init', 'local/qwen', '--thinking', 'low'] });
    const failed = runShim(path.join(root, 'bin', 'subzero'), ['tasks'], { PATH: path_, STUB_STATUS: '3' });
    expect(failed.status).toBe(3);
  });

  it('accepts a later major version and a version without the v prefix', () => {
    const root = pluginTree();
    for (const version of ['v24.1.0', '22.0.0']) {
      const run = runShim(path.join(root, 'bin', 'subzero'), ['tasks'], { PATH: `${stubNode(version)}:${SYSTEM_PATH}` });
      expect(run.status).toBe(0);
    }
  });

  it('prints one line naming Node 22 and exits non-zero without running the CLI under Node 20', () => {
    const root = pluginTree();
    const run = runShim(path.join(root, 'bin', 'subzero'), ['tasks'], { PATH: `${stubNode('v20.11.1')}:${SYSTEM_PATH}` });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe('');
    const lines = run.stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Node(\.js)? 22/);
    expect(lines[0]).toContain('v20.11.1');
  });

  it('prints one line naming Node and exits non-zero when there is no node on PATH', () => {
    expect(spawnSync('sh', ['-c', 'command -v node'], { env: { PATH: SYSTEM_PATH } }).status).not.toBe(0);
    const root = pluginTree();
    const run = runShim(path.join(root, 'bin', 'subzero'), ['tasks'], { PATH: SYSTEM_PATH });
    expect(run.status).not.toBe(0);
    const lines = run.stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Node(\.js)? 22/);
    expect(lines[0]).toMatch(/not found/);
  });

  it('finds the plugin root through a symlink and from another directory', () => {
    const root = pluginTree();
    const links = tempDir('subzero-links-');
    symlinkSync(path.join(root, 'bin', 'subzero'), path.join(links, 'subzero'));
    // A link to a link, to exercise the resolution loop.
    symlinkSync(path.join(links, 'subzero'), path.join(links, 'second'));
    for (const name of ['subzero', 'second']) {
      const run = runShim(path.join(links, name), ['tasks'], { PATH: REAL_NODE_PATH }, tempDir());
      expect(run.status).toBe(0);
      expect(record(run)).toMatchObject({ bundle: 'cli.js', args: ['tasks'] });
    }
  });

  it('works from a plugin root whose path contains a space', () => {
    const root = pluginTree();
    const spaced = path.join(tempDir('subzero-space-'), 'plugin root');
    mkdirSync(spaced);
    mkdirSync(path.join(spaced, 'bin'));
    mkdirSync(path.join(spaced, 'dist'));
    copyFileSync(path.join(root, 'bin', 'subzero'), path.join(spaced, 'bin', 'subzero'));
    copyFileSync(path.join(root, 'dist', 'cli.js'), path.join(spaced, 'dist', 'cli.js'));
    writeFileSync(path.join(spaced, 'package.json'), '{"type":"module"}');
    const run = runShim(path.join(spaced, 'bin', 'subzero'), ['tasks'], { PATH: REAL_NODE_PATH });
    expect(run.status).toBe(0);
  });

  it('forwards CLAUDE_PROJECT_DIR as SUBZERO_PROJECT_DIR only when the latter is unset', () => {
    const root = pluginTree();
    const shim = path.join(root, 'bin', 'subzero');
    const forwarded = runShim(shim, ['tasks'], { PATH: REAL_NODE_PATH, CLAUDE_PROJECT_DIR: '/claude/project' });
    expect(record(forwarded).projectDir).toBe('/claude/project');
    const kept = runShim(shim, ['tasks'], { PATH: REAL_NODE_PATH, CLAUDE_PROJECT_DIR: '/claude/project', SUBZERO_PROJECT_DIR: '/own/project' });
    expect(record(kept).projectDir).toBe('/own/project');
    const neither = runShim(shim, ['tasks'], { PATH: REAL_NODE_PATH });
    expect(record(neither).projectDir).toBeNull();
  });

  it('runs dist/server.js, dist/hook.js and dist/agent-hook.js for --bundle, with the arguments of the caller', () => {
    const root = pluginTree();
    const shim = path.join(root, 'bin', 'subzero');
    for (const [mode, file] of [
      ['server', 'server.js'],
      ['hook', 'hook.js'],
      ['agent-hook', 'agent-hook.js'],
      ['wake-hook', 'wake-hook.js'],
      ['prompt-hook', 'prompt-hook.js'],
    ] as const) {
      const run = runShim(shim, ['--bundle', mode, 'one', '--two'], { PATH: REAL_NODE_PATH, STUB_STATUS: '4' });
      expect(record(run)).toEqual({ bundle: file, args: ['one', '--two'], projectDir: null });
      expect(run.status).toBe(4);
    }
  });

  it('gives a hook bundle the standard input of the caller', () => {
    const root = pluginTree();
    writeFileSync(path.join(root, 'dist', 'hook.js'), `process.stdin.pipe(process.stdout);\n`);
    const result = spawnSync('sh', [path.join(root, 'bin', 'subzero'), '--bundle', 'hook'], {
      input: '{"hook_event_name":"SessionStart"}',
      encoding: 'utf8',
      env: { PATH: REAL_NODE_PATH },
    });
    expect(result.stdout).toBe('{"hook_event_name":"SessionStart"}');
  });

  it('exits 0 with the Node line in the hook modes and non-zero in the server mode when node is unsuitable', () => {
    const root = pluginTree();
    const shim = path.join(root, 'bin', 'subzero');
    for (const env of [{ PATH: SYSTEM_PATH }, { PATH: `${stubNode('v18.0.0')}:${SYSTEM_PATH}` }]) {
      for (const mode of ['hook', 'agent-hook', 'wake-hook', 'prompt-hook']) {
        const run = runShim(shim, ['--bundle', mode], env);
        expect(run.status).toBe(0);
        expect(run.stdout).toBe('');
        expect(run.stderr).toMatch(/Node(\.js)? 22/);
      }
      const server = runShim(shim, ['--bundle', 'server'], env);
      expect(server.status).not.toBe(0);
      expect(server.stderr).toMatch(/Node(\.js)? 22/);
    }
  });

  it('rejects an unknown bundle name with a non-zero status', () => {
    const root = pluginTree();
    const run = runShim(path.join(root, 'bin', 'subzero'), ['--bundle', 'nope'], { PATH: REAL_NODE_PATH });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/nope/);
  });
});

describe('plugin launch configuration', () => {
  const json = (file: string) => JSON.parse(readFileSync(path.join(REPO, file), 'utf8')) as any;
  const SHIM = 'sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero"';

  it('declares the MCP server in the plugin manifest, not a root .mcp.json that a session in this repository would load', () => {
    expect(existsSync(path.join(REPO, '.mcp.json'))).toBe(false);
    const server = json('.claude-plugin/plugin.json').mcpServers.subzero;
    expect(server.command).toBe('sh');
    expect(server.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/bin/subzero', '--bundle', 'server']);
    expect(server.env).toEqual({ SUBZERO_PROJECT_DIR: '${CLAUDE_PROJECT_DIR}', SUBZERO_DATA: '${CLAUDE_PLUGIN_DATA}' });
  });

  it('launches both hooks through the shim with the same matchers', () => {
    const hooks = json('hooks/hooks.json').hooks;
    expect(Object.keys(hooks).sort()).toEqual(['PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.SessionStart[0].matcher).toBeUndefined();
    expect(hooks.SessionStart[0].hooks).toEqual([{ type: 'command', command: `${SHIM} --bundle hook` }]);
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0].matcher).toBe('Agent|Task|mcp__plugin_subzero_subzero__delegate|mcp__plugin_subzero_subzero__continue|mcp__plugin_subzero_subzero__await');
    expect(hooks.PreToolUse[0].hooks).toEqual([{ type: 'command', command: `${SHIM} --bundle agent-hook` }]);
    expect(hooks.UserPromptSubmit).toHaveLength(1);
    expect(hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(hooks.UserPromptSubmit[0].hooks).toEqual([{ type: 'command', command: `${SHIM} --bundle prompt-hook` }]);
    expect(hooks.Stop[0].hooks).toEqual([{ type: 'command', command: `${SHIM} --bundle wake-hook`, asyncRewake: true, timeout: 3600 }]);
  });
});

describe('plugin command skills', () => {
  for (const name of ['init', 'tasks']) {
    describe(`skills/${name}/SKILL.md`, () => {
      const text = readFileSync(path.join(REPO, 'skills', name, 'SKILL.md'), 'utf8');
      const frontmatter = text.split('---')[1] ?? '';

      it('is a user-invoked command that calls the shim by path', () => {
        expect(frontmatter).toMatch(/^disable-model-invocation: true$/m);
        expect(frontmatter).toMatch(/^description: ./m);
        expect(frontmatter).toMatch(/^argument-hint: ./m);
        expect(text).toContain('SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" ' + name);
        expect(text).toMatch(/unchanged/i);
      });

      it('grants only the shim command, written as quoted Bash rules', () => {
        const block = frontmatter.match(/^allowed-tools:\n((?:  - .*\n?)+)/m)?.[1] ?? '';
        expect(block).toContain('SUBZERO_PROJECT_DIR="${CLAUDE_PROJECT_DIR}" sh "${CLAUDE_PLUGIN_ROOT}/bin/subzero" ' + name);
        for (const line of block.split('\n').filter(Boolean)) expect(line).toMatch(/^  - 'Bash\(.*\)'$/);
      });
    });
  }

  it('init names the model argument and the optional flags', () => {
    const text = readFileSync(path.join(REPO, 'skills', 'init', 'SKILL.md'), 'utf8');
    for (const flag of ['--host', '--timeout', '--thinking', '$ARGUMENTS']) expect(text).toContain(flag);
  });
});
