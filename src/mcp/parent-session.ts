// @sigil implements design/claude-mcp-server.sigil ClaudeMcpServer (parent session id, readiness marker)
//
// The SessionStart hook records each Claude session id in its own file under the
// project, with its ancestor pids, and the server reads the newest entry of its own
// Claude Code process on each call, so a listing stays with this conversation after
// /clear and two sessions of one project never take each other's id.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** A parent without a terminal, or one whose command requests print mode, cannot retain background results. */
export function parentIsNonInteractive(pid = process.ppid): boolean {
  try {
    const row = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'tty=', '-o', 'command='], { encoding: 'utf8', timeout: 2000 }).trim();
    const [, tty, command] = /^(\S+)\s+([\s\S]+)$/.exec(row) ?? [];
    if (!tty || !command || /^\?+$/.test(tty)) return true;
    return /(?:^|\s)(?:--print(?:=\S*)?|-p\S*)(?:\s|$)/.test(command);
  } catch {
    // Unknown mode is treated as non-interactive, so results cannot be lost.
    return true;
  }
}

/** A ${VAR} that the host left unsubstituted counts as unset. */
export function setting(value: string | undefined): string | undefined {
  if (value === undefined || value === '' || /^\$\{[^}]*\}$/.test(value)) return undefined;
  return value;
}

export function dataDir(env: NodeJS.ProcessEnv): string {
  return setting(env.SUBZERO_DATA) ?? setting(env.CLAUDE_PLUGIN_DATA) ?? path.join(homedir(), '.subzero');
}

/** The name of a project's files and folders under the plugin data folder. */
export function projectKey(projectRoot: string): string {
  return createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
}

/** A session file not written for this long is deleted when the hook writes. */
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

/** The folder of a project's session files: one file for each Claude session id. */
function sessionFolder(dir: string, projectRoot: string): string {
  return path.join(dir, 'sessions', projectKey(projectRoot));
}

/**
 * The session id of the newest entry whose recorded ancestor pids include `ppid`, the
 * Claude Code process that started this server (the check the readiness marker uses),
 * or undefined when none does: the listing is then unscoped.
 */
export function readParentSessionId(dir: string, projectRoot: string | undefined, ppid: number): string | undefined {
  if (projectRoot === undefined) return undefined;
  const folder = sessionFolder(dir, projectRoot);
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return undefined;
  }
  let best: { sessionId: string; at: number } | undefined;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const value = JSON.parse(readFileSync(path.join(folder, name), 'utf8')) as { sessionId?: unknown; updatedAt?: unknown; ancestors?: unknown };
      if (typeof value.sessionId !== 'string' || value.sessionId === '' || !Array.isArray(value.ancestors) || !value.ancestors.includes(ppid)) continue;
      const at = typeof value.updatedAt === 'string' ? Date.parse(value.updatedAt) : Number.NaN;
      if (Number.isNaN(at)) continue;
      if (best === undefined || at >= best.at) best = { sessionId: value.sessionId, at };
    } catch {
      // An unreadable entry counts as absent.
    }
  }
  return best?.sessionId;
}

/**
 * Record one Claude session id of a project in its own file, with the hook's ancestor
 * pids, so a resumed or cleared session becomes the newest entry of its Claude process
 * and no session overwrites another's. Files not written for seven days are deleted.
 */
export function writeParentSessionId(dir: string, projectRoot: string, sessionId: string, ancestors: Iterable<number>, now: number = Date.now()): void {
  const folder = sessionFolder(dir, projectRoot);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ sessionId, projectRoot, updatedAt: new Date(now).toISOString(), ancestors: [...ancestors] }) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  pruneSessions(folder, now, file);
}

function pruneSessions(folder: string, now: number, keep: string): void {
  try {
    for (const name of readdirSync(folder)) {
      const file = path.join(folder, name);
      if (file === keep) continue;
      try {
        if (now - statSync(file).mtimeMs > SESSION_TTL_MS) rmSync(file, { force: true });
      } catch {
        // A file another process just removed is gone either way.
      }
    }
  } catch {
    // Nothing to prune.
  }
}

// The readiness marker: while a server runs for a project, its folder under the plugin
// data folder holds one file named by the server's pid, with that pid and its parent's
// pid (the Claude Code process that started it). The PreToolUse hook denies only while
// a marker names a live process whose parent is one of the hook's own ancestors.

function readinessDir(dir: string, projectRoot: string): string {
  return path.join(dir, 'ready', projectKey(projectRoot));
}

export interface ReadinessMarker {
  pid: number;
  ppid: number;
  taskMode: boolean | null;
}

export function writeReadinessMarker(dir: string, projectRoot: string, pid: number, ppid: number, taskMode = false): void {
  const folder = readinessDir(dir, projectRoot);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `${pid}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid, ppid, projectRoot, taskMode, startedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

export function removeReadinessMarker(dir: string, projectRoot: string, pid: number): void {
  rmSync(path.join(readinessDir(dir, projectRoot), `${pid}.json`), { force: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code === 'EPERM';
  }
}

/** The markers of a project whose process is alive; a dead one counts as absent. */
export function liveReadinessMarkers(dir: string, projectRoot: string): ReadinessMarker[] {
  const folder = readinessDir(dir, projectRoot);
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const live: ReadinessMarker[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const value = JSON.parse(readFileSync(path.join(folder, name), 'utf8')) as { pid?: unknown; ppid?: unknown; taskMode?: unknown };
      if (Number.isInteger(value.pid) && Number.isInteger(value.ppid) && isAlive(value.pid as number)) {
        live.push({ pid: value.pid as number, ppid: value.ppid as number, taskMode: typeof value.taskMode === 'boolean' ? value.taskMode : null });
      }
    } catch {
      // An unreadable marker counts as absent.
    }
  }
  return live;
}

// The prompt marker and the call markers: the UserPromptSubmit hook records when the
// user last typed in a session, and the PreToolUse hook records, for each subzero tool
// call, whether a subagent made it. The server reads both to tell a call it should end
// early from one it should not. Each lives in its own file under the project's session
// folder (`prompts/` and `calls/`), written by temp file and rename.

/** A call marker not written for this long is deleted when a new one is written. */
const CALL_TTL_MS = 3600 * 1000;

function atomicWrite(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

function promptFile(dir: string, projectRoot: string, sessionId: string): string {
  return path.join(sessionFolder(dir, projectRoot), 'prompts', `${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.json`);
}

/** Record when the user submitted a prompt in a session: `time` is epoch milliseconds. Holds no message text. */
export function writePromptMarker(dir: string, projectRoot: string, sessionId: string, time: number = Date.now()): void {
  atomicWrite(promptFile(dir, projectRoot, sessionId), JSON.stringify({ sessionId, at: time }) + '\n');
}

/** The epoch milliseconds of the session's last prompt, or undefined when there is no readable marker. */
export function readPromptMarker(dir: string, projectRoot: string, sessionId: string): number | undefined {
  try {
    const value = JSON.parse(readFileSync(promptFile(dir, projectRoot, sessionId), 'utf8')) as { at?: unknown };
    return typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : undefined;
  } catch {
    return undefined;
  }
}

/** A tool-use id is a file name, so only plain id characters are accepted. */
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function callFile(dir: string, projectRoot: string, toolUseId: string): string | undefined {
  return TOOL_USE_ID.test(toolUseId) ? path.join(sessionFolder(dir, projectRoot), 'calls', `${toolUseId}.json`) : undefined;
}

export interface CallMarker {
  /** The subagent that made the call; absent when the main conversation made it. */
  agentId?: string;
}

/**
 * Record one subzero tool call under its tool-use id, with the id of the subagent that
 * made it or none. Call markers older than an hour are deleted (best effort).
 */
export function writeCallMarker(dir: string, projectRoot: string, toolUseId: string, agentId?: string, now: number = Date.now()): void {
  const file = callFile(dir, projectRoot, toolUseId);
  if (file === undefined) return;
  atomicWrite(file, JSON.stringify({ toolUseId, ...(agentId ? { agentId } : {}), at: now }) + '\n');
  try {
    const folder = path.dirname(file);
    for (const name of readdirSync(folder)) {
      const other = path.join(folder, name);
      if (other === file) continue;
      try {
        if (now - statSync(other).mtimeMs > CALL_TTL_MS) rmSync(other, { force: true });
      } catch {
        // A file another process just removed is gone either way.
      }
    }
  } catch {
    // Nothing to prune.
  }
}

/** The call marker of a tool-use id, or undefined when there is none. */
export function readCallMarker(dir: string, projectRoot: string, toolUseId: string): CallMarker | undefined {
  const file = callFile(dir, projectRoot, toolUseId);
  if (file === undefined) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as { agentId?: unknown };
    return typeof value.agentId === 'string' && value.agentId !== '' ? { agentId: value.agentId } : {};
  } catch {
    return undefined;
  }
}
