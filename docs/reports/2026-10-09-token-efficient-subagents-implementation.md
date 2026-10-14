# Token-efficient subagents: implementation and acceptance record

Date: 2026-10-09. Starting revision: `dce84c1`. Working branch: `feat/token-efficient-subagents`.

The user authorized implementation and testing after an architecture review (its plan and review documents have since been retired from this checkout), using Luna subagents with explicit success contracts. The earlier documentation edits belong to the same task and are preserved. This record contains the acceptance contract and coordinator-observed results. All first-delivery acceptance requirements C1–C12 are covered by the checks below; the final review follow-up is closed.

## Scope

Implement the plan's first delivery: durable run lookup, bounded `subzero_run`, run-specific `subzero_get`, separation of text from orchestration events, safe active-request MCP progress, and coordinated public documentation/contracts. Preserve existing workspace, credential, worker ownership, stop, queue, artifact, and recovery guarantees.

Automatic Pi wakeup, detached execution, dispatch retries, new task stores, MCP Tasks adoption, dependency upgrades, commits, and publication are outside this delivery.

## Subagent acceptance contract

Each worker receives one bounded assignment and an exclusive file scope. It must return changed paths, the tests it inspected, actual commands with exit codes and evidence-log paths, any observed pre-fix failure, and remaining limitations. Commands not run must be labeled unrun. Passing a smaller test is not evidence that a larger gate passed.

Behavioral tests must assert returned results, persisted state, or wire/host effects. A child saying it succeeded, a ready state, process exit, or an agent's summary is insufficient. A delegated coding task succeeds only when the requested effect exists and its acceptance checks pass. The coordinator reviews the actual diff and independently runs the integrated gate before accepting the work.

Workers must not commit, stage, reset, install dependencies, expose credentials, edit another unit's files, weaken assertions to gain a pass, or claim live behavior from mocks. A blocked or failing check must be reported with its evidence.

## Acceptance requirements

| ID | Required behavior | Acceptance evidence |
| --- | --- | --- |
| C1 | Query the exact `(childId, runId)` and validate ownership/workspace. | Unknown, mismatched, cross-workspace and previous-run tests. |
| C2 | Wait through text/tool activity, queued/running/stop-requested states; return on that run's settlement or deadline. | Timing-controlled tests including concurrent waiters and immediate successor runs. |
| C3 | Persist results independently of event retention and child latest result. | Event-prune and store-reopen tests. |
| C4 | `run` returns accepted identity by its bounded deadline even during worker initialization. | Controlled slow-start test, deadline snapshot, and no duplicate dispatch. |
| C5 | Request cancellation cleans up observation without stopping accepted work. An explicit stop can cancel locally owned pending initialization before execution; broker shutdown retains late-worker cleanup responsibility. | Active-observation abort, pending-initialization stop, late worker, stop/open race and shutdown regressions. |
| C6 | No new per-token event rows; transcripts/artifacts preserve output and historical cursors remain valid. | Store/event assertions plus artifact and redaction regression coverage. |
| C7 | Compact run responses contain only that run's status/result/error and wait-expiry metadata. | MCP schema/response tests with failure, stop and interruption outcomes. |
| C8 | Progress is client-requested, redacted, bounded, throttled and limited to an active request. | Progress opt-in/out, cancellation, slow consumer and secret-safety tests. |
| C9 | Public operations, schemas, version declarations, fixtures and instructions agree. | Contract, packaging, discovery and documentation checks. |
| C10 | Pinned Pi host displays progress without intermediate progress/text in parent model context. | Real Pi host with controlled provider; exact transcript and event assertions. |
| C11 | Parent tool-call count follows wait windows, not child activity volume. | Controlled short/long and low/high activity comparison; no invented token percentage. |
| C12 | Final integrated checkout preserves all existing behavior under the full local gate. | Coordinator-run `npm run verify`, with exact exit and counts. |

Opt-in real-provider qualification uses the existing LongCat configuration and requires the requested file effect, an explicit completed run, a nonempty matching artifact, and sanitized diagnostics. Provider failure is recorded as a failed/unverified live gate; it is never relabeled success because the child became ready.

## Verification results

| Gate | Coordinator-observed result |
| --- | --- |
| Starting checkout | `npm run verify`: exit 0; 128/128 tests before production changes. |
| Integrated implementation | `npm run verify`: exit 0; 150/150 tests, zero failures, cancellations, or skips after the review follow-up; build and typecheck passed on Node v26.3.1/Linux. |
| Controlled Pi host | Pinned Pi 1.0.4 made exactly two parent provider requests and one `subzero_run` tool round trip while the child made 12 provider requests. The test verifies actual UI progress text is absent from parent model messages, one compact final result, exact file bytes, and matching persisted run/artifact. |
| Interrupted MCP outcome | A real resumed worker is killed after an earlier successful run. The MCP response identifies the interrupted run, reports `worker_eof`, validates against the full response schema, and contains neither the old artifact nor events. |
| Actual-code benchmark | Coordinator command exited 0; all eight baseline/candidate cases and bounded-call, stored-result, and text-row assertions passed. See the metrics below. |
| Real LongCat | Final coordinator `SUBZERO_TEST_KEEP_ARTIFACTS=1 npm run test:live` exited 0. Exact file, completed run, matching result/artifact, ownership release, and secret scans passed. |
| Retained live artifacts | Coordinator independently reread the exact file, completed SQLite run, 128-byte artifact, released ownership, and zero text-event rows. |
| Workspace regression | Owning-workspace exact-run read succeeds; the foreign workspace receives `not_found` without artifact leakage, run mutation, or a provider request. Included in the final 150-test gate. |
| Whitespace and links | `git diff --check` passed; all 38 local links across 13 changed Markdown documents resolved. |
| Dependency boundary | Lockfile comparison found zero changed external dependency entries. |

Live run: `6a2ecdf2-5447-4765-a788-50329c418884`; child: `e7da6ed1-1bfb-4d7c-b6ff-f950a84ca0bb`; artifact: `4252dce2dacc9655f85f28158c471e498be443e816290b6d2ca0d4c1503fa581`. The requested file contained exactly `subzero-live-ok`. The earlier subagent live check also passed; the final coordinator run exercised the strengthened harness and final production source.

Machine-local logs are under `/tmp/subzero-implementation-evidence/`; the final live fixture is `/tmp/subzero-pi-live-wktFdi`. These temporary files are not permanent dependencies. The checks and reproducible benchmark are retained in the repository, and measured benchmark data is saved beside this report.

## Measured core API comparison

The [benchmark data](2026-10-09-token-efficient-subagents-benchmark.json) records source SHA-256 hashes. The [script](../../packages/pi/test/observation-benchmark.mjs) loads the exact core source from `dce84c1` and the candidate source. Both run against the same controlled worker/store fixtures, event schedule, preview limits, and observation windows. Responses are returned by those implementations, not constructed by a simulator.

| Duration / wait / activity units | Baseline calls | Candidate calls | Baseline response bytes | Candidate response bytes |
| --- | ---: | ---: | ---: | ---: |
| 60 ms / 200 ms / 4 | 7 | 1 | 3,069 | 188 |
| 60 ms / 200 ms / 40 | 43 | 1 | 22,581 | 188 |
| 240 ms / 80 ms / 4 | 7 | 3 | 3,069 | 338 |
| 240 ms / 80 ms / 40 | 43 | 3 | 22,581 | 338 |

Each activity unit emits text and a tool milestone. Baseline stored 5 or 41 text rows, including its buffered flush; the candidate stored zero. These are synthetic core/controller calls and serialized response bytes, including dispatch responses. They are not MCP transport-byte totals, measured LLM token savings, billing estimates, or production latency measurements. Provider token/cache savings remain unmeasured.

Reproduce after installing the repository's existing pinned dependencies:

```sh
npm run verify
node --experimental-strip-types packages/pi/test/observation-benchmark.mjs
SUBZERO_TEST_KEEP_ARTIFACTS=1 npm run test:live
```

The live command is opt-in and uses the configured provider credential. The benchmark requires the baseline git object and fails rather than substituting an imitation if that object is unavailable.

## Acceptance corrections and review

The coordinator rejected early success evidence when it did not prove the named behavior. Corrections included queueing the successor before settlement, aborting an active observer, explicit stop during initialization, and shutdown preventing a late worker from executing. The shutdown defect had an observed red test before the fix. The large-response regression retained its size/parseability checks using valid tool milestones instead of removed text rows.

MCP review corrected immediate-read defaults, replaced invented progress percentages with an emission counter, bounded pre-admission preparation, limited progress transport concurrency, and validated responses against the complete canonical schema. The first benchmark imitated response shapes; it was rejected and replaced by actual baseline/candidate execution. Its numbers are not used here.

Three Luna simplification reviews led to one reuse change and two clarity changes: direct credential awaiting, removal of unused duplicate run identity, and an explicit progress-message switch. The suggested historical-event replay optimization was skipped because it would change observable progress/recheck ordering and require a separate cursor design; no safety check was removed.

Final `ce-code-review` completed with nine Luna reviewer outcomes and one confirmed finding, #1: missing regression coverage for run-specific cross-workspace reads. The coordinator added an owning-workspace positive control, a foreign exact-run rejection, no artifact leakage, and unchanged owner-visible run assertions. The subsequent full gate passed 150/150; finding #1 is closed and no actionable findings remain. Review run: `20261009-124153-2c1db31f`. The original review receipt records the pre-fix finding; this record captures its resolution.

All review subagents were requested as Luna; no external cross-model peer was used. The formal review excludes untracked files under its scope rules; the coordinator separately inspected and executed the new benchmark and checked the conformance fixtures. Progress/context-isolation evidence comes from the controlled-provider Pi host test. The real LongCat check establishes actual file/run/artifact completion; it does not measure provider token savings or independently capture progress rendering.

## Remaining scope and delivery

Automatic Pi wakeup remains deferred as agreed. No detached worker service, task store, retry mechanism, or external dependency upgrade was introduced. Only Subzero workspace package/protocol versions changed; the existing template schema and MCP SDK/protocol negotiation remain unchanged.

Operational docs and `AGENTS.md` now describe the available tools and require explicit delegation acceptance checks. Historical v0.1 verification and design records remain labeled as historical. Changes are local and uncommitted on `feat/token-efficient-subagents`.
