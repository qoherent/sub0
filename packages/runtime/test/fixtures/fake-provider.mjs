import { createServer } from 'node:http';

export async function startFakeProvider(options = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ authorization: request.headers.authorization, body });
    if (options.onRequest) {
      await options.onRequest(body, response, request);
      return;
    }
    const text = options.reply?.(body) ?? 'fake-provider-ok';
    sendCompletion(response, text);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

export function sendCompletion(response, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const data of [
      { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
      { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]) response.write(`data: ${JSON.stringify(data)}\n\n`);
  response.end('data: [DONE]\n\n');
}

export function finishStream(response, text) {
  if (text) response.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  response.end('data: [DONE]\n\n');
}

export function sendToolCall(response, name, args, id = 'fake-tool-call') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const data of [
    { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]) response.write(`data: ${JSON.stringify(data)}\n\n`);
  response.end('data: [DONE]\n\n');
}
