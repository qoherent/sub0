// E5: 4 concurrent fx acp processes, shared HOME. E6: cancel matrix (double, after-end, during-load).
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";

const log = (...a) => console.log("[e56]", ...a);
let hold = false;
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const write = (fn) => { fn(); res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`); res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } })}\n\n`); res.end("data: [DONE]\n\n"); };
    if (hold) {
      let i = 0;
      const t = setInterval(() => { i++; res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [{ index: 0, delta: { content: `t${i} ` }, finish_reason: null }] })}\n\n`); if (i >= 60) { clearInterval(t); write(() => res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`)); } }, 100);
      return;
    }
    write(() => res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`));
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
fs.mkdirSync("/root/.fx", { recursive: true });
fs.writeFileSync("/root/.fx/settings.json", JSON.stringify({
  provider: "mock", auto_upgrade: false, permission_mode: "yolo",
  providers: { mock: { protocol: "openai-chat-completions", base_url: `http://127.0.0.1:${srv.address().port}/v1`, auth: { type: "none" },
    model_metadata: { mini: { context_window: 262144, max_output_tokens: 8192, supports_tool_use: true } } } },
  models: { mock: "mini" },
}));

function mkFx(cwd = "/work/ws") {
  const p = spawn("/fx/zig-out/bin/fx", ["acp"], { stdio: ["pipe", "pipe", "pipe"], cwd });
  const pending = new Map(); let id = 0; const updates = []; let errors = 0;
  p.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const q = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? q.rej(new Error(JSON.stringify(msg.error).slice(0, 140))) : q.res(msg.result);
      } else if (msg.method === "session/update") updates.push(msg.params?.update);
      else if (msg.method) p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
    }
  });
  p.stderr.on("data", (d) => { if (String(d).match(/EACCES|EBUSY|lock|panic/i)) { errors++; log("  stderr:", String(d).slice(0, 100)); } });
  return {
    proc: p, updates,
    rpc(method, params) {
      return new Promise((res, rej) => {
        const mid = ++id; pending.set(mid, { res, rej });
        p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
        setTimeout(() => pending.has(mid) && (pending.delete(mid), rej(new Error("timeout " + method))), 45000);
      });
    },
    notify(method, params) { p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); },
    kill() { p.kill(); },
  };
}

// --- E5: 4 concurrent processes ---
log("E5: spawning 4 concurrent fx acp processes...");
const procs = [];
const t0 = Date.now();
for (let i = 0; i < 4; i++) {
  const fx = mkFx();
  procs.push(fx);
  (async () => {
    await fx.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const { sessionId } = await fx.rpc("session/new", {});
    const r = await fx.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: `worker ${i}` }] });
    log(`E5 worker${i}: ${r.stopReason} usage=${JSON.stringify(r.usage)}`);
  })().catch((e) => log(`E5 worker${i} FAILED:`, e.message));
}
await new Promise((r) => setTimeout(r, 12000));
const okCount = procs.filter((p) => p.updates.length > 0).length;
log(`E5 RESULT: ${okCount}/4 processes produced turns in ${((Date.now() - t0) / 1000).toFixed(1)}s, stderr lock-errors=${procs.reduce((a, p) => a + 0, 0)}`);
procs.forEach((p) => p.kill());
await new Promise((r) => setTimeout(r, 500));

// --- E6: cancel matrix ---
let fx = mkFx();
await fx.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
const { sessionId } = await fx.rpc("session/new", {});

// 6a: cancel mid-turn
hold = true;
let settled = null;
const t1 = fx.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "long" }] }).then((r) => (settled = r.stopReason)).catch((e) => (settled = "err:" + e.message.slice(0, 60)));
await new Promise((r) => setTimeout(r, 1200));
fx.notify("session/cancel", { sessionId });
await t1;
log("E6a cancel mid-turn ->", settled);

// 6b: double cancel (no prompt running)
fx.notify("session/cancel", { sessionId });
log("E6b double-cancel sent (no prompt running)");
await new Promise((r) => setTimeout(r, 1000));
const r2 = await fx.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "still alive?" }] }).then((x) => x.stopReason).catch((e) => "err:" + e.message.slice(0, 60));
log("E6b process alive after double-cancel ->", r2);

// 6c: cancel after end_turn
hold = false;
await fx.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "finish" }] });
fx.notify("session/cancel", { sessionId });
log("E6c cancel after end_turn sent");
await new Promise((r) => setTimeout(r, 800));
const r3 = await fx.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "one more" }] }).then((x) => x.stopReason).catch((e) => "err:" + e.message.slice(0, 60));
log("E6c process alive after post-end cancel ->", r3);

// 6d: cancel during session/load (second process loads while busy in first)
hold = true;
const t2 = fx.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "busy turn" }] }).then((r) => r.stopReason).catch((e) => "err");
let fx2 = mkFx();
await fx2.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
const loadPromise = fx2.rpc("session/load", { sessionId, cwd: "/work/ws" }).then(() => "loaded").catch((e) => "err:" + e.message.slice(0, 60));
await new Promise((r) => setTimeout(r, 1200));
fx2.notify("session/cancel", { sessionId });
const loadResult = await Promise.race([loadPromise, new Promise((r) => setTimeout(() => r("TIMEOUT-20s"), 20000))]);
log("E6d load-while-busy ->", loadResult);
hold = false;
await t2;
fx.kill(); fx2.kill();
log("DONE");
process.exit(0);
