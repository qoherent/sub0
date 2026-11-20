// @sigil implements design/pi-extension.sigil PiExtension (subagent request)
import { mapRequest } from '../config/tier-words.js';
import type { Delegation } from '../service/delegation-service.js';

export interface PiRequest {
  task: string;
  agent?: string;
  model?: string;
  async?: boolean;
  files?: string[];
  expected_output?: string;
  worktree?: boolean;
  isolation?: string;
  context?: string;
  action?: string;
  [key: string]: unknown;
}

export type PiRequestResult = { delegation: Delegation; notice?: string } | { error: string };

export function mapPiRequest(request: PiRequest, tiers: readonly string[] | (() => readonly string[]), sessionId: string): PiRequestResult {
  if (request.worktree || request.isolation || request.context === 'fork') {
    return { error: 'subzero isolation is not supported yet; worktree and fork requests cannot run.' };
  }
  if (request.action !== undefined || Object.keys(request).some((key) => key.startsWith('workflow'))) {
    return { error: 'Use subzero_tasks, subzero_await or subzero_cancel to manage tasks.' };
  }
  const mapped = mapRequest(request.agent, request.model, typeof tiers === 'function' ? tiers() : tiers);
  const delegation: Delegation = {
    briefText: request.task,
    parentSessionId: sessionId,
    ...(mapped.agent !== undefined ? { agent: mapped.agent } : {}),
    ...(mapped.tier.kind === 'tier' ? { tier: mapped.tier.name } : {}),
    ...(request.files !== undefined ? { files: request.files } : {}),
    ...(request.expected_output !== undefined ? { expectedOutput: request.expected_output } : {}),
  };
  return mapped.tier.kind === 'unmatched'
    ? { delegation, notice: `model "${mapped.tier.value}" was not used` }
    : { delegation };
}
