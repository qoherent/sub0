// Builds the release artifacts from an already-built dist/:
//   <out>/subzero-<version>/            the staged plugin (an allowlist, nothing else)
//   <out>/subzero-<version>.zip         that directory zipped, the plugin at the zip root
//   <out>/subzero-<version>.zip.sha256  the zip's SHA-256
//   <out>/local-marketplace/            a `qoherent` marketplace with a relative-path copy of the plugin
// and prints one JSON line {zip, sha256, version} on stdout.
//
//   node scripts/build-plugin.mjs [--out <dir>] [--tag v<version>] [--root <repo>]
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryUrl } from './repository.mjs';

const BUNDLES = ['agent-hook', 'cli', 'hook', 'server', 'wake-hook'];

// Named paths only: a new file never ships by accident.
const ALLOWLIST = [
  '.claude-plugin/plugin.json',
  '.mcp.json',
  'hooks/hooks.json',
  'skills/init',
  'skills/cancel',
  'skills/tasks',
  'bin/subzero',
  ...BUNDLES.map((name) => `dist/${name}.js`),
  'LICENSE',
];

const MARKETPLACE_NAME = 'qoherent';
const PLUGIN_NAME = 'subzero';

function fail(message) {
  console.error(`build-plugin: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { out: 'dist-release', tag: undefined, root: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag !== '--out' && flag !== '--tag' && flag !== '--root') fail(`unknown argument "${flag}" (expected --out, --tag or --root)`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`${flag} needs a value`);
    options[flag.slice(2)] = value;
    i += 1;
  }
  return options;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return fail(`cannot read ${file}: ${error.message}`);
  }
}

const options = parseArgs(process.argv.slice(2));
const root = path.resolve(options.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const out = path.resolve(options.out);

// 1. The version: the manifest owns it; package.json and an optional --tag must agree.
const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'));
const pkg = readJson(path.join(root, 'package.json'));
const version = manifest.version;
if (typeof version !== 'string' || version === '') fail('.claude-plugin/plugin.json has no version');
if (pkg.version !== version) fail(`version mismatch: plugin.json says ${version} but package.json says ${pkg.version}`);
if (options.tag !== undefined && options.tag !== `v${version}`) fail(`tag mismatch: the tag is ${options.tag} but the version is ${version} (expected v${version})`);
let repository;
try {
  repository = repositoryUrl(pkg.repository);
} catch (error) {
  fail(error.message);
}

// 5. Preconditions, before anything is written.
const missing = BUNDLES.filter((name) => !existsSync(path.join(root, 'dist', `${name}.js`)));
if (missing.length > 0) fail(`dist/ is missing ${missing.map((name) => `${name}.js`).join(', ')}; run \`npm run build\` first`);
for (const entry of ALLOWLIST) {
  if (!existsSync(path.join(root, entry))) fail(`${entry} is missing from ${root}`);
}
if (spawnSync('zip', ['-v'], { stdio: 'ignore' }).status !== 0) fail('the `zip` command is not installed; install zip and try again');

// 2. Stage the allowlist.
const name = `subzero-${version}`;
const stage = path.join(out, name);
const zip = path.join(out, `${name}.zip`);
const market = path.join(out, 'local-marketplace');
for (const target of [stage, zip, `${zip}.sha256`, market]) rmSync(target, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const entry of ALLOWLIST) {
  const target = path.join(stage, entry);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(path.join(root, entry), target, { recursive: true });
}
chmodSync(path.join(stage, 'bin', 'subzero'), 0o755);
// So Node reads the ESM bundles as modules on every Node 22 release.
writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);
// The committed manifest is never edited; only the staged copy gets the derived fields.
writeFileSync(
  path.join(stage, '.claude-plugin', 'plugin.json'),
  `${JSON.stringify({ ...manifest, repository, homepage: repository }, null, 2)}\n`,
);

// The plugin at the zip root; `.` so dotfiles (.claude-plugin, .mcp.json) are included, -X to drop extra file attributes.
const zipped = spawnSync('zip', ['-q', '-r', '-X', zip, '.'], { cwd: stage, encoding: 'utf8' });
if (zipped.status !== 0) fail(`zip failed: ${zipped.stderr || zipped.stdout}`);

// 3. The checksum next to the zip.
const sha256 = createHash('sha256').update(readFileSync(zip)).digest('hex');
writeFileSync(`${zip}.sha256`, `${sha256}  ${path.basename(zip)}\n`);

// 4. A local marketplace: one entry, a relative path to a copy of the staged plugin.
const copy = path.join(market, 'plugins', PLUGIN_NAME);
mkdirSync(path.dirname(copy), { recursive: true });
cpSync(stage, copy, { recursive: true });
mkdirSync(path.join(market, '.claude-plugin'), { recursive: true });
writeFileSync(
  path.join(market, '.claude-plugin', 'marketplace.json'),
  `${JSON.stringify(
    {
      name: MARKETPLACE_NAME,
      owner: manifest.author ?? { name: 'Qoherent' },
      description: 'Local test marketplace for the subzero plugin. Built by scripts/build-plugin.mjs; not the published catalog.',
      plugins: [{ name: PLUGIN_NAME, source: `./plugins/${PLUGIN_NAME}`, description: manifest.description }],
    },
    null,
    2,
  )}\n`,
);

console.log(JSON.stringify({ zip, sha256, version }));
