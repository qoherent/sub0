// @sigil implements design/pi-driver.sigil PiDriver (launch spec, attach command)
import type { AgentDefinition } from '../config/agent-config.js';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildHostOptions, LaunchSpec } from '../core/types.js';

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

export interface PiExtensions {
  /** The extension files, absolute, in file order, without duplicates. */
  files: string[];
  /** Why pi must not start, or undefined: a bad shape, or a path that names no file. */
  problem?: string;
}

const WHERE = 'hosts.pi.extensions in the global file';

/**
 * The extension files in the child host options for pi: the list `extensions`, each path absolute
 * or starting with `~/`. pi gives no warning for a missing -e path, so the models of that extension
 * would only show as unknown; a path that names no file is a problem here, before pi starts.
 */
export function piExtensionsOf(options: ChildHostOptions | undefined): PiExtensions {
  if (options === undefined) return { files: [] };
  for (const key of Object.keys(options)) {
    if (key !== 'extensions') return { files: [], problem: `hosts.pi in the global file holds "${key}", but only extensions is known` };
  }
  if (options.extensions === undefined || options.extensions === null) return { files: [] };
  const list = options.extensions;
  if (!Array.isArray(list)) return { files: [], problem: `${WHERE} must be a list of paths` };
  const files: string[] = [];
  for (const [i, entry] of list.entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') return { files: [], problem: `${WHERE}: item ${i + 1} must be a non-empty path` };
    const resolved = entry === '~' ? '' : entry.startsWith('~/') ? path.join(os.homedir(), entry.slice(2)) : entry;
    if (resolved === '' || !path.isAbsolute(resolved)) {
      return { files: [], problem: `${WHERE}: "${entry}" must be an absolute path or start with ~/` };
    }
    const file = path.normalize(resolved);
    let isFile = false;
    try {
      isFile = existsSync(file) && statSync(file).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) return { files: [], problem: `pi extension not found: ${file} (named under ${WHERE})` };
    if (!files.includes(file)) files.push(file);
  }
  return { files };
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
 * The exact flag set of a child run. --session is never added: pi exits when it is
 * combined with --session-id.
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
