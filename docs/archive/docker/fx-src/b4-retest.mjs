// B4-retest (single process at a time) + B3c libfx/steer
import { spawn } from "node:child_process";
import fs from "node:fs";

const log = (...a) => console.log("[b4r]", ...a);
let hold = false;
import http from "node:http";
fs.mkdirSync("/root/.fx", { recursive: true });
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (hold) {
      let i = 0;
      const t = setInterval(() => {
        i++;
        res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [{ index: 0, delta: { content: `t${i} ` }, finish_reason: null }] })}\n\n`);
        if (i >= 40) { clearInterval(t); fin(res); }
      }, 150);
      return;
    }
    fin(res);
  });
});
function fin(res) {
  res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
fs.writeFileSync("/root/.fx/settings.json", JSON.stringify({
  provider: "mock", auto_upgrade: false, permission_mode: "yolo",
  providers: { mock: { protocol: "openai-chat-completions", base_url: `http://127.0.0.1:${srv.address().port}/v1`, auth: { type: "none" },
    model_metadata: { mini: { context_window: 262144, max_output_tokens: 8192, supports_tool_use: true } } } },
  models: { mock: "mini" },
}));

function makeFx() {
  const p = spawn("/fx/zig-out/bin/fx", ["acp"], { stdio: ["pipe", "pipe", "inherit"], cwd: "/work/ws" });
  const pending = new Map(); let id = 0; const updates = [];
  p.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const q = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? q.rej(new Error(JSON.stringify(msg.error))) : q.res(msg.result);
      } else if (msg.method === "session/update") updates.push(msg.params?.update);
      else if (msg.method === "session/request_permission") p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }) + "\n");
      else if (msg.method) p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
    }
  });
  return {
    proc: p, updates,
    rpc(method, params) {
      return new Promise((res, rej) => {
        const mid = ++id; pending.set(mid, { res, rej });
        p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
        setTimeout(() => pending.has(mid) && (pending.delete(mid), rej(new Error("timeout " + method))), 60000);
      });
    },
    notify(method, params) { p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); },
    kill() { p.kill(); },
  };
}

// --- turn 1 in process 1, then kill ---
let fx1 = makeFx();
await fx1.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
const { sessionId } = await fx1.rpc("session/new", {});
log("session", sessionId);
hold = true;
const t1 = fx1.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "long task" }] }).then(r => log("turn1:", JSON.stringify(r))).catch(e => log("turn1 err:", e.message.slice(0, 100)));
await new Promise((r) => setTimeout(r, 1200));

// --- B3c: libfx/steer while running ---
try {
  const r = await fx1.rpc("libfx/steer", { sessionId, message: "STEER: focus on X" });
  log("B3c libfx/steer ACCEPTED:", JSON.stringify(r).slice(0, 140));
} catch (e) { log("B3c libfx/steer REJECTED:", e.message.slice(0, 160)); }
hold = false;
await t1;
log("updates turn1:", fx1.updates.length);
fx1.kill();
await new Promise((r) => setTimeout(r, 500));

// --- B4: fresh process, session/load + prompt ---
let fx2 = makeFx();
await fx2.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
try {
  await fx2.rpc("session/load", { sessionId, cwd: "/work/ws" });
  log("B4 session/load OK");
  const r = await fx2.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "what did we discuss?" }] });
  log("B4 resumed result:", JSON.stringify(r).slice(0, 130));
  const texts = fx2.updates.filter(u => u?.sessionUpdate === "agent_message_chunk").map(u => u.content?.text ?? "").join("");
  log("B4 resumed text:", texts.slice(0, 200));
  const hasHistory = fx2.updates.length > 2; // replayed history updates?
  log("B4 updates count (history replay?):", fx2.updates.length);
} catch (e) { log("B4 failed:", e.message.slice(0, 160)); }
fx2.kill();
log("DONE");
process.exit(0);
