import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../helpers.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const script = path.join(root, 'scripts', 'publish-pi-branch.mjs');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

beforeAll(() => {
  if (existsSync(path.join(root, 'dist', 'pi-extension.js'))) return;
  const built = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`build failed: ${built.stderr}`);
}, 180_000);

describe('pi branch publisher', () => {
  it('refuses default branches', () => {
    const run = spawnSync(process.execPath, [script, '--branch', 'main'], { cwd: root, env, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/default branch/);
  });
  it('prepares a local branch without pushing unless requested', () => {
    const remote = tempDir();
    expect(spawnSync('git', ['init', '--bare', '-q', remote], { env }).status).toBe(0);
    const run = spawnSync(process.execPath, [script, '--remote', remote], { cwd: root, env, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!);
    expect(result).toMatchObject({ branch: 'pi', pushed: false, changed: true });
    expect(spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/pi'], { env }).status).not.toBe(0);
  });
  it('pushes exactly the staged package when explicitly requested', () => {
    const remote = tempDir();
    expect(spawnSync('git', ['init', '--bare', '-q', remote], { env }).status).toBe(0);
    const source = tempDir();
    mkdirSync(path.join(source, '.claude-plugin'));
    mkdirSync(path.join(source, 'dist'));
    for (const file of ['package.json', 'LICENSE', 'CHANGELOG.md', '.claude-plugin/plugin.json']) {
      cpSync(path.join(root, file), path.join(source, file));
    }
    writeFileSync(path.join(source, 'dist/pi-extension.js'), '// bundle\n');
    expect(spawnSync('git', ['init', '-q', source], { env }).status).toBe(0);
    expect(spawnSync('git', ['-C', source, 'add', '.'], { env }).status).toBe(0);
    expect(spawnSync('git', ['-C', source, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'source'], { env }).status).toBe(0);
    const run = spawnSync(process.execPath, [script, '--root', source, '--remote', remote, '--push'], { cwd: root, env, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout.trim().split('\n').at(-1)!).pushed).toBe(true);
    const tree = spawnSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'pi'], { env, encoding: 'utf8' });
    expect(tree.stdout.trim().split('\n').sort()).toEqual(['CHANGELOG.md', 'LICENSE', 'dist/pi-extension.js', 'package.json']);
  });
});
