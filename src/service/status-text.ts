// @sigil implements design/delegation-service.sigil DelegationService (status text)
//
// The one owner of the wording of a task's state: every reply that tells a parent
// or a person whether a child has started, and every result text, comes through
// here, so that no front end imports another front end for it.
import type { StarterResult } from '../config/agent-config.js';
import { isUnavailable, type DomainEvent, type Measure, type Result, type SessionUsage } from '../core/types.js';
import type { CollectReply, ContinueReply, DelegateReply, TaskListing } from './delegation-service.js';

export function formatProgress(agent: string, latest: string, elapsedMs: number): string {
  return `${agent} · ${latest} · ${formatElapsed(elapsedMs)}`;
}

const UNIDENTIFIED_LINE = 'note: this conversation could not be identified, so the task cannot be continued';

export function describeTaskReply(reply: DelegateReply | CollectReply, view: { agent: string; createdAt: string } | undefined, tools: { collect: string; cancel: string }, now = Date.now()): string {
  const text = describeReply(reply, view, tools, now);
  return 'continuable' in reply && reply.continuable === false ? `${text}\n${UNIDENTIFIED_LINE}` : text;
}

function describeReply(reply: DelegateReply | CollectReply, view: { agent: string; createdAt: string } | undefined, tools: { collect: string; cancel: string }, now: number): string {
  if (reply.kind === 'result') {
    const results = 'results' in reply && reply.results !== undefined ? reply.results : [reply.result];
    const sections = results.map((r, i) => (i === results.length - 1 && reply.openedTurn !== undefined ? `${formatResult(r)}\n${openedLine(reply.openedTurn)}` : formatResult(r)));
    return sections.join('\n\n');
  }
  if (reply.kind === 'results') {
    const sections = reply.results.map((r) => (r.openedTurn !== undefined ? `${formatResult(r.result)}\n${openedLine(r.openedTurn)}` : formatResult(r.result)));
    if (reply.then !== undefined) sections.push(describeReply(reply.then, view, tools, now));
    return sections.join('\n\n');
  }
  if (reply.kind === 'delivered') return `task: ${reply.taskId} · turn ${reply.turn} already reached you (${reply.status}); read it again with ${tools.collect === 'await' ? 'tasks' : tools.collect}`;
  const id = `task: ${reply.taskId}`;
  const lead = view !== undefined ? `${id} · ${view.agent}` : id;
  if (reply.kind === 'abandoned') return `${lead} · abandoned: its owner process died, so it has no result`;
  if (reply.kind === 'not_found') return `${id} · no such task`;
  const line = reply.kind === 'started' || reply.kind === 'running'
    ? formatStatusLine({ state: 'running', startedAt: reply.startedAt }, now)
    : reply.kind === 'queued'
      ? formatStatusLine({ state: 'queued', model: reply.model, ...(reply.place !== undefined ? { place: reply.place } : {}), enqueuedAt: reply.enqueuedAt }, now)
      : formatStatusLine(statusFacts({ ...(reply.startedAt !== undefined ? { startedAt: reply.startedAt } : {}), ...(reply.model !== undefined ? { model: reply.model } : {}), createdAt: reply.enqueuedAt }), now);
  if (reply.kind === 'started' || reply.kind === 'queued') return `${lead} · ${line}; collect it with ${tools.collect} or cancel it with ${tools.cancel}`;
  if (reply.kind === 'other_process') return `${lead} · ${line}; it belongs to another process, so it cannot be collected or cancelled here`;
  return `${lead} · ${line}`;
}

/** The one line a result carries when messages held for its turn opened another turn. */
function openedLine(turn: number): string {
  return `note: a message queued for this turn opened turn ${turn}; its result follows when it settles`;
}

/** What `continue` answers: the delivery outcome first, with the task id leading the line. */
export function describeContinueReply(
  reply: ContinueReply,
  tools: { collect: string; cancel: string },
  view?: { agent: string; createdAt: string },
  now = Date.now(),
): string {
  const lead = view !== undefined ? `task: ${reply.taskId} · ${view.agent}` : `task: ${reply.taskId}`;
  switch (reply.kind) {
    case 'not_delivered':
      return `${lead} · not delivered: ${reply.reason}${reply.status !== undefined ? `; ${reply.status}` : ''}`;
    case 'steered':
      return `${lead} · steered: your message joined turn ${reply.turn}, which is still running; its single result will include it (collect it with ${tools.collect})`;
    case 'queued':
      return `${lead} · queued: the child has not started turn ${reply.turn}, so your message is held and delivered right after its prompt (collect with ${tools.collect})`;
    case 'new_turn': {
      const replay = reply.replayed !== undefined ? `, after ${reply.replayed} earlier message${reply.replayed === 1 ? '' : 's'} that never reached the child` : '';
      const head = `${lead} · new turn: turn ${reply.turn} started from your message${replay}`;
      if (reply.status.kind === 'result') return `${head}\n${describeTaskReply(reply.status, view, tools, now)}`;
      return `${head}; ${describeTaskReply(reply.status, undefined, tools, now).replace(/^task: \S+ · /, '')}`;
    }
  }
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

export function describeEvent(event: DomainEvent): string {
  if (event.kind === 'tool_activity') return [event.kind, event.tool, event.path].filter(Boolean).join(' ');
  return event.kind;
}

function show(value: Measure, digits = 0): string {
  if (isUnavailable(value)) return 'unavailable';
  return digits > 0 ? value.toFixed(digits) : String(value);
}

export function formatUsage(usage: SessionUsage): string {
  return [
    `tokens ${show(usage.totalTokens)} (in ${show(usage.inputTokens)}, out ${show(usage.outputTokens)})`,
    `cost ${show(usage.cost, 4)}`,
    `context at settle ${show(usage.contextTokens)}/${show(usage.contextWindow)}`,
  ].join(' · ');
}

/** The task id comes first so it survives compaction of the parent's history. */
export function formatResult(result: Result): string {
  const head = [`task: ${result.taskId}`, ...(result.turn !== undefined ? [`turn ${result.turn}`] : []), result.agent, `status: ${result.status}`];
  if (result.failureKind !== undefined) head.push(`failure: ${result.failureKind}`);
  const lines = [head.join(' · ')];
  if (result.message !== undefined) lines.push(`message: ${result.message}`);
  if (result.heldNotDelivered !== undefined) {
    lines.push(`note: ${result.heldNotDelivered} follow-up message${result.heldNotDelivered === 1 ? '' : 's'} held for this turn did not reach the child`);
  }
  if (result.summary !== undefined) lines.push('summary:', result.summary === '' ? '(empty)' : result.summary);
  if (result.usage !== undefined) {
    const duration = result.durationMs !== undefined ? ` · duration ${Math.round(result.durationMs / 1000)}s` : '';
    lines.push(`usage: ${formatUsage(result.usage)}${duration}`);
  }
  return lines.join('\n');
}

/** What a reader knows of a task that has no result yet. */
export type StatusFacts =
  | { state: 'queued'; model?: string; place?: number; enqueuedAt: string }
  | { state: 'running'; startedAt: string };

/** A task with a start time is running; a task without one has not launched, whatever its stored status says. */
export function statusFacts(task: { startedAt?: string; model?: string; queuePlace?: number; createdAt: string; enqueuedAt?: string }): StatusFacts {
  if (task.startedAt !== undefined) return { state: 'running', startedAt: task.startedAt };
  return {
    state: 'queued',
    ...(task.model !== undefined ? { model: task.model } : {}),
    ...(task.queuePlace !== undefined ? { place: task.queuePlace } : {}),
    // The time waited counts from the enqueue time of the latest turn, which is the creation time for turn 1.
    enqueuedAt: task.enqueuedAt ?? task.createdAt,
  };
}

/** The status line of a task with no result: queued with its place and wait, or running with its start time. */
export function formatStatusLine(facts: StatusFacts, now = Date.now()): string {
  if (facts.state === 'running') {
    return `running, started ${facts.startedAt} (${formatElapsed(now - Date.parse(facts.startedAt))} ago)`;
  }
  const waiting = formatElapsed(now - Date.parse(facts.enqueuedAt));
  const model = facts.model ?? 'unknown';
  const where =
    facts.place !== undefined
      ? `place ${facts.place} in this session's queue, waiting ${waiting}`
      : `in another session's queue, waiting ${waiting}`;
  return `queued, not launched yet: no child is running; it starts when model ${model} has room (${where})`;
}

/** Put a notice on the line after the first one, so the task id still comes first. */
export function withNotice(text: string, notice: string | undefined): string {
  if (notice === undefined) return text;
  const newline = text.indexOf('\n');
  const line = `notice: ${notice}`;
  return newline < 0 ? `${text}\n${line}` : `${text.slice(0, newline)}\n${line}${text.slice(newline)}`;
}

/** The row of a listing: queued or running by its status line, anything else by its stored status. */
export function listingStatus(t: TaskListing, now = Date.now()): string {
  return t.status === 'running' ? formatStatusLine(statusFacts(t), now) : t.status;
}

export function completionNotice(taskId: string, status: string, live: TaskListing[], collectTool: string, turn?: number, now = Date.now()): string {
  const named = turn !== undefined && turn >= 2 ? `task ${taskId} turn ${turn}` : `task ${taskId}`;
  const lines = [`${named} ${status}; collect its result with ${collectTool}.`];
  if (live.length > 0) {
    lines.push('Still running:');
    for (const task of live) lines.push(`- ${task.taskId} · ${task.agent} · ${listingStatus(task, now)}`);
    lines.push('Wait for these tasks before using their results together.');
  }
  return lines.join('\n');
}

export function stopNotice(taskId: string): string {
  return `task ${taskId} was stopped; no action is needed.`;
}

/** What `init <model>` reports about the starter entries: one line each. */
export function formatStarterResult(result: StarterResult): string[] {
  if (result.added.length === 0) {
    return ['all three entries (the medium tier, the general agent and the fallback agent) are already there; nothing changed'];
  }
  const name = (entry: string) => (entry === 'medium' ? 'the medium tier' : `the ${entry} agent`);
  const lines = [`added ${result.added.map(name).join(', ')}`];
  if (result.present.length > 0) lines.push(`already there: ${result.present.map(name).join(', ')}`);
  return lines;
}
