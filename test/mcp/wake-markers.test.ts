import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WakeMarkers, waitForWake } from '../../src/mcp/wake-markers.js';

describe('background wake markers', () => {
  it('clears a pending marker if publishing the completion notice fails', () => {
    const data = mkdtempSync(path.join(tmpdir(), 'subzero-wake-'));
    const markers = new WakeMarkers(data, '/project');
    const key = (value: string) => createHash('sha256').update(value).digest('hex');
    markers.start('session-a', 'sz-one');
    mkdirSync(path.join(data, 'wake', key('/project'), key('session-a'), key('sz-one'), 'done'));
    markers.finish('session-a', 'sz-one', 'result');
    expect(markers.read('session-a')).toEqual({ pending: false, notice: undefined });
  });
  it('isolates sessions, claims each completed notice once, and clears collected work', () => {
    const markers = new WakeMarkers(mkdtempSync(path.join(tmpdir(), 'subzero-wake-')), '/project');
    markers.start('session-a', 'sz-one');
    markers.start('session-a', 'sz-two');
    expect(markers.read('session-b')).toEqual({ pending: false, notice: undefined });
    expect(markers.read('session-a')).toEqual({ pending: true, notice: undefined });
    markers.finish('session-a', 'sz-one', 'one finished');
    expect(markers.read('session-a')).toEqual({ pending: true, notice: 'one finished' });
    expect(markers.read('session-a')).toEqual({ pending: true, notice: undefined });
    markers.clear('session-a', 'sz-two');
    markers.finish('session-a', 'sz-two', 'too late');
    expect(markers.read('session-a')).toEqual({ pending: false, notice: undefined });
  });

  it('wakes on a completed result after the Stop hook starts', async () => {
    const data = mkdtempSync(path.join(tmpdir(), 'subzero-wake-data-'));
    const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'subzero-wake-project-')));
    const markers = new WakeMarkers(data, project);
    markers.start('session-a', 'sz-one');
    const hook = spawn(process.execPath, [path.resolve('dist/wake-hook.js')], { env: { ...process.env, SUBZERO_DATA: data, CLAUDE_PROJECT_DIR: project }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    hook.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const exited = new Promise<number | null>((resolve, reject) => { hook.on('error', reject); hook.on('exit', resolve); });
    hook.stdin.end(JSON.stringify({ session_id: 'session-a' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    markers.finish('session-a', 'sz-one', 'the whole result');
    expect(await exited).toBe(2);
    expect(stderr).toContain('the whole result');
  });

  it('renews the wake hook while work outlasts its watch period', async () => {
    const markers = new WakeMarkers(mkdtempSync(path.join(tmpdir(), 'subzero-wake-')), '/project');
    markers.start('session-a', 'sz-one');
    vi.useFakeTimers();
    try {
      const waiting = waitForWake(markers, 'session-a', 500, 100);
      await vi.advanceTimersByTimeAsync(500);
      expect(await waiting).toMatch(/still running.*waiting/i);
      expect(markers.read('session-a').pending).toBe(true);
      markers.finish('session-a', 'sz-one', 'eventual result');
      expect(await waitForWake(markers, 'session-a', 500, 100)).toBe('eventual result');
    } finally { vi.useRealTimers(); }
  });

  it('ignores a pending marker whose server has exited', () => {
    const data = mkdtempSync(path.join(tmpdir(), 'subzero-wake-'));
    const markers = new WakeMarkers(data, '/project');
    markers.start('session-a', 'sz-one');
    const exited = spawnSync(process.execPath, ['-e', '']);
    const key = (value: string) => createHash('sha256').update(value).digest('hex');
    writeFileSync(path.join(data, 'wake', key('/project'), key('session-a'), key('sz-one'), 'owner'), String(exited.pid));
    expect(markers.read('session-a')).toEqual({ pending: false, notice: undefined });
    // A competing hook can still restore a claimed result after the orphan check.
    markers.finish('session-a', 'sz-one', 'restored result');
    expect(markers.read('session-a')).toEqual({ pending: false, notice: 'restored result' });
  });

  it('preserves an active claim after its server exits and recovers an abandoned claim', () => {
    const data = mkdtempSync(path.join(tmpdir(), 'subzero-wake-'));
    const markers = new WakeMarkers(data, '/project');
    const key = (value: string) => createHash('sha256').update(value).digest('hex');
    const folder = path.join(data, 'wake', key('/project'), key('session-a'), key('sz-one'));
    const exited = spawnSync(process.execPath, ['-e', '']);
    markers.start('session-a', 'sz-one');
    markers.finish('session-a', 'sz-one', 'whole result');
    writeFileSync(path.join(folder, 'owner'), String(exited.pid));
    const active = path.join(folder, `${process.pid}.active.claim`);
    renameSync(path.join(folder, 'done'), active);
    expect(markers.read('session-a')).toEqual({ pending: true, notice: undefined });
    expect(existsSync(active)).toBe(true);
    const abandoned = path.join(folder, `${exited.pid}.abandoned.claim`);
    renameSync(active, abandoned);
    expect(markers.read('session-a')).toEqual({ pending: true, notice: undefined });
    expect(markers.read('session-a')).toEqual({ pending: false, notice: 'whole result' });
  });
});
