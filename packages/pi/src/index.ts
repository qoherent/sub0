import type { ExtensionAPI, McpServerConfig } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';

const serverName = 'subzero';

/** Register the local Subzero runtime as a direct stdio MCP server for this Pi session. */
export default function registerSubzeroExtension(pi: ExtensionAPI): void {
  let registered = false;

  const register = (cwd: string) => {
    if (registered) return;
    pi.registerMcpServer(serverName, createSubzeroServerConfig(cwd));
    registered = true;
  };

  pi.on('session_start', (_event, context) => register(context.cwd));
  pi.on('session_shutdown', () => {
    if (!registered) return;
    pi.unregisterMcpServer(serverName);
    registered = false;
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
