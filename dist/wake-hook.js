import { createRequire as __subzeroCreateRequire } from 'node:module';
const require = __subzeroCreateRequire(import.meta.url);

// src/mcp/wake-hook.ts
import { realpathSync } from "node:fs";

// src/mcp/parent-session.ts
import { homedir } from "node:os";
import path from "node:path";
function setting(value) {
  if (value === void 0 || value === "" || /^\$\{[^}]*\}$/.test(value)) return void 0;
  return value;
}
function dataDir(env) {
  return setting(env.SUBZERO_DATA) ?? setting(env.CLAUDE_PLUGIN_DATA) ?? path.join(homedir(), ".subzero");
}
var SESSION_TTL_MS = 7 * 24 * 3600 * 1e3;

// src/mcp/wake-markers.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path2 from "node:path";
var key = (value) => createHash("sha256").update(value).digest("hex");
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
var WakeMarkers = class {
  constructor(dataDir2, projectRoot) {
    this.dataDir = dataDir2;
    this.projectRoot = projectRoot;
  }
  dataDir;
  projectRoot;
  folder(session) {
    return path2.join(this.dataDir, "wake", key(this.projectRoot), key(session));
  }
  taskFolder(session, task) {
    return path2.join(this.folder(session), key(task));
  }
  start(session, task) {
    const folder = this.folder(session);
    mkdirSync(folder, { recursive: true, mode: 448 });
    const temp = path2.join(folder, `${randomUUID()}.tmp`);
    mkdirSync(temp, { mode: 448 });
    try {
      writeFileSync(path2.join(temp, "owner"), String(process.pid), { mode: 384 });
      renameSync(temp, this.taskFolder(session, task));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  finish(session, task, notice) {
    const folder = this.taskFolder(session, task);
    const temp = path2.join(folder, `${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, notice, { mode: 384 });
      renameSync(temp, path2.join(folder, "done"));
    } catch {
      try {
        this.clear(session, task);
      } catch {
      }
    } finally {
      rmSync(temp, { force: true });
    }
  }
  clear(session, task) {
    rmSync(this.taskFolder(session, task), { recursive: true, force: true });
  }
  read(session) {
    const folder = this.folder(session);
    let names;
    try {
      names = readdirSync(folder).filter((name) => /^[a-f0-9]{64}$/.test(name));
    } catch {
      return { pending: false, notice: void 0 };
    }
    let pending = false;
    let notice;
    for (const name of names) {
      const taskFolder = path2.join(folder, name);
      if (notice !== void 0) {
        pending = true;
        continue;
      }
      const claimed = path2.join(taskFolder, `${process.pid}.${randomUUID()}.claim`);
      try {
        renameSync(path2.join(taskFolder, "done"), claimed);
        notice = readFileSync(claimed, "utf8");
        rmSync(taskFolder, { recursive: true, force: true });
      } catch {
        try {
          const claims = readdirSync(taskFolder).filter((name2) => name2.endsWith(".claim"));
          if (claims.length) {
            for (const claim of claims) {
              if (!alive(Number(claim.split(".")[0]))) {
                try {
                  renameSync(path2.join(taskFolder, claim), path2.join(taskFolder, "done"));
                } catch {
                }
              }
            }
            pending = true;
            continue;
          }
          const pid = Number(readFileSync(path2.join(taskFolder, "owner"), "utf8"));
          if (!Number.isInteger(pid) || pid <= 0) throw new Error("invalid owner");
          if (alive(pid)) pending = true;
        } catch {
        }
      }
    }
    return { pending, notice };
  }
};
async function waitForWake(markers, session, renewalMs = 55 * 6e4, pollMs = 250) {
  const started = Date.now();
  while (true) {
    const { pending, notice } = markers.read(session);
    if (notice !== void 0) return notice;
    if (!pending) return void 0;
    if (Date.now() - started >= renewalMs) return "Subzero tasks are still running. Keep waiting for their results before using them.";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// src/mcp/wake-hook.ts
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const project = setting(process.env.CLAUDE_PROJECT_DIR);
  if (typeof input.session_id === "string" && input.session_id && project) {
    const markers = new WakeMarkers(dataDir(process.env), realpathSync(project));
    const notice = await waitForWake(markers, input.session_id);
    if (notice !== void 0) process.stderr.write(`${notice}
`, () => process.exit(2));
  }
} catch {
}
