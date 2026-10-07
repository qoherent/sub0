import type { ServerResponse } from 'node:http';

export type FakeMessage = { role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string };
export type FakeTool = { type?: string; function: { name: string } };
export type FakeChatRequest = { tools?: FakeTool[]; messages: FakeMessage[]; [key: string]: unknown };
export type FakeProviderOptions = {
  reply?: (body: FakeChatRequest) => string;
  onRequest?: (body: FakeChatRequest, response: ServerResponse) => void | Promise<void>;
};
export type FakeProvider = {
  endpoint: string;
  requests: Array<{ authorization: string | undefined; body: FakeChatRequest }>;
  close(): Promise<void>;
};
export function startFakeProvider(options?: FakeProviderOptions): Promise<FakeProvider>;
export function sendCompletion(response: ServerResponse, text: string): void;
export function finishStream(response: ServerResponse, text?: string): void;
export function sendToolCall(response: ServerResponse, name: string, args: Record<string, unknown>, id?: string): void;
