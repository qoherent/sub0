// @sigil implements design/claude-mcp-server.sigil ClaudeMcpServer (background tasks)
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { Task } from '@modelcontextprotocol/sdk/types.js';
import type { DelegationService } from '../service/delegation-service.js';

/** MCP task cancellation also stops the subzero child. */
export class SubzeroTaskStore extends InMemoryTaskStore {
  private readonly children = new Map<string, string>();
  constructor(private readonly service: DelegationService) { super(); }
  bind(taskId: string, childId: string): void { this.children.set(taskId, childId); }
  release(taskId: string): void { this.children.delete(taskId); }
  reset(): void { this.children.clear(); this.cleanup(); }

  override async updateTaskStatus(taskId: string, status: Task['status'], message?: string, sessionId?: string): Promise<void> {
    await super.updateTaskStatus(taskId, status, message, sessionId);
    const child = this.children.get(taskId);
    if (status === 'cancelled' && child) await this.service.cancel(child);
  }

  override async getTaskResult(taskId: string, sessionId?: string) {
    const task = await this.getTask(taskId, sessionId);
    if (task?.status === 'cancelled') return { content: [{ type: 'text', text: 'The task was stopped; no action is needed.' }] };
    return super.getTaskResult(taskId, sessionId);
  }
}
