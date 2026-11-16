import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../helpers.js';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'publish-plugin-branch.mjs');
const BUNDLES = ['agent-hook', 'cli', 'hook', 'server', 'wake-hook'];
const HAS_CLAUDE = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;

/** What the plugin branch holds: the staged plugin (the release allowlist) and its marketplace file. */
const BRANCH_FILES = [
  '.claude-plugin/marketplace.json',
  '.claude-plugin/plugin.json',
  '.mcp.json',
  'LICENSE',
  'bin/subzero',
  ...BUNDLES.map((name) => `dist/${name}.js`),
  'hooks/hooks.json',
  'package.json',
  'skills/init/SKILL.md',
  'skills/init/guided-init.md',
  'skills/cancel/SKILL.md',
  'skills/tasks/SKILL.md',
].sort();

// Hermetic git: no global config, so the script's own identity fallback is what commits.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

/** A repository-shaped source tree with stub bundles that the script can build from (--root). */
function sourceTree(options: { dist?: boolean; version?: string } = {}): string {
  const root = tempDir('subzero-pubsrc-');
  for (const file of ['.claude-plugin/plugin.json', '.mcp.json', 'LICENSE', 'bin/subzero', 'hooks/hooks.json', 'package.json']) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    cpSync(path.join(REPO, file), path.join(root, file));
  }
  for (const skill of ['init', 'tasks', 'cancel']) cpSync(path.join(REPO, 'skills', skill), path.join(root, 'skills', skill), { recursive: true });
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'decoy.ts'), 'decoy\n');
  if (options.dist !== false) {
    mkdirSync(path.join(root, 'dist'));
    for (const name of BUNDLES) writeFileSync(path.join(root, 'dist', `${name}.js`), `// stub ${name}\n`);
  }
  if (options.version !== undefined) setVersion(root, options.version);
  return root;
}

function setVersion(root: string, version: string): void {
  for (const file of ['.claude-plugin/plugin.json', 'package.json']) {
    const full = path.join(root, file);
    writeFileSync(full, `${JSON.stringify({ ...JSON.parse(readFileSync(full, 'utf8')), version }, null, 2)}\n`);
  }
}

/** An empty bare repository standing in for the GitHub remote. */
function bareRemote(): string {
  const dir = tempDir('subzero-remote-');
  git(dir, 'init', '-q', '--bare', '-b', 'main');
  return dir;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  result?: { branch: string; version: string; commit: string; changed: boolean; pushed: boolean; remote: string; work: string | null };
}

function publish(root: string, args: string[]): Run {
  const run = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8', env: GIT_ENV });
  const line = run.stdout.trim().split('\n').filter(Boolean).at(-1);
  let result: Run['result'];
  try {
    result = line === undefined ? undefined : JSON.parse(line);
  } catch {
    result = undefined;
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, result };
}

const branchHead = (remote: string, branch = 'plugin') => spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: remote, encoding: 'utf8', env: GIT_ENV }).stdout.trim();
const files = (remote: string, branch = 'plugin') => git(remote, 'ls-tree', '-r', '--name-only', branch).split('\n').sort();

describe('scripts/publish-plugin-branch.mjs', () => {
  it('builds the branch but pushes nothing unless --push is given', () => {
    const remote = bareRemote();
    const run = publish(sourceTree(), ['--remote', remote]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.result).toMatchObject({ branch: 'plugin', pushed: false, changed: true });
    expect(branchHead(remote)).toBe('');
    // The prepared commit is there to inspect.
    expect(git(run.result!.work!, 'log', '--format=%s', '-1')).toBe(`plugin ${run.result!.version}`);
    expect(run.stderr).toMatch(/--push/);
  });

  it('with --push publishes exactly the staged plugin and its marketplace file on the branch', () => {
    const remote = bareRemote();
    const run = publish(sourceTree(), ['--remote', remote, '--push']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.result).toMatchObject({ pushed: true, changed: true });
    expect(files(remote)).toEqual(BRANCH_FILES);
    expect(branchHead(remote)).toBe(run.result!.commit);
  });

  it('keeps the executable bit of bin/subzero in git', () => {
    const remote = bareRemote();
    publish(sourceTree(), ['--remote', remote, '--push']);
    expect(git(remote, 'ls-tree', 'plugin', 'bin/subzero')).toMatch(/^100755 blob /);
  });

  it('writes a qoherent marketplace whose one entry is the plugin at the branch root, with no version', () => {
    const remote = bareRemote();
    publish(sourceTree(), ['--remote', remote, '--push']);
    const marketplace = JSON.parse(git(remote, 'show', 'plugin:.claude-plugin/marketplace.json'));
    expect(marketplace.name).toBe('qoherent');
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0]).toMatchObject({ name: 'subzero', source: './' });
    expect(marketplace.plugins[0]).not.toHaveProperty('version');
    const manifest = JSON.parse(git(remote, 'show', 'plugin:.claude-plugin/plugin.json'));
    expect(manifest.name).toBe('subzero');
  });

  it('adds no commit when nothing changed', () => {
    const remote = bareRemote();
    const root = sourceTree();
    const first = publish(root, ['--remote', remote, '--push']);
    const second = publish(root, ['--remote', remote, '--push']);
    expect(second.status, second.stderr).toBe(0);
    expect(second.result).toMatchObject({ changed: false, pushed: false });
    expect(branchHead(remote)).toBe(first.result!.commit);
    expect(git(remote, 'rev-list', '--count', 'plugin')).toBe('1');
  });

  it('adds a commit on top of the old one when the version changes, so history is kept', () => {
    const remote = bareRemote();
    const root = sourceTree();
    const first = publish(root, ['--remote', remote, '--push']);
    setVersion(root, '0.1.0-preview.2');
    const second = publish(root, ['--remote', remote, '--push']);
    expect(second.status, second.stderr).toBe(0);
    expect(second.result).toMatchObject({ changed: true, pushed: true, version: '0.1.0-preview.2' });
    expect(git(remote, 'rev-list', '--count', 'plugin')).toBe('2');
    expect(git(remote, 'rev-parse', 'plugin~1')).toBe(first.result!.commit);
    expect(JSON.parse(git(remote, 'show', 'plugin:.claude-plugin/plugin.json')).version).toBe('0.1.0-preview.2');
  });

  it('removes a file that left the allowlist from the branch', () => {
    const remote = bareRemote();
    const root = sourceTree();
    publish(root, ['--remote', remote, '--push']);
    // A stale file committed to the branch by hand must not survive the next publish.
    const clone = tempDir('subzero-stale-');
    git(clone, 'clone', '-q', '-b', 'plugin', remote, '.');
    writeFileSync(path.join(clone, 'STALE.md'), 'old\n');
    git(clone, 'add', '-A');
    git(clone, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'stale');
    git(clone, 'push', '-q', 'origin', 'plugin');
    expect(files(remote)).toContain('STALE.md');
    setVersion(root, '0.1.0-preview.2');
    const run = publish(root, ['--remote', remote, '--push']);
    expect(run.status, run.stderr).toBe(0);
    expect(files(remote)).toEqual(BRANCH_FILES);
  });

  it('takes the branch name from --branch', () => {
    const remote = bareRemote();
    const run = publish(sourceTree(), ['--remote', remote, '--branch', 'built', '--push']);
    expect(run.status, run.stderr).toBe(0);
    expect(branchHead(remote, 'built')).toBe(run.result!.commit);
    expect(branchHead(remote, 'plugin')).toBe('');
  });

  it.each(['main', 'master'])('refuses the branch name %s: the plugin branch is never the default branch', (name) => {
    const remote = bareRemote();
    const run = publish(sourceTree(), ['--remote', remote, '--branch', name, '--push']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/default branch|main/);
    expect(branchHead(remote, name)).toBe('');
  });

  it('defaults the remote to origin of the repository it builds from', () => {
    const remote = bareRemote();
    const root = sourceTree();
    git(root, 'init', '-q');
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'src');
    const run = publish(root, ['--push']);
    expect(run.status, run.stderr).toBe(0);
    expect(branchHead(remote)).toBe(run.result!.commit);
    // The commit message names the source commit the plugin was built from.
    expect(git(remote, 'log', '--format=%B', '-1', 'plugin')).toContain(git(root, 'rev-parse', 'HEAD'));
  });

  it('refuses to push a build of a working tree with uncommitted changes', () => {
    const remote = bareRemote();
    const root = sourceTree();
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'src');
    writeFileSync(path.join(root, 'src', 'decoy.ts'), 'changed\n');
    const run = publish(root, ['--remote', remote, '--push']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/uncommitted/);
    expect(branchHead(remote)).toBe('');
  });

  it('fails plainly with no remote and no origin', () => {
    const run = publish(sourceTree(), []);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/--remote/);
  });

  it('fails with the build message when dist/ is missing, and pushes nothing', () => {
    const remote = bareRemote();
    const run = publish(sourceTree({ dist: false }), ['--remote', remote, '--push']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/npm run build/);
    expect(branchHead(remote)).toBe('');
  });

  it('refuses an unknown argument', () => {
    const run = publish(sourceTree(), ['--force']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/unknown argument/);
  });

  it.skipIf(!HAS_CLAUDE)('the branch validates, adds as a marketplace and installs, in a clean profile', () => {
    const remote = bareRemote();
    publish(sourceTree(), ['--remote', remote, '--push']);
    const checkout = tempDir('subzero-branch-');
    git(checkout, 'clone', '-q', '-b', 'plugin', remote, '.');
    const env = { ...process.env, CLAUDE_CONFIG_DIR: tempDir('subzero-claude-') };
    const claude = (...args: string[]) => spawnSync('claude', args, { cwd: checkout, encoding: 'utf8', env });
    const validated = claude('plugin', 'validate', checkout);
    expect(validated.stdout + validated.stderr).toMatch(/Validation passed/);
    const added = claude('plugin', 'marketplace', 'add', checkout);
    expect(added.stdout + added.stderr).toMatch(/Successfully added marketplace: qoherent/);
    const installed = claude('plugin', 'install', 'subzero@qoherent');
    expect(installed.stdout + installed.stderr).toMatch(/Successfully installed plugin: subzero@qoherent/);
    const listed = claude('plugin', 'list');
    expect(listed.stdout).toMatch(/subzero@qoherent[\s\S]*Version: 0\.\d+\.\d+/);
    expect(existsSync(checkout)).toBe(true);
  }, 120_000);
});
