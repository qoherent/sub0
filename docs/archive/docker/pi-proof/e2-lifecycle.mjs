// E2: Pi lifecycle firing + real prompt against mock provider + registry persistence (pi@0.99.1).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const log = (...a) => console.log("[e2]", ...a);
// mock provider
let hits = 0;
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-1", object: "chat.completion", created: 1, model: "mock-mini",
      choices: [{ index: 0, message: { role: "assistant", content: "mock reply" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    }));
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pihome-"));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "piproj-"));
fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ defaultProvider: "mock", defaultModel: "mock-mini", defaultTools: ["read"] }));
fs.writeFileSync(path.join(home, ".pi", "agent", "models.json"), JSON.stringify({
  providers: { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: "mock-mini" }] } },
}));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
process.chdir(proj);

const pi = await import("@earendil-works/pi-coding-agent");
const events = [];
let appended = false;
const extension = (piApi) => {
  piApi.registerTool({
    name: "subzero_probe",
    label: "Subzero Probe",
    description: "returns ok",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "probe-ok" }], details: {} }; },
  });
  piApi.on("session_start", async () => { events.push("session_start"); });
  piApi.on("session_shutdown", async () => { events.push("session_shutdown"); });
};

const { createAgentSession, DefaultResourceLoader } = pi;
const loader = new DefaultResourceLoader({ cwd: proj, agentDir: path.join(home, ".pi", "agent"), extensionFactories: [extension] });
await loader.reload();
const { session } = await createAgentSession({ resourceLoader: loader });
// SDK does not bind lifecycle automatically — bindExtensions() is what fires session_start (agent-session.js:2550)
if (typeof session.bindExtensions === "function") {
  await session.bindExtensions({});
  log("bindExtensions OK");
} else { log("bindExtensions missing; keys:", Object.keys(session).filter(k => /bind|extension/i.test(k)).join(",")); }
log("session up; prompting with real model round-trip...");
try {
  const result = await session.prompt("say hi");
  const shape = result && typeof result === "object" ? JSON.stringify(result).slice(0, 160) : String(result);
  log("prompt result:", shape);
} catch (e) { log("prompt error:", e.message.slice(0, 160)); }
log("mock hits:", hits);

// registry persistence through the real session manager
const sm = session.sessionManager ?? session._sessionManager;
if (sm?.appendCustomEntry) { sm.appendCustomEntry("subzero.registry", { children: [{ id: "c1", template: "researcher" }] }); appended = true; }
const file = sm?.getSessionFile?.();
log("registry appended:", appended, "file:", file ? path.basename(file) : "none");

if (typeof session.dispose === "function") { try { await session.dispose(); } catch (e) { log("dispose err:", e.message.slice(0, 80)); } }
if (typeof session.shutdown === "function") { try { await session.shutdown(); } catch (e) { log("shutdown err:", e.message.slice(0, 80)); } }
log("events:", events.join(",") || "(none fired)");
const verdict = [];
if (events.includes("session_start")) verdict.push("session_start FIRES");
if (hits > 0) verdict.push("real LLM round-trip OK");
if (appended && file && fs.existsSync(file)) verdict.push("registry JSONL persisted");
if (events.includes("session_shutdown")) verdict.push("session_shutdown FIRES");
log("VERDICT:", verdict.join(" | ") || "NOT PROVEN");
srv.close();
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(proj, { recursive: true, force: true });
process.exit(0);
