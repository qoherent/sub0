import type { ChildRecord, CoreLimits, EventInput, RunRecord, TemplateDefinition } from '@subzero/core';

export const limits: CoreLimits = {
  activeWorkersPerWorkspace: 4, writeRunsPerWorkspace: 1, promptBytes: 65536,
  instructionBytes: 65536, grantedTools: 64, eventBytes: 8192, eventBatch: 50,
  outputPreviewBytes: 2048, maxWaitMs: 30000,
};

export const researcher: TemplateDefinition = {
  id: 'researcher', description: 'Read-only researcher', instructions: 'Research carefully.',
  tools: [{ name: 'read', writable: false }], skills: [], mcpServers: [], writeCapable: false,
};

export const coder: TemplateDefinition = {
  id: 'coder', description: 'Writer', instructions: 'Edit carefully.',
  tools: [{ name: 'read', writable: false }, { name: 'write', writable: true }], skills: [], mcpServers: [], writeCapable: true,
};

export function records(id: string, write = false, runId = `${id}-run`) {
  const templateSnapshot = structuredClone(write ? coder : researcher);
  const child: ChildRecord = {
    childId: id, workspaceRoot: '/workspace', state: 'running', templateSnapshot,
    model: { url: 'https://model.example/v1', model: 'model-x', api: 'openai-completions' },
    activeRunId: runId, ownerGeneration: 0, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z',
  };
  const run: RunRecord = { runId, childId: id, prompt: `prompt for ${id}`, status: 'running', createdAt: child.createdAt };
  const event: EventInput = { childId: id, runId, at: child.createdAt, type: 'run_started' };
  return { child, run, event };
}

export function queuedRun(childId: string, runId: string): RunRecord {
  return { runId, childId, prompt: runId, status: 'queued', createdAt: '2026-10-07T00:00:01.000Z' };
}
