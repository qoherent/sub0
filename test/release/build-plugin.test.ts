import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../helpers.js';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'build-plugin.mjs');
const BUNDLES = ['agent-hook', 'cli', 'hook', 'prompt-hook', 'server', 'wake-hook'];
const HAS_CLAUDE = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;

/** Exactly what a release ships (KTD4): any other file in the staged plugin is a leak. */
const ALLOWLIST = [
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
];

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;

/** Every file under `dir` as a sorted, slash-separated relative path. */
function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

beforeAll(() => {
  if (BUNDLES.every((name) => existsSync(path.join(REPO, 'dist', `${name}.js`)))) return;
  const built = spawnSync('npm', ['run', 'build'], { cwd: REPO, encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`npm run build failed:\n${built.stdout}\n${built.stderr}`);
}, 180_000);

/**
 * A repository-shaped source tree the script can build from (--root): the
 * allowlisted files plus decoys that must stay out. `dist` is 'real' (the built
 * bundles), 'stub' (tiny files) or 'none'.
 */
function sourceTree(dist: 'real' | 'stub' | 'none' = 'stub'): string {
  const root = tempDir('subzero-src-');
  for (const file of ['.claude-plugin/plugin.json', '.mcp.json', 'LICENSE', 'bin/subzero', 'hooks/hooks.json', 'package.json']) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    cpSync(path.join(REPO, file), path.join(root, file));
  }
  for (const skill of ['init', 'tasks', 'cancel', 'review']) cpSync(path.join(REPO, 'skills', skill), path.join(root, 'skills', skill), { recursive: true });
  for (const decoy of ['src/a.ts', 'test/a.test.ts', 'bench/a.md', 'examples/a.md', 'design/a.sigil', 'docs/a.md', 'node_modules/a/index.js', '.agents/a.md', 'subzero.yaml']) {
    mkdirSync(path.dirname(path.join(root, decoy)), { recursive: true });
    writeFileSync(path.join(root, decoy), 'decoy\n');
  }
  if (dist !== 'none') {
    mkdirSync(path.join(root, 'dist'));
    for (const name of BUNDLES) {
      const target = path.join(root, 'dist', `${name}.js`);
      if (dist === 'real') cpSync(path.join(REPO, 'dist', `${name}.js`), target);
      else writeFileSync(target, `// stub ${name}\n`);
    }
  }
  return root;
}

interface Built {
  status: number | null;
  stdout: string;
  stderr: string;
  out: string;
  stage: string;
  zip: string;
}

function build(root: string, extra: string[] = []): Built {
  const out = path.join(tempDir('subzero-out-'), 'release');
  const run = spawnSync(process.execPath, [SCRIPT, '--root', root, '--out', out, ...extra], { encoding: 'utf8', cwd: tempDir() });
  const version = json(path.join(root, '.claude-plugin', 'plugin.json')).version as string;
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    out,
    stage: path.join(out, `subzero-${version}`),
    zip: path.join(out, `subzero-${version}.zip`),
  };
}

function editJson(file: string, edit: (data: Record<string, any>) => void): void {
  const data = json(file);
  edit(data);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

describe('scripts/build-plugin.mjs', () => {
  it('packages the user-invoked cancel skill with its preapproved cancel tool', () => {
    const skill = readFileSync(path.join(REPO, 'skills/cancel/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^disable-model-invocation: true$/m);
    expect(skill).toContain('mcp__plugin_subzero_subzero__cancel');
    expect(skill).toMatch(/no arguments when no id was supplied/);
  });
  it('stages exactly the allowlist, with a package.json that only makes the bundles ES modules', () => {
    const run = build(sourceTree());
    expect(run.status, run.stderr).toBe(0);
    expect(listFiles(run.stage)).toEqual([...ALLOWLIST].sort());
    expect(json(path.join(run.stage, 'package.json'))).toEqual({ type: 'module' });
    for (const leak of ['src', 'test', 'bench', 'examples', 'design', 'docs', 'node_modules', '.agents', 'skills/review']) {
      expect(existsSync(path.join(run.stage, leak)), leak).toBe(false);
    }
  });

  it('contains the prompt-hook bundle, and the staged hooks.json registers it for UserPromptSubmit', () => {
    const run = build(sourceTree('real'));
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(path.join(run.stage, 'dist', 'prompt-hook.js'))).toBe(true);
    const hooks = json(path.join(run.stage, 'hooks', 'hooks.json')).hooks;
    expect(JSON.stringify(hooks.UserPromptSubmit)).toContain('--bundle prompt-hook');
  });

  it('keeps bin/subzero executable in the staged directory, and the zip lists the same files', () => {
    const run = build(sourceTree());
    expect(run.status, run.stderr).toBe(0);
    expect(statSync(path.join(run.stage, 'bin', 'subzero')).mode & 0o111).toBe(0o111);
    const listed = spawnSync('unzip', ['-Z1', run.zip], { encoding: 'utf8' });
    expect(listed.status).toBe(0);
    // The plugin sits at the zip root, so entries carry no wrapping directory.
    const entries = listed.stdout.split('\n').filter((entry) => entry && !entry.endsWith('/'));
    expect(entries.sort()).toEqual(listFiles(run.stage));
    // The executable bit survives in the archive itself.
    const long = spawnSync('unzip', ['-Z', run.zip, 'bin/subzero'], { encoding: 'utf8' }).stdout;
    expect(long).toMatch(/^-rwx/);
  });

  it('prints the zip path, the checksum and the version as one JSON line, and the checksum is the zip SHA-256', () => {
    const run = build(sourceTree());
    expect(run.status, run.stderr).toBe(0);
    const lines = run.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const printed = JSON.parse(lines[0]!) as { zip: string; sha256: string; version: string };
    const independent = createHash('sha256').update(readFileSync(run.zip)).digest('hex');
    expect(printed.sha256).toBe(independent);
    expect(printed.version).toBe(json(path.join(REPO, 'package.json')).version);
    expect(path.resolve(printed.zip)).toBe(run.zip);
    // The checksum is also written next to the zip.
    expect(readFileSync(`${run.zip}.sha256`, 'utf8')).toContain(independent);
    // Independent check with the system tool, too.
    const shasum = spawnSync('shasum', ['-a', '256', run.zip], { encoding: 'utf8' });
    if (shasum.status === 0) expect(shasum.stdout.split(/\s+/)[0]).toBe(independent);
  });

  it('derives the staged manifest repository and homepage from package.json, and leaves the committed manifest alone', () => {
    const root = sourceTree();
    const committed = readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8');
    editJson(path.join(root, 'package.json'), (pkg) => {
      pkg.repository = { type: 'git', url: 'https://github.com/example/elsewhere.git' };
    });
    const run = build(root);
    expect(run.status, run.stderr).toBe(0);
    const staged = json(path.join(run.stage, '.claude-plugin', 'plugin.json'));
    expect(staged.repository).toBe('https://github.com/example/elsewhere');
    expect(staged.homepage).toBe('https://github.com/example/elsewhere');
    expect(readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).toBe(committed);

    // And the real repository slug flows through unchanged.
    const real = build(sourceTree());
    const manifest = json(path.join(real.stage, '.claude-plugin', 'plugin.json'));
    expect(manifest.repository).toBe('https://github.com/qoherent/sub0');
    expect(manifest.homepage).toBe('https://github.com/qoherent/sub0');
    expect(manifest.name).toBe('subzero');
  });

  it('exits non-zero and builds nothing when the manifest version differs from package.json', () => {
    const root = sourceTree();
    editJson(path.join(root, '.claude-plugin', 'plugin.json'), (manifest) => {
      manifest.version = '0.1.0-preview.2';
    });
    const run = build(root);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/version/);
    expect(existsSync(run.out)).toBe(false);
  });

  it('accepts a matching --tag and refuses a different one without building', () => {
    const version = json(path.join(REPO, 'package.json')).version as string;
    const ok = build(sourceTree(), ['--tag', `v${version}`]);
    expect(ok.status, ok.stderr).toBe(0);

    const bad = build(sourceTree(), ['--tag', 'v0.1.0-preview.2']);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/tag/);
    expect(existsSync(bad.out)).toBe(false);

    // A tag without the v prefix is not v<version> either.
    const bare = build(sourceTree(), ['--tag', version]);
    expect(bare.status).not.toBe(0);
  });

  it('writes a qoherent marketplace with one subzero entry that points at a relative copy of the staged plugin', () => {
    const run = build(sourceTree());
    expect(run.status, run.stderr).toBe(0);
    const market = path.join(run.out, 'local-marketplace');
    const catalog = json(path.join(market, '.claude-plugin', 'marketplace.json'));
    expect(catalog.name).toBe('qoherent');
    expect(catalog.plugins).toHaveLength(1);
    const entry = catalog.plugins[0] as { name: string; source: string };
    expect(entry.name).toBe('subzero');
    expect(typeof entry.source).toBe('string');
    expect(entry.source.startsWith('./')).toBe(true);
    expect(entry.source).not.toContain('..');
    const copy = path.join(market, entry.source);
    expect(listFiles(copy)).toEqual(listFiles(run.stage));
    expect(statSync(path.join(copy, 'bin', 'subzero')).mode & 0o111).toBe(0o111);
  });

  it.skipIf(!HAS_CLAUDE)('passes claude plugin validate for the staged plugin and the local marketplace', () => {
    const run = build(sourceTree());
    expect(run.status, run.stderr).toBe(0);
    for (const target of [run.stage, path.join(run.out, 'local-marketplace')]) {
      const validated = spawnSync('claude', ['plugin', 'validate', target], { encoding: 'utf8', cwd: tempDir() });
      expect(validated.status, `${validated.stdout}\n${validated.stderr}`).toBe(0);
      expect(validated.stdout + validated.stderr).toMatch(/Validation passed/);
    }
  }, 60_000);

  it('exits non-zero and says to run the build first when dist/ is missing', () => {
    const run = build(sourceTree('none'));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/dist/);
    expect(run.stderr).toMatch(/npm run build/);
    expect(existsSync(run.out)).toBe(false);
  });

  it('runs the staged CLI through bin/subzero with no repository around it', () => {
    const run = build(sourceTree('real'));
    expect(run.status, run.stderr).toBe(0);
    const bare = tempDir('subzero-bare-');
    // No arguments: the CLI prints its usage (and uses its usage exit status, 2).
    const usage = spawnSync('sh', [path.join(run.stage, 'bin', 'subzero')], { cwd: bare, encoding: 'utf8' });
    expect(usage.stdout + usage.stderr).toMatch(/usage:/);
    expect(usage.stdout + usage.stderr).toContain('subzero init');
    expect(usage.stderr).not.toMatch(/Cannot find|ERR_|SyntaxError/);
    expect(usage.status).toBe(2);
    // A real command exits cleanly in an empty directory.
    const tasks = spawnSync(path.join(run.stage, 'bin', 'subzero'), ['tasks'], { cwd: bare, encoding: 'utf8' });
    expect(tasks.status, tasks.stderr).toBe(0);
    expect(tasks.stdout).toMatch(/no tasks/i);
  });
});
