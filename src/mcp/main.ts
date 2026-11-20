// @sigil implements design/claude-mcp-server.sigil ClaudeMcpServer (process entry)
//
// node dist/server.js, started by Claude Code from the plugin's .mcp.json. The
// project root comes from SUBZERO_PROJECT_DIR or the roots Claude Code reports,
// never from this process's working directory. This entry point imports and
// registers the child driver and the parent adapter this process needs, before its
// first request.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Kernel } from '../kernel/kernel.js';
import { PI_HOST, PiDriver } from '../pi/driver.js';
import { DelegationService } from '../service/delegation-service.js';
import { dataDir, parentIsNonInteractive, readParentSessionId, removeReadinessMarker, setting, writeReadinessMarker } from './parent-session.js';
import { createSubzeroServer } from './server.js';

// Stamped by build.mjs from package.json; absent when this file runs unbundled.
declare const __SUBZERO_VERSION__: string | undefined;
const version = typeof __SUBZERO_VERSION__ === 'string' ? __SUBZERO_VERSION__ : undefined;

const env = { ...process.env };
if (setting(env.SUBZERO_PROJECT_DIR) === undefined) delete env.SUBZERO_PROJECT_DIR;

let server: ReturnType<typeof createSubzeroServer>;
const pi = setting(env.SUBZERO_PI);
const piDriver = new PiDriver(pi !== undefined ? { piCommand: [pi] } : {});
const kernel = new Kernel();
kernel.registerChildDriver(PI_HOST, piDriver);
kernel.registerParentAdapter('claude-code');
const service = new DelegationService({
  env,
  kernel,
  roots: async () => {
    if (!server.getClientCapabilities()?.roots) return [];
    const { roots } = await server.listRoots();
    return roots.map((root) => root.uri);
  },
});
const data = dataDir(env);

// The readiness marker says to the PreToolUse hook that this server can serve its
// project: written once the project root resolves, removed on exit. A killed server
// leaves a marker whose pid is dead, which counts as absent.
let markedRoot: string | undefined;
let readyTaskMode = false;
function markReady(): void {
  const root = service.projectRoot;
  if (root === undefined || markedRoot !== undefined) return;
  try {
    writeReadinessMarker(data, root, process.pid, process.ppid, readyTaskMode);
    markedRoot = root;
  } catch {
    // Without a marker the hook lets every spawn through, which is the safe side.
  }
}
process.on('exit', () => {
  if (markedRoot === undefined) return;
  try {
    removeReadinessMarker(data, markedRoot, process.pid);
  } catch {
    // A marker left behind names a dead pid and counts as absent.
  }
});

const nonInteractive = parentIsNonInteractive();
server = createSubzeroServer({
  service,
  version,
  wakeDataDir: data,
  nonInteractive,
  taskMode: !nonInteractive,
  onTaskMode: (enabled) => {
    if (readyTaskMode === enabled) return;
    if (markedRoot !== undefined) {
      try { writeReadinessMarker(data, markedRoot, process.pid, process.ppid, enabled); }
      catch {
        // A stale task-mode marker is unsafe; remove it so routing fails open.
        try { removeReadinessMarker(data, markedRoot, process.pid); } catch {}
        markedRoot = undefined;
      }
    }
    readyTaskMode = enabled;
  },
  parentSessionId: () => {
    markReady(); // a root that resolved later, through a reported root, is marked on the next call
    return readParentSessionId(data, service.projectRoot, process.ppid);
  },
});

// Start-up goes through the service so the start-up sweep runs; when no root
// resolves yet, each later call tries again and reports the error.
server.oninitialized = () => void service.start().then(markReady, () => undefined);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  // Leave no child run behind: past the deadline the service kills what is left.
  // If this process is killed first, pi still sees EOF on its stdin and exits.
  if (!(await service.shutdown(8000))) piDriver.killAll();
  process.exit(0);
}
process.stdin.on('end', () => void shutdown());
process.stdin.on('close', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

await server.connect(new StdioServerTransport());
