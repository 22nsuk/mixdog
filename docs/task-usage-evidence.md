# Task usage evidence and follow-up plan

## Baseline and scope

This increment starts from fork/upstream `main` at
`536c3f5729f718b7be937293e46862c50bc3d47d` (v1.2.2). It does not stack the
unmerged delegation-observation PR #31, nor import its old provider adapters
over the newer retry implementations. Main already accounts abandoned attempts,
partial failures and nested fallback results at `accountProviderSend`. That
boundary and the existing durable usage ledger remain the numeric authority.

Recent changes relevant to the design:

- Provider retry parity (`62755d6d`) records abandoned/partial usage; summing
  terminal turn returns would miss it or repeat nested results.
- Agent cancellation (`57f36455`) delivers partial output once; a cancelled
  report is not proof that all underlying requests have settled.
- Session indexing (`ca1be648`, `d1cfcb87`) separates durable sessions from live
  runtime ownership; a session ID is not a task ID, especially for reused workers.
- Review baselines (`a5f7eb34`, `f15ed8b6`) capture first-seen file versions and
  avoid unrelated session scans. Their diff/etag is not a verification result.
- In-place model switching (`2fe88973`) makes the actual request route in the
  ledger more reliable than the session's later selected model for comparison.

The usable result of this PR is a durable **runtime-turn lineage**, with
session-scoped read access in `/context` under **Task usage**. It is the identity
and accounting foundation for the later features below, not an implementation
of verified whole-user-goal completion or recommendations.

## Identity and ownership

Each actual `askSession` turn uses its runtime-generated checkpoint token as a
run ID. An initial request is a root. Nested turns share the root only through
an observed runtime parent or a registered submission. Initial transcript
message/checkpoint IDs and queued submission IDs are retained as links, never
prompt text. Reusing a session starts a new run; changing the selected mode
does not relabel old runs. `none` is a recorded mode, not proof of a Solo baseline.

The asynchronous context starts before preparation/effort judging and surrounds
the real loop and commit/unwind. Provider admission callbacks bind the submitting
context: a queued call cannot inherit the task that happened to release a slot.
The internal agent tool carries a run ID in its trusted caller context, never
model arguments. After a process boundary, it is checked against the caller's
recorded session. Canonical agent submissions are registered durably **before**
dispatch with the target session and generated submission ID, then consumed by
the receiving turn. This works without sharing AsyncLocalStorage across processes.

Pending manager submissions use the same mapping. A queued group with one
known root may join that root once; several parents are retained as links.
Missing or conflicting roots produce a separate `unlinked-input` run, not an
arbitrary allocation. Steering merged into an already running turn marks it
`mixed-input`; its spend cannot be divided reliably among prompts. Consumed
submissions whose work is mixed or assigned elsewhere are exposed as allocation
gaps in the originating root. No session/time-window heuristic repairs links.

The boundary is **turn admission**, not a user's click or resource-queue entry.
Failures before a turn is claimed have no run. Synthetic continuation/notification
turns without explicit ownership remain separate; no conversation-wide Goal is
inferred. Cross-host RPC, independent helpers, provider-hidden work and old hosts
without these links remain outside the captured lineage. Local desktop, canonical
agent, automation and headless paths using this manager share the same mechanism.

## Accounting and coverage

The additive SQLite tables live beside `usage_events` in the existing ledger.
They hold IDs, enum/status values, timestamps and measurement flags; no prompts,
responses, commands, paths, credentials, new prices or copied monetary totals.
The ledger worker performs writes and indexed reads. No network telemetry or
new storage-retention policy is introduced: evidence follows the ledger's
existing durable retention. Restart keeps the rows; an unfinished row remains
unsettled/unknown rather than becoming a fabricated success.

`task_usage` links an existing accounting event ID to one run in the same
transaction as the event. Root queries join those events, including reported
abandoned retries, partial failure usage and in-context compaction. Existing
numeric accounting, deduplication, prices and session totals remain unchanged.
Nested account wrappers do not add the returned result a second time. Duplicate
response IDs with conflicting roots are excluded from both roots and flagged;
historical unlinked IDs are never backfilled into a new task.

The read model returns separate input/output/cache buckets, record counts,
per-counter certified-record counts, provider-call counts and calls with no
recorded usage. Certification requires an explicit `*TokensComplete === true`
and a valid raw counter; normalized numeric zero alone is not evidence. PR #31
can supply these flags after its separate refresh/merge. On current main,
unflagged adapters still contribute the existing ledger subtotal but remain
uncertified. A zero subtotal with no records is displayed as unknown. Failed
attempts without reported usage count as a coverage gap; their tokens are not
invented. Provider-internal attempts with no accounting event are unknowable.

Costs are grouped by the ledger's `costSource` (`provider`, `catalog`,
`subscription`, `local`, `unpriced`). They must not be merged into an invoice:
subscription estimates, catalog values and billed API figures are different.
Later repricing remains visible because reads join the original ledger rows.

The `/context` snapshot includes the ten most recent roots **owned by the shown
session**, plus their explicitly linked descendants' aggregate numbers. It
does not expose child transcript bodies or recursively grant session access.
Old clients ignore the optional `taskUsage.version=1` field; old hosts omit it.
The renderer checks the session identity again to reject a stale snapshot.
Reopening the dialog refreshes it. Ten rows are a display limit, not retention.

`firstTurnMs` is the root turn's monotonic execution duration. `linkedSettlementMs`
is the host wall-clock span until the last known run/provider call has settled;
it stays null while a run, call or registered submission is pending. Parallel
durations are never summed. Late requests can extend settlement without changing
the first turn's duration. Neither value means validated, integrated or accepted
completion. Clock adjustment can affect the wall-clock span. Measurement write
failure logs a diagnostic and cannot replay a paid call or replace its error;
absence of evidence must not be treated as proof of complete coverage.

## Next PR: revision-linked validation

Attach explicit evidence to `root_id` / `run_id`, input checkpoint IDs and an
artifact revision, reusing the existing review baseline and worktree identity.
Store check identity, producer (local runner / CI), invocation/run ID, scope,
start/end, exit/status and the exact revision or dirty-tree fingerprint tested.
An exit code of zero is a successful command, not automatically a passing test
suite; test discovery/summary and skips need their own evidence. Later mutations
make evidence stale for the new revision. Keep `not-run`, `running`, `passed`,
`failed`, `cancelled`, `unknown` and stale evidence distinguishable. A root's
completed status must never certify validation. Test old-pass/new-edit, missing
checks, skipped-only checks, late CI results, mixed worktrees and cancellation.

## Following PR: explicit rework and integration

Link a new run to the prior run/artifact with an explicit reason and evidence
source: failed validation repair, review response, merge conflict, requirement
change, or user correction. A send/follow-up or provider retry alone is not
rework. Unknown/unclassified work remains visible; model-inferred labels must
be marked separately from user/runtime-confirmed ones. Prevent cycles and
double allocation when several attempts contribute to one artifact. Record
integration-ready and user-accepted milestones separately from first response
and accounting settlement. Handle reopen/reject/continue without rewriting
the previous milestones. Add explicit continuation links for notification,
Goal and cross-host paths before calling a lineage a complete user task.

## Following PR: evidence-based advice

Start with deterministic eligibility and abstention rules; use language models
only to explain the already computed evidence. Exclude neither failures nor
their recorded cost. Show compared cohorts, dates, sample counts, missingness,
quality/validation coverage and uncertainty. Do not select by surviving recent
jobs or count descendant jobs as independent user tasks.

Comparisons require declared comparable tasks, project/workload, change size,
actual provider/model/effort mix, environment/cache conditions and revision-linked
validation. Observational differences cannot establish delegation's causal
benefit: harder work is preferentially delegated. Prefer paired/repeated
controlled task trials, and specify the required precision/power for the metric
instead of a universal sample-count threshold. Quality and acceptance constraints
come before speed/cost. Missing baseline, poor coverage or conflicting quality
must return **insufficient evidence**, not a score or forced recommendation.
Any suggested mode/model/budget change remains user-applied; this foundation
does not alter scheduling, resource limits, permissions, caches or routing.

## Verification contract

- Actual ask/read/provider/accounting/API tests cover reused-session roots and
  failed requests, plus canonical submissions with deliberately lost async
  context and repeated worker use.
- A real constrained provider admission queue proves cross-root isolation;
  disabling callback binding reproduces 30 tokens assigned to the 10-token root.
- Store/accounting tests cover durable cross-connection submission links, mixed
  queues, historical/duplicate IDs, explicit zero vs unknown, abandoned retries,
  nested fallback, partial failure, pending settlement and foreign-session reads.
- Renderer tests cover old hosts, foreign snapshots, missing coverage, unsettled
  work and escaped identities. Release Gate validates the combined branch.

The local Windows/Node 24 zero-network fixture measured 100 calls each at about
4.8 ms mean without task capture and 14.4 ms with capture (about 9.6 ms extra).
The extra durable start/end records deliberately preserve in-flight/failed-call
evidence; they are not free. Twenty worker reads of the latest ten roots among
500 roots / 10,000 accounting records averaged about 12.4 ms. These are local
storage overhead measurements, not real-model latency, throughput or delegation
benefit claims. Capturing writes on the ledger worker keeps SQLite off the
interactive event loop, but callers still await durability at these boundaries.
