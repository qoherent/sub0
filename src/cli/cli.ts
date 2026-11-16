// @sigil implements design/cli.sigil Cli
//
//   subzero init <model> [--host H] [--timeout S] [--thinking L]
//                                    add the medium tier, general and fallback entries
//   subzero config models|show|check|preview|apply
//                                    guided setup through the setup service, one JSON
//                                    document on stdout per command
//   subzero run [--agent A] <brief...>  delegate, wait and print the result (no --agent: general)
//   subzero tasks                    list every task
//   subzero attach <task id>         reopen the child session in the pi terminal interface
//   subzero show <task id> [-o file] export the child session as HTML
//
// Every command starts through the delegation service, so the start-up sweep runs
// first. A delegation from here carries no parent session id. This file names no
// child driver and no host: the entry point (main.ts) registers the drivers with the
// Kernel it passes in, and attach and show ask that registry.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import {
  addStarterEntries,
  isThinkingLevel,
  LoadError,
  StarterHostConflictError,
  THINKING_LEVELS,
  TierError,
  UnknownAgentError,
  UnresolvedRootError,
} from '../config/agent-config.js';
import type { Change } from '../config/agent-setup.js';
import { isTaskId } from '../core/ids.js';
import { UnsupportedHostError } from '../kernel/kernel.js';
import { DelegationService, EmptyBriefError, type DelegationServiceOptions } from '../service/delegation-service.js';
import { isSetupError, parseStarterOptions, SetupService, setupRefusalBody, type ModelCheckInput } from '../service/setup-service.js';
import {
  describeEvent,
  formatResult,
  formatStarterResult,
  formatStatusLine,
  listingStatus,
  statusFacts,
  withNotice,
} from '../service/status-text.js';

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

const CHANGE_FLAGS = '[--tier <tier>=<model>:<thinking>]... [--unset <tier>]... [--limit <endpoint>=<n>]... [--no-limit <endpoint>]...';

const USAGE = `usage:
  subzero init <model> [--host <host>] [--timeout <seconds>] [--thinking <level>]
  subzero config models [--host <host>]
  subzero config show [--host <host>]
  subzero config check [--host <host>] <model>:<thinking>...
  subzero config preview [--host <host>] ${CHANGE_FLAGS}
  subzero config apply --expect <fingerprint> [--host <host>] ${CHANGE_FLAGS}
  subzero run [--agent <agent>] <brief...>
  subzero tasks
  subzero attach <task id>
  subzero show <task id> [-o <file.html>]
thinking levels: ${THINKING_LEVELS.join(', ')}; a model and its level split at the last colon`;

/** init with no model: the guided flow needs an agent, which a terminal does not have. */
const INIT_NEEDS_MODEL =
  'subzero: init needs a model in a terminal. For guided setup, run /subzero:init in Claude Code or /subzero init in pi; ' +
  'or run subzero init <model> here.';

function knownError(err: unknown): boolean {
  return (
    err instanceof UnknownAgentError ||
    err instanceof TierError ||
    err instanceof StarterHostConflictError ||
    err instanceof LoadError ||
    err instanceof UnresolvedRootError ||
    err instanceof EmptyBriefError ||
    err instanceof UnsupportedHostError
  );
}

export type CliOptions = DelegationServiceOptions & { interactive?: boolean };

export async function runCli(argv: string[], io: CliIo, options: CliOptions): Promise<number> {
  const [command, ...rest] = argv;
  // The working directory is only the fallback; SUBZERO_PROJECT_DIR comes first.
  const service = new DelegationService({ env: process.env, cwd: process.cwd(), ...options });

  try {
    await service.start();
    switch (command) {
      case 'init':
        return await init(service, rest, io, options);
      case 'config':
        return await config(service, rest, io, options);
      case 'run':
        return await run(service, rest, io);
      case 'tasks':
        return await tasks(service, io);
      case 'attach':
        return await attach(service, rest, io, options);
      case 'show':
        return await show(service, rest, io, options);
      default:
        io.err(USAGE);
        return 2;
    }
  } catch (err) {
    // config prints its refusals as JSON on stdout, including a root that does not resolve.
    if (command === 'config' && (knownError(err) || isSetupError(err))) {
      io.out(json(setupRefusalBody(err as Error)));
      return 1;
    }
    if (knownError(err)) {
      io.err(`subzero: ${(err as Error).message}`);
      return 1;
    }
    throw err;
  }
}

async function init(service: DelegationService, args: string[], io: CliIo, options: CliOptions): Promise<number> {
  const parsed = parseNamed(args, { host: { type: 'string' }, timeout: { type: 'string' }, thinking: { type: 'string' } });
  const [model, ...extra] = parsed?.positionals ?? [];
  if (parsed !== null && (model === undefined || model === '')) {
    io.err(INIT_NEEDS_MODEL);
    io.err(USAGE);
    return 2;
  }
  if (parsed === null || model === undefined || extra.length > 0) {
    io.err(USAGE);
    return 2;
  }
  const { host: hostOption, timeout: timeoutOption, thinking: thinkingOption } = parsed.values;
  const starter = parseStarterOptions({ thinking: thinkingOption, timeout: timeoutOption });
  if ('error' in starter) {
    io.err(`subzero: ${starter.error}`);
    return 2;
  }
  const { thinking, timeout } = starter;

  const supported = options.kernel.supportedHosts();
  if (supported.length === 0) {
    io.err('subzero: no host is registered, so init has no host to write the starter entries for');
    return 1;
  }
  const host = hostOption ?? (supported.length === 1 ? supported[0] : undefined);
  if (host === undefined || !supported.includes(host)) {
    const which = host === undefined ? 'the --host option is needed' : `the host "${host}" is not supported`;
    io.err(`subzero: ${which} when init has these supported hosts to choose from: ${supported.join(', ')}`);
    return 1;
  }
  // A missing prerequisite stops init before anything is written.
  const problem = options.kernel.prerequisites(host)?.();
  if (problem !== undefined) {
    io.err(`subzero: ${problem}`);
    return 1;
  }
  const tools = options.kernel.starterTools(host);
  if (tools === undefined) {
    io.err(`subzero: the child driver of the host "${host}" offers no starter tools, so init cannot write the agent entries`);
    return 1;
  }

  const result = addStarterEntries(service.projectRoot!, {
    host,
    model,
    thinking,
    timeout,
    generalTools: tools.general,
    fallbackTools: tools.fallback,
  });
  for (const line of formatStarterResult(result)) io.out(line);
  return 0;
}

/** Parse named options and positionals; null means the arguments are not valid. */
function parseNamed<T extends Record<string, { type: 'string' }>>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch {
    return null;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** A malformed config argument: a usage error, exit 2. */
class ConfigUsageError extends Error {}

/** Split `<model>:<thinking>` at the last colon, since model ids can hold colons. */
function modelAndThinking(spec: string, what: string): ModelCheckInput {
  const colon = spec.lastIndexOf(':');
  if (colon === -1) throw new ConfigUsageError(`${what} "${spec}" needs a thinking level: <model>:<thinking>`);
  const model = spec.slice(0, colon);
  const thinking = spec.slice(colon + 1);
  if (model.trim() === '') throw new ConfigUsageError(`${what} "${spec}" needs a model before the thinking level`);
  if (!isThinkingLevel(thinking)) {
    throw new ConfigUsageError(`${what} "${spec}": the thinking level must be one of ${THINKING_LEVELS.join(', ')} (got "${thinking}")`);
  }
  return { model, thinking };
}

/** Split `<name>=<value>` at the first equals sign; both parts must be non-empty. */
function nameAndValue(flag: string, arg: string, shape: string): [string, string] {
  const eq = arg.indexOf('=');
  const name = eq === -1 ? '' : arg.slice(0, eq);
  const value = eq === -1 ? '' : arg.slice(eq + 1);
  if (name.trim() === '' || value === '') throw new ConfigUsageError(`${flag} "${arg}" must have the form ${shape}`);
  return [name, value];
}

function nonEmptyArg(flag: string, arg: string): string {
  if (arg.trim() === '') throw new ConfigUsageError(`${flag} needs a non-empty name`);
  return arg;
}

/** The change set the repeated change flags spell, in flag order. */
function parseChanges(values: { tier?: string[]; unset?: string[]; limit?: string[]; 'no-limit'?: string[] }): Change[] {
  const changes: Change[] = [];
  for (const arg of values.tier ?? []) {
    const [tier, spec] = nameAndValue('--tier', arg, '<tier>=<model>:<thinking>');
    changes.push({ op: 'setTier', tier, ...modelAndThinking(spec, `--tier ${tier}`) });
  }
  for (const arg of values.unset ?? []) changes.push({ op: 'unsetTier', tier: nonEmptyArg('--unset', arg) });
  for (const arg of values.limit ?? []) {
    const [endpoint, n] = nameAndValue('--limit', arg, '<endpoint>=<n>');
    if (!/^[1-9][0-9]*$/.test(n) || !Number.isSafeInteger(Number(n))) {
      throw new ConfigUsageError(`--limit "${arg}": the limit must be a positive whole number`);
    }
    changes.push({ op: 'setLimit', endpoint, parallel: Number(n) });
  }
  for (const arg of values['no-limit'] ?? []) changes.push({ op: 'clearLimit', endpoint: nonEmptyArg('--no-limit', arg) });
  return changes;
}

const HOST_OPTION = { host: { type: 'string' } } as const;
const CHANGE_OPTIONS = {
  ...HOST_OPTION,
  tier: { type: 'string', multiple: true },
  unset: { type: 'string', multiple: true },
  limit: { type: 'string', multiple: true },
  'no-limit': { type: 'string', multiple: true },
} as const;
const APPLY_OPTIONS = { ...CHANGE_OPTIONS, expect: { type: 'string' } } as const;

/**
 * subzero config: the setup service's five operations, for the Claude Code init skill.
 * Each prints one JSON document on stdout: `ok: true` and the result, or `ok: false`,
 * a code and the reason (exit 1). A malformed argument is a usage error on stderr (exit 2).
 */
async function config(service: DelegationService, args: string[], io: CliIo, options: CliOptions): Promise<number> {
  const [sub, ...rest] = args;
  const parse = <O extends ParseArgsOptionsConfig>(opts: O, positionals: boolean) => {
    let parsed;
    try {
      parsed = parseArgs({ args: rest, options: opts, allowPositionals: true, strict: true });
    } catch (err) {
      throw new ConfigUsageError((err as Error).message);
    }
    if (!positionals && parsed.positionals.length > 0) {
      throw new ConfigUsageError(`config ${sub} takes no arguments (got "${parsed.positionals[0]}")`);
    }
    return parsed;
  };
  const setup = (host: string | undefined) =>
    new SetupService({ kernel: options.kernel, projectRoot: service.projectRoot!, ...(host !== undefined ? { host } : {}) });

  try {
    switch (sub) {
      case 'models': {
        const { values } = parse(HOST_OPTION, false);
        return ok(io, await setup(values.host).models());
      }
      case 'show': {
        const { values } = parse(HOST_OPTION, false);
        return ok(io, await setup(values.host).show());
      }
      case 'check': {
        const { values, positionals } = parse(HOST_OPTION, true);
        if (positionals.length === 0) throw new ConfigUsageError('config check needs at least one <model>:<thinking>');
        const models = positionals.map((spec) => modelAndThinking(spec, 'model'));
        // Ctrl-C cancels the running check; the rest are reported cancelled.
        const abort = new AbortController();
        const onSigint = () => abort.abort();
        process.on('SIGINT', onSigint);
        try {
          return ok(io, await setup(values.host).check(models, abort.signal));
        } finally {
          process.off('SIGINT', onSigint);
        }
      }
      case 'preview': {
        const { values } = parse(CHANGE_OPTIONS, false);
        const { text: _text, ...preview } = setup(values.host).preview(parseChanges(values));
        return ok(io, preview);
      }
      case 'apply': {
        const { values } = parse(APPLY_OPTIONS, false);
        if (values.expect === undefined || values.expect === '') {
          throw new ConfigUsageError('config apply needs --expect <fingerprint> from config preview');
        }
        const { text: _text, ...applied } = setup(values.host).apply(parseChanges(values), values.expect);
        return ok(io, applied);
      }
      default:
        io.err(USAGE);
        return 2;
    }
  } catch (err) {
    if (!(err instanceof ConfigUsageError)) throw err;
    io.err(`subzero: ${err.message}`);
    io.err(USAGE);
    return 2;
  }
}

function ok(io: CliIo, result: object): number {
  io.out(json({ ok: true, ...result }));
  return 0;
}

async function run(service: DelegationService, args: string[], io: CliIo): Promise<number> {
  // The agent is a named option, so a lone argument is always the brief.
  const parsed = parseNamed(args, { agent: { type: 'string' } });
  if (parsed === null || parsed.positionals.length === 0) {
    io.err(USAGE);
    return 2;
  }
  const { agent } = parsed.values;
  const words = parsed.positionals;
  // Ctrl-C cancels the child run; the command line has no other cancel.
  const abort = new AbortController();
  const onSigint = () => abort.abort();
  process.on('SIGINT', onSigint);
  try {
    const reply = await service.delegate(
      { ...(agent !== undefined ? { agent } : {}), briefText: words.join(' ') },
      {
        wait: true,
        signal: abort.signal,
        onEvent: (event) => {
          if (event.kind === 'tool_activity' && event.phase === 'start') io.err(`· ${describeEvent(event)}`);
        },
        onState: (state) => {
          if (state === 'Pending') io.err('· waiting for the endpoint');
        },
      },
    );
    if (reply.kind !== 'result') return 1;
    io.out(withNotice(formatResult(reply.result), reply.notice));
    return reply.result.status === 'completed' || reply.result.status === 'truncated' ? 0 : 1;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

async function tasks(service: DelegationService, io: CliIo): Promise<number> {
  const views = await service.list();
  views.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (views.length === 0) io.out('no tasks');
  for (const v of views) io.out(`${v.taskId}  ${v.agent}  ${listingStatus(v)}  ${v.createdAt}`);
  return 0;
}

function taskArg(args: string[], io: CliIo): string | null {
  const id = args[0];
  if (id === undefined || !isTaskId(id)) {
    io.err(USAGE);
    return null;
  }
  return id;
}

async function attach(
  service: DelegationService,
  args: string[],
  io: CliIo,
  options: CliOptions,
): Promise<number> {
  const id = taskArg(args, io);
  if (id === null) return 2;
  await service.list(); // runs the sweep again before reading the status
  const record = service.store.readTask(id);
  if (record === null) {
    io.err(`subzero: no task ${id}`);
    return 1;
  }
  if (record.status === 'running') {
    // A stored running status with no start time is a queued task: no child exists yet.
    const facts = statusFacts(record);
    io.err(`subzero: task ${id} is ${formatStatusLine(facts)}; attach once its child run has ended`);
    return 1;
  }
  const spec = record.task?.launchSpec;
  if (spec === undefined) {
    io.err(`subzero: no launch spec was recorded for task ${id}, so it cannot be attached`);
    return 1;
  }
  const host = recordedHost(record.task?.agent);
  const attachCommand = options.kernel.attachCommand(host);
  if (attachCommand === undefined) {
    io.err(`subzero: the child driver of the host ${host} offers no attach command, so task ${id} cannot be attached`);
    return 1;
  }
  const [program, ...rest] = attachCommand(spec);
  if (options.interactive === false) {
    io.out([program, ...rest].join(' '));
    return 0;
  }
  return new Promise((resolve) => {
    const child = spawn(program!, rest, { cwd: spec.cwd, stdio: 'inherit' });
    child.once('error', (err) => {
      io.err(`subzero: could not start ${program}: ${err.message}`);
      resolve(1);
    });
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

/** The host of a recorded agent definition; a record without one has no child driver to ask. */
function recordedHost(agent: { host?: string } | undefined): string {
  return agent?.host ?? '(not recorded)';
}

async function show(
  service: DelegationService,
  args: string[],
  io: CliIo,
  options: CliOptions,
): Promise<number> {
  const id = taskArg(args, io);
  if (id === null) return 2;
  await service.list(); // runs the sweep again before reading the status
  const record = service.store.readTask(id);
  if (record === null) {
    io.err(`subzero: no task ${id}`);
    return 1;
  }
  if (record.status === 'abandoned') io.out(`task ${id} was abandoned: its owner process died, so it has no result.`);

  const sessionFile = record.sessionFile;
  if (sessionFile === undefined) {
    io.err(`subzero: task ${id} has no child session to export`);
    return 1;
  }
  const host = recordedHost(record.task?.agent);
  const sessionExport = options.kernel.sessionExport(host);
  if (sessionExport === undefined) {
    io.err(`subzero: the child driver of the host ${host} offers no session export, so task ${id} cannot be exported`);
    return 1;
  }
  const flag = args.indexOf('-o');
  const output = flag !== -1 && args[flag + 1] ? path.resolve(args[flag + 1]!) : path.resolve(`${id}.html`);
  try {
    await sessionExport(sessionFile, output);
  } catch (err) {
    io.err(`subzero: could not export the child session of ${id}: ${(err as Error).message}`);
    return 1;
  }
  io.out(`exported the child session of ${id} to ${output}`);
  return 0;
}
