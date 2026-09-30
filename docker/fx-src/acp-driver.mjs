// Bisect: drive native `fx acp` exactly like fx-sdk.js does (initialize w/ libfx caps -> libfx/new -> session/prompt)
import { spawn } from "node:child_process";

const fx = spawn("/fx/zig-out/bin/fx", ["acp"], { stdio: ["pipe", "pipe", "inherit"] });
let id = 0;
const pending = new Map();
const log = (...a) => console.log("[acp]", ...a);

fx.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log("nonjson:", line.slice(0, 120)); continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    } else if (msg.method === "session/update") {
      log("update:", JSON.stringify(msg.params?.update ?? msg.params).slice(0, 120));
    } else if (msg.method) {
      log("srv->req:", msg.method, JSON.stringify(msg.params ?? {}).slice(0, 120));
      // auto-cancel any permission request like fx-sdk without onPermission
      if (msg.method === "session/request_permission") {
        send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
    }
  }
});

function send(msg) { fx.stdin.write(JSON.stringify(msg) + "\n"); }
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    send({ jsonrpc: "2.0", id: mid, method, params });
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error("timeout " + method)); } }, 20000);
  });
}

const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
log("initialized:", JSON.stringify(init).slice(0, 200));
const sess = await rpc("session/new", {});
log("session:", JSON.stringify(sess).slice(0, 120));
const sessionId = sess.sessionId;
const promptResult = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "say hi" }] });
log("PROMPT RESULT:", JSON.stringify(promptResult));
await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "again" }] }).then((r) => log("PROMPT2:", JSON.stringify(r))).catch((e) => log("PROMPT2 err", e.message));
fx.kill();
process.exit(0);
