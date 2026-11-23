// @sigil implements design/pi-extension.sigil PiExtension
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { configuredTierNames } from '../config/agent-config.js';
import { TIER_WORDS } from '../config/tier-words.js';
import type { Kernel } from '../kernel/kernel.js';
import type { DelegationService, TaskListing } from '../service/delegation-service.js';
import { describeContinueReply, describeTaskReply, listingStatus, withNotice } from '../service/status-text.js';
import { INIT_SYNTAX, registerPiInit } from './init.js';
import { mapPiRequest } from './request.js';
import { sendCompletion, sendStopped } from './notices.js';
import { clashWarning, SessionWidget } from './ui.js';

const names = { collect: 'subzero_await', cancel: 'subzero_cancel' };
const TYPED_NOTE = 'note: you sent a message, so this call stopped waiting; the child keeps running and its result arrives as a completion notice';
const result = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) });
const describe = (reply: Parameters<typeof describeTaskReply>[0]) =>
  withNotice(describeTaskReply(reply, undefined, names), 'notice' in reply ? reply.notice : undefined);
const formatSessionListing = (tasks: TaskListing[]) =>
  tasks.length ? tasks.map((task) => `${task.taskId} · ${task.agent} · ${listingStatus(task)}`).join('\n') : 'no tasks';
const USAGE = `Usage: /subzero [attach <id> | cancel [id] | ${INIT_SYNTAX}]`;
const BASE_DESCRIPTION = 'Delegate an isolated task. Await background tasks before using their results. Send a running or finished task more with subzero_continue.';

/** The `subagent` description: each tier phrase, configured or not, from the project's agent file. */
function tierDescription(root: string): string {
  try {
    const tiers = configuredTierNames(root);
    return ['Delegate an isolated task. Await background tasks with subzero_await before using their results. Send a running or finished task more with subzero_continue.',
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
  let stopNotices: (() => void) | undefined;
  /** The waited calls a message typed mid-turn may end, each by its own signal. */
  const waits = new Set<AbortController>();
  const startWait = (): { until: AbortSignal; done: () => void; ended: () => boolean } => {
    const controller = new AbortController();
    waits.add(controller);
    return { until: controller.signal, done: () => waits.delete(controller), ended: () => controller.signal.aborted };
  };
  /** Send the completion notice of one turn once it settles, unless it was cancelled or the session closed. */
  const notified = new Set<string>();
  const notifyWhenSettled = (svc: DelegationService, taskId: string, turn: number, parentSessionId: string): void => {
    // A turn reports once, whichever call ended its wait or started it in the background.
    if (notified.has(`${taskId}:${turn}`)) return;
    notified.add(`${taskId}:${turn}`);
    const activeSession = session;
    const done = svc.resultOfTurn(taskId, turn);
    if (done === undefined) return;
    void done.then(async (settled) => {
      if (settled.status === 'cancelled' || activeSession.closed) return;
      const notice = await svc.notice(taskId, settled.status, parentSessionId, 'subzero_await', turn);
      if (!activeSession.closed) sendCompletion(pi, notice);
    }).catch(() => {});
  };
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
  pi.on('session_start', async (event, ctx) => {
    stopNotices?.();
    service = createService(ctx);
    sessionId = ctx.sessionManager.getSessionId();
    projectRoot = ctx.cwd;
    session = { closed: false };
    const activeSession = session;
    widget = new SessionWidget(service, sessionId, ctx);
    description = BASE_DESCRIPTION;
    await service.start();
    // A turn that held messages opened reports here, since no call waits for it.
    const svc = service;
    stopNotices = svc.onNotice((notice) => {
      if (notice.phase !== 'settled' || notice.parentSessionId !== sessionId || notice.result.status === 'cancelled' || activeSession.closed) return;
      void svc.notice(notice.taskId, notice.result.status, sessionId, 'subzero_await', notice.turn).then((text) => {
        if (!activeSession.closed) sendCompletion(pi, text);
      });
    });
    if (event?.reason === 'reload' || event?.reason === 'resume') {
      try {
        const report = await svc.reloadReport(sessionId);
        if (report !== undefined) sendStopped(pi, report);
      } catch { /* A report that cannot be built must not stop the session from starting. */ }
    }
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
    stopNotices?.();
    stopNotices = undefined;
    // The session ends here, so each stopped turn is recorded as stopped by a session end.
    void svc.cancelSession(sessionId, 'session_end');
    if (!(await svc.shutdown())) killRemaining();
    service = undefined;
    if (count && ctx.hasUI) ctx.ui.notify(`${count} subzero tasks cancelled`);
  });
  // A message typed while the parent is blocked in a wait ends that wait, cancelling nothing.
  pi.on('input', (event) => {
    if (event.streamingBehavior === 'steer') for (const controller of waits) controller.abort();
    return { action: 'continue' as const };
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
        const typing = wait && !forced ? startWait() : undefined;
        const response = svc.delegate(mapped.delegation, {
          wait,
          ...(wait && signal ? { signal } : {}),
          ...(typing ? { until: typing.until } : {}),
          ...(forced ? { followOn: true } : {}),
          onState: (state) => {
            void activeWidget?.refresh();
            if (wait) return;
            if (state !== 'Settled' && state !== 'Failed' && state !== 'Cancelled') return;
            queueMicrotask(() => void (async () => {
              const dispatched = await response;
              const id = dispatched.kind === 'result' ? dispatched.result.taskId : dispatched.taskId;
              if (dispatched.kind === 'result' || activeSession.closed) return;
              notifyWhenSettled(svc, id, 1, mapped.delegation.parentSessionId!);
            })().catch(() => {}));
          },
        });
        const reply = await response.finally(() => { signal?.removeEventListener('abort', abort); typing?.done(); });
        let text = describe(reply);
        if (typing?.ended() && reply.kind !== 'result') {
          text += `\n${TYPED_NOTE}`;
          notifyWhenSettled(svc, reply.taskId, svc.runningTurn(reply.taskId) ?? 1, mapped.delegation.parentSessionId!);
        }
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
        const typing = startWait();
        try {
          const replies = await Promise.all(args.tasks.map((id) => svc.waitFor(id, seconds * 1000, { until: typing.until })));
          let text = replies.map(describe).join('\n\n');
          if (typing.ended()) {
            text += `\n\n${TYPED_NOTE}`;
            for (const reply of replies) {
              const pending = reply.kind === 'results' ? reply.then : reply;
              if (pending !== undefined && (pending.kind === 'running' || pending.kind === 'queued')) {
                const turn = svc.runningTurn(pending.taskId);
                if (turn !== undefined) notifyWhenSettled(svc, pending.taskId, turn, sessionId);
              }
            }
          }
          return text;
        } finally {
          signal?.removeEventListener('abort', abort);
          typing.done();
        }
      });
    },
  });
  pi.registerTool({
    name: 'subzero_continue', label: 'Continue a subzero task',
    description:
      'Send a follow-up message to a task of this session. A running child is steered, one that has not started holds the message, and a finished child starts a new turn in the same session. Write the message self-contained: the child sees nothing else.',
    parameters: Type.Object({ task: Type.String(), message: Type.String(), async: Type.Optional(Type.Boolean()) }),
    async execute(_id, args, signal, _update, ctx) {
      return respond(async () => {
        const svc = getService();
        const forced = ctx.mode === 'print' || ctx.mode === 'json';
        const wait = forced || args.async === false;
        const abort = () => void stopSession(svc, ctx);
        if (wait && signal) {
          if (signal.aborted) throw new Error('task was stopped; no action is needed');
          signal.addEventListener('abort', abort, { once: true });
        }
        const typing = wait && !forced ? startWait() : undefined;
        try {
          const reply = await svc.continue(
            { taskId: args.task, message: args.message, parentSessionId: sessionId },
            { wait, ...(typing ? { until: typing.until } : {}), ...(forced ? { followOn: true } : {}), onState: () => void widget?.refresh() },
          );
          let text = describeContinueReply(reply, names);
          if (reply.kind === 'new_turn' && reply.status.kind !== 'result') {
            if (typing?.ended()) text += `\n${TYPED_NOTE}`;
            // A new turn nobody waits for reports by completion notice.
            notifyWhenSettled(svc, args.task, reply.turn, sessionId);
          }
          return text;
        } finally {
          signal?.removeEventListener('abort', abort);
          typing?.done();
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
