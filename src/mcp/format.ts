// @sigil implements design/claude-mcp-server.sigil ClaudeMcpServer (tool result limit, await reply, listing)
//
// What is specific to the MCP tool replies: the tool result limit, the reply
// budget it leaves a child, the whole-or-deferred sections of an await reply and
// the listing cap. The wording of a task's state comes from the service.
import type { CollectReply, DelegateReply, TaskListing } from '../service/delegation-service.js';
import { describeTaskReply, listingStatus, withNotice } from '../service/status-text.js';

/**
 * Claude Code's inline limit for an MCP tool result: a longer text result is not
 * truncated but saved to a file in the session's tool-results folder, and Claude
 * is given its path (https://code.claude.com/docs/en/mcp, "MCP output limits and
 * warnings"). No reply is cut to it; an await reply defers the sections past it.
 */
export const TOOL_RESULT_LIMIT = 50_000;
/** Room kept in a reply for the result's header line, notice and usage line. */
export const REPLY_RESERVE = 2_000;
/** What a child is told its final reply should stay under, so its result fits inline. */
export const REPLY_BUDGET_CHARS = TOOL_RESULT_LIMIT - REPLY_RESERVE;
export const LISTING_CAP = 50;

/** One reply of delegate, tasks, await or cancel about one task, with the task id first. */
export function describeReply(reply: DelegateReply | CollectReply, view?: { agent: string; createdAt: string }, now = Date.now()): string {
  return withNotice(describeTaskReply(reply, view, { collect: 'await', cancel: 'cancel' }, now), 'notice' in reply ? reply.notice : undefined);
}

/** The one line of an await reply that stands for a result left out for the reply's size. */
function deferredLine(reply: Extract<CollectReply, { kind: 'result' }>): string {
  const { taskId, agent, status } = reply.result;
  return `task: ${taskId} · ${agent} · ${status} · result not shown here (reply size); read it whole with tasks(${taskId})`;
}

/**
 * An await reply: one section per task, in the order asked. A result is never cut.
 * Each result section is given whole while the joined reply stays within the limit,
 * and the first is always given whole, even alone over the limit, since Claude Code
 * then saves the reply to a file and loses nothing. A later result that does not
 * fit is deferred to one line that points to tasks(<id>). A task with no result
 * keeps its status line.
 */
export function formatAwait(replies: CollectReply[], limit = TOOL_RESULT_LIMIT, now = Date.now()): string {
  return formatAwaitWithShown(replies, limit, now).body;
}

/** The complete result sections actually included in an await response. */
export function formatAwaitWithShown(replies: CollectReply[], limit = TOOL_RESULT_LIMIT, now = Date.now()): { body: string; shown: string[] } {
  const sections: string[] = [];
  const shown: string[] = [];
  let length = 0;
  for (const reply of replies) {
    const whole = describeReply(reply, undefined, now);
    const joined = length + (sections.length > 0 ? 2 : 0) + whole.length;
    const section = reply.kind === 'result' && sections.length > 0 && joined > limit ? deferredLine(reply) : whole;
    if (reply.kind === 'result' && section === whole) shown.push(reply.result.taskId);
    length += (sections.length > 0 ? 2 : 0) + section.length;
    sections.push(section);
  }
  return { body: sections.join('\n\n'), shown };
}

/**
 * At most 50 tasks: those with a start time and no result first, then each queued
 * task, then the rest, newest first, with a closing notice.
 */
export function formatListing(tasks: TaskListing[], conversationKnown: boolean, now = Date.now()): string {
  const rank = (t: TaskListing) => (t.status !== 'running' ? 2 : t.startedAt !== undefined ? 0 : 1);
  const ordered = [...tasks].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    // Queued tasks keep their order of arrival; the others read newest first.
    return rank(a) === 1 ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt);
  });
  const shown = ordered.slice(0, LISTING_CAP);
  const left = ordered.length - shown.length;
  const lines: string[] = [];
  if (!conversationKnown) lines.push('subzero could not identify this conversation, so this lists every task.');
  if (shown.length === 0) lines.push('no tasks');
  for (const t of shown) lines.push(`${t.taskId} · ${t.agent} · ${listingStatus(t, now)} · created ${t.createdAt}`);
  lines.push(`${left} ${left === 1 ? 'task was' : 'tasks were'} left out; any task can still be read by its task id with tasks(task).`);
  return lines.join('\n');
}
