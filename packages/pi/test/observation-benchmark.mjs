#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const REV = 'dce84c1';
function arg(name) { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(arg('--repo') ?? resolve(scriptDir, '../../..'));
const outPath = arg('--out') ? resolve(arg('--out')) : undefined;
const baselineDir = await mkdtemp(resolve(tmpdir(), 'subzero-actual-baseline-'));
process.once('exit', () => { try { rmSync(baselineDir, { recursive: true, force: true }); } catch {} });
const hash = (s) => createHash('sha256').update(s).digest('hex');
const gitShow = (path) => execFileSync('git', ['show', `${REV}:${path}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let baselineIndex, baselineTypes;
try {
  baselineIndex = gitShow('packages/core/src/index.ts');
  baselineTypes = gitShow('packages/core/src/types.ts');
} catch (e) { throw new Error(`Required baseline source ${REV} unavailable; refusing substitute baseline. ${e.stderr?.toString() ?? e.message}`); }
await mkdir(resolve(baselineDir, 'src'), { recursive: true });
await writeFile(resolve(baselineDir, 'src/index.ts'), baselineIndex);
await writeFile(resolve(baselineDir, 'src/types.ts'), baselineTypes);
const baseline = await import(pathToFileURL(resolve(baselineDir, 'src/index.ts')).href);
const candidate = await import(pathToFileURL(resolve(repo, 'packages/core/src/index.ts')).href);
const fixtures = await import(pathToFileURL(resolve(repo, 'packages/core/test/support.ts')).href);
const supportSource = await readFile(resolve(repo, 'packages/core/test/support.ts'), 'utf8');
const { FakeStore, ControlledEngineFactory, template, ids } = fixtures;

const preview = 'Controlled benchmark artifact preview — finished.';
const model = { url: 'https://benchmark.invalid/v1', model: 'synthetic-control', key: 'synthetic-secret' };
const config = (store, engine) => ({
  store, engineFactory: engine, templates: [template], ids: ids(), clock: () => new Date('2026-10-09T12:00:00.000Z'),
  worker: { name: 'benchmark-fake', version: '1', capabilities: [] }, configuredModelRefs: ['synthetic'],
  limits: { outputPreviewBytes: 96, maxWaitMs: 1000, eventBatch: 1000 },
  artifactReader: async (artifactId, offset, length) => ({ artifactId, offset, text: 'controlled artifact body'.slice(offset, offset + length), nextOffset: Math.min(offset + length, 24), eof: offset + length >= 24 }),
});
async function until(test, label) {
  const end = performance.now() + 1500;
  while (!test()) { if (performance.now() > end) throw new Error(`Timed out waiting for ${label}`); await delay(1); }
}
async function one(Core, variant, { activity, durationMs, waitMs }) {
  const store = new FakeStore(); const engine = new ControlledEngineFactory(); const core = Core.createSubzero(config(store, engine));
  const started = performance.now(); let apiCalls = 0; let returned = []; let control;
  const wallDeadlineMs = 5000, maxApiCalls = 100;
  const guard = () => { if (performance.now() - started > wallDeadlineMs) throw new Error(`${variant} case exceeded ${wallDeadlineMs}ms wall deadline`); if (apiCalls >= maxApiCalls) throw new Error(`${variant} case exceeded ${maxApiCalls} core calls`); };
  const input = { prompt: 'Summarize the controlled fixture.', templateId: 'researcher', model, workspaceRoot: '/synthetic/workspace', waitMs, previewLimit: 64 };
  try {
    if (variant === 'candidate') {
      guard(); apiCalls++;
      const first = core.run(input).then(value => { returned.push(value); return value; });
      await until(() => engine.runs.length === 1, 'candidate worker readiness');
      control = engine.runs[0];
      // This is the same absolute-duration worker schedule for both core versions.
      const scheduler = schedule(control, activity, durationMs);
      let latest = await first;
      while (latest.status === 'running') {
        guard(); apiCalls++;
        latest = await core.get(latest.childId, { runId: latest.runId, waitMs, previewLimit: 64 });
        returned.push(latest);
      }
      await scheduler;
    } else {
      apiCalls++;
      const { waitMs: _waitMs, previewLimit: _previewLimit, ...spawnInput } = input;
      guard();
      const spawned = await core.spawn(spawnInput);
      returned.push(spawned);
      control = engine.runs[0];
      if (!control) throw new Error('Baseline spawn returned before fixture worker was ready');
      const scheduler = schedule(control, activity, durationMs);
      let snap;
      do {
        guard(); apiCalls++;
        snap = await core.get(spawned.childId, { waitMs, previewLimit: 64, cursor: snap?.cursor ?? 0, eventLimit: 1000 });
        returned.push(snap);
      } while (snap.state === 'running');
      await scheduler;
    }
    const final = returned.at(-1);
    const completed = variant === 'candidate' ? final.status === 'completed' : final.state === 'ready' && final.result?.artifactId === 'artifact-controlled';
    if (!completed) throw new Error(`${variant} did not return a completed result: ${JSON.stringify(final)}`);
    if (variant === 'candidate' && (final.result?.artifactId !== 'artifact-controlled' || final.result.preview !== preview.slice(0, 64))) throw new Error(`Candidate result/preview mismatch: ${JSON.stringify(final.result)}`);
    if (variant === 'baseline' && final.result.preview !== preview.slice(0, 64)) throw new Error(`Baseline preview mismatch: ${JSON.stringify(final.result)}`);
    const row = await store.getRun('child-1', 'run-1');
    if (row?.status !== 'completed' || row.result?.artifactId !== 'artifact-controlled' || row.result.preview !== preview) throw new Error(`Actual stored run result mismatch: ${JSON.stringify(row)}`);
    const persisted = await store.readEvents('child-1', 0, 10000);
    const textRows = persisted.events.filter(e => e.type === 'text').length;
    const bodyBytes = returned.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value), 'utf8'), 0);
    const elapsedMs = performance.now() - started;
    return { variant, activity, durationMs, waitMs, wallDeadlineMs, maxApiCalls, apiCalls, returnedValues: returned.length, responseJsonUtf8Bytes: bodyBytes, elapsedMs: +elapsedMs.toFixed(3), persistedTextRows: textRows, finalStatus: variant === 'candidate' ? final.status : row.status, artifactId: final.result?.artifactId, preview: final.result?.preview, storedResult: row.result, schedule: { eventsEmitted: activity, completedAtMs: durationMs } };
  } finally {
    await core.shutdown();
  }
}
function schedule(run, activity, durationMs) {
  const born = performance.now();
  const jobs = [];
  for (let i = 0; i < activity; i++) {
    const at = Math.floor((durationMs * i) / activity);
    jobs.push((async () => {
      await delay(Math.max(0, born + at - performance.now()));
      run.emit({ type: 'text', text: `controlled text ${String(i).padStart(3, '0')} — synthetic` });
      run.emit({ type: 'tool', name: 'read_file', state: 'finished' });
    })());
  }
  jobs.push((async () => { await delay(Math.max(0, born + durationMs - performance.now())); run.complete({ checkpointId: 'checkpoint-controlled', artifactId: 'artifact-controlled', preview }); })());
  return Promise.all(jobs);
}
try {
const cases = [];
for (const activity of [4, 40]) for (const timing of [{ name: 'short', durationMs: 60, waitMs: 200 }, { name: 'long', durationMs: 240, waitMs: 80 }]) {
  for (const [variant, Core] of [['baseline', baseline], ['candidate', candidate]]) cases.push(await one(Core, variant, { activity, ...timing }));
}
const by = (variant, activity, durationMs) => cases.find(c => c.variant === variant && c.activity === activity && c.durationMs === durationMs);
const candidateShortOneCall = [4, 40].every(activity => by('candidate', activity, 60).apiCalls === 1);
const candidateLongBoundedCalls = [4, 40].every(activity => by('candidate', activity, 240).apiCalls <= Math.ceil(240 / 80) + 1);
const candidateNoPersistedText = cases.filter(c => c.variant === 'candidate').every(c => c.persistedTextRows === 0);
const candidateActivityTolerance = [60, 240].every(duration => Math.abs(by('candidate', 4, duration).apiCalls - by('candidate', 40, duration).apiCalls) <= 1);
if (!candidateShortOneCall || !candidateLongBoundedCalls || !candidateNoPersistedText || !candidateActivityTolerance) throw new Error('Candidate observation acceptance assertion failed');
const report = {
  status: 'SUCCESS', baselineRevision: REV,
  sources: { baselineIndexSha256: hash(baselineIndex), baselineTypesSha256: hash(baselineTypes), candidateIndexSha256: hash(await readFile(resolve(repo, 'packages/core/src/index.ts')), 'utf8'), candidateTypesSha256: hash(await readFile(resolve(repo, 'packages/core/src/types.ts'), 'utf8')), fixtureSupportSha256: hash(supportSource) },
  methodology: { sameFixtures: 'packages/core/test/support.ts FakeStore, ControlledEngineFactory, template and ids()', input: { workspaceRoot: '/synthetic/workspace', templateId: 'researcher', model: { url: model.url, model: model.model }, previewLimit: 64 }, previewLimit: 64, eventSchedule: 'each activity unit emits one WorkerEvent text plus one tool at evenly spaced offsets; completion occurs at durationMs', responseBytes: 'sum of UTF-8 bytes of JSON.stringify over actual core-returned values', persistedTextRows: 'actual FakeStore readEvents type=text count', controllerCalls: 'calls to core observation API; setup is included for baseline spawn, candidate run is one call', limits: { outputPreviewBytes: 96, maxWaitMs: 1000 } }, cases,
  assertions: { baselineSourceExactGitShow: true, candidateSourceDirectImport: true, baselineShortCompleted: true, baselineLongCompleted: true, candidateShortCompleted: true, candidateLongCompleted: true, storedRunResultCheckedForEveryCase: true, noManualResponseConstruction: true, candidateShortExactlyOneCoreRunCall: candidateShortOneCall, candidateLongCallsWithinWaitWindowBound: candidateLongBoundedCalls, candidatePersistedTextRowsZero: candidateNoPersistedText, candidateLowHighCallCountsWithinOneCall: candidateActivityTolerance },
  limitations: ['Synthetic local core/controller benchmark only; no provider, LLM tokens, billing, production load, or wall-clock savings inference.', 'FakeStore event fanout and Node scheduler timings are local fixtures; elapsed duration includes setup and excludes shutdown cleanup.', 'Persisted text rows are core event-store records generated by the actual worker schedule.']
};
if (outPath) await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(outPath ? { outPath, status: report.status, cases: cases.map(({ variant, activity, durationMs, waitMs, apiCalls, responseJsonUtf8Bytes, elapsedMs, persistedTextRows, finalStatus }) => ({ variant, activity, durationMs, waitMs, apiCalls, responseJsonUtf8Bytes, elapsedMs, persistedTextRows, finalStatus })) } : report, null, 2));

} finally { await rm(baselineDir, { recursive: true, force: true }); }
