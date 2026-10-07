const mode = process.argv[2];
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let buffer = '';
setInterval(() => {}, 1_000);
process.stdout.setDefaultEncoding('utf8');
send({ type: 'ready' });
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf('\n');
    if (end < 0) break;
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    const message = JSON.parse(line);
    if (message.type === 'initialize') {
      if (mode === 'init-failure') setTimeout(() => send({ type: 'response', id: message.id, ok: false, error: 'synthetic_init_failure' }), 100);
      else send({ type: 'response', id: message.id, ok: true });
    } else if (message.type === 'run' && mode === 'hang-stop') {
      send({ type: 'text', id: message.id, text: 'run is still active' });
    } else if (message.type === 'stop' && mode === 'hang-stop') {
      // Deliberately stay silent so the broker control deadline must reap this process.
    }
  }
});
