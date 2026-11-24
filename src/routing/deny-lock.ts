// @sigil implements design/claude-routing-hooks.sigil ClaudeRoutingHooks (deny memory)
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const pause = new Int32Array(new SharedArrayBuffer(4));
// The helper holds the OS lock until its stdin closes, including when the hook dies.
const helper = "require('node:fs').writeFileSync(process.argv[1], 'ready', { mode: 0o600 }); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));";

/** Hold a crash-released per-session lock. An unavailable or busy lock fails open. */
export function withDenyLock<T>(dataDir: string, sessionKey: string, action: () => T, wait = true): T | undefined {
  const root = path.join(dataDir, 'sessions', 'deny-locks');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, `${sessionKey}.lock`);
  const ready = path.join(root, `${process.pid}-${randomUUID()}.ready`);
  const program = process.platform === 'darwin' ? 'lockf' : 'flock';
  const args = process.platform === 'darwin'
    ? ['-k', '-t', wait ? '2' : '0', lock, process.execPath, '-e', helper, ready]
    : ['-w', wait ? '2' : '0', lock, process.execPath, '-e', helper, ready];
  const child = spawn(program, args, { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => undefined);
  try {
    if (child.pid === undefined) return undefined;
    const deadline = Date.now() + (wait ? 2500 : 200);
    while (!existsSync(ready) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 5);
    if (!existsSync(ready)) return undefined;
    return action();
  } finally {
    // The helper and lock utility share a process group, so both release their FDs.
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }
    child.stdin?.destroy();
    child.unref();
    try { rmSync(ready, { force: true }); } catch {}
  }
}
