// @sigil implements design/claude-mcp-server.sigil ClaudeMcpServer
//
// The plugin's MCP server: four tools backed by DelegationService. Claude Code
// names them mcp__plugin_subzero_subzero__<tool>.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { configuredTierNames, LoadError, MissingAgentFileError, routableTiers, TierError, UnknownAgentError, UnresolvedRootError } from '../config/agent-config.js';
import { mapRequest } from '../config/tier-words.js';
import { isTaskId } from '../core/ids.js';
import type { ChildRunState } from '../core/types.js';
import { UnsupportedHostError } from '../kernel/kernel.js';
import { EmptyBriefError, type DelegationService } from '../service/delegation-service.js';
import { describeContinueReply, pendingOf } from '../service/status-text.js';
import { deliveredTurns, describeReply, formatAwaitWithShown, formatListing, MCP_TOOL_NAMES, REPLY_BUDGET_CHARS } from './format.js';
import { readCallMarker, readPromptMarker } from './parent-session.js';
import { ProgressReporter, type ProgressOptions } from './progress.js';
import { SubzeroTaskStore } from './task-store.js';
import { WakeMarkers } from './wake-markers.js';

export const SERVER_INSTRUCTIONS = [
  'Use the delegate tool to hand a task to a child on another model, naming an agent, a model tier, both or neither.',
  'Write a self-contained brief: the goal, the relevant file paths, the constraints and the output you expect.',
  'The child cannot see this conversation; it sees only the brief.',
  'When the user tells you something a running child needs, or you want a finished child to go on, use the continue tool with its task id and a self-contained message: it steers a running child, holds the message for one that has not started, and starts a new turn on one that finished.',
].join(' ');

export const MAX_AWAIT_SECONDS = 600;

const DELEGATE_DESCRIPTION =
  'Delegate a task to a subzero agent running on another model. With no agent it runs the general agent. A tier picks the model the agent runs on. Returns the result with the task id first, or a task handle or id when running in the background.';

const TOOLS = [
  {
    name: 'delegate',
    execution: { taskSupport: 'optional' as const },
    description: DELEGATE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Name of an agent in .agents/subzero.yaml; none runs the general agent' },
        tier: { type: 'string', description: 'A model tier, medium or tier:medium; the tiers this server can run are listed in the description of this tool' },
        brief: { type: 'string', description: 'A self-contained brief; the child cannot see this conversation' },
        files: { type: 'array', items: { type: 'string' }, description: 'Paths the child should read' },
        expected_output: { type: 'string', description: 'What the result should contain' },
        wait: { type: 'boolean', description: 'Wait for the result; defaults to true unless the call requests an MCP task' },
      },
      required: ['brief'],
    },
    _meta: { 'anthropic/alwaysLoad': true },
  },
  {
    name: 'tasks',
    description: 'List the tasks of this conversation (at most 50), or show one task by its task id.',
    inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'await',
    description: 'Collect the results of tasks started with wait: false, waiting up to timeout_s seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: { type: 'array', items: { type: 'string' } },
        timeout_s: { type: 'number', description: `Seconds to wait, at most ${MAX_AWAIT_SECONDS}` },
      },
      required: ['tasks'],
    },
    annotations: { readOnlyHint: true },
    _meta: { 'anthropic/alwaysLoad': true },
  },
  {
    name: 'continue',
    description:
      'Send a follow-up message to a task of this conversation. A running child is steered, one that has not started holds the message, and a finished child starts a new turn in the same session. Write the message self-contained: the child sees nothing else. The reply says which happened.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task id' },
        message: { type: 'string', description: 'A self-contained message for the child' },
        wait: { type: 'boolean', description: 'For a new turn: wait for its result; defaults to true' },
      },
      required: ['task', 'message'],
    },
  },
  {
    name: 'cancel',
    description: 'Cancel one task, or all tasks of this session when no task is given.',
    inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
  },
];

export interface SubzeroServerOptions {
  service: DelegationService;
  /** The parent session id of the current conversation, when the hook recorded it. */
  parentSessionId: () => string | undefined;
  progress?: ProgressOptions;
  version?: string;
  /** Enable only when the parent is known to support interactive MCP tasks. */
  taskMode?: boolean;
  onTaskMode?: (enabled: boolean) => void;
  wakeDataDir?: string;
  nonInteractive?: boolean;
}

/** A tool reply, never cut: Claude Code saves a reply over its inline limit to a file. */
function text(body: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: body }], ...(isError ? { isError: true } : {}) };
}

/** What a caller does when delegate made no task because the tier or its host cannot run. */
const PASS_BACK =
  "delegate made no task. Dispatch that subagent through Claude's own Agent tool instead, as a pass-back: call Agent with the same prompt and a short description that begins with passback.";

function toolError(err: unknown): CallToolResult {
  if (err instanceof UnresolvedRootError) {
    return text(
      `${err.message} This is a configuration problem the user must fix; do not retry this call.`,
      true,
    );
  }
  if (err instanceof TierError || err instanceof UnsupportedHostError || err instanceof MissingAgentFileError) return text(`${err.message}. ${PASS_BACK}`, true);
  if (err instanceof UnknownAgentError || err instanceof LoadError || err instanceof EmptyBriefError) {
    return text(err.message, true);
  }
  return text(`subzero failed: ${(err as Error)?.message ?? String(err)}`, true);
}

/** The typing watch of a call that no typed message may end. */
const NO_TYPING: { signal?: AbortSignal; stop: () => void } = { stop() {} };

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === 'string' ? (args[key] as string) : undefined;
}

export function createSubzeroServer(options: SubzeroServerOptions): Server {
  const { service } = options;
  const taskMode = options.taskMode === true && options.nonInteractive !== true;
  const taskStore = new SubzeroTaskStore(service);
  const server = new Server(
    { name: 'subzero', version: options.version ?? '0.0.0-dev' },
    { capabilities: { tools: {}, ...(taskMode ? { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } } : {}) }, ...(taskMode ? { taskStore } : {}), instructions: SERVER_INSTRUCTIONS },
  );
  let lastSession: string | undefined;
  let watcher: NodeJS.Timeout | undefined;
  const wakeKey = (taskId: string, turn: number) => (turn >= 2 ? `${taskId}#${turn}` : taskId);
  const wakeMarkers = (): WakeMarkers | undefined =>
    options.wakeDataDir !== undefined && service.projectRoot !== undefined ? new WakeMarkers(options.wakeDataDir, service.projectRoot) : undefined;
  /** Tell the Stop hook to wake Claude with the result of one turn, whatever the task mode. */
  const armWake = (session: string, taskId: string, turn: number): void => {
    const markers = wakeMarkers();
    const done = service.resultOfTurn(taskId, turn);
    if (markers === undefined || done === undefined) return;
    const key = wakeKey(taskId, turn);
    try { markers.start(session, key); } catch { return; /* A marker for this turn already waits. */ }
    void done.then(async (result) => {
      if (result.status === 'cancelled') { markers.clear(session, key); return; }
      const body = `${describeReply({ kind: 'result', result })}\n\n${await service.notice(taskId, result.status, session, 'await', turn)}`;
      markers.finish(session, key, JSON.stringify({ notice: body, collectedMarker: service.collectedMarkerPath(taskId, turn) }));
    }).catch(() => { try { markers.clear(session, key); } catch { /* The marker may already be gone. */ } });
  };
  // A turn that held messages opened reports through a wake marker: no call is waiting for it.
  const stopSink = service.onNotice((notice) => {
    if (notice.parentSessionId === undefined) return;
    if (notice.phase === 'opened') armWake(notice.parentSessionId, notice.taskId, notice.turn);
  });
  /**
   * Ends a waited call when the user types: the prompt hook writes a prompt marker for the
   * session, and only a call that the PreToolUse hook marked as made by the main conversation
   * (a marker with no agent id) may end. A subagent call, or one with no marker, keeps waiting.
   */
  const watchTyping = (session: string | undefined, startedAtMs: number, toolUseId: unknown): { signal?: AbortSignal; stop: () => void } => {
    const dir = options.wakeDataDir;
    const root = service.projectRoot;
    if (dir === undefined || root === undefined || session === undefined || typeof toolUseId !== 'string') return NO_TYPING;
    const controller = new AbortController();
    // Once the call marker is found it never changes: a subagent call can never end, so polling stops.
    let call: ReturnType<typeof readCallMarker>;
    const timer = setInterval(() => {
      try {
        call ??= readCallMarker(dir, root, toolUseId);
        if (call === undefined) return;
        if (call.agentId !== undefined) { clearInterval(timer); return; }
        const at = readPromptMarker(dir, root, session);
        if (at !== undefined && at > startedAtMs) { controller.abort(); clearInterval(timer); }
      } catch { /* An unreadable marker never ends a wait. */ }
    }, 200);
    timer.unref();
    return { signal: controller.signal, stop: () => clearInterval(timer) };
  };
  const typedNote = 'note: the user sent a message, so this call stopped waiting; the child keeps running and its result wakes you when it settles';
  const syncSession = async (): Promise<string | undefined> => {
    await service.start();
    const current = options.parentSessionId();
    const previous = lastSession;
    if (current !== undefined) lastSession = current;
    if (current !== undefined && previous !== undefined && current !== previous) {
      taskStore.reset();
      await service.cancelSession(previous);
    }
    return current;
  };
  const stopWatchingIfIdle = () => {
    if (watcher && !service.hasLiveSessionTasks()) { clearInterval(watcher); watcher = undefined; }
  };
  const watchSessions = () => {
    if (watcher || !service.hasLiveSessionTasks()) return;
    watcher = setInterval(() => void syncSession().catch(() => undefined).finally(stopWatchingIfIdle), 5000);
    watcher.unref();
  };
  server.onclose = () => { if (watcher) clearInterval(watcher); watcher = undefined; stopSink(); taskStore.cleanup(); };

  // The delegate description names the tiers the agent file holds now, read at each listing.
  async function delegateDescription(): Promise<string> {
    try {
      await service.start();
      const root = service.projectRoot;
      if (root === undefined) return DELEGATE_DESCRIPTION;
      const tiers = routableTiers(root, service.supportedHosts());
      if (tiers.length === 0) return DELEGATE_DESCRIPTION;
      const list = tiers.map((t) => `${t.tier} → ${t.model} (host ${t.host})`).join('; ');
      return `${DELEGATE_DESCRIPTION} Tiers you can pass as tier: ${list}.`;
    } catch {
      return DELEGATE_DESCRIPTION;
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try { await syncSession(); } catch { /* A later call reports the root error. */ }
    const description = await delegateDescription();
    return { tools: TOOLS.map((tool) => {
      if (tool.name !== 'delegate') return tool;
      const { execution, ...base } = tool;
      return { ...base, description, ...(taskMode ? { execution } : {}) };
    }) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const toolUseId = request.params._meta?.['claudecode/toolUseId'];
    const startedAt = Date.now();
    try {
      if (request.params.task && request.params.name !== 'delegate') throw new Error('only delegate supports tasks');
      const currentSession = await syncSession();
      switch (request.params.name) {
        case 'delegate': {
          options.onTaskMode?.(request.params.task !== undefined && taskMode);
          const agent = stringArg(args, 'agent');
          const brief = stringArg(args, 'brief');
          if (brief === undefined) {
            if (request.params.task) throw new Error('delegate needs a brief');
            return text('delegate needs a brief', true);
          }
          const tier = stringArg(args, 'tier');
          const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === 'string') : undefined;
          const expectedOutput = stringArg(args, 'expected_output');
          const wait = options.nonInteractive === true || args.wait !== false ||
            (options.wakeDataDir !== undefined && currentSession === undefined && !request.params.task);
          // Connect first, so the parent session id is read for the resolved root.
          await service.start();
          const parentSessionId = currentSession;
          let ownTask: string | undefined;
          let cancelOwnWhenCreated = false;
          const onAbort = () => {
            if (Date.now() - startedAt < 120_000 && parentSessionId !== undefined) void service.cancelSession(parentSessionId);
            else if (ownTask) void service.cancel(ownTask);
            else cancelOwnWhenCreated = true;
          };
          const tiers = configuredTierNames(service.projectRoot!);
          const mapped = mapRequest(agent, tier, tiers);
          if (mapped.tier.kind === 'unmatched') throw new TierError(mapped.tier.value, tiers);
          const progressToken = request.params._meta?.progressToken;
          const reporter = (request.params.task ? args.wait === true : wait) && progressToken !== undefined
            ? new ProgressReporter(
                agent ?? 'general',
                (progress, message) => void extra
                  .sendNotification({ method: 'notifications/progress', params: { progressToken, progress, message } })
                  .catch(() => undefined),
                options.progress,
              )
            : null;
          const delegation = {
            ...(mapped.agent !== undefined ? { agent: mapped.agent } : {}),
            ...(mapped.tier.kind === 'tier' ? { tier: mapped.tier.name } : {}),
            briefText: brief,
            ...(files !== undefined ? { files } : {}),
            ...(expectedOutput !== undefined ? { expectedOutput } : {}),
            replyBudgetChars: REPLY_BUDGET_CHARS,
            ...(parentSessionId !== undefined ? { parentSessionId } : {}),
          };
          const onState = (state: ChildRunState) => {
            reporter?.onState(state);
            if (parentSessionId !== undefined && lastSession !== undefined && parentSessionId !== lastSession) {
              void service.cancelSession(parentSessionId);
            }
            watchSessions();
            if (state === 'Settled' || state === 'Failed' || state === 'Cancelled') setImmediate(stopWatchingIfIdle);
          };
          if (request.params.task) {
            try {
              if (!extra.taskStore) throw new Error('task storage unavailable');
              const reply = await service.delegate(delegation, {
                wait: false,
                ...(reporter ? { onEvent: (event) => reporter.onEvent(event) } : {}),
                onState,
              });
              if (reply.kind === 'result') throw new Error('expected a live task');
              let task;
              try { task = await extra.taskStore.createTask({ ttl: null, pollInterval: 100 }); }
              catch (err) { await service.cancel(reply.taskId); throw err; }
              taskStore.bind(task.taskId, reply.taskId);
              const store = extra.taskStore;
              const completion = (async () => {
                try {
                  const result = await service.waitForCompletion(reply.taskId);
                  if ((await store.getTask(task.taskId)).status === 'cancelled') return;
                  const notice = result.kind === 'result' && parentSessionId !== undefined
                    ? await service.notice(reply.taskId, result.result.status, parentSessionId, 'await') : '';
                  const withNotice = reply.notice === undefined ? result : { ...result, notice: reply.notice };
                  const body = `${describeReply(withNotice)}${notice ? `\n\n${notice}` : ''}`;
                  await store.storeTaskResult(task.taskId, result.kind === 'result' && result.result.status === 'failed' ? 'failed' : 'completed', text(body));
                  for (const t of deliveredTurns(result)) service.markDelivered(t.taskId, t.turn);
                } finally { taskStore.release(task.taskId); }
              })();
              if (args.wait === true || options.nonInteractive === true) {
                const onAbort = () => {
                  if (Date.now() - startedAt < 120_000 && parentSessionId !== undefined) void service.cancelSession(parentSessionId);
                  else void service.cancel(reply.taskId);
                };
                if (extra.signal.aborted) onAbort();
                else extra.signal.addEventListener('abort', onAbort, { once: true });
                try {
                  await completion;
                  return { task: await store.getTask(task.taskId) };
                } finally { extra.signal.removeEventListener('abort', onAbort); }
              }
              void completion.catch(() => undefined);
              return { task };
            } finally { reporter?.stop(); }
          }
          if (wait) {
            if (extra.signal.aborted) onAbort();
            else extra.signal.addEventListener('abort', onAbort, { once: true });
          }

          const typing = wait && !request.params.task ? watchTyping(parentSessionId, startedAt, toolUseId) : NO_TYPING;
          try {
            const reply = await service.delegate(
              delegation,
              {
                wait,
                onTask: (taskId) => {
                  ownTask = taskId;
                  if (wait && (cancelOwnWhenCreated || (extra.signal.aborted && Date.now() - startedAt < 120_000))) void service.cancel(taskId);
                },
                ...(typing.signal ? { until: typing.signal } : {}),
                ...(options.nonInteractive === true ? { followOn: true } : {}),
                ...(reporter ? { onEvent: (e) => reporter.onEvent(e) } : {}),
                onState,
              },
            );
            // A background task, or a waited one the user's message ended, reports through a wake marker.
            const endedEarly = wait && typing.signal?.aborted === true && reply.kind !== 'result';
            if ((!wait || endedEarly) && reply.kind !== 'result' && parentSessionId !== undefined) {
              try { armWake(parentSessionId, reply.taskId, service.runningTurn(reply.taskId) ?? 1); } catch { /* A marker failure must not lose a delegation. */ }
            }
            return text(endedEarly ? `${describeReply(reply)}\n${typedNote}` : describeReply(reply));
          } finally {
            typing.stop();
            extra.signal.removeEventListener('abort', onAbort);
            reporter?.stop();
          }
        }

        case 'tasks': {
          const task = stringArg(args, 'task');
          if (task !== undefined) {
            if (!isTaskId(task)) return text(`"${task}" is not a task id`, true);
            const views = await service.list();
            const view = views.find((v) => v.taskId === task);
            if (view === undefined) return text(`task: ${task} · no such task`);
            const reply = await service.collect(task);
            const markers = wakeMarkers();
            if (markers !== undefined && view.parentSessionId !== undefined) {
              for (const turn of deliveredTurns(reply)) try { markers.clear(view.parentSessionId, wakeKey(turn.taskId, turn.turn)); } catch {}
            }
            return text(describeReply(reply, view));
          }
          await service.start();
          const parentSessionId = currentSession;
          const views = await service.list(parentSessionId);
          return text(formatListing(views, parentSessionId !== undefined));
        }

        case 'await': {
          const ids = Array.isArray(args.tasks) ? args.tasks.filter((t): t is string => typeof t === 'string') : [];
          if (ids.length === 0) return text('await needs at least one task id', true);
          const seconds = typeof args.timeout_s === 'number' && args.timeout_s >= 0 ? Math.min(args.timeout_s, MAX_AWAIT_SECONDS) : 30;
          const onAbort = () => {
            if (Date.now() - startedAt < 120_000) void service.cancelSession(currentSession);
          };
          if (extra.signal.aborted) onAbort();
          else extra.signal.addEventListener('abort', onAbort, { once: true });
          const typing = watchTyping(currentSession, startedAt, toolUseId);
          let replies;
          try { replies = await Promise.all(ids.map((id) => service.waitFor(id, seconds * 1000, typing.signal ? { until: typing.signal } : {}))); }
          finally { extra.signal.removeEventListener('abort', onAbort); typing.stop(); }
          const formatted = formatAwaitWithShown(replies);
          const markers = wakeMarkers();
          if (formatted.shown.length && markers !== undefined) {
            const owners = await service.list().catch(() => []);
            for (const { taskId, turn } of formatted.shown) {
              const owner = owners.find((task) => task.taskId === taskId)?.parentSessionId;
              if (owner !== undefined) try { markers.clear(owner, wakeKey(taskId, turn)); } catch {}
            }
          }
          // A wait the user's message ended leaves each unsettled task to a wake marker.
          const endedEarly = typing.signal?.aborted === true;
          if (endedEarly && currentSession !== undefined) {
            for (const reply of replies) {
              const pending = pendingOf(reply);
              if (pending !== undefined) {
                const turn = service.runningTurn(pending.taskId);
                if (turn !== undefined) try { armWake(currentSession, pending.taskId, turn); } catch {}
              }
            }
          }
          // Whole results while they fit, the first always; a later one that does not fit is deferred, never cut.
          return text(endedEarly ? `${formatted.body}\n\n${typedNote}` : formatted.body);
        }

        case 'continue': {
          const task = stringArg(args, 'task');
          const message = stringArg(args, 'message');
          if (task === undefined || !isTaskId(task)) return text(`"${task ?? ''}" is not a task id`, true);
          if (message === undefined || message.trim() === '') return text('continue needs a message', true);
          await service.start();
          // A new turn waits unless asked not to; a steered or queued message always replies at once.
          // Forced to true where the wait of a delegate call is: a non-interactive or unknown mode, or
          // no known parent session id while wake markers are in use.
          const wait = options.nonInteractive === true || args.wait !== false ||
            (options.wakeDataDir !== undefined && currentSession === undefined);
          let ownTask: string | undefined = task;
          const onAbort = () => {
            if (Date.now() - startedAt < 120_000 && currentSession !== undefined) void service.cancelSession(currentSession);
            else if (ownTask) void service.cancel(ownTask);
          };
          if (wait) {
            if (extra.signal.aborted) onAbort();
            else extra.signal.addEventListener('abort', onAbort, { once: true });
          }
          const typing = wait ? watchTyping(currentSession, startedAt, toolUseId) : NO_TYPING;
          // A waited continue reports progress as a waited delegate does.
          const progressToken = request.params._meta?.progressToken;
          const reporter = wait && progressToken !== undefined
            ? new ProgressReporter(
                (await service.list().catch(() => [])).find((view) => view.taskId === task)?.agent ?? 'general',
                (progress, message) => void extra
                  .sendNotification({ method: 'notifications/progress', params: { progressToken, progress, message } })
                  .catch(() => undefined),
                options.progress,
              )
            : null;
          try {
            const reply = await service.continue(
              { taskId: task, message, ...(currentSession !== undefined ? { parentSessionId: currentSession } : {}) },
              {
                wait,
                ...(typing.signal ? { until: typing.signal } : {}),
                ...(options.nonInteractive === true ? { followOn: true } : {}),
                ...(reporter ? { onEvent: (event) => reporter.onEvent(event) } : {}),
                onState: (state) => { reporter?.onState(state); watchSessions(); },
              },
            );
            if (reply.kind === 'new_turn' && reply.status.kind !== 'result' && currentSession !== undefined) {
              try { armWake(currentSession, task, reply.turn); } catch { /* A marker failure must not lose a continuation. */ }
            }
            const endedEarly = reply.kind === 'new_turn' && wait && typing.signal?.aborted === true && reply.status.kind !== 'result';
            const body = describeContinueReply(reply, MCP_TOOL_NAMES);
            return text(endedEarly ? `${body}\n${typedNote}` : body);
          } finally {
            typing.stop();
            extra.signal.removeEventListener('abort', onAbort);
            reporter?.stop();
          }
        }

        case 'cancel': {
          const task = stringArg(args, 'task');
          if (task === undefined) {
            await service.start();
            const cancelled = await service.cancelSession(currentSession);
            return cancelled.kind === 'unknown_session'
              ? text('session is unknown; no tasks were cancelled', true)
              : text(`${cancelled.count} tasks cancelled${cancelled.count ? `: ${cancelled.taskIds.join(', ')}` : ''}`);
          }
          return text(describeReply(await service.cancel(task)));
        }

        default:
          return text(`unknown tool ${request.params.name}`, true);
      }
    } catch (err) {
      if (request.params.task) {
        const result = toolError(err);
        throw new McpError(ErrorCode.InvalidParams, result.content.map((part) => part.type === 'text' ? part.text : '').join('\n'));
      }
      return toolError(err);
    }
  });

  return server;
}
