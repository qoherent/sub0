import { appendFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';

if (process.argv[2]) appendFileSync(process.argv[2], 'started\n');
if (process.argv[2] && process.argv[3] === 'missing-grant') writeFileSync(process.argv[2], String(process.pid));
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let initialized = false;
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf('\n');
    if (end < 0) break;
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      initialized = true;
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'subzero-fake', version: '1.0.0' } } });
    } else if (message.method === 'notifications/initialized') {
      continue;
    } else if (message.method === 'tools/list' && process.argv[3] === 'paged') {
      const tool = name => ({ name, description: `paged ${name}`, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } });
      send({ jsonrpc: '2.0', id: message.id, result: message.params?.cursor === 'page-2' ? { tools: [tool('allowed_echo')] } : { tools: [tool('unlisted_first_page')], nextCursor: 'page-2' } });
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [
        ...(process.argv[3] === 'missing-grant' ? [] : [{ name: 'allowed_echo', description: 'Echo a short string', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }]),
        { name: 'unlisted_write', description: 'Must not be exposed', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      ] } });
    } else if (message.method === 'tools/call') {
      const credentialPresent = Boolean(process.env.SUBZERO_MCP_AUTH);
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `mcp:${message.params.arguments.text};credential:${credentialPresent ? process.env.SUBZERO_MCP_AUTH : 'missing'}` }] } });
    } else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unknown method ${message.method}; initialized=${initialized}` } });
  }
});
