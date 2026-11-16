// @sigil implements design/pi-extension.sigil PiExtension
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { configuredTierNames } from '../config/agent-config.js';
import { TIER_WORDS } from '../config/tier-words.js';
import type { Kernel } from '../kernel/kernel.js';
import type { DelegationService, TaskListing } from '../service/delegation-service.js';
import { describeTaskReply, listingStatus, withNotice } from '../service/status-text.js';
import { INIT_SYNTAX, registerPiInit } from './init.js';
import { mapPiRequest } from './request.js';
import { sendCompletion, sendStopped } from './notices.js';
import { clashWarning, SessionWidget } from './ui.js';

const names = { collect: 'subzero_await', cancel: 'subzero_cancel' };
const result = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) });
const describe = (reply: Parameters<typeof describeTaskReply>[0]) =>
  withNotice(describeTaskReply(reply, undefined, names), 'notice' in reply ? reply.notice : undefined);
const formatSessionListing = (tasks: TaskListing[]) =>
  tasks.length ? tasks.map((task) => `${task.taskId} · ${task.agent} · ${listingStatus(task)}`).join('\n') : 'no tasks';
const USAGE = `Usage: /subzero [attach <id> | cancel [id] | ${INIT_SYNTAX}]`;
const BASE_DESCRIPTION = 'Delegate an isolated task. Await background tasks before using their results.';

/** The `subagent` description: each tier phrase, configured or not, from the project's agent file. */
function tierDescription(root: string): string {
  try {
    const tiers = configuredTierNames(root);
    return ['Delegate an isolated task. Await background tasks with subzero_await before using their results.',
      ...TIER_WORDS.map(({ tier, phrase }) => tiers.includes(tier)
        ? `${phrase} (${tier}): pass model: "${tier}".`
        : `${phrase} (${tier}): not configured, omit model.`),
    ].join('\n');
  } catch {
    return BASE_DESCRIPTION;
  }
}

export function registerPiExtension(pi: ExtensionAPI, createService: (ctx: ExtensionContext) => DelegationService, killRemaining: () => void = () => {}, ownFile = fileURLToPath(import.meta.url), kernel?: Kernel): void {
  let service: DelegationService | undefined;
  let sessionId = '';
  let projectRoot = '';
  let session = { closed: true };
  let stopping: Promise<void> | undefined;
  let widget: SessionWidget | undefined;
  let warning: string | undefined;
  let description = BASE_DESCRIPTION;
  const getService = () => {
    if (!service) throw new Error('subzero session has not started');
    return service;
  };
  const respond = async (fn: () => Promise<string>) => {
    try { return result(await fn()); }
    catch (err) { return result((err as Error).message, true); }
  };
  const stopSession = (svc: DelegationService, ctx: ExtensionContext): Promise<void> => {
    if (stopping) return stopping;
    const activeSession = session;
    stopping = (async () => {
      const cancelled = await svc.cancelSession(sessionId);
      if (cancelled.count && !activeSession.closed) {
        sendStopped(pi, `${cancelled.count} subzero tasks stopped: ${cancelled.taskIds.join(', ')}. No action is needed.`);
        if (ctx.hasUI) ctx.ui.notify(`${cancelled.count} subzero tasks cancelled`);
      }
    })().finally(() => { stopping = undefined; });
    return stopping;
  };
  pi.on('session_start', async (_event, ctx) => {
    service = createService(ctx);
    sessionId = ctx.sessionManager.getSessionId();
    projectRoot = ctx.cwd;
    session = { closed: false };
    widget = new SessionWidget(service, sessionId, ctx);
    description = BASE_DESCRIPTION;
    await service.start();
    description = tierDescription(ctx.cwd);
    pi.setActiveTools(pi.getActiveTools());
    warning = clashWarning(pi, ownFile);
    if (warning) {
      if (ctx.hasUI) ctx.ui.notify(warning, 'warning');
      else process.stderr.write(`subzero: ${warning}\n`);
    }
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    const svc = service;
    if (!svc) return;
    session.closed = true;
    widget?.close();
    const count = (await svc.listLiveSession(sessionId)).length;
    void svc.cancelSession(sessionId);
    if (!(await svc.shutdown())) killRemaining();
    service = undefined;
    if (count && ctx.hasUI) ctx.ui.notify(`${count} subzero tasks cancelled`);
  });
  pi.on('agent_settled', async (event, ctx) => {
    if (!event.aborted || !service) return;
    await stopSession(service, ctx);
  });
  pi.registerTool({
    name: 'subagent', label: 'Subagent', description,
    executionMode: 'parallel',
    prepareLoadout: () => ({ descriptions: { subagent: description } }),
    parameters: Type.Object({
      task: Type.String(), agent: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
      async: Type.Optional(Type.Boolean()), files: Type.Optional(Type.Array(Type.String())),
      expected_output: Type.Optional(Type.String()), worktree: Type.Optional(Type.Boolean()),
      isolation: Type.Optional(Type.String()), context: Type.Optional(Type.String()),
      action: Type.Optional(Type.String()), workflow: Type.Optional(Type.Unknown()),
    }),
    async execute(_id, args, signal, _update, ctx) {
      return respond(async () => {
        const svc = getService();
        const mapped = mapPiRequest(args, () => configuredTierNames(projectRoot), sessionId);
        if ('error' in mapped) throw new Error(mapped.error);
        const forced = ctx.mode === 'print' || ctx.mode === 'json';
        const wait = forced || args.async === false;
        const activeSession = session;
        const activeWidget = widget;
        const abort = () => void stopSession(svc, ctx);
        if (wait && signal) {
          if (signal.aborted) throw new Error('task was stopped; no action is needed');
          signal.addEventListener('abort', abort, { once: true });
        }
        const response = svc.delegate(mapped.delegation, {
          wait,
          ...(wait && signal ? { signal } : {}),
          onState: (state) => {
            void activeWidget?.refresh();
            if (wait) return;
            if (state !== 'Settled' && state !== 'Failed' && state !== 'Cancelled') return;
            queueMicrotask(() => void (async () => {
              const dispatched = await response;
              const id = dispatched.kind === 'result' ? dispatched.result.taskId : dispatched.taskId;
              const collected = await svc.collect(id);
              if (collected.kind !== 'result' || collected.result.status === 'cancelled' || activeSession.closed) return;
              const notice = await svc.notice(id, collected.result.status, mapped.delegation.parentSessionId!, 'subzero_await');
              if (!activeSession.closed) sendCompletion(pi, notice);
            })().catch(() => {}));
          },
        });
        const reply = await response.finally(() => signal?.removeEventListener('abort', abort));
        let text = describe(reply);
        if (mapped.notice) text = withNotice(text, mapped.notice);
        if (forced && args.async === true) text += '\nnotice: this mode waits for the result.';
        return text;
      });
    },
  });
  pi.registerTool({
    name: 'subzero_await', label: 'Await subzero tasks', description: 'Collect task results, waiting up to 600 seconds.',
    parameters: Type.Object({ tasks: Type.Array(Type.String()), timeout_s: Type.Optional(Type.Number()) }),
    async execute(_id, args, signal, _update, ctx) {
      return respond(async () => {
        if (args.tasks.length === 0) throw new Error('await needs at least one task id');
        const seconds = args.timeout_s !== undefined && args.timeout_s >= 0 ? Math.min(args.timeout_s, 600) : 30;
        const svc = getService();
        const abort = () => void stopSession(svc, ctx);
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        try {
          return (await Promise.all(args.tasks.map((id) => svc.waitFor(id, seconds * 1000)))).map(describe).join('\n\n');
        } finally {
          signal?.removeEventListener('abort', abort);
        }
      });
    },
  });
  pi.registerTool({
    name: 'subzero_tasks', label: 'Subzero tasks', description: 'List session tasks or inspect a task.',
    parameters: Type.Object({ task: Type.Optional(Type.String()) }),
    async execute(_id, args) {
      return respond(async () => {
        if (args.task) return describe(await getService().collect(args.task));
        const tasks = await getService().list(sessionId);
        return formatSessionListing(tasks);
      });
    },
  });
  pi.registerTool({
    name: 'subzero_cancel', label: 'Cancel subzero tasks', description: 'Cancel one task or all tasks in this session.',
    parameters: Type.Object({ task: Type.Optional(Type.String()) }),
    async execute(_id, args, _signal, _update, ctx) {
      return respond(async () => {
        const svc = getService();
        if (!args.task) {
          const count = (await svc.listLiveSession(sessionId)).length;
          await stopSession(svc, ctx);
          return `${count} tasks cancelled`;
        }
        const wasLive = (await svc.listLiveSession(sessionId)).some((task) => task.taskId === args.task);
        const reply = await svc.cancel(args.task);
        if (wasLive && reply.kind === 'result' && reply.result.status === 'cancelled' && !session.closed) {
          sendStopped(pi, await svc.notice(args.task, 'cancelled', sessionId, 'subzero_await'));
        }
        return describe(reply);
      });
    },
  });
  // Guided init and its quick path; the tier text is rebuilt after a write, so new tiers show at once.
  const init = kernel && registerPiInit(pi, {
    kernel,
    projectRoot: async () => {
      const svc = getService();
      await svc.start();
      return svc.projectRoot ?? projectRoot;
    },
    refreshTierText: () => {
      description = tierDescription(projectRoot);
      pi.setActiveTools(pi.getActiveTools());
    },
  });
  pi.registerCommand('subzero', {
    description: 'List or cancel subzero tasks for this session, or set subzero up with init.',
    async handler(args, ctx) {
      const words = args.trim().split(/\s+/);
      const [first, ...rest] = words;
      if (first === 'init') {
        if (!init) { ctx.ui.notify('subzero init is not available in this session'); return; }
        await init.command(rest, ctx);
        return;
      }
      const [action, id, ...extra] = words;
      if (extra.length) { ctx.ui.notify(USAGE); return; }
      if (action === 'attach') {
        if (!id) { ctx.ui.notify('Usage: /subzero attach <id>'); return; }
        const attach = await getService().attachCommand(id);
        const quote = (arg: string) => /^[A-Za-z0-9_./:=+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
        ctx.ui.notify(attach.kind === 'command' ? attach.command.map(quote).join(' ') : attach.message);
        return;
      }
      if (action === 'cancel' && id) {
        const svc = getService();
        const live = (await svc.listLiveSession(sessionId)).some((task) => task.taskId === id);
        if (!live) { ctx.ui.notify(`task ${id} not found among this session's running tasks`); return; }
        const reply = await svc.cancel(id);
        if (reply.kind === 'result' && reply.result.status === 'cancelled') {
          sendStopped(pi, await svc.notice(id, 'cancelled', sessionId, 'subzero_await'));
          ctx.ui.notify('1 subzero task cancelled');
        } else ctx.ui.notify(describe(reply));
        return;
      }
      if (action === 'cancel') {
        const svc = getService();
        const count = (await svc.listLiveSession(sessionId)).length;
        await stopSession(svc, ctx);
        if (ctx.hasUI && count === 0) ctx.ui.notify('0 subzero tasks cancelled');
        if (!ctx.hasUI) process.stderr.write(`subzero: ${count} tasks cancelled\n`);
        return;
      }
      if (action) { ctx.ui.notify(USAGE); return; }
      const tasks = await getService().list(sessionId);
      const listing = formatSessionListing(tasks);
      ctx.ui.notify(warning ? `${listing}\n${warning}` : listing);
    },
  });
}
