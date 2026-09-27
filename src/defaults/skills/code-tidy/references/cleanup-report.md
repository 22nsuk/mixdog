# Cleanup inventory and report

Read this before registering the first candidate, and again when closing the
last round. It owns candidate registration, statuses, completion criteria, and
the final report template. Findings and their risk tiers come from the
agent-level analysis; this file owns how they are recorded and reported.

## Candidate inventory

The candidate inventory grows as rounds reveal findings. Register candidates
using stable candidate IDs:

```text
[ID] path · symbol → problem → cost (what it duplicates, wastes, or makes harder) → planned action | tier: SAFE/CAREFUL/RISKY | confidence: high/medium/low | status: completed/kept/unfinished | verification: <test/check>
```

- **Stable IDs & Grouping**: Assign stable IDs (e.g. `C-01`, `C-02` or `MOD-01`).
  When multiple locations share an identical root cause (e.g. an unused helper
  referenced across three call sites, or repeated boilerplate), group them under
  one ID without losing each member's path and symbol. Counts track
  candidate IDs, not raw diagnostics or individual member locations.
- **Origin tracking**: When code moves during extraction or splitting, retain
  the origin candidate ID and record the new target location under that ID.
- **Candidate classification**: Register only a lens finding with a
  path-plus-symbol location, a cost, and an action. Line numbers appear only
  when copied from engine diagnostics or grep output. Mechanical threshold hits (files > 1,000 lines,
  functions > 50 lines, nesting > 3) are investigation signals only; without a
  finding, do not register them or write a Keep justification.
- **Cost, Confidence & Nits**: A finding that cannot name its cost is a nit:
  do not register it. An unresolved registered finding remains `unfinished`;
  uncertainty is not evidence for keeping it. Confidence is `low` when
  current code, callers, contracts, and tests do not explain why the code exists.
  Consult history only to resolve a specific remaining question. Medium/low
  confidence candidates stay unfinished until that question is resolved; apply
  approval does not authorize guessing that they are safe to delete.
- **Statuses & Reconciliation Invariants**:
  - `completed`: verified done, with evidence of what and how changed.
  - `kept`: preserved with concrete evidence (documented keep rule or external contract).
  - `unfinished`: work remaining, with substatuses: `pending`, `in_progress`, `blocked`, `deferred`, or `unverified`.
  - Formula for registered candidates: `Total Candidate IDs = Completed + Kept + Unfinished Remaining`. Counts must reconcile exactly.

Report round outcome separately from overall cleanup status. Overall cleanup
is complete only when all partitions and applicable stages are verified and
every registered candidate is completed or evidenced as kept. A completed round
with remaining partitions or candidates is **round complete, overall partial**,
with the remaining paths, IDs, and next work.
Skipped, failed, or unverified checks never count as passed.

## Final report template

This is the shape of the closing reply after the last round; earlier rounds
close as the skill body's section 7 describes, while the inventory accumulates
in the form above.

```text
Scope: <user-selected paths | explicit whole project> · Mode: report|apply
Round: Round <N> <completed|partial> · Overall: <complete|partial>
Inventory: Total <N> · Completed <X> · Kept <Y> · Unfinished <Z> (X + Y + Z = N)
Stages: baseline / engines / structural / ladder + lenses / tiered changes / final verification
  <stage>: completed <evidence> | not applicable <reason> | unfinished <blocker>
Baseline: tests <green|N pre-existing failures excluded> · typecheck <ok|…>
Deterministic: engines used/missing · files changed · diagnostics remaining · structural matches applied/skipped

Completed (what changed and how)
  [ID] path/file.ts · symbol
    ✓ [Quality/SAFE]   removed comment narrating the change in `renderRow` → deleted redundant comment
    ✓ [Reuse/CAREFUL]  replaced manual join with `joinPath` from src/shared/path.mjs → consolidated helper

Kept / Not Applicable (evidenced)
  [ID] path/file.ts · symbol
    - [Keep/Contract]  public export `parseConfig` kept → external contract
    - [Keep/Rule]      redundant-looking guard in `fetchUser` kept → validates untrusted network input

Unfinished (remaining candidates)
  [ID] path/file.ts · symbol
    ☐ [Structure/CAREFUL] split `handleRequest` responsibility · Status: pending|in_progress|blocked|deferred|unverified
      Remaining: extract auth sub-handler · Reason: waiting for auth test fixture · Next: Round <N+1>

Noticed but not applied (report-only or out of scope)
  [ID] ⚠ [Altitude/RISKY] special case for caller X in `run` (src/core/run.mjs) — separate correction · coverage: none · Status: deferred
  [ID] ⚠ [Quality]        two equal rewrites of `parseInput`; principles could not decide · Status: blocked

Bugs found (not fixed here): <correctness issues surfaced while cleaning>
Verification: tests <passed/failed/skipped/baseline-excluded counts> · typecheck <result> · lint <remaining diagnostics>
Blocked or unavailable verification (required; write "none"): <check> — <engine unresolved through tidy | runner broken | lane conflict> → <paths left unverified>
Needs your decision: <one consolidated list — RISKY findings, bugs found, unresolved intent, unfinished candidates>
Next round: <scope and IDs planned for next round, or none if overall complete>
```
