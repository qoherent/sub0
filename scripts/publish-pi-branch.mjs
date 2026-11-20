import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BRANCHES = ['main', 'master'];

function fail(message) {
  console.error(`publish-pi-branch: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { remote: undefined, branch: 'pi', push: false, root: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--push') {
      options.push = true;
      continue;
    }
    if (flag !== '--remote' && flag !== '--branch' && flag !== '--root') fail(`unknown argument "${flag}" (expected --remote, --branch, --push or --root)`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`${flag} needs a value`);
    options[flag.slice(2)] = value;
    i += 1;
  }
  return options;
}

/** Runs git in a folder; a failure stops the script with git's own message unless the caller handles it. */
function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0 && !allowFailure) fail(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result;
}

const options = parseArgs(process.argv.slice(2));
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(options.root ?? path.join(here, '..'));
const branch = options.branch;

if (DEFAULT_BRANCHES.includes(branch)) fail(`the branch "${branch}" is the default branch; the pi branch must have another name`);
if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) fail(`"${branch}" is not a usable branch name`);

let remote = options.remote;
if (remote === undefined) {
  const origin = git(root, ['remote', 'get-url', 'origin'], { allowFailure: true });
  if (origin.status !== 0) fail('no --remote given and the repository has no origin; pass --remote <url|path>');
  remote = origin.stdout.trim();
}

const source = git(root, ['rev-parse', 'HEAD'], { allowFailure: true });
const sourceCommit = source.status === 0 ? source.stdout.trim() : undefined;
if (sourceCommit !== undefined && options.push) {
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no'], { allowFailure: true }).stdout.trim();
  if (dirty !== '') fail('the working tree has uncommitted changes; commit them first so the branch matches a commit of this repository');
}

const scratch = mkdtempSync(path.join(tmpdir(), 'subzero-branch-'));
const built = spawnSync(process.execPath, [path.join(here, 'build-pi-package.mjs'), '--root', root, '--out', path.join(scratch, 'out')], { encoding: 'utf8' });
if (built.status !== 0) {
  process.stderr.write(built.stderr);
  fail('the build failed; nothing was published');
}
const { version } = JSON.parse(built.stdout.trim().split('\n').at(-1));
const stage = path.join(scratch, 'out');

const work = path.join(scratch, 'branch');
mkdirSync(work);
git(work, ['init', '-q']);
git(work, ['remote', 'add', 'origin', remote]);
const fetched = git(work, ['fetch', '-q', '--depth', '1', 'origin', `refs/heads/${branch}`], { allowFailure: true });
if (fetched.status === 0) git(work, ['checkout', '-q', '-B', branch, 'FETCH_HEAD']);
else git(work, ['checkout', '-q', '--orphan', branch]);

for (const entry of readdirSync(work)) {
  if (entry !== '.git') rmSync(path.join(work, entry), { recursive: true, force: true });
}
cpSync(stage, work, { recursive: true });
git(work, ['add', '-A', '--force']);
const changed = git(work, ['status', '--porcelain']).stdout.trim() !== '';
if (changed) {
  const identity = ['-c', 'user.name=subzero release', '-c', 'user.email=subzero-release@users.noreply.invalid'];
  const configured = git(work, ['config', 'user.name'], { allowFailure: true }).stdout.trim() !== '';
  const message = `pi ${version}\n\n${sourceCommit === undefined ? 'Built by scripts/publish-pi-branch.mjs.' : `Built from ${sourceCommit} by scripts/publish-pi-branch.mjs.`}`;
  git(work, [...(configured ? [] : identity), 'commit', '-q', '-m', message]);
}
const commit = git(work, ['rev-parse', 'HEAD'], { allowFailure: true }).stdout.trim();

let pushed = false;
if (options.push && changed) {
  git(work, ['push', '-q', 'origin', `${branch}:refs/heads/${branch}`]);
  pushed = true;
}
const kept = !options.push && changed;
if (kept) {
  console.error(`publish-pi-branch: prepared pi package ${version} on branch "${branch}" in ${work}; run again with --push to publish it to ${remote}`);
} else {
  rmSync(scratch, { recursive: true, force: true });
}
if (!changed) console.error(`publish-pi-branch: branch "${branch}" already holds pi package ${version}; nothing to publish`);

console.log(JSON.stringify({ branch, version, commit, changed, pushed, remote, work: kept ? work : null }));
