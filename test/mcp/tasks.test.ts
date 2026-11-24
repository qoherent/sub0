import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CreateTaskResultSchema, GetTaskResultSchema, CancelTaskResultSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { createSubzeroServer } from '../../src/mcp/server.js';
import { DelegationService } from '../../src/service/delegation-service.js';
import { WakeMarkers } from '../../src/mcp/wake-markers.js';
import { kernelWithPort, makeProject, manualPort, TIERED_YAML, until } from '../helpers.js';

async function setup(taskMode = true, nonInteractive = false, session: () => string | undefined = () => 'session-a', onTaskMode?: (enabled: boolean) => void) {
  const root = makeProject(TIERED_YAML);
  const { port, started } = manualPort();
  const service = new DelegationService({ env: { SUBZERO_PROJECT_DIR: root }, kernel: kernelWithPort(port), warn: () => {} });
  const wakeDataDir = mkdtempSync(path.join(tmpdir(), 'subzero-wake-test-'));
  const server = createSubzeroServer({ service, parentSessionId: session, taskMode, wakeDataDir, nonInteractive, onTaskMode, progress: { heartbeatMs: 20 } });
  const client = new Client({ name: 'task-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, service, started, markers: new WakeMarkers(wakeDataDir, root), wakeDataDir };
}

describe('Claude MCP tasks', () => {
  it('marks task mode only after an augmented request demonstrates support', async () => {
    const observed: boolean[] = [];
    const { client, started } = await setup(true, false, () => 'session-a', (enabled) => { observed.push(enabled); });
    const delegate = (await client.listTools()).tools.find((tool) => tool.name === 'delegate');
    expect(JSON.stringify(delegate?.inputSchema)).toMatch(/defaults to true unless the call requests an MCP task/);
    await client.callTool({ name: 'delegate', arguments: { agent: 'free', brief: 'one', wait: false } }, CallToolResultSchema);
    expect(observed).toEqual([false]);
    await client.request({ method: 'tools/call', params: { name: 'delegate', arguments: { agent: 'free', brief: 'two' }, task: {} } }, CreateTaskResultSchema);
    expect(observed).toEqual([false, true]);
    await client.callTool({ name: 'delegate', arguments: { agent: 'free', brief: 'three', wait: false } }, CallToolResultSchema);
    expect(observed).toEqual([false, true, false]);
    started.forEach((task) => task.settle());
    await client.close();
  });
  it('waits when a fallback delegation cannot be associated with a session', async () => {
    const { client, started } = await setup(false, false, () => undefined);
    let returned = false;
    const pending = client.callTool({ name: 'delegate', arguments: { agent: 'free', brief: 'one', wait: false } }, CallToolResultSchema).then((result) => { returned = true; return result; });
    await until(() => started.length === 1);
    expect(returned).toBe(false);
    started[0]!.settle({ lastAssistantText: 'complete' });
    expect(JSON.stringify(await pending)).toContain('complete');
    await client.close();
  });
  it('forgets the previous session task handles when the parent session changes', async () => {
    let session = 'session-a';
    const { client, started } = await setup(true, false, () => session);
    const task = await client.request({ method: 'tools/call', params: { name: 'delegate', arguments: { agent: 'free', brief: 'one' }, task: {} } }, CreateTaskResultSchema);
    session = 'session-b';
    await client.listTools();
    await expect(client.request({ method: 'tasks/get', params: { taskId: task.task.taskId } }, GetTaskResultSchema)).rejects.toThrow();
    expect(started.length).toBe(1);
    await client.close();
  });
  it('waits for an explicitly backgrounded call in non-interactive mode', async () => {
    const { client, started, markers } = await setup(false, true);
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

  it('does not advertise task mode in non-interactive mode', async () => {
    const { client } = await setup(true, true);
    expect(client.getServerCapabilities()?.tasks).toBeUndefined();
    const delegate = (await client.listTools()).tools.find((tool) => tool.name === 'delegate');
    expect(delegate?.execution?.taskSupport).toBeUndefined();
    await client.close();
  });
  it('leaves a completion marker for uncollected background work without MCP tasks', async () => {
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
  it('returns task handles and includes other live tasks in a completed result', async () => {
    const { client, started } = await setup();
    const call = (brief: string) => client.request({ method: 'tools/call', params: { name: 'delegate', arguments: { agent: 'free', brief }, task: {} } }, CreateTaskResultSchema);
    const first = await call('one');
    const second = await call('two');
    expect(first.task.status).toBe('working');
    expect(second.task.status).toBe('working');
    started[0]!.settle({ lastAssistantText: 'first result' });
    const result = await client.request({ method: 'tasks/result', params: { taskId: first.task.taskId } }, CallToolResultSchema);
    const text = result.content.map((part) => part.type === 'text' ? part.text : '').join('\n');
    expect(text).toMatch(/first result/);
    expect(text).toMatch(/wait/i);
    expect(text).toContain(started[1]!.taskId);
    const status = await client.request({ method: 'tasks/get', params: { taskId: second.task.taskId } }, GetTaskResultSchema);
    expect(status.status).toBe('working');
    started[1]!.settle();
    await client.close();
  });

  it('cancels only the child bound to the requested task', async () => {
    const { client, service, started } = await setup();
    const call = (brief: string) => client.request({ method: 'tools/call', params: { name: 'delegate', arguments: { agent: 'free', brief }, task: {} } }, CreateTaskResultSchema);
    const first = await call('one');
    const second = await call('two');
    const cancelled = await client.request({ method: 'tasks/cancel', params: { taskId: first.task.taskId } }, CancelTaskResultSchema);
    expect(cancelled.status).toBe('cancelled');
    const result = await client.request({ method: 'tasks/result', params: { taskId: first.task.taskId } }, CallToolResultSchema);
    expect(JSON.stringify(result)).toMatch(/stopped.*no action is needed/i);
    expect((await service.collect(started[0]!.taskId)).kind).toBe('result');
    expect((await service.collect(started[1]!.taskId)).kind).toBe('running');
    expect((await client.request({ method: 'tasks/get', params: { taskId: second.task.taskId } }, GetTaskResultSchema)).status).toBe('working');
    started[1]!.settle();
    await client.close();
  });

  it('waits for an explicitly waited task and reports its completed status', async () => {
    const { client, started } = await setup();
    let returned = false;
    const pending = client.request({ method: 'tools/call', params: { name: 'delegate', arguments: { agent: 'free', brief: 'one', wait: true }, task: {} } }, CreateTaskResultSchema).then((value) => { returned = true; return value; });
    await until(() => started.length === 1);
    expect(returned).toBe(false);
    started[0]!.settle();
    expect((await pending).task.status).toBe('completed');
    await client.close();
  });
  it('sends progress for an explicitly waited task', async () => {
    const { client, started } = await setup();
    const messages: string[] = [];
    const pending = client.request({ method: 'tools/call', params: { name: 'delegate', arguments: { agent: 'free', brief: 'one', wait: true }, task: {} } }, CreateTaskResultSchema, { onprogress: (event) => messages.push(event.message ?? '') });
    await until(() => messages.length > 0);
    expect(messages[0]).toMatch(/free/);
    started[0]!.settle();
    await pending;
    const count = messages.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messages).toHaveLength(count);
    await client.close();
  });

  it('marks a failed child as a failed MCP task', async () => {
    const { client, started } = await setup();
    const result = await client.request({ method: 'tools/call', params: { name: 'delegate', arguments: { agent: 'free', brief: 'one' }, task: {} } }, CreateTaskResultSchema);
    started[0]!.settle({ status: 'failed' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const status = await client.request({ method: 'tasks/get', params: { taskId: result.task.taskId } }, GetTaskResultSchema);
    expect(status.status).toBe('failed');
    await client.close();
  });
  it('preserves the fallback-agent notice in an MCP task result', async () => {
    const { client, started } = await setup();
    const result = await client.request({ method: 'tools/call', params: { name: 'delegate', arguments: { agent: 'not-configured', brief: 'one' }, task: {} } }, CreateTaskResultSchema);
    started[0]!.settle();
    const collected = await client.request({ method: 'tasks/result', params: { taskId: result.task.taskId } }, CallToolResultSchema);
    expect(JSON.stringify(collected)).toMatch(/not-configured.*not configured.*fallback/i);
    await client.close();
  });

  it('returns a stop notice when the session cancels a background child', async () => {
    const { client, service } = await setup();
    const result = await client.request({ method: 'tools/call', params: { name: 'delegate', arguments: { agent: 'free', brief: 'one' }, task: {} } }, CreateTaskResultSchema);
    await service.cancelSession('session-a');
    const collected = await client.request({ method: 'tasks/result', params: { taskId: result.task.taskId } }, CallToolResultSchema);
    expect(collected.content.map((part) => part.type === 'text' ? part.text : '').join('\n')).toMatch(/stopped.*no action is needed/i);
    await client.close();
  });
});
