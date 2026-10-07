// Codex-sub inheritance, attempt 2: settings provider=codex + E2E loopback models+responses, no gateway.
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
const log = (...a) => console.log("[codex2]", ...a);
let hits = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hits.push({ url: req.url, auth: req.headers.authorization, account: req.headers["chatgpt-account-id"] });
    log("got:", req.method, req.url, "auth:", (req.headers.authorization || "").slice(0, 44), "acct:", req.headers["chatgpt-account-id"] || "-");
    if (req.url.includes("models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ models: [{ slug: "gpt-5.6", visibility: "list", supported_in_api: true, priority: 7, supported_reasoning_levels: [{ effort: "high" }], additional_speed_tiers: [], input_modalities: ["text"], context_window: 272000 }] }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`);
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
fs.mkdirSync("/root/.fx", { recursive: true });
fs.writeFileSync("/root/.fx/chatgpt-auth.json", JSON.stringify({
  version: 1, access_token: "fake-parent-token", refresh_token: "fake-refresh",
  account_id: "acc-12345678", expires_at_ms: 9999999999999,
}), { mode: 0o600 });
fs.writeFileSync("/root/.fx/settings.json", JSON.stringify({
  provider: "codex", auto_upgrade: false, models: { codex: "gpt-5.6" }, permission_mode: "yolo",
}));
delete process.env.AI_GATEWAY_API_KEY;
const r = spawn("/fx/zig-out/bin/fx", ["ask", "hi"], {
  env: { ...process.env, FX_E2E_OPENAI_CODEX_RESPONSES_URL: `${base}/backend-api/codex/responses`, FX_E2E_OPENAI_CODEX_MODELS_URL: `${base}/backend-api/codex/models` },
});
let out = "", err = "";
r.stdout.on("data", (d) => (out += d));
r.stderr.on("data", (d) => (err += d));
const code = await new Promise((res) => r.on("close", res));
log("fx exit:", code, "stdout:", out.slice(0, 120), "stderr:", err.slice(0, 200));
const authHit = hits.find((h) => h.auth?.includes("fake-parent-token"));
log(authHit ? "INHERITANCE PROVEN: parent token used by child fx transport" : "no request carried the parent token; hits=" + JSON.stringify(hits.map(h => ({ u: h.url, a: h.auth?.slice(0, 20) }))));
server.close();
