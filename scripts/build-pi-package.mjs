import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = (message) => { console.error(`build-pi-package: ${message}`); process.exit(1); };
const args = process.argv.slice(2);
let out = 'dist-pi-package';
let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key !== '--out' && key !== '--root') fail(`unknown argument "${key}"`);
  const value = args[++i];
  if (!value || value.startsWith('--')) fail(`${key} needs a value`);
  if (key === '--out') out = value; else root = path.resolve(value);
}
out = path.resolve(out);
const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const pkg = readJson('package.json');
const plugin = readJson('.claude-plugin/plugin.json');
if (pkg.version !== plugin.version) fail('package and plugin versions do not match');
for (const file of ['dist/pi-extension.js', 'LICENSE', 'CHANGELOG.md']) {
  if (!existsSync(path.join(root, file))) fail(`${file} is missing; run the build first`);
}
if (existsSync(out) && readdirSync(out).length) {
  const allowed = new Set(['package.json', 'LICENSE', 'CHANGELOG.md', 'dist']);
  const entries = readdirSync(out);
  const manifestFile = path.join(out, 'package.json');
  let previous;
  try { previous = JSON.parse(readFileSync(manifestFile, 'utf8')); } catch {}
  const dist = path.join(out, 'dist');
  if (previous?.name !== 'subzero-pi' || entries.some((entry) => !allowed.has(entry)) ||
      (existsSync(dist) && readdirSync(dist).some((entry) => entry !== 'pi-extension.js'))) {
    fail(`destination ${out} contains files outside a previous pi package stage`);
  }
  for (const entry of entries) rmSync(path.join(out, entry), { recursive: true, force: true });
}
mkdirSync(path.join(out, 'dist'), { recursive: true });
for (const file of ['dist/pi-extension.js', 'LICENSE', 'CHANGELOG.md']) cpSync(path.join(root, file), path.join(out, file));
const manifest = {
  name: 'subzero-pi', version: pkg.version, type: 'module', license: pkg.license,
  description: 'Delegate pi subagents to isolated subzero children.',
  keywords: ['pi-package'], pi: { extensions: ['./dist/pi-extension.js'] },
  peerDependencies: {
    '@earendil-works/pi-coding-agent': '*', '@earendil-works/pi-agent-core': '*',
    '@earendil-works/pi-ai': '*', '@earendil-works/pi-tui': '*', typebox: '*',
  },
};
writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ out, version: pkg.version }));
