import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LocalArtifactStore } from '../src/artifacts.ts';
import { safeToolError } from '../src/application.ts';
import { loadRuntimeConfig } from '../src/config.ts';
import { CredentialResolver } from '../src/credentials.ts';

test('credential references resolve only configured environment variables and allowed origins', () => {
  const resolver = new CredentialResolver({ MODEL_A: { env: 'SUBZERO_MODEL_A_KEY', origins: ['https://api.example.com'] } });
  const env = { SUBZERO_MODEL_A_KEY: 'secret-value', OPENAI_API_KEY: 'ambient-secret' };
  assert.deepEqual(resolver.resolve('MODEL_A', 'https://api.example.com/v1', env), { key: 'secret-value' });
  assert.throws(() => resolver.resolve('MODEL_A', 'https://attacker.example/path', env), /origin/i);
  assert.throws(() => resolver.resolve('OPENAI_API_KEY', 'https://api.example.com', env), /unknown/i);
  assert.throws(() => resolver.resolve('toString', 'https://api.example.com', env), { name: 'SubzeroError', code: 'credentials_required' });
  assert.throws(() => resolver.resolve('MODEL_A', 'file:///tmp/x', env), /https?/i);
  assert.throws(() => resolver.resolve('MODEL_A', 'https://api.example.com', {}), /credential/i);
});

test('credential targets preserve harmless query parameters and reject URL-embedded configured keys', () => {
  const resolver = new CredentialResolver({ MODEL_A: { env: 'SUBZERO_MODEL_A_KEY', origins: ['https://api.example.com'] } });
  const key = 'synthetic+url-secret/42';
  const env = { SUBZERO_MODEL_A_KEY: key };
  assert.deepEqual(resolver.resolve('MODEL_A', 'https://api.example.com/v1?api-version=2026-01#chat', env), { key });
  assert.throws(() => resolver.resolve('MODEL_A', `https://api.example.com/v1?token=${encodeURIComponent(key)}`, env), /credential.*url|url.*credential/i);
  assert.throws(() => resolver.resolve('MODEL_A', `https://api.example.com/v1#${encodeURIComponent(key)}`, env), /credential.*url|url.*credential/i);
});

test('handled tool errors replace unrecognized external error codes with request_failed', () => {
  const external = Object.assign(new Error('provider detail'), { code: 'E_PROVIDER_PRIVATE_73' });
  assert.deepEqual(safeToolError(external), { code: 'request_failed', message: 'The runtime could not complete this request.' });
});

test('artifact writes are immutable per run, chunk reads are bounded UTF-8, and IDs cannot traverse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subzero-artifacts-'));
  try {
    const artifacts = new LocalArtifactStore(dir, { maxChunkBytes: 5 });
    const stored = await artifacts.write('run-1', 'héllo world');
    assert.match(stored.artifactId, /^[a-f0-9]{64}$/);
    await assert.rejects(artifacts.write('run-1', 'replacement'), /immutable|exists/i);
    const first = await artifacts.read(stored.artifactId, 0, 3);
    assert.equal(first.text, 'hé');
    assert.equal(first.nextOffset, 3);
    assert.equal(first.eof, false);
    const second = await artifacts.read(stored.artifactId, first.nextOffset, 5);
    assert.equal(second.text, 'llo w');
    assert.equal(second.eof, false);
    const third = await artifacts.read(stored.artifactId, second.nextOffset, 5);
    assert.equal(third.text, 'orld');
    assert.equal(third.eof, true);
    await assert.rejects(artifacts.read('../outside', 0, 5), /artifact|invalid/i);
    await assert.rejects(artifacts.read(stored.artifactId, 0, 6), /bound|limit/i);
    await assert.rejects(artifacts.read(stored.artifactId, 2, 5), /boundary/i);
    await assert.rejects(artifacts.read(stored.artifactId, 1, 1), /too small/i);
    await assert.rejects(readFile(join(dir, 'run-1')), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runtime config loads trusted templates and explicit skill snapshots without ambient discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-config-'));
  try {
    const dataRoot = join(root, 'data'); const workspaceRoot = join(root, 'workspace');
    await mkdir(join(dataRoot, 'skills'), { recursive: true }); await mkdir(workspaceRoot);
    await writeFile(join(dataRoot, 'skills', 'review.md'), 'Review sources.');
    await writeFile(join(dataRoot, 'templates.json'), JSON.stringify([{ id: 'custom', description: 'Custom', instructions: 'Use skill.', skills: ['review'], mcpServers: [{ name: 'lookup', command: 'mcp-lookup', args: ['--safe'], envRefs: ['env:LOOKUP_TOKEN'], tools: ['search'], writeCapable: false }] }]));
    await writeFile(join(workspaceRoot, 'ambient.md'), 'Do not load me');
    const config = await loadRuntimeConfig({ dataRoot, workspaceRoot, credentialRefs: { MODEL_A: { env: 'MODEL_A_KEY', origins: ['https://api.example.com'] } } });
    assert.equal(config.workspaceRoot, workspaceRoot);
    assert.deepEqual(config.configuredModelRefs, ['MODEL_A']);
    assert.equal(config.templates.find(item => item.id === 'custom')?.skills[0]?.content, 'Review sources.');
    assert.deepEqual(config.templates.find(item => item.id === 'custom')?.mcpServers[0], { name: 'lookup', command: 'mcp-lookup', args: ['--safe'], envRefs: ['env:LOOKUP_TOKEN'], tools: ['search'], writeCapable: false });
    assert.deepEqual(config.templates.filter(item => item.id === 'researcher').flatMap(item => item.tools.map(tool => tool.name)), ['read', 'grep', 'find', 'ls']);
    assert.deepEqual(config.templates.filter(item => item.id === 'coder').flatMap(item => item.tools.map(tool => tool.name)), ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']);
    assert.equal(JSON.stringify(config).includes('secret-value'), false);
    assert.equal(JSON.stringify(config).includes('ambient.md'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime config rejects a template file symlink that escapes the trusted data root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-config-link-'));
  try {
    const dataRoot = join(root, 'data'); const workspaceRoot = join(root, 'workspace');
    await mkdir(dataRoot); await mkdir(workspaceRoot);
    await writeFile(join(root, 'outside.json'), '[]');
    await symlink(join(root, 'outside.json'), join(dataRoot, 'templates.json'));
    await assert.rejects(loadRuntimeConfig({ dataRoot, workspaceRoot }), /inside dataRoot/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI runs when invoked through a symlinked executable path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subzero-cli-link-'));
  const entry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const linkedEntry = join(root, 'subzero-runtime');
  try {
    await symlink(entry, linkedEntry);
    const result = spawnSync(process.execPath, [linkedEntry, '--version'], { encoding: 'utf8', timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '0.1.0\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('audit: the conformance spawn fixture credential alias resolves through a configured reference', async () => {
  const fixture = JSON.parse(await readFile(fileURLToPath(new URL('../../core/conformance/valid-spawn.json', import.meta.url)), 'utf8')) as { arguments: { model: { url: string; credentialRef: string } } };
  const { url, credentialRef } = fixture.arguments.model;
  const resolver = new CredentialResolver({ [credentialRef]: { env: 'SUBZERO_MODEL_KEY', origins: [new URL(url).origin] } });
  assert.deepEqual(resolver.resolve(credentialRef, url, { SUBZERO_MODEL_KEY: 'synthetic-conformance-key' }), { key: 'synthetic-conformance-key' });
});

test('audit: missing credential reference or environment key fails with the documented credentials_required code', () => {
  const resolver = new CredentialResolver({ MODEL_A: { env: 'SUBZERO_MODEL_A_KEY', origins: ['https://api.example.com'] } });
  assert.throws(() => resolver.resolve('UNKNOWN', 'https://api.example.com/v1', {}), { code: 'credentials_required', message: /Unknown credential reference/ });
  assert.throws(() => resolver.resolve('MODEL_A', 'https://api.example.com/v1', {}), { code: 'credentials_required', message: /Credential is not configured/ });
  assert.throws(() => resolver.resolve('MODEL_A', 'https://api.example.com/v1', { SUBZERO_MODEL_A_KEY: '' }), { code: 'credentials_required' });
});
