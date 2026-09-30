// B3/B4 on ACP engine: steer (prompt while running), cancel, resume from fx file session.
// Mock model: first turn streams slowly (holds turn open), so we can steer/cancel mid-flight.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";

const log = (...a) => console.log("[b34]", ...a);
let holdStreams = false;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    log("mock:", req.method, req.url, "msgs:", parsed.messages?.length);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (holdStreams) {
      // drip chunks slowly so the turn stays open
      let i = 0;
      const timer = setInterval(() => {
        i++;
        res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [{ index: 0, delta: { content: `tick${i} ` }, finish_reason: null }] })}\n\n`);
        if (i >= 30) { clearInterval(timer); finish(res); }
      }, 200);
      return;
    }
    finish(res);
  });
});
function finish(res) {
  res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
fs.writeFileSync("/root/.fx/settings.json", JSON.stringify({
  provider: "mock", auto_upgrade: false, permission_mode: "yolo",
  providers: { mock: { protocol: "openai-chat-completions", base_url: base, auth: { type: "none" },
    model_metadata: { mini: { context_window: 262144, max_output_tokens: 8192, supports_tool_use: true } } } },
  models: { mock: "mini" },
}));

const fx = spawn("/fx/zig-out/bin/fx", ["acp"], { stdio: ["pipe", "pipe", "inherit"], cwd: "/work/ws" });
let id = 0; const pending = new Map(); const updates = [];
const send = (m) => fx.stdin.write(JSON.stringify(m) + "\n");
const rpc = (method, params) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  send({ jsonrpc: "2.0", id: mid, method, params });
  setTimeout(() => pending.has(mid) && (pending.delete(mid), rej(new Error("timeout " + method))), 60000);
});
fx.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
    } else if (msg.method === "session/update") {
      updates.push(msg.params?.update);
    } else if (msg.method === "session/request_permission") {
      send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } });
    } else if (msg.method) send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});

await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
const { sessionId } = await rpc("session/new", {});
log("session", sessionId);

// --- B3a: steer = second session/prompt while first is running ---
holdStreams = true;
const t1 = rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "long task" }] }).then(r => log("B3a turn1 result:", JSON.stringify(r))).catch(e => log("B3a turn1 error:", e.message));
await new Promise((r) => setTimeout(r, 1500));
log("updates so far:", updates.length);
try {
  const r2 = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "STEER: focus on X" }] });
  log("B3a mid-turn prompt ACCEPTED:", JSON.stringify(r2).slice(0, 120));
} catch (e) { log("B3a mid-turn prompt REJECTED:", e.message.slice(0, 160)); }
holdStreams = false;
await t1;
log("updates total after turn1:", updates.length);

// --- B3b: cancel mid-turn ---
holdStreams = true;
const t2 = rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "another long task" }] }).then(r => log("B3b result:", JSON.stringify(r))).catch(e => log("B3b error:", e.message));
await new Promise((r) => setTimeout(r, 1500));
send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
log("cancel sent");
const r2res = await t2; // must settle, never hang
holdStreams = false;

// --- B4: resume the fx file session in a NEW process ---
const sessDir = fs.readdirSync("/root/.fx/sessions").filter(d => fs.existsSync(`/root/.fx/sessions/${d}/session.json`));
log("B4 fx sessions on disk:", sessDir.join(",") || "none");
const fx2 = spawn("/fx/zig-out/bin/fx", ["acp"], { stdio: ["pipe", "pipe", "inherit"], cwd: "/work/ws" });
const pending2 = new Map(); let id2 = 0; const ups2 = [];
const send2 = (m) => fx2.stdin.write(JSON.stringify(m) + "\n");
const rpc2 = (method, params) => new Promise((res, rej) => {
  const mid = ++id2; pending2.set(mid, { res, rej });
  send2({ jsonrpc: "2.0", id: mid, method, params });
  setTimeout(() => pending2.has(mid) && (pending2.delete(mid), rej(new Error("timeout " + method))), 60000);
});
fx2.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending2.has(msg.id)) {
      const p = pending2.get(msg.id); pending2.delete(msg.id);
      msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
    } else if (msg.method === "session/update") ups2.push(msg.params?.update);
    else if (msg.method) send2({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
await rpc2("initialize", { protocolVersion: 1, clientCapabilities: {} });
try {
  const loaded = await rpc2("session/load", { sessionId, cwd: "/work/ws" });
  log("B4 session/load ok:", JSON.stringify(loaded).slice(0, 100));
} catch (e) { log("B4 session/load failed:", e.message.slice(0, 140)); }
try {
  const r = await rpc2("session/prompt", { sessionId, prompt: [{ type: "text", text: "what did we discuss?" }] });
  log("B4 resumed prompt result:", JSON.stringify(r).slice(0, 120));
  log("B4 resumed updates:", ups2.length);
} catch (e) { log("B4 resumed prompt failed:", e.message.slice(0, 140)); }
fx2.kill(); fx.kill();
log("DONE");
process.exit(0);
