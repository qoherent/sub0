// @sigil implements design/pi-driver.sigil PiDriver (pi RPC client)
//
// Our own client for pi 1.5.2 RPC mode. Each command gets an id and its response is
// matched by that id. There is no response timeout here: the driver's own timeout
// and termination decide how long a child run may take.
import type { Readable, Writable } from 'node:stream';
import { JsonlSplitter } from './jsonl.js';

export interface PiResponse {
  type: 'response';
  id?: string;
  command?: string;
  success: boolean;
  data?: any;
  error?: string;
}

export interface PiEvent {
  type: string;
  [key: string]: any;
}

export class RpcClosedError extends Error {
  constructor() {
    super('pi RPC stream closed');
    this.name = 'RpcClosedError';
  }
}

export interface PiRpcClientOptions {
  onEvent: (event: PiEvent) => void;
  onBadRecord?: (record: string) => void;
}

export class PiRpcClient {
  private nextId = 1;
  private readonly waiting = new Map<string, { resolve: (r: PiResponse) => void; reject: (e: Error) => void; onResponse?: (r: PiResponse) => void }>();
  private closed = false;
  private markLost!: () => void;
  /** Resolves when the pipe to pi is lost, whether or not a command is waiting. */
  readonly lost = new Promise<void>((resolve) => (this.markLost = resolve));

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly options: PiRpcClientOptions,
  ) {
    const splitter = new JsonlSplitter();
    stdout.on('data', (chunk: Buffer) => {
      for (const record of splitter.push(chunk)) this.dispatch(record);
    });
    stdout.on('end', () => {
      for (const record of splitter.end()) this.dispatch(record);
      this.failAll();
    });
    stdout.on('error', () => this.failAll());
    // A write after pi exits raises EPIPE on the stream; the exit handles it.
    stdin.on('error', () => this.failAll());
  }

  private dispatch(record: string): void {
    if (record.trim() === '') return;
    let message: any;
    try {
      message = JSON.parse(record);
    } catch {
      this.options.onBadRecord?.(record);
      return;
    }
    if (message?.type === 'response' && typeof message.id === 'string' && this.waiting.has(message.id)) {
      const entry = this.waiting.get(message.id)!;
      this.waiting.delete(message.id);
      // Runs now, before the next record of the same chunk is dispatched; a resolved promise runs later.
      entry.onResponse?.(message as PiResponse);
      entry.resolve(message as PiResponse);
      return;
    }
    this.options.onEvent(message as PiEvent);
  }

  /**
   * `onResponse`, when given, is called synchronously as the response is dispatched, so it sees
   * the state of the stream exactly at the response (pi's responses and events share one stdout).
   */
  send(command: { type: string; [key: string]: unknown }, onResponse?: (response: PiResponse) => void): Promise<PiResponse> {
    if (this.closed) return Promise.reject(new RpcClosedError());
    const id = `sz-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, ...(onResponse ? { onResponse } : {}) });
      try {
        this.stdin.write(JSON.stringify({ ...command, id }) + '\n');
      } catch {
        this.waiting.delete(id);
        reject(new RpcClosedError());
      }
    });
  }

  /** Close stdin; pi exits on EOF. */
  close(): void {
    if (this.stdin.writableEnded) return;
    try {
      this.stdin.end();
    } catch {
      // already closed
    }
  }

  failAll(): void {
    this.closed = true;
    this.markLost();
    for (const entry of this.waiting.values()) entry.reject(new RpcClosedError());
    this.waiting.clear();
  }
}
