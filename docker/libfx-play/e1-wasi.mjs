// E1: wasm-direct ACP — run fx-core.wasm as a WASI command via node:wasi, drive session/new over stdio.
import { WASI } from "node:wasi";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const log = (...a) => console.log("[e1]", ...a);
const wasmPath = "/work/node_modules/libfx/fx-core.wasm";
log("wasm bytes:", fs.statSync(wasmPath).size);

// mock provider (same as proven matrix)
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [{ index: 0, delta: { role: "assistant", content: "wasm says hi" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "c", model: "mini", choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } })}\n\n`);
    res.end("data: [DONE]\n\n");
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

const wasi = new WASI({ version: "preview1", args: ["fx", "acp"], env: {}, preopens: { "/": "/" } });
const bytes = fs.readFileSync(wasmPath);
log("instantiating...");
let mod;
try { mod = await WebAssembly.compile(bytes); } catch (e) { log("compile failed:", e.message.slice(0, 160)); process.exit(1); }
const imps = WebAssembly.Module.imports(mod);
log("imports:", imps.map(i => i.module + "." + i.name).join("\n[e1]   "));
log("exports:", WebAssembly.Module.exports(mod).map(e => e.name).slice(0, 12).join(", "));

let pendingResolve = null;
const stdoutChunks = [];
const wasiImport = wasi.getImportObject ? wasi.getImportObject() : wasi.wasiImport;
const imports = { wasi_snapshot_preview1: wasiImport };
const instance = await WebAssembly.instantiate(mod, imports);
try {
  if (instance.exports._start) {
    log("running _start (preview1 sync)...");
    instance.exports._start();
    log("_start returned (kernel exited) — stdio interaction must happen via hooks; if we got here without hanging, WASI stdio path is sync");
  } else if (instance.exports._initialize) { log("reactor module (_initialize)"); }
} catch (e) {
  log("start error:", String(e).slice(0, 200));
}
process.exit(0);
