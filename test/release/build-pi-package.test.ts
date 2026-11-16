import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../helpers.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const script = path.join(root, 'scripts', 'build-pi-package.mjs');
const guide = path.join(root, 'skills', 'init', 'guided-init.md');

/** The newest modification time among the bundle's inputs: the sources, the guide and the build script. */
function newestInput(): number {
  const files = [guide, path.join(root, 'build.mjs'), ...readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' }).map((f) => path.join(root, 'src', f))];
  return Math.max(...files.map((file) => statSync(file).mtimeMs));
}

beforeAll(() => {
  const bundle = path.join(root, 'dist', 'pi-extension.js');
  if (existsSync(bundle) && statSync(bundle).mtimeMs >= newestInput()) return;
  const built = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`build failed: ${built.stderr}`);
}, 180_000);

describe('pi package staging', () => {
  it('stages only the extension, license, changelog and host-provided peers', () => {
    const out = tempDir();
    const run = spawnSync(process.execPath, [script, '--out', out], { cwd: root, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['CHANGELOG.md', 'LICENSE', 'dist', 'package.json']);
    expect(readdirSync(path.join(out, 'dist'))).toEqual(['pi-extension.js']);
    const manifest = JSON.parse(readFileSync(path.join(out, 'package.json'), 'utf8'));
    expect(manifest.version).toBe(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version);
    expect(manifest.version).toBe(JSON.parse(readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8')).version);
    expect(manifest.keywords).toContain('pi-package');
    expect(manifest.pi.extensions).toEqual(['./dist/pi-extension.js']);
    expect(manifest.peerDependencies).toMatchObject({ '@earendil-works/pi-coding-agent': '*', typebox: '*' });
    expect(manifest.dependencies).toBeUndefined();
    expect(existsSync(path.join(out, 'dist', 'pi-extension.js'))).toBe(true);
    const bundle = readFileSync(path.join(out, 'dist', 'pi-extension.js'), 'utf8');
    expect(bundle).not.toMatch(/node_modules\/(?:typebox|@earendil-works)\//);
    // The guided init text is embedded in the bundle, since the package ships no skills folder.
    expect(bundle).toContain(JSON.stringify('Ask about `medium` first, because it is required.').slice(1, -1));
    expect(spawnSync(process.execPath, [script, '--out', out], { cwd: root, encoding: 'utf8' }).status).toBe(0);
    writeFileSync(path.join(out, 'keep.txt'), 'keep');
    expect(spawnSync(process.execPath, [script, '--out', out], { cwd: root, encoding: 'utf8' }).status).not.toBe(0);
    expect(readFileSync(path.join(out, 'keep.txt'), 'utf8')).toBe('keep');
  });
});
