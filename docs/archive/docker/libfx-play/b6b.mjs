import http from "node:http";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createFxAgent } from "libfx";
const log = (...a) => console.log("[b6b]", ...a);
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", c => body += c);
  req.on("end", () => {
    log("mock:", req.method, req.url, JSON.stringify(body).slice(0, 90));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunks = [
      { id: "c", model: "mini", choices: [{ index: 0, delta: { role: "assistant", content: "hello from mock" }, finish_reason: null }] },
      { id: "c", model: "mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "c", model: "mini", choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } },
    ];
    for (const v of chunks) res.write(`data: ${JSON.stringify(v)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const fxDir = path.join(os.homedir(), ".fx");
fs.mkdirSync(fxDir, { recursive: true });
fs.writeFileSync(path.join(fxDir, "settings.json"), JSON.stringify({
  provider: "mock", auto_upgrade: false, permission_mode: "yolo",
  providers: { mock: { protocol: "openai-chat-completions", base_url: base, auth: { type: "none" },
    model_metadata: { mini: { context_window: 262144, max_output_tokens: 8192, supports_tool_use: true } } } },
  models: { mock: "mini" },
}));
// NO model arg -> FX_MODEL unset -> kernel uses settings.models.mock
const agent = await createFxAgent({ apiKey: "unused" });
const turn = agent.prompt("say hi");
for await (const ev of turn) log("ev:", ev.type ?? "?");
const r = await turn.result;
log("RESULT:", JSON.stringify(r));
await agent.close();
server.close();
