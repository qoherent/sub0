<!-- @sigil implements design/spike-harness.sigil SpikeHarness (spike results document) -->
# subzero spike: results

This document holds the measurements of the spike and the decision on whether to
build subzero v0.2. Plan: [docs/plans/2026-11-02-1109-feat-subzero-spike-plan.md](plans/2026-11-02-1109-feat-subzero-spike-plan.md).
Harness: [bench/README.md](../bench/README.md).

## Measurements

One row per pass. Four failed passes were dropped, their evidence kept under
`~/.subzero-bench`: a B pass that hit the earlier 120-minute limit, two A passes
whose evaluator did not wait for its background interpreters, and an A-cheap pass
whose evaluator was denied `sigilc` by its absolute path and stopped. The harness
since fixes the last three. The harness scores each planted
problem from a `sigilc check` it runs itself on the pass, so a score reflects what
the interpreters read. "N/A" means the problem's anchor Facets were not read in
that pass. "unscored" means the check did not validate. A measure that could not
be taken is shown as unavailable with its reason, never as zero. No threshold
applies.

The planned comparison is three matched passes each of A and B, plus one pass
each of B-low, A-cheap and B-control, all on the same design revision with the
same Claude model and effort (`deno task run matrix` in `bench/`).

<!-- spike-table:start -->

Design revision `52ebee356c4c2efb93cec157ca609ba9caabc83219481875d494ebc951fb4fa9`; Claude model and effort claude-sonnet-5-5 / high.

| Pass | Arm | Status | `booking-pending-range-contradiction` | `booking-rooms-archived-mark-ownership` | `calendar-display-name-unmet-obligation` | `calendar-owner-digest-unreached-step` | Extra findings | Ingest state | Re-asks | Unread units | Main tokens | Evaluator tokens | Interpreter tokens | Wall time | Interpreter context at settle | Thinking (launch spec) | Stray writes | Notes |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | ---: | ---: | --- | --- | --- | ---: | --- | --- | --- | --- |
| 2026-11-04T09-07-17-899Z-B-low | B-low | completed | N/A | N/A | found | found | 96 | disjoint | 7 | 80 | 64,934 (in 4, cache 0+64,911, out 19) | 2,299,958 (in 78, cache 1,453,274+821,827, out 24,779) | 3,808,800 (in 3,616,177, cache 0+0, out 192,623) | 7844 s | max 67,331 of 14 | low | none | handed back disjoint; Claude models seen: claude-sonnet-5-5; interpreter models seen: Qwen3.8 |
| 2026-11-04T12-59-56-526Z-B | B | completed | found | found | found | found | 100 | disjoint | 3 | 0 | 65,011 (in 4, cache 0+64,988, out 19) | 2,499,659 (in 82, cache 1,973,628+505,304, out 20,645) | 2,797,740 (in 2,469,852, cache 0+0, out 327,888) | 8602 s | max 105,684 of 10 (1 unavailable) | high | none | handed back disjoint; Claude models seen: claude-sonnet-5-5; interpreter models seen: Qwen3.8 |
| 2026-11-04T15-26-11-231Z-B | B | completed | N/A | N/A | found | found | 48 | disjoint | 5 | 84 | 65,217 (in 4, cache 24,370+40,823, out 20) | 2,543,449 (in 84, cache 1,721,231+796,803, out 25,331) | unavailable (task sz-4r67qr reported no session usage) | 10335 s | max 89,044 of 12 (1 unavailable) | unavailable (task sz-4r67qr recorded no launch spec), high | none | handed back disjoint; writes unchecked: sz-4r67qr: no pi session found for task sz-4r67qr; Claude models seen: claude-sonnet-5-5; interpreter models seen: Qwen3.8 |
| 2026-11-04T18-18-26-612Z-A | A | completed | found | found | found | found | 50 | disjoint | 1 | 0 | 64,170 (in 4, cache 54,542+9,602, out 22) | 1,184,962 (in 42, cache 1,095,074+74,879, out 14,967) | 871,290 (in 50, cache 444,995+364,892, out 61,353) | 267 s | max 84,619 of 8 | — | none | handed back disjoint; Claude models seen: claude-sonnet-5-5; interpreter models seen: claude-sonnet-5-5 |
| 2026-11-04T18-22-53-983Z-B | B | completed | found | found | found | found | 120 | disjoint | 7 | 9 | 66,455 (in 4, cache 24,370+41,239, out 842) | 3,578,105 (in 98, cache 2,210,718+1,336,513, out 30,776) | 2,867,320 (in 2,493,537, cache 0+0, out 373,783) | 12262 s | max 90,492 of 14 | high | none | handed back disjoint; Claude models seen: claude-sonnet-5-5; interpreter models seen: Qwen3.8 |
| 2026-11-04T21-49-24-397Z-A-cheap | A-cheap | completed | found | found | found | missed | 50 | disjoint | 7 | 0 | 64,781 (in 4, cache 54,472+9,464, out 841) | 1,562,653 (in 46, cache 1,452,327+84,470, out 25,810) | 3,460,302 (in 804, cache 2,416,871+777,635, out 264,992) | 957 s | max 77,369 of 14 | — | none | handed back disjoint; Claude models seen: claude-sonnet-5-5; interpreter models seen: claude-haiku-4-5-20251001 |

| Arm | Passes (completed) | `booking-pending-range-contradiction` | `booking-rooms-archived-mark-ownership` | `calendar-display-name-unmet-obligation` | `calendar-owner-digest-unreached-step` |
| --- | --- | --- | --- | --- | --- |
| A | 1 (1) | 1/1 | 1/1 | 1/1 | 1/1 |
| A-cheap | 1 (1) | 1/1 | 1/1 | 1/1 | 0/1 |
| B | 3 (3) | 2/2 (1 N/A) | 2/2 (1 N/A) | 3/3 | 3/3 |
| B-low | 1 (1) | 0/0 (1 N/A) | 0/0 (1 N/A) | 1/1 | 1/1 |

<!-- spike-table:end -->

### Review quality (manual)

For each pass, which planted problems the evaluator's final report names, following
sigil's claims review fixture (`sigil:skills/sigil-evaluate/evals/claims-review-fixture.md`).

| Pass | Planted problems named in the evaluator's report | Notes |
| --- | --- | --- |

## Plumbing checks

Each delegation requirement of the plan, with where its evidence lives. "Test"
evidence runs against the scripted fake pi in `npm test`; "live" evidence needs a
real run and is filled in when it happens.

| Req | What it requires | Evidence | Status |
| --- | --- | --- | --- |
| R1 | One result per call, task id first. The plan's 2000-token summary limit was replaced by decision 24: the summary is the child's whole final message, never cut, and the brief gives a 48,000-character reply budget | `test/core/task-core.test.ts`, `test/mcp/server.test.ts` | tests pass; live: whole results in the six-batch probe after decision 24 (below) |
| R2 | Exactly the declared skills; a missing folder or a difference fails as `skill_mismatch` before the brief | `test/pi/driver.test.ts` (skill verification cases); live pi 0.87 `get_commands` check | tests pass; live verification passed on a smoke agent |
| R3 | Declared model and thinking level, user's pi login, no extensions, context files, templates or other skills | `test/pi/launch.test.ts`; launch spec in each task record; the table's thinking column | tests pass; live: pending |
| R4 | Typed failures, cancel with no failure kind, no pi process outlives Esc, timeout or session end | `test/pi/driver.test.ts`, `test/mcp/server.test.ts` (stdin close), `test/service/delegation-service.test.ts` (shutdown) | tests pass; live orphan check: pending |
| R5 | Progress at least every 60 s; `wait: false` plus `await` | `test/mcp/progress.test.ts`, `test/mcp/server.test.ts` | tests pass; live: pending |
| R6 | Per-endpoint parallel limit, first come first served, per process only | `test/service/delegation-service.test.ts` | tests pass |
| R7 | Durable task records, `tasks` capped at 50, abandoned tasks, `attach`, `show` | `test/store/task-store.test.ts`, `test/cli/cli.test.ts`, `test/mcp/server.test.ts` | tests pass; live attach: pending |
| R8 | No snapshots, no write gating, no changed-file list | `test/core/task-core.test.ts`; `examples/sigil/README.md` | tests pass |
| R9 | In B every interpreter goes through `delegate` and none through the Agent tool; the main conversation loads no sigil skill | Table: interpreter runs via subzero / Agent tool, main conversation clean | pending (U8) |
| R10 | Each interpreter writes its claim rows to the exact answer file its brief names | Table: stray writes; the ingest state | pending (U8) |

## Tiered subagent routing: acceptance run (R17)

Plan: [docs/plans/2026-11-06-0953-feat-tiered-subagent-routing-plan.md](plans/2026-11-06-0953-feat-tiered-subagent-routing-plan.md), unit U6. Run on 2026-11-10 from a copy made by `examples/demo/demo.sh setup` (git repo: an empty baseline commit, then `src/`), headless with `claude -p "/ce-code-review base:c00afd7 depth:full"`, Claude Code 2.1.318 (model claude-opus-5-5), the subzero plugin at commit 90b8f24 and compound-engineering 3.26.3. The review ran 53 turns in 13.7 minutes. Its transcript is the stream-json file `r17/transcript.jsonl` in the session scratchpad, not kept in the repository.

**Deviation from the plan.** The `r9700` endpoint was down, so the tiers (`default` and `medium`, thinking low and medium) ran on a llama.cpp server at `http://<lan-address>:8080/v1` through a second pi provider, `local`, serving `qwen3.6-35b-a3b-reggie`, with the endpoint named `local` (`parallel: 1`). The task records therefore show `local/qwen3.6-35b-a3b-reggie`, not `r9700/Qwen3.8`. The demo files in the repository still name `r9700`; only the demo copy was edited.

| Success criterion | Result | Evidence |
|---|---|---|
| Every CE dispatch for a configured tier appears as a subzero task with that tier's model | Met, for one dispatch | CE selected one mid-tier reviewer, `testing`. `delegate` was called with `tier: "medium"` and `wait: false`, then `await` with `timeout_s: 600`. Task `sz-iziigu` records agent `general:medium` and a launch with `--model local/qwen3.6-35b-a3b-reggie --thinking medium --tools read,bash,edit,write,grep,find,ls`. Its `startedAt` is set, and its `parentSessionId` is the session's id from the per-session file. |
| Every CE dispatch for an unconfigured tier ran natively | Met | `correctness`, `security` and `adversarial` (session tier) went to the Agent tool, as did the merge leaf, the validator and the report leaf. No `large` or `small` tier is configured, and the hook denied none of them. |
| No Agent call was allowed with a prompt the hook had denied earlier, except a pass-back | Met, vacuously | The hook denied no spawn in the review, because Claude followed the SessionStart text and called `delegate` itself. There were no pass-backs. |
| CE's final report lists no failed reviewer and has findings from every selected reviewer | Met | Reviewers: correctness, security, testing, adversarial. The report lists 13 primary findings; the validator confirmed 8 of 8 in its batch and the testing reviewer's findings are among them. Coverage lists no failed reviewer. |

**Probe of the PreToolUse hook.** Because the review never needed a denial, a second headless run asked Claude for one generic Agent spawn with `model: "sonnet"` and the description `probe hook`. The hook denied it with the instruction to call `delegate` with `tier: "medium"`, the prompt unchanged as `brief` and `wait: false`; Claude did so, and task `sz-wksvtm` (`general:medium`) completed in 6 seconds with the reply `ok`. This confirms in Claude Code 2.1.318 that the hook fires on the Agent tool, that the readiness marker and the ancestor-process check work in a real process tree, and that a denial reaches Claude as a routing instruction. The hook input's `description` field (the pass-back marker) was not exercised, because no pass-back was needed.

**Further probes (2026-11-10, same demo copy, same plugin build).** Each is a short headless run (`claude -p`) that forces one scenario the review did not reach.

| Scenario | Result | Evidence |
|---|---|---|
| AE4, a batch larger than the endpoint | Pass | Four parallel generic `sonnet` Agent spawns were all denied, and Claude sent them as four `delegate(tier: "medium", wait: false)` calls. The replies were `running, started <iso>` for the first and `queued, not launched yet ... (place n in this session's queue)` for the rest. One `await` collected all four, completed. Two queued tasks both showed place 1 because the first task finished (about a second) between dispatches. |
| AE8, alias switch after a deny | Pass | The same prompt retried with `haiku` and then with no model was denied both times, with the same instruction (`tier: "medium"`). |
| AE12 and a tier on a host with no driver | Pass | A `small` tier on host `claude` was added to the demo copy (and removed afterwards). The hook denied a `haiku` spawn toward `small`; `delegate` returned a tool error that names the tier, the host, the supported hosts (`pi`) and the configured tiers, and made no task; Claude passed the prompt back with a `passback` description and the hook let it through. This also shows the hook receives the Agent `description` field, so the plan's stop condition does not apply. The probe's first description already began with `passback`, and the hook still denied it, which matches the rule that a pass-back of a never-denied prompt is routed like any other spawn. |
| Subzero server command broken | Pass | In a copy of the plugin whose `.mcp.json` points at a missing file, the MCP server reported `failed`, a `sonnet` spawn was allowed, ran on Claude and replied. The SessionStart text still said routing was on, because that hook cannot know the server will fail; nothing was denied, so nothing was stranded. |
| `/compact` | Pass | A resumed session was compacted (34,914 to 4,802 tokens; SessionStart fired around it), and the next generic spawn was still denied and routed to `general:medium`. |

**Last three gaps (2026-11-10).** A copy of the plugin whose PreToolUse command also logged its stdin captured the real hook input; the sweep and the six-batch probes ran against the real plugin data folder.

| Scenario | Result | Evidence |
|---|---|---|
| Real hook input, `isolation` and `fork` | Pass | The hook input carries `session_id`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name: "Agent"` and `tool_input` with `description`, `prompt`, `model`, `run_in_background` and, when asked, `isolation: "worktree"` or `subagent_type: "fork"`, exactly the shapes the hook assumes. A worktree-isolated spawn and a fork spawn were both allowed and ran on Claude; the next generic `sonnet` spawn in the same session was denied and ran as `general:medium`. |
| Deny-memory sweep, live | Pass | Before the run, the session's own deny folder and another session's folder were both aged to 9 days. After one denial the other session's folder was gone, and the session's own folder was kept, now holding its new entry. |
| Six-reviewer batch against `parallel: 1` | Pass on queueing | Six parallel `sonnet` spawns were denied by six concurrent hook processes, and `delegate` returned one `running` and five `queued` at places 1 to 5. One `await` collected all six. |
| `await` result share with realistic sizes | Finding | Each child returned about 3 KB (30 lines of 90+ characters). `await` returned 11,998 characters with a cut marker on all six sections, each cut to about 2,000 characters, as KTD11 specifies. Claude followed the pointer and read a full result with `tasks`. A CE batch of six or more reviewers whose compact returns exceed about 2,000 characters would be cut the same way, so the code review's adversarial finding on this (a share fixed by task count, not by size) is now measured, not just argued. |

**After decision 24 (whole results).** The same six-batch probe, rerun on the build that never cuts a result: the one `await` reply was 33,299 characters and showed all six results whole, 30 lines each, with no cut marker and no deferred task. Each brief ended with the reply-size section (`Keep your final reply under 48,000 characters`).

**Not covered**
- A CE run that selects six reviewers; the batch probe used plain generic spawns.
- Concurrent hook processes were exercised live by the four-spawn and six-spawn probes; their unit test remains.
- A worktree-isolated CE reviewer (mutation testing) was not run; the isolated spawn was a plain probe.
- The hook input carries `permission_mode`, which the hook does not read. A generic spawn made in plan mode is therefore still redirected to a child that has bash, write and edit.
- CE tried to start its cross-model peer review (a Codex command). The non-interactive session had no permission to run it, so it was denied, nothing was sent, and the adversarial lens ran in-process.

## Decision

_Written by the user, citing the table above: build subzero v0.2 or not, and why._

## Parent adapter platform probe (2026-11-12)

On pi 1.5.2, `pi.sendMessage` with `{ triggerTurn: true, deliverAs: "steer" }`
starts a turn when idle and steers a running turn, according to the installed
extension documentation. A temporary extension sent that message to an idle
RPC session, and the local model ran to `agent_settled`. The same documentation
says `agent_settled.aborted` identifies an aborted turn, including Escape; the
interactive Escape check remains part of the live verification.

On Claude Code 2.1.322, temporary local MCP servers advertised optional task
support to both an interactive session and `claude -p`. Each session called the
test tool without the MCP task parameter. These observations do not establish
that every Claude configuration behaves the same way. SDK 1.32.2 implements
the low-level task protocol, but these calls do not demonstrate that the client
will select it. No reliable environment flag distinguishing the two modes was
established.

A follow-up process probe launched Claude Code 2.1.322 in a terminal: `ps`
reported its process with a `ttys...` terminal and command `claude`. The
earlier `claude -p` server probe reported no controlling terminal and a
command containing `-p`. The server therefore treats a parent without a
terminal, one with a print flag, or one it cannot inspect as non-interactive.
This is deliberately conservative: an IDE or SDK client without a controlling
terminal also waits, even if a human is interacting with it.

On 2026-11-13, a clean Debian Bookworm arm64 container with Node 22, `flock`
and `procps` built the committed tree and passed 68 routing, deny-lock and
wake-marker tests. The minimal Node image did not include `ps` until `procps`
was installed. A second pass including the simplified server and parent-mode
check passed 74 MCP, routing, deny-lock and wake-marker tests.

A separate interactive probe registered an `asyncRewake` Stop hook. After the
first assistant turn ended, the hook exited with code 2 and feedback; Claude
started another turn without a user prompt, and the second Stop hook ran. This
confirms the hook wake mechanism for the fallback. The probe used only temporary
files and did not install a hook in the project.

The two-parent acceptance run in the pi parent plan is still pending. A person
must check a real compound-engineering review and local child on pi, including
notices, Escape, `/subzero cancel`, `/new`, and the shell task listing. On Claude
Code, the remaining checks cover background delivery, Escape during `await`,
stopping one task, the 120-second boundary, `/subzero:cancel`, and `/clear`.
The 2.1.322 probe above did not select MCP tasks, so it does not establish that
delegations appear as MCP tasks in Claude's `/tasks` view.
