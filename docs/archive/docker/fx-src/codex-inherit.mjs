// Codex-sub inheritance proof: fake parent ~/.fx/chatgpt-auth.json + FX_E2E_OPENAI_CODEX_RESPONSES_URL -> our mock.
// If the mock receives `Authorization: Bearer fake-parent-token` + chatgpt account header,
// the child fx process INHERITED the parent's codex-sub credential. Point 2 answered.
import http from "node:http";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const log = (...a) => console.log("[codex]", ...a);
let seen = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen = {
      method: req.method, url: req.url,
      auth: req.headers.authorization,
      account: req.headers["chatgpt-account-id"] ?? req.headers["x-account-id"] ?? Object.keys(req.headers).filter(h => /account/i.test(h)),
      bodyBytes: body.length,
    };
    log("codex-mock got:", req.method, req.url, "auth:", (req.headers.authorization || "").slice(0, 40), "accountHdr:", JSON.stringify(seen.account));
    // minimal SSE responses-shaped stream; even a 500 proves the token was read from the parent file
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`);
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/backend-api/codex/responses`;

fs.mkdirSync("/root/.fx", { recursive: true });
fs.writeFileSync("/root/.fx/chatgpt-auth.json", JSON.stringify({
  version: 1, access_token: "fake-parent-token", refresh_token: "fake-refresh",
  account_id: "acc-12345678", expires_at_ms: 9999999999999,
}), { mode: 0o600 });

// child process = any fx invocation; use `fx ask` with a codex model, e2e env points transport at our mock
const r = spawnSync("/fx/zig-out/bin/fx", ["ask", "--model", "codex/gpt-5.6", "hi"], {
  env: { ...process.env, FX_E2E_OPENAI_CODEX_RESPONSES_URL: url, FX_E2E_OPENAI_CODEX_MODELS_URL: url },
  encoding: "utf8",
});
log("fx exit:", r.status);
log("fx stdout:", (r.stdout || "").slice(0, 200));
log("fx stderr:", (r.stderr || "").slice(0, 300));
log(seen ? "INHERITANCE PROVEN — parent token reached codex transport" : "NO REQUEST reached codex transport — token NOT inherited or route not taken");
server.close();
