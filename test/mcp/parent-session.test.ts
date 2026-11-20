import { existsSync, readdirSync, utimesSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parentIsNonInteractive, readParentSessionId, writeParentSessionId } from '../../src/mcp/parent-session.js';
import { tempDir } from '../helpers.js';

const DAY = 24 * 3600 * 1000;

describe('parent process mode', () => {
  it('treats a process without a terminal as non-interactive', () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
    try { expect(child.pid).toBeDefined(); expect(parentIsNonInteractive(child.pid!)).toBe(true); }
    finally { child.kill(); }
  });
});

describe('parent session id per Claude process', () => {
  it('two sessions of one project from different parent processes do not see each other', () => {
    const data = tempDir();
    const project = tempDir();
    writeParentSessionId(data, project, 'session-a', [100, 10]);
    writeParentSessionId(data, project, 'session-b', [200, 20]);
    expect(readParentSessionId(data, project, 10)).toBe('session-a');
    expect(readParentSessionId(data, project, 20)).toBe('session-b');
  });

  it('the newest session of the same parent process wins (/clear, resume)', () => {
    const data = tempDir();
    const project = tempDir();
    const t = Date.now();
    writeParentSessionId(data, project, 'old', [100, 10], t - 5000);
    writeParentSessionId(data, project, 'new', [101, 10], t);
    writeParentSessionId(data, project, 'other', [300, 30], t + 1000);
    expect(readParentSessionId(data, project, 10)).toBe('new');
    // A resumed older session writes again and becomes the newest.
    writeParentSessionId(data, project, 'old', [102, 10], t + 2000);
    expect(readParentSessionId(data, project, 10)).toBe('old');
  });

  it('gives undefined when no entry names the process, for another project, and without a root', () => {
    const data = tempDir();
    const project = tempDir();
    writeParentSessionId(data, project, 'session-a', [100, 10]);
    expect(readParentSessionId(data, project, 99)).toBeUndefined();
    expect(readParentSessionId(data, tempDir(), 10)).toBeUndefined();
    expect(readParentSessionId(data, undefined, 10)).toBeUndefined();
    expect(readParentSessionId(tempDir(), project, 10)).toBeUndefined();
  });

  it('prunes session files older than seven days on write', () => {
    const data = tempDir();
    const project = tempDir();
    writeParentSessionId(data, project, 'stale', [100, 10]);
    const folder = path.join(data, 'sessions', readdirSync(path.join(data, 'sessions'))[0]!);
    const stale = path.join(folder, readdirSync(folder)[0]!);
    const old = new Date(Date.now() - 8 * DAY);
    utimesSync(stale, old, old);
    writeParentSessionId(data, project, 'fresh', [101, 10]);
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(folder)).toHaveLength(1);
    expect(readParentSessionId(data, project, 10)).toBe('fresh');
  });
});
