import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCompletionResult, sanitizeOutput, summarizeLiveFailure } from './live-pi-diagnostics.mjs';

const parentKey = process.env.OPENCODE_API_KEY;
const childKey = process.env.SUBZERO_TEST_KEY;
if (!parentKey || !childKey) throw new Error('Set OPENCODE_API_KEY and SUBZERO_TEST_KEY to run the live Pi delegation check.');

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const extension = join(repoRoot, 'packages/pi/dist/index.js');
const piCli = join(repoRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const root = await mkdtemp(join(tmpdir(), 'subzero-pi-live-'));
const workspace = join(root, 'workspace');
const agentDir = join(root, 'pi-agent');
const dataDir = join(root, 'runtime');
const configFile = join(dataDir, 'config.json');
const runtimePidFile = join(root, 'runtime.pid');
const nodeWrapper = join(root, 'node-wrapper.sh');
const outputFile = join(workspace, 'subzero-live-child.txt');
let pi;
let stdout = '';
let stderr = '';
const secretValues = [parentKey, childKey];

try {
  await Promise.all([mkdir(workspace), mkdir(agentDir), mkdir(dataDir)]);
  await writeFile(nodeWrapper, '#!/bin/sh\nprintf "%s" "$$" > "$SUBZERO_RUNTIME_PID_FILE"\nexec "$SUBZERO_TEST_NODE" "$@"\n');
  await chmod(nodeWrapper, 0o700);
  await writeFile(configFile, JSON.stringify({ credentialRefs: {
    longcat: { env: 'SUBZERO_TEST_KEY', origins: ['https://opencode.ai'] },
  } }, null, 2));

  pi = spawn(process.execPath, [
    piCli, '--print', '--no-session', '--tools', 'mcp__subzero__subzero_spawn,mcp__subzero__subzero_get', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes',
    '--extension', extension, '--provider', 'opencode-go', '--model', 'longcat-2.5-preview-free',
    'Use mcp__subzero__subzero_spawn to start one coder child with model longcat-2.5-preview-free, URL https://opencode.ai/zen/go/v1, and credentialRef longcat. Have it create subzero-live-child.txt with exactly subzero-live-ok. Do not write the file yourself. Poll only with mcp__subzero__subzero_get, using waitMs 10000 and the latest nextCursor as cursor. Stop polling only after a completed event includes artifactId. If the child is failed or interrupted, report its state and code. Never call resume or stop.',
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      SUBZERO_NODE: nodeWrapper,
      SUBZERO_RUNTIME_PID_FILE: runtimePidFile,
      SUBZERO_TEST_NODE: process.execPath,
      SUBZERO_DATA_DIR: dataDir,
      SUBZERO_CONFIG: configFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pi.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  pi.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pi?.kill('SIGTERM');
      reject(new Error('Live Pi delegation exceeded the 180 second limit.'));
    }, 180_000);
    pi.once('error', error => { clearTimeout(timer); reject(error); });
    pi.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const secretScan = await scanSecrets();
  assert.equal(secretScan.fileLeaks, 0, 'Generated files must not contain provider key values.');
  assert.equal(secretScan.outputLeaks, 0, 'Pi output must not contain provider key values.');
  assert.equal(exitCode, 0, 'Pi should exit successfully after its delegation turn.');
  const fileContent = await readFile(outputFile, 'utf8');
  assert.ok(fileContent === 'subzero-live-ok', 'the child should create the requested file with the exact content.');

  const db = new DatabaseSync(join(dataDir, 'metadata.sqlite'), { readOnly: true });
  let childRow;
  let childEvents;
  let childRuns;
  try {
    childRow = db.prepare('SELECT child_id, state, ownership_state, last_result FROM children WHERE workspace_root = ? ORDER BY created_at DESC LIMIT 1').get(workspace);
    if (childRow) {
      childEvents = db.prepare('SELECT type, payload FROM events WHERE child_id = ? ORDER BY seq').all(childRow.child_id);
      childRuns = db.prepare('SELECT status, error_code FROM runs WHERE child_id = ? ORDER BY ordinal').all(childRow.child_id);
    }
  } finally { db.close(); }
  assert.ok(childRow, 'Subzero should persist child metadata.');
  assert.equal(childRow.state, 'ready', 'the child should finish and release ownership.');
  assert.equal(childRow.ownership_state, 'none', 'the child should have no active owner after completion.');
  const result = requireCompletionResult(childRow.last_result,
    summarizeLiveFailure({ child: childRow, runs: childRuns, events: childEvents, stdout, stderr, secretValues }));
  assert.ok(typeof result.preview === 'string' && result.preview.length > 0, 'the child should persist a nonempty completion result.');
  assert.ok(typeof result.artifactId === 'string' && result.artifactId.length > 0, 'the child should persist a completion artifact.');
  assert.ok(childEvents.some(event => {
    if (event.type !== 'completed') return false;
    const payload = JSON.parse(event.payload);
    return typeof payload.artifactId === 'string' && payload.artifactId.length > 0;
  }), 'the child should persist a completed event with an artifact.');
  assert.ok(childEvents.some(event => event.type === 'tool' && JSON.parse(event.payload).name === 'write' && JSON.parse(event.payload).state === 'finished'), 'the child should persist a successful write tool event.');
  process.stdout.write(`Live Pi delegation passed; child ${childRow.child_id} reached ready and wrote the expected file.\n`);
} catch (error) {
  const scan = await scanSecrets().catch(() => ({ fileLeaks: -1, outputLeaks: -1 }));
  const snapshot = await readLifecycleSnapshot().catch(() => ({ child: undefined, runs: [], events: [] }));
  const diagnostic = summarizeLiveFailure({ ...snapshot, stdout, stderr, secretValues });
  process.stderr.write(`Live Pi failure diagnostics: ${diagnostic}\nSecret scan before cleanup: ${JSON.stringify(scan)}\n`);
  throw new Error(sanitizeOutput(error instanceof Error ? error.message : String(error), secretValues));
} finally {
  if (pi && pi.exitCode === null) {
    pi.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => pi.once('exit', resolve)),
      new Promise(resolve => setTimeout(() => { pi?.kill('SIGKILL'); resolve(); }, 1_500)),
    ]);
  }
  const runtimePid = Number(await readFile(runtimePidFile, 'utf8').catch(() => '0'));
  if (runtimePid > 1) await stopProcess(runtimePid);
  const sessionFiles = await readdir(join(dataDir, 'sessions'), { recursive: true }).catch(() => []);
  for (const path of sessionFiles.filter(value => String(value).endsWith('worker-owner.json'))) {
    const owner = await readFile(join(dataDir, 'sessions', String(path)), 'utf8').then(JSON.parse).catch(() => undefined);
    if (owner?.pid > 1) await stopProcess(owner.pid, true);
  }
  await rm(root, { recursive: true, force: true });
}

async function scanSecrets() {
  const generatedFiles = await readdir(root, { recursive: true });
  let fileLeaks = 0;
  for (const path of generatedFiles) {
    const content = await readFile(join(root, String(path))).then(value => value.toString('latin1')).catch(() => '');
    if (secretValues.some(secret => secret && content.includes(secret))) fileLeaks++;
  }
  return { fileLeaks, outputLeaks: Number(secretValues.some(secret => secret && (stdout.includes(secret) || stderr.includes(secret)))) };
}

async function readLifecycleSnapshot() {
  const dbPath = join(dataDir, 'metadata.sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const child = db.prepare('SELECT child_id, state, ownership_state, last_result FROM children WHERE workspace_root = ? ORDER BY created_at DESC LIMIT 1').get(workspace);
    if (!child) return { child: null, runs: [], events: [] };
    return {
      child,
      runs: db.prepare('SELECT status, error_code FROM runs WHERE child_id = ? ORDER BY ordinal').all(child.child_id),
      events: db.prepare('SELECT type, payload FROM events WHERE child_id = ? ORDER BY seq').all(child.child_id),
    };
  } finally { db.close(); }
}

async function stopProcess(pid, group = false) {
  let state = await readProcState(pid);
  if (state === 'gone' || state === 'Z') return;
  try { process.kill(group ? -pid : pid, 'SIGTERM'); } catch { return; }
  for (let attempt = 0; attempt < 80; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    state = await readProcState(pid);
    if (state === 'gone' || state === 'Z') return;
  }
  try { process.kill(group ? -pid : pid, 'SIGKILL'); } catch { /* Already exited. */ }
}

async function readProcState(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? 'unknown';
  } catch { return 'gone'; }
}
