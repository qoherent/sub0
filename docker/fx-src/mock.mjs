// minimal OpenAI-compatible mock; prints its port on line 1
import http from "node:http";
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    console.error("mock:", req.method, req.url);
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: "mini", object: "model", owned_by: "mock" }] }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunks = [
      { id: "c", model: "mini", choices: [{ index: 0, delta: { role: "assistant", content: "hello from mock" }, finish_reason: null }] },
      { id: "c", model: "mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "c", model: "mini", choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } },
    ];
    for (const value of chunks) res.write(`data: ${JSON.stringify(value)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
