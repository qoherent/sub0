import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const required: Record<string, string[]> = {
  core: ['dist/index.js', 'dist/index.d.ts'],
  runtime: ['dist/index.js', 'dist/index.d.ts', 'dist/cli.js', 'dist/engine/worker-child.js'],
  pi: ['dist/index.js', 'dist/index.d.ts'],
};
const names = Object.keys(required);
type Manifest = { license?: string; private?: boolean; engines?: Record<string, string>; keywords?: string[]; files?: string[]; exports?: Record<string, string | Record<string, string>> };
const manifestOf = async (name: string) => JSON.parse(await readFile(join(repoRoot, 'packages', name, 'package.json'), 'utf8')) as Manifest;
const npmEnv = { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };

async function pack(directory: string): Promise<{ code: number; files: string[]; stderr: string }> {
  try {
    const { stdout } = await run('npm', ['pack', '--dry-run', '--json'], { cwd: directory, env: { ...npmEnv, npm_config_cache: join(directory, '.npm-cache') } });
    const files = (JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map(file => file.path);
    return { code: 0, files, stderr: '' };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, files: [], stderr: String(failure.stderr ?? '') };
  }
}

for (const name of names) {
  test(`${name} package refuses to pack without build output and packs its entrypoints once built`, { timeout: 60_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), `subzero-packaging-${name}-`));
    try {
      await cp(join(repoRoot, 'packages', name, 'package.json'), join(directory, 'package.json'));
      await cp(join(repoRoot, 'packages', name, 'README.md'), join(directory, 'README.md'), { force: true }).catch(() => undefined);
      const unbuilt = await pack(directory);
      assert.notEqual(unbuilt.code, 0, 'an unbuilt package must not pack');
      assert.match(unbuilt.stderr, /npm run build/);
      assert.deepEqual((await readdir(directory)).filter(entry => entry.endsWith('.tgz')), []);
      for (const path of required[name]!) {
        await mkdir(dirname(join(directory, path)), { recursive: true });
        await cp(join(repoRoot, 'packages', name, path), join(directory, path));
      }
      const built = await pack(directory);
      assert.equal(built.code, 0, built.stderr);
      for (const path of required[name]!) assert.ok(built.files.includes(path), `${path} is packed`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test('package manifests declare the MIT license, runtime engines, Pi gallery keyword, and byte-identical license files', async () => {
  const rootLicense = await readFile(join(repoRoot, 'LICENSE'));
  for (const name of names) {
    const manifest = await manifestOf(name);
    assert.equal(manifest.license, 'MIT', name);
    assert.equal(manifest.private, true, name);
    assert.deepEqual(await readFile(join(repoRoot, 'packages', name, 'LICENSE')), rootLicense, `${name} LICENSE matches the root license`);
  }
  assert.equal((await manifestOf('core')).engines, undefined);
  assert.deepEqual((await manifestOf('runtime')).engines, { node: '>=24.15.0' });
  assert.deepEqual((await manifestOf('pi')).engines, { node: '>=22.19.0' });
  assert.ok((await manifestOf('pi')).keywords?.includes('pi-package'));
});

test('every development export equals its compiled default and is shipped and built', async () => {
  for (const name of names) {
    const manifest = await manifestOf(name);
    const entries = Object.values(manifest.exports ?? {}).flatMap(entry => typeof entry === 'object' && entry.development ? [entry] : []);
    assert.ok(entries.length > 0, `${name} advertises a development export`);
    for (const entry of entries) {
      assert.equal(entry.development, entry.default, `${name} development export equals its compiled default`);
      assert.match(entry.development!, /\.js$/);
      const relative = entry.development!.replace(/^\.\//, '');
      assert.ok((manifest.files ?? []).some(entry => relative === entry || relative.startsWith(`${entry}/`)), `${name} ships ${relative}`);
      await readFile(join(repoRoot, 'packages', name, relative));
    }
  }
});
