// E10: limits on ACP — oversized instructions + oversized delta. E3: provider switch via config option.
import http from "node:http";
import fs from "node:fs";

const log = (...a) => console.log("[el]", ...a);
function mkMock(tag) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push(1);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (tag === "big") {
        res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [{ index: 0, delta: { role: "assistant", content: "X".repeat(40000) }, finish_reason: null }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [{ index: 0, delta: { role: "assistant", content: `hello-from-${tag}` }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", r)).then(() => ({ server, hits, port: server.address().port, tag }));
}

const mockA = await mkMock("alpha");
const mockBig = await mkMock("big");
fs.mkdirSync("/root/.fx", { recursive: true });
fs.writeFileSync("/root/.fx/settings.json", JSON.stringify({
  provider: "alpha", auto_upgrade: false, permission_mode: "yolo",
  providers: {
    alpha: { protocol: "openai-chat-completions", base_url: `http://127.0.0.1:${mockA.port}/v1`, auth: { type: "none" },
      model_metadata: { mini: { context_window: 262144, max_output_tokens: 8192, supports_tool_use: true } } },
    beta: { protocol: "openai-chat-completions", base_url: `http://127.0.0.1:${mockBig.port}/v1`, auth: { type: "none" },
      model_metadata: { mini: { context_window: 262144, max_output_tokens: 8192, supports_tool_use: true } } },
  },
  models: { alpha: "mini", beta: "mini" },
}));

const { spawn } = await import("node:child_process");
const fx = spawn("/fx/zig-out/bin/fx", ["acp"], { stdio: ["pipe", "pipe", "inherit"], cwd: "/work/ws" });
const pending = new Map(); let id = 0; let bigDeltaSeen = 0; let helloAlpha = 0; let helloBeta = 0; let configOpts = null;
const send = (m) => fx.stdin.write(JSON.stringify(m) + "\n");
const rpc = (method, params) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  send({ jsonrpc: "2.0", id: mid, method, params });
  setTimeout(() => pending.has(mid) && (pending.delete(mid), rej(new Error("timeout " + method))), 30000);
});
fx.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.rej(new Error(JSON.stringify(msg.error).slice(0, 200))) : p.res(msg.result);
    } else if (msg.method === "session/update") {
      const u = JSON.stringify(msg.params?.update ?? {});
      if (u.includes("XXXXX")) bigDeltaSeen += (u.match(/X/g) || []).length;
      if (u.includes("hello-from-alpha")) helloAlpha++;
      if (u.includes("hello-from-beta")) helloBeta++;
    } else if (msg.method) send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});

const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
configOpts = init.configOptions;
log("E3 initialize keys:", Object.keys(init).join(","));
const sess = await rpc("session/new", {});
const sessionId = sess.sessionId;
configOpts = sess.configOptions;
log("E3 session/new configOptions:", JSON.stringify(configOpts)?.slice(0, 400) || "(none)");

// turn 1 on alpha
await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
log(`E3 turn1: alpha chunks=${helloAlpha}`);

// E3: switch provider to beta via set_config_option (discover option id from configOptions)
try {
  const opt = (configOpts ?? []).find(o => o.category === "model" || o.id === "provider") ?? configOpts?.[0];
  log("E3 using config option:", JSON.stringify(opt)?.slice(0, 200));
  const r = await rpc("session/set_config_option", { sessionId, configId: opt?.configId ?? opt?.id, value: "beta" });
  log("E3 set_config_option ok:", JSON.stringify(r).slice(0, 120));
} catch (e) { log("E3 set_config_option rejected:", e.message.slice(0, 160)); }
await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi again" }] });
log(`E3 turn2: beta chunks=${helloBeta} (provider switch ${helloBeta > 0 ? "WORKS" : "did not switch"})`);
log(`E3 mock hits: alpha=${mockA.hits.length} big=${mockBig.hits.length}`);

// E10: oversized instructions — new session with 65KiB prompt text as instructions surrogate:
// fx instructions limits are set via initialize libfx caps (libfx surface); on ACP the system prompt is fx-owned,
// so instead test oversized PROMPT (512KiB) — documents transport behavior for our own instruction clamps.
const bigPrompt = "y".repeat(512 * 1024);
try {
  const r = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: bigPrompt }] });
  log("E10 512KiB prompt ACCEPTED:", JSON.stringify(r).slice(0, 100));
} catch (e) { log("E10 512KiB prompt REJECTED:", e.message.slice(0, 160)); }
log(`E10 40KiB delta: total X chars delivered = ${bigDeltaSeen} (${bigDeltaSeen >= 40000 ? "WHOLE — no truncation" : bigDeltaSeen > 0 ? "PARTIAL/chunked" : "lost"})`);
fx.kill();
process.exit(0);
