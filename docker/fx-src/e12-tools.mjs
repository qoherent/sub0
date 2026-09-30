// E12: ACP tool usage — fx builtin write_file under yolo, then under ask (permission round-trip).
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";

const log = (...a) => console.log("[e12]", ...a);
let turnCount = 0;
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    turnCount++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunks = [];
    if (turnCount === 1) {
      const delta = { role: "assistant", tool_calls: [{ index: 0, id: "call1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: `/work/ws/e12-${process.env.PM || "yolo"}.txt`, content: "hello-e12" }) } }] };
      chunks.push({ id: "c", model: "mini", choices: [{ index: 0, delta, finish_reason: null }] });
      chunks.push({ id: "c", model: "mini", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      chunks.push({ id: "c", model: "mini", choices: [{ index: 0, delta: { role: "assistant", content: "wrote the file" }, finish_reason: null }] });
      chunks.push({ id: "c", model: "mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    for (const value of chunks) res.write(`data: ${JSON.stringify(value)}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
fs.mkdirSync("/root/.fx", { recursive: true });
fs.mkdirSync("/work/ws", { recursive: true });
fs.writeFileSync("/root/.fx/settings.json", JSON.stringify({
  provider: "mock", auto_upgrade: false,
  permission_mode: process.env.PM || "yolo",
  providers: { mock: { protocol: "openai-chat-completions", base_url: `http://127.0.0.1:${srv.address().port}/v1`, auth: { type: "none" },
    model_metadata: { mini: { context_window: 262144, max_output_tokens: 8192, supports_tool_use: true } } } },
  models: { mock: "mini" },
}));

const { spawn: sp } = await import("node:child_process");
const fx = sp("/fx/zig-out/bin/fx", ["acp"], { stdio: ["pipe", "pipe", "pipe"], cwd: "/work/ws" });
const pending = new Map(); let id = 0;
const toolCalls = []; let permissionSeen = null; let answered = null;
const send = (m) => fx.stdin.write(JSON.stringify(m) + "\n");
const rpc = (method, params) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  send({ jsonrpc: "2.0", id: mid, method, params });
  setTimeout(() => pending.has(mid) && (pending.delete(mid), rej(new Error("timeout " + method))), 45000);
});
fx.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.rej(new Error(JSON.stringify(msg.error).slice(0, 160))) : p.res(msg.result);
    } else if (msg.method === "session/update") {
      const u = msg.params?.update ?? {};
      if (u.sessionUpdate === "tool_call") toolCalls.push({ tool: u.toolCall?.tool ?? u.toolCall?.title, kind: u.toolCall?.kind, raw: JSON.stringify(u).slice(0, 120) });
    } else if (msg.method === "session/request_permission") {
      permissionSeen = msg.params;
      log("PERMISSION REQUEST:", JSON.stringify(msg.params).slice(0, 300));
      const opts = msg.params?.options ?? msg.params?.permissions ?? [];
      const allow = Array.isArray(opts) ? opts.find(o => /allow/i.test(o?.optionId ?? o?.name ?? "")) : null;
      answered = allow?.optionId ?? (Array.isArray(opts) ? opts[0]?.optionId : null) ?? null;
      send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: answered } } });
      log("answered with optionId:", answered);
    } else if (msg.method) send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});

await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
const sess = await rpc("session/new", {});
const sessionId = sess.sessionId;
log("modes/configOptions:", JSON.stringify(sess.configOptions ?? sess.modes ?? {}).slice(0, 200));
const r = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: `Create a file named e12-${process.env.PM || "yolo"}.txt containing the text hello-e12 using the write tool.` }] });
log("prompt result:", r.stopReason, "usage:", JSON.stringify(r.usage));
log("tool calls seen:", toolCalls.length ? toolCalls.map(t => `${t.tool}(${t.kind})`).join(", ") : "NONE");
log("raw:", toolCalls[0]?.raw ?? "-");
const written = fs.existsSync(`/work/ws/e12-${process.env.PM || "yolo"}.txt`);
log("file written on disk:", written, written ? `content=${fs.readFileSync(`/work/ws/e12-${process.env.PM || "yolo"}.txt`, "utf8").slice(0, 40)}` : "");
fx.kill();
process.exit(0);
