import type { ExtensionAPI, McpServerConfig } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';

const serverName = 'subzero';
const delegationSection = 'subzero_delegation';
const delegationGuide = `Subzero delegates work to persistent child sessions in this workspace. Use mcp__subzero__subzero_info to discover templates and configured credential references. Honor explicit caller model URL, model, API and credentialRef; never put raw keys in tool arguments.
Prefer mcp__subzero__subzero_run for a new assignment. State scope, allowed actions, acceptance checks and required evidence in its prompt. If the run is queued, running or stop_requested, continue with mcp__subzero__subzero_get using the same childId and runId and a bounded waitMs. Never redispatch because a wait expired or a response was lost; inspect existing work instead. Never substitute a child's latest result for the requested run.
Accept success only after inspecting the requested effect against its acceptance checks and the matching completed run/result/artifact. A ready child, stopped, failed or interrupted run is not proof of success. Read more output only through bounded mcp__subzero__subzero_output chunks.
Observation cancellation does not stop accepted work. Explicit mcp__subzero__subzero_stop requires the active runId as expectedRunId; cancellation is confirmed only after cleanup. Broker shutdown may interrupt children. After broker restart, resume with explicit model/credentialRef before sending work; never replay interrupted effects automatically. No background parent wakeup is promised.
When calling these tools from codemode, check the MCP response isError before reading structuredContent; the child run status is separate from transport success.`;

/** Register the local Subzero runtime as a direct stdio MCP server for this Pi session. */
export default function registerSubzeroExtension(pi: ExtensionAPI): void {
  let registeredCwd: string | undefined;

  const register = (cwd: string) => {
    if (registeredCwd === cwd) return;
    pi.registerMcpServer(serverName, createSubzeroServerConfig(cwd));
    registeredCwd = cwd;
  };

  pi.on('session_start', (_event, context) => register(context.cwd));
  pi.on('before_agent_start', event => {
    if (registeredCwd !== undefined) event.systemPromptOptions.sections[delegationSection] = delegationGuide;
  });
  pi.on('session_shutdown', () => {
    if (registeredCwd === undefined) return;
    pi.unregisterMcpServer(serverName);
    registeredCwd = undefined;
  });
}

/** Build a registration that passes only paths and runtime references to the child process. */
export function createSubzeroServerConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): McpServerConfig & { command: string; args: string[]; cwd: string; exposure: 'direct' } {
  const args = [fileURLToPath(import.meta.resolve('@subzero/runtime/cli')), '--workspace', cwd];
  if (env.SUBZERO_DATA_DIR) args.push('--data-dir', env.SUBZERO_DATA_DIR);
  if (env.SUBZERO_CONFIG) args.push('--config', env.SUBZERO_CONFIG);

  return {
    command: env.SUBZERO_NODE || process.execPath,
    args,
    cwd,
    exposure: 'direct',
    description: 'Manage Subzero child workers for the current workspace.',
  };
}
