import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { WakeMarkers } from '../../src/mcp/wake-markers.js';
import { tempDir } from '../helpers.js';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const HOOK = path.join(REPO, 'dist', 'wake-hook.js');

function runHook(data: string, project: string) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: 's-1' }),
    env: { ...process.env, SUBZERO_DATA: data, CLAUDE_PROJECT_DIR: project },
    encoding: 'utf8',
  });
}

describe('wake hook collected marker', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: REPO });
  });

  function finished(notice: string) {
    const data = tempDir();
    const project = tempDir();
    const markers = new WakeMarkers(data, project);
    markers.start('s-1', 'sz-one');
    markers.finish('s-1', 'sz-one', notice);
    return { data, project };
  }

  it('creates the collected marker named by the wake marker and delivers the notice text', () => {
    const collected = path.join(tempDir(), 'turn.collected');
    const { data, project } = finished(JSON.stringify({ notice: 'the whole result', collectedMarker: collected }));
    const result = runHook(data, project);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('the whole result\n');
    expect(existsSync(collected)).toBe(true);
  });

  it('leaves an existing collected marker alone and still delivers', () => {
    const collected = path.join(tempDir(), 'turn.collected');
    writeFileSync(collected, 'kept');
    const { data, project } = finished(JSON.stringify({ notice: 'again', collectedMarker: collected }));
    const result = runHook(data, project);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('again');
  });

  it('survives an unwritable collected marker path and still delivers the result', () => {
    const folder = tempDir();
    const blocker = path.join(folder, 'blocker');
    writeFileSync(blocker, 'a file');
    const { data, project } = finished(JSON.stringify({ notice: 'delivered anyway', collectedMarker: path.join(blocker, 'turn.collected') }));
    const result = runHook(data, project);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('delivered anyway');
  });

  it('delivers a plain text notice as it is and creates no marker', () => {
    mkdirSync(tempDir(), { recursive: true });
    const { data, project } = finished('plain result');
    const result = runHook(data, project);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('plain result\n');
  });
});
