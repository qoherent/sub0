// B6 experiment: configured provider (openai-chat-completions) vs gatewayChatUrl
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFxAgent } from "libfx";

const log = (...a) => console.log("[b6]", ...a);

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    log("mock:", req.method, req.url);
    if (req.method === "GET" && req.url.includes("models"))
      return json(res, { object: "list", data: [{ id: "mini", object: "model", owned_by: "mock" }] });
    const chunks = [
      { id: "chat-local", model: "mini", choices: [{ index: 0, delta: { role: "assistant", content: "hello from mock" }, finish_reason: null }] },
      { id: "chat-local", model: "mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "chat-local", model: "mini", choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const value of chunks) res.write(`data: ${JSON.stringify(value)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
const json = (res, o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// write ~/.fx/settings.json with configured provider
const fxDir = path.join(os.homedir(), ".fx");
fs.mkdirSync(fxDir, { recursive: true });
const settings = {
  provider: "mock",
  auto_upgrade: false,
  permission_mode: "yolo",
  providers: {
    mock: {
      protocol: "openai-chat-completions",
      base_url: base,
      auth: { type: "none" },
      model_metadata: { mini: { context_window: 262144, max_output_tokens: 8192, supports_tool_use: true } },
    },
  },
  models: { mock: "mini" },
};
fs.writeFileSync(path.join(fxDir, "settings.json"), JSON.stringify(settings));
log("wrote", path.join(fxDir, "settings.json"));

for (const model of ["mock/mini", "mock-mini", "mini"]) {
  try {
    const agent = await createFxAgent({ apiKey: "unused", model, onPermission: async () => ({ optionId: "allow" }) });
    const turn = agent.prompt("say hi");
    for await (const ev of turn) log(`  ev[${model}]:`, ev.type ?? "?");
    const r = await turn.result;
    log(`model=${model} ->`, JSON.stringify(r).slice(0, 160));
    await agent.close();
    if (r.stopReason !== "refused") { log("SUCCESS with", model); break; }
  } catch (e) {
    log(`model=${model} threw:`, e.message.slice(0, 120));
  }
}
server.close();
