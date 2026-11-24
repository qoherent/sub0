import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { createSubzeroServer } from '../../src/mcp/server.js';
import { DelegationService } from '../../src/service/delegation-service.js';
import { WakeMarkers } from '../../src/mcp/wake-markers.js';
import { kernelWithPort, makeProject, manualPort, TIERED_YAML, until } from '../helpers.js';

async function setup(nonInteractive = false, session: () => string | undefined = () => 'session-a', portOptions: { steers?: boolean; resume?: boolean } = {}) {
  const root = makeProject(TIERED_YAML);
  const { port, started } = manualPort(portOptions);
  const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} });
  const wakeDataDir = mkdtempSync(path.join(tmpdir(), 'subzero-wake-test-'));
  const server = createSubzeroServer({ service, parentSessionId: session, wakeDataDir, nonInteractive, progress: { heartbeatMs: 20 } });
  const client = new Client({ name: 'task-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, service, started, markers: new WakeMarkers(wakeDataDir, root), wakeDataDir };
}

describe('Claude MCP background delivery', () => {
  it('covers R16: continue on a running background task replies steered at once, with the task id first', async () => {
    const { client, started } = await setup(false, () => 'session-a', { steers: true });
    const first = await client.callTool({ name: 'delegate', arguments: { agent: 'free', brief: 'one', wait: false } }, CallToolResultSchema);
    const taskId = /sz-[a-z2-7]{6}/.exec(JSON.stringify(first))![0];
    started[0]!.emit({ kind: 'prompt_sent' });
    const reply: any = await client.callTool({ name: 'continue', arguments: { task: taskId, message: 'also check the tests' } }, CallToolResultSchema);
    expect(reply.content[0].text).toMatch(new RegExp(`^task: ${taskId} · steered: your message joined turn 1`));
    expect(started[0]!.steers).toEqual(['also check the tests']);
    started[0]!.settle();
    await client.close();
  });
  it('waits when a fallback delegation cannot be associated with a session', async () => {
    const { client, started } = await setup(false, () => undefined);
    let returned = false;
    const pending = client.callTool({ name: 'delegate', arguments: { agent: 'free', brief: 'one', wait: false } }, CallToolResultSchema).then((result) => { returned = true; return result; });
    await until(() => started.length === 1);
    expect(returned).toBe(false);
    started[0]!.settle({ lastAssistantText: 'complete' });
    expect(JSON.stringify(await pending)).toContain('complete');
    await client.close();
  });
  it('waits for an explicitly backgrounded call in non-interactive mode', async () => {
    const { client, started, markers } = await setup(true);
    let returned = false;
    const pending = client.callTool({ name: 'delegate', arguments: { agent: 'free', brief: 'one', wait: false } }, CallToolResultSchema).then((result) => { returned = true; return result; });
    await until(() => started.length === 1);
    expect(returned).toBe(false);
    started[0]!.settle({ lastAssistantText: 'whole result' });
    const result = await pending;
    expect(JSON.stringify(result)).toContain('whole result');
    expect(markers.read('session-a').pending).toBe(false);
    await client.close();
  });

  it('forces a continue with wait:false on a settled task to wait in non-interactive mode, and returns the new turn\'s result', async () => {
    const { client, service, started } = await setup(true, () => 'session-a', { steers: true, resume: true });
    const first = client.callTool({ name: 'delegate', arguments: { agent: 'free', brief: 'one', wait: false } }, CallToolResultSchema);
    await until(() => started.length === 1);
    started[0]!.emit({ kind: 'prompt_sent' });
    started[0]!.settle({ lastAssistantText: 'turn one answer' });
    await first;
    const taskId = (await service.list('session-a'))[0]!.taskId;
    let returned = false;
    const pending = client.callTool({ name: 'continue', arguments: { task: taskId, message: 'go on', wait: false } }, CallToolResultSchema).then((result) => { returned = true; return result; });
    await until(() => started.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(returned).toBe(false);
    started[1]!.emit({ kind: 'prompt_sent' });
    started[1]!.settle({ lastAssistantText: 'turn two answer' });
    const reply: any = await pending;
    expect(reply.content[0].text).toMatch(new RegExp(`^task: ${taskId} · new turn: turn 2`));
    expect(JSON.stringify(reply)).toContain('turn two answer');
    await client.close();
  });

  it.each([false, true])('never advertises MCP tasks (non-interactive: %s)', async (nonInteractive) => {
    const { client } = await setup(nonInteractive);
    expect(client.getServerCapabilities()?.tasks).toBeUndefined();
    const delegate = (await client.listTools()).tools.find((tool) => tool.name === 'delegate');
    expect(delegate?.execution?.taskSupport).toBeUndefined();
    await client.close();
  });
  it('refuses a task-augmented call it never offered, and starts no child', async () => {
    const { client, started } = await setup();
    const call = client.request({ method: 'tools/call', params: { name: 'delegate', arguments: { agent: 'free', brief: 'one' }, task: {} } }, CallToolResultSchema);
    await expect(call).rejects.toThrow(/does not support task creation/);
    expect(started).toHaveLength(0);
    await client.close();
  });
  it('leaves a completion marker for uncollected background work', async () => {
    const { client, started, markers } = await setup(false);
    const response = await client.callTool({ name: 'delegate', arguments: { agent: 'free', brief: 'one', wait: false } }, CallToolResultSchema);
    expect(response.isError).not.toBe(true);
    expect(markers.read('session-a').pending).toBe(true);
    started[0]!.settle({ lastAssistantText: 'done' });
    let notice: string | undefined;
    await until(() => { notice = markers.read('session-a').notice; return notice !== undefined; });
    expect(notice).toContain(started[0]!.taskId);
    await client.close();
  });
  it('removes the wake marker when a background result is collected', async () => {
    const { client, started, markers } = await setup(false);
    await client.callTool({ name: 'delegate', arguments: { agent: 'free', brief: 'one', wait: false } }, CallToolResultSchema);
    started[0]!.settle();
    await client.callTool({ name: 'await', arguments: { tasks: [started[0]!.taskId], timeout_s: 1 } }, CallToolResultSchema);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(markers.read('session-a')).toEqual({ pending: false, notice: undefined });
    await client.close();
  });
  it.each([['await', 'session-b'], ['tasks', undefined]] as const)('clears the owner marker when %s collects from session %s', async (tool, session) => {
    const { client, service, started, markers, wakeDataDir } = await setup(false);
    await client.callTool({ name: 'delegate', arguments: { agent: 'free', brief: 'one', wait: false } }, CallToolResultSchema);
    started[0]!.settle();
    const server = createSubzeroServer({ service, parentSessionId: () => session, wakeDataDir });
    const collector = new Client({ name: 'collector', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), collector.connect(b)]);
    await collector.callTool({ name: tool, arguments: tool === 'await' ? { tasks: [started[0]!.taskId], timeout_s: 1 } : { task: started[0]!.taskId } }, CallToolResultSchema);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(markers.read('session-a')).toEqual({ pending: false, notice: undefined });
    await Promise.all([collector.close(), client.close()]);
  });
  it('keeps a wake notice for a result deferred by the await size limit', async () => {
    const { client, started, markers } = await setup(false);
    for (const brief of ['one', 'two']) await client.callTool({ name: 'delegate', arguments: { agent: 'free', brief, wait: false } }, CallToolResultSchema);
    started[0]!.settle({ lastAssistantText: 'a'.repeat(30_000) });
    started[1]!.settle({ lastAssistantText: 'b'.repeat(30_000) });
    const reply = await client.callTool({ name: 'await', arguments: { tasks: started.map((task) => task.taskId), timeout_s: 1 } }, CallToolResultSchema);
    expect(JSON.stringify(reply)).toMatch(/result not shown here/);
    let notice: string | undefined;
    await until(() => { notice = markers.read('session-a').notice; return notice !== undefined; });
    expect(notice).toContain(started[1]!.taskId);
    await client.close();
  });
  it('removes the wake marker without waking Claude when a child is cancelled', async () => {
    const { client, service, markers } = await setup(false);
    await client.callTool({ name: 'delegate', arguments: { agent: 'free', brief: 'one', wait: false } }, CallToolResultSchema);
    await service.cancelSession('session-a');
    await until(() => !markers.read('session-a').pending);
    expect(markers.read('session-a').notice).toBeUndefined();
    await client.close();
  });
});
