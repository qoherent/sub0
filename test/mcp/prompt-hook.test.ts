import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readPromptMarker } from '../../src/mcp/parent-session.js';
import { tempDir } from '../helpers.js';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const HOOK = path.join(REPO, 'dist', 'prompt-hook.js');

function run(input: string, env: Record<string, string | undefined>) {
  const e: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete e[key];
  return spawnSync(process.execPath, [HOOK], { input, env: e, encoding: 'utf8' });
}

describe('prompt hook', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: REPO });
  });

  it('writes the prompt marker for its session id with a time, and prints nothing', () => {
    const project = tempDir();
    const data = tempDir();
    const before = Date.now();
    const result = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's-1', prompt: 'a secret message' }), {
      CLAUDE_PROJECT_DIR: project,
      SUBZERO_DATA: data,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    const at = readPromptMarker(data, project, 's-1');
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(readPromptMarker(data, project, 's-2')).toBeUndefined();
    // The marker holds no text of the message.
    const folder = path.join(data, 'sessions', createHash('sha256').update(project).digest('hex').slice(0, 16), 'prompts');
    for (const name of readdirSync(folder)) expect(readFileSync(path.join(folder, name), 'utf8')).not.toContain('secret');
  });

  it('a later prompt of the session replaces the time', () => {
    const project = tempDir();
    const data = tempDir();
    const env = { CLAUDE_PROJECT_DIR: project, SUBZERO_DATA: data };
    run(JSON.stringify({ session_id: 's-1' }), env);
    const first = readPromptMarker(data, project, 's-1')!;
    run(JSON.stringify({ session_id: 's-1' }), env);
    expect(readPromptMarker(data, project, 's-1')!).toBeGreaterThanOrEqual(first);
  });

  it('exits 0 with no marker and no output for malformed input, no session id, or a missing project', () => {
    const project = tempDir();
    const data = tempDir();
    const env = { CLAUDE_PROJECT_DIR: project, SUBZERO_DATA: data };
    for (const input of ['not json {', '', JSON.stringify({}), JSON.stringify({ session_id: 42 }), JSON.stringify({ session_id: '  ' })]) {
      const result = run(input, env);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    }
    const noProject = run(JSON.stringify({ session_id: 's-1' }), { CLAUDE_PROJECT_DIR: '${CLAUDE_PROJECT_DIR}', SUBZERO_DATA: data });
    expect(noProject.status).toBe(0);
    expect(noProject.stdout).toBe('');
    expect(existsSync(path.join(data, 'sessions'))).toBe(false);
  });

  it('exits 0 with no output when the data folder cannot be written', () => {
    const project = tempDir();
    const data = tempDir();
    writeFileSync(path.join(data, 'sessions'), 'a file where a folder should be');
    const result = run(JSON.stringify({ session_id: 's-1' }), { CLAUDE_PROJECT_DIR: project, SUBZERO_DATA: data });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});
