// libfx smoke — validates B1 (backend/options), B3 (steer/cancel), B4 (checkpoint), B6-partial (custom baseUrl)
// Runs fully offline against a mock OpenAI-compatible endpoint.
import http from "node:http";
import { createFxAgent, getBackendInfo, fxSdkApiVersion } from "libfx";

const log = (...a) => console.log("[smoke]", ...a);

// --- mock OpenAI chat-completions server ---
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    log("mock got:", req.method, req.url, "auth:", (req.headers.authorization || "none").slice(0, 20));
    if (req.method === "GET") return json(res, { object: "list", data: [{ id: "mock-mini", object: "model", owned_by: "mock" }] });
    const nTools = (JSON.parse(body || "{}").tools || []).length;
    // stream a tiny SSE completion that optionally calls a tool
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunks = [
      `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`,
      nTools > 0
        ? `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "echo", arguments: "{\"text\":\"hi\"}" } }] } }] })}\n\n`
        : `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "mock says hi" } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: nTools > 0 ? "tool_calls" : "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    for (const c of chunks) res.write(c);
    res.end();
  });
});
const json = (res, o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/v1`;
log("mock endpoint", base);

// --- B1: backend info + agent options ---
const info = await getBackendInfo({ surface: "agent", backend: "auto" });
log("B1 backend:", JSON.stringify(info));
log("B1 fxSdkApiVersion:", fxSdkApiVersion);

const echoTool = {
  name: "echo",
  description: "echo text back",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: async (input) => ({ content: [{ type: "text", text: `echo:${input.text}` }] }),
};

const mk = (over = {}) => createFxAgent({
  apiKey: "mock-key",
  model: "mock-mini",
  gatewayChatUrl: base,
  tools: [echoTool],
  instructions: "You are a smoke-test child.",
  ...over,
});

// --- B6-partial: custom baseUrl end-to-end + tool call ---
let agent = await mk();
let turn = agent.prompt("run the echo tool");
for await (const ev of turn) log("  ev:", ev.type ?? "?", JSON.stringify(ev).slice(0, 140));
const r1 = await turn.result;
log("B6 result:", JSON.stringify(r1).slice(0, 300));

// --- B4: checkpoint round-trip ---
const ckpt = await agent.checkpoint();
log("B4 checkpoint bytes:", ckpt.length);
await agent.close();
agent = await mk({ checkpoint: ckpt });
turn = agent.prompt("what did we do?");
for await (const ev of turn) {}
const r2 = await turn.result;
log("B4 resumed result:", JSON.stringify(r2).slice(0, 200));

// --- B3: cancel mid-turn (mock holds nothing, but cancel path must not hang) ---
turn = agent.prompt("count to infinity");
setTimeout(() => turn.cancel(), 50);
try { for await (const ev of turn) {} await turn.result; } catch (e) { log("B3 cancel settled:", e.message.slice(0, 80)); }

// --- B3b: steer-while-running (expect either apply or defined error, never hang) ---
turn = agent.prompt("long task");
try { turn.steer?.("focus on X"); log("B3b steer accepted"); } catch (e) { log("B3b steer error:", e.message.slice(0, 80)); }
setTimeout(() => turn.cancel(), 50);
try { for await (const ev of turn) {} await turn.result; } catch {}

await agent.close();
server.close();
log("DONE — record outputs for docs/PLAN.md Phase 0");
