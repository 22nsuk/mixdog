# Delegation observations

The context dialog (`/context`) contains a read-only **Delegation activity**
section. Assisted (`focused` / 보조), Collaborative (`balanced` / 분담), and
Swarm use the same job lifecycle and the same measurements. Their delegation
policies, role definitions, permissions and cancellation authority are unchanged.
Goal scheduling, budgets, automatic model escalation and efficiency scoring are
not part of this feature.

## What a row means

One row is an existing `agent` background job: a fresh `spawn`, or a `send` to an
idle/reused worker. The immutable mode is copied from the **calling session at
request time**, never from model arguments or the currently selected setting.
Unstamped/unknown modes remain unknown. Rows retain task ID, worker tag, agent,
route and operation; task IDs, not reused tags/session IDs, identify observations.

The clocks are monotonic and local to the executing host:

- **Admission wait:** request creation to resource admission (or cancellation /
  failure while still waiting).
- **Preparation:** admission to entry into the prepared worker's turn, or the
  end of failed preparation. Not a model/provider latency measurement.
- **Execution:** entry into the turn to the first reported outcome. This can
  include session locking, compaction and provider/tool work.
- **Time to first outcome:** request creation to that outcome; durations are **not
  summed across parallel workers** as an elapsed-time or speedup estimate.

The first outcome is frozen before completion notification / subsequent storage
settlement. A late provider result cannot relabel a cancellation. Cancellation
time is the **request/report boundary**, not proof that every process or provider
has already stopped. Watchdog partial handoffs remain a distinct `partial`
observation even though the existing task contract delivers them as `completed`.
Neither completed status nor a nonempty result proves validated correctness.
A follow-up request does not, by itself, mean a retry or rework.

## Usage and coverage limits

Input/output tokens and tool calls are copied only from the raw **returned
terminal turn** before handoff rendering removes them. These values are not a
worker's cumulative session counters. A second job using the same worker cannot
repeat the first job's usage. Missing, invalid or nonfinite counters remain
`null` / `—`; a measured zero remains zero. Provider input-token conventions
may differ. These counters are not monetary costs or a total-job bill.

The loop carries per-counter completeness alongside its existing numeric
subtotals. If any contributing call omits or reports an invalid input/output
count, that counter remains unmeasured even after a later measured call. The
legacy numeric accounting is unchanged; observations never infer measurement
from a normalized zero. Built-in adapters mark completeness at their wire
boundary, before defaults/coercion lose field presence: OpenAI-compatible Chat
Completions/Responses (HTTP and WebSocket), Anthropic (SSE and non-streaming
fallback), Gemini/Antigravity, and Cursor. Final Anthropic API-key results retain
these flags; OpenCode Go's inclusive input also requires measured cache
components. Stream revisions preserve earlier measurements on omitted/null
fields and replace them on explicit zero; Cursor requires a valid token delta
and never repairs a malformed delta with a later one.
Cursor also retains an explicitly measured zero on stream failure; absent or
malformed deltas do not acquire fabricated measurement evidence.

Gemini output includes candidate and thought tokens. Missing components remain
unknown unless the reported total exactly reconciles the known prompt, output
and tool-use prompt components. Its legacy derived input is only certified when
all output components and an explicit zero tool-use prompt count prove the
subtraction. These checks change only measurement evidence, not token subtotals,
costs, ledger records or provider retries. No historical zero is backfilled;
custom adapters that already discarded presence information must supply the
completeness flags themselves. Provider-internal omissions before the wire
response remain unknowable.

A busy `send` still follows its existing queue path: it does not create another
background job and therefore is **not another sample** here. The in-process
manager may drain multiple queued turns but return only the final turn's usage;
the canonical session service returns its settled turn. Earlier queued turns,
unreported retries/failures, usage outside the returned turn, descendants and
hidden maintenance agents are not independently added into these values.
Fresh-context compaction performed inside the turn is already folded into the
loop's returned usage and **remains included**; these counters are not limited
to the worker's final provider request. Separate compaction outside that return
value is not added. No whole-job usage,
acceptance rate, retry rate or quality score is inferred from incomplete evidence.
Use the existing usage ledger/statistics for its independently defined accounting.

An unrecovered exception has no returned terminal-turn aggregate. Its
`error.partialUsage` describes one provider request, not necessarily the earlier
calls in the turn, so it cannot establish whole-turn coverage even when both
of that request's counters are complete. The same applies to a watchdog handoff
assembled from partial text without a terminal-turn usage aggregate.
Such failures and handoffs keep `—` and count in
the retained denominator only. A recovered partial response that the existing
loop folds into a returned result follows the normal completeness rules. A
failed terminal result with actual returned usage can still be measured. These
distinctions preserve the existing numeric/cost accounting and do not infer
full failed-turn usage from a last request's subtotal.

This is a bounded, **host-local recent observation view**, not durable history or
a cross-session analytics database. It reuses the background task registry:
terminal rows expire after 30 minutes; the shared 300-task capacity and explicit
cleanup can remove rows sooner. Restart clears the registry. Active jobs are
not expired by the terminal TTL. The UI pages 25 observations at a time.
An empty snapshot is not proof that no delegation ever happened. Old hosts,
legacy jobs, missing mode stamps and missing usage do not get fabricated values.
The context dialog holds its opening snapshot; close and reopen it for a new
reading. This section does not turn it into a live monitor.

The coverage summary counts **all retained jobs in the current caller's
snapshot**, before the 25-row page limit. Duplicate task IDs count once. Legacy
or unsupported observations count in the retained denominator but cannot
contribute measured input/output; explicitly foreign callers are excluded from
both counts. Input and output are counted independently from valid observed
counters, including explicit zero and measured failed/cancelled/partial jobs.
Unmeasured or still-running jobs remain in the denominator; there is no
completed-only selection. Thus `5 / 31` means five of 31 retained jobs have a
measured counter, not five tokens, five successful jobs or historical coverage.
Unavailable snapshots show `—`; an available empty snapshot shows zero jobs and
`0 / 0` for both counters. Paging does not change the summary.

The UI labels returned-turn input/output and time to **first** outcome explicitly.
Its scope notice distinguishes admission wait from busy-worker queues or Lead
waiting, and first report from whole-task completion. Whole-task aggregation,
revision-linked validation, explicit rework tracking and evidence-based
recommendations are follow-up work; this PR does not infer them from job status,
follow-up requests or retained sample counts. It adds no ranking or efficiency
score and does not extend retention to simulate a historical baseline.

## Ownership and compatibility

No new read/write endpoint, permission, file store or telemetry service is added.
The existing session-scoped `agentJobs` projection carries the versioned optional
`delegation` object. The read model additionally matches its recorded caller to
the displayed session. It does not recursively expand a parent's authorization
to other sessions. A child that itself delegates has its own caller-scoped view.

The object contains enum values, caller identity and numeric observations only:
no prompt text, result bodies, credentials, error payloads or provider prices.
Returned projection objects are detached from the recorded snapshot. Legacy
clients ignore the optional field; the UI explains absent/unsupported observations
rather than inferring a mode or reporting zero usage. Generic task prose omits
the structured object; existing model-facing acknowledgements remain compact.

## Validation

`delegation-observation.test.mjs` exercises deterministic phase timing, all modes,
unknown/zero counters, immutable terminal reports and session reuse.
`delegation-lifecycle.test.mjs` exercises real background tasks, admission failure,
queued cancellation, early result settlement, partial handoffs, owner isolation
and projection copies. Spawn/send integration and caller-context tests exercise
the capture sites. `src/ui/delegation-observations.test.mjs` covers the pure wire
read model. Desktop component tests cover rendering, old hosts, missing fields,
owner isolation, escaping and paged history. No live provider, performance,
quality or billing claim is made by these tests.
Coverage regressions exercise off-page records, per-counter missingness, explicit
zero, duplicate IDs, legacy/future records, foreign callers, empty/unavailable
snapshots and count updates when the displayed session changes.

`delegation-runtime.slow.test.mjs` also runs real `askSession` turns with a fixture
provider through spawn/send, terminal reconciliation, job projection and the
wire read model. It covers missing, one-sided, zero and mixed multi-call usage.
It also proves that an unrecovered request subtotal after an earlier measured
call cannot become measured turn usage. `delegation-compaction.test.mjs` runs
the actual pre-send compactor, loop finalization and observation read model to
verify that compaction usage already folded into the returned aggregate stays
included.
Automation tests traverse the actual internal-tool provider and job starter for
all three delegation modes, preserving the caller stamp rather than tool args.

Adapter regression tests drive fixture SSE/SDK/protobuf events through the real
stream consumers, final result builders, loop accumulation and observation
projection. Responses HTTP and Anthropic SSE also run through the real
`askSession`/`read`/spawn/send path. These are deterministic transport fixtures,
not paid live-provider calls. Existing usage-ledger/cost tests remain unchanged.
