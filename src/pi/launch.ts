// @sigil implements design/pi-driver.sigil PiDriver (launch spec, attach command)
import type { AgentDefinition } from '../config/agent-config.js';
import type { LaunchSpec } from '../core/types.js';

/** Environment variables the driver sets for every child run. Names only are recorded. */
export const CHILD_ENV: Readonly<Record<string, string>> = { PI_OFFLINE: '1', PI_TELEMETRY: '0' };

export interface LaunchInputs {
  taskId: string;
  agent: AgentDefinition;
  overlaySkills: string[];
  sessionsFolder: string;
  /** Extension files named in the global file; each loads with -e. */
  piExtensions?: readonly string[];
}

/**
 * The flags every pi run of subzero starts with: RPC mode, offline, and the
 * resource isolation of a child (no project trust, extensions, context files,
 * prompt templates, themes or discovered skills). Child runs, the model listing
 * and the model check all take them from here. -ne keeps every extension out except the
 * files named in the global file, which load with -e right after the isolation flags.
 */
export function childRpcArgs(piExtensions: readonly string[] = []): string[] {
  return [
    '--mode', 'rpc',
    '--offline',
    '-na', '-ne', '-nc', '-np',
    '--no-themes',
    '-ns',
    ...piExtensions.flatMap((file) => ['-e', file]),
  ];
}

/**
 * The exact flag set of a child run. --session is never added: pi 0.87 exits when
 * it is combined with --session-id.
 */
export function launchArgs({ taskId, agent, overlaySkills, sessionsFolder, piExtensions = [] }: LaunchInputs): string[] {
  return [
    ...childRpcArgs(piExtensions),
    ...overlaySkills.flatMap((folder) => ['--skill', folder]),
    '--model', agent.model,
    '--thinking', agent.thinking,
    '--tools', agent.tools.join(','),
    '--session-dir', sessionsFolder,
    '--session-id', taskId,
    '--name', `subzero:${agent.name}:${taskId}`,
  ];
}

/**
 * Reopen the child session of a task in the pi terminal interface: the launch spec
 * without --mode rpc and without --session. Its --session-dir and --session-id
 * reopen the existing session.
 */
export function attachCommand(spec: LaunchSpec): string[] {
  const out: string[] = [];
  const command = spec.command;
  for (let i = 0; i < command.length; i++) {
    const arg = command[i]!;
    if (arg === '--mode' && command[i + 1] === 'rpc') {
      i++;
      continue;
    }
    if (arg === '--mode=rpc') continue;
    if (arg === '--session') {
      i++;
      continue;
    }
    if (arg.startsWith('--session=')) continue;
    out.push(arg);
  }
  return out;
}
