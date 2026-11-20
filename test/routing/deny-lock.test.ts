import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { withDenyLock } from '../../src/routing/deny-lock.js';
import { tempDir, until } from '../helpers.js';

describe('deny-memory lock', () => {
  it('preserves the action result if the ready file cannot be removed', () => {
    const data = tempDir();
    const root = path.join(data, 'sessions', 'deny-locks');
    const result = withDenyLock(data, 'session', () => {
      renameSync(root, `${root}-moved`);
      writeFileSync(root, 'not a directory');
      return 'recorded';
    });
    expect(result).toBe('recorded');
  });

  it('fails open when the operating-system lock utility is unavailable', () => {
    const previous = process.env.PATH;
    process.env.PATH = '';
    try { expect(withDenyLock(tempDir(), 'session', () => 'entered')).toBeUndefined(); }
    finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
  });

  it('releases its lock when the hook process is killed', async () => {
    const data = tempDir();
    const bundle = path.join(tempDir(), 'lock.mjs');
    buildSync({ entryPoints: [path.resolve('src/routing/deny-lock.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm' });
    const active = path.join(data, 'active');
    const source = `import { withDenyLock } from ${JSON.stringify(pathToFileURL(bundle).href)}; import { writeFileSync } from 'node:fs'; withDenyLock(process.argv[1], 'session', () => { writeFileSync(process.argv[2], 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); });`;
    const worker = spawn(process.execPath, ['--input-type=module', '-e', source, data, active], { stdio: 'ignore' });
    try {
      await until(() => existsSync(active));
      const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
      worker.kill('SIGKILL');
      await exited;
      expect(withDenyLock(data, 'session', () => 'entered')).toBe('entered');
    } finally { worker.kill('SIGKILL'); }
  });

  it('excludes another process and is released when the lock holder dies', async () => {
    const data = tempDir();
    const folder = path.join(data, 'sessions', 'deny-locks');
    mkdirSync(folder, { recursive: true });
    const lock = path.join(folder, 'session.lock');
    const ready = path.join(folder, 'holder-ready');
    const helper = "require('node:fs').writeFileSync(process.argv[1], 'ready');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))";
    const program = process.platform === 'darwin' ? 'lockf' : 'flock';
    const args = process.platform === 'darwin'
      ? ['-k', '-t', '2', lock, process.execPath, '-e', helper, ready]
      : ['-w', '2', lock, process.execPath, '-e', helper, ready];
    const holder = spawn(program, args, { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    try {
      await until(() => existsSync(ready));
      expect(withDenyLock(data, 'session', () => 'entered', false)).toBeUndefined();
      process.kill(-holder.pid!, 'SIGKILL');
      holder.stdin?.destroy();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(withDenyLock(data, 'session', () => 'entered')).toBe('entered');
    } finally {
      try { process.kill(-holder.pid!, 'SIGKILL'); } catch { /* already gone */ }
      holder.stdin?.destroy();
      rmSync(ready, { force: true });
    }
  });
});
