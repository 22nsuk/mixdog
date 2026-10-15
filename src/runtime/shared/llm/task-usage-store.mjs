// Additive attribution beside the existing usage ledger. Numbers and prices
// remain owned by usage_events; these tables store identities and evidence only.
export const TASK_USAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY, root_id TEXT NOT NULL, parent_id TEXT,
    session_id TEXT NOT NULL, source TEXT NOT NULL, mode TEXT,
    started_at INTEGER NOT NULL, finished_at INTEGER, elapsed_ms INTEGER,
    outcome TEXT NOT NULL, attribution TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_runs_root ON task_runs(root_id);
  CREATE INDEX IF NOT EXISTS task_runs_session ON task_runs(session_id, started_at);
  CREATE TABLE IF NOT EXISTS task_inputs (
    run_id TEXT NOT NULL, input_id TEXT NOT NULL, kind TEXT NOT NULL,
    PRIMARY KEY(run_id,input_id,kind)
  );
  CREATE TABLE IF NOT EXISTS task_submissions (
    session_id TEXT NOT NULL, submission_id TEXT NOT NULL, parent_id TEXT NOT NULL,
    requested_at INTEGER NOT NULL, consumed_by TEXT, rejected INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(session_id, submission_id)
  );
  CREATE INDEX IF NOT EXISTS task_submissions_parent ON task_submissions(parent_id);
  CREATE TABLE IF NOT EXISTS task_run_links (
    run_id TEXT NOT NULL, parent_id TEXT NOT NULL, PRIMARY KEY(run_id, parent_id)
  );
  CREATE TABLE IF NOT EXISTS task_sends (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, outcome TEXT NOT NULL, has_usage INTEGER NOT NULL DEFAULT 0,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS task_sends_run ON task_sends(run_id);
  CREATE TABLE IF NOT EXISTS task_usage (
    event_id BLOB PRIMARY KEY, run_id TEXT NOT NULL, send_id TEXT NOT NULL,
    input_measured INTEGER NOT NULL, output_measured INTEGER NOT NULL,
    ambiguous INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS task_usage_run ON task_usage(run_id);
  CREATE TABLE IF NOT EXISTS task_usage_conflicts (
    event_id BLOB NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(event_id,run_id)
  );
  CREATE INDEX IF NOT EXISTS task_usage_conflicts_run ON task_usage_conflicts(run_id);
`;

const MODES = new Set(['none', 'focused', 'balanced', 'swarm']);
const clean = (value) => (typeof value === 'string' ? value.slice(0, 300) : '');

export function taskUsageOperation(db, action, data) {
  if (action === 'parent') {
    // A forwarded tool context may name only the caller's own recorded run.
    return db.prepare('SELECT * FROM task_runs WHERE id=? AND session_id=?').get(data.id, data.sessionId) || null;
  }
  if (action === 'submit') {
    db.prepare(`INSERT OR IGNORE INTO task_submissions(session_id,submission_id,parent_id,requested_at)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM task_runs WHERE id=?)`).run(
      data.sessionId,
      data.submissionId,
      data.parentId,
      data.requestedAt,
      data.parentId
    );
    return;
  }
  if (action === 'reject') {
    db.prepare(
      'UPDATE task_submissions SET rejected=1 WHERE session_id=? AND submission_id=? AND consumed_by IS NULL'
    ).run(data.sessionId, data.submissionId);
    return;
  }
  if (action === 'begin') {
    const ids = [...new Set((data.submissionIds || []).filter(Boolean))];
    const submissions = ids.map((id) =>
      db
        .prepare(`SELECT * FROM task_submissions
      WHERE session_id=? AND submission_id=? AND rejected=0 AND consumed_by IS NULL`)
        .get(data.sessionId, id)
    );
    const directParent = !data.requireSubmission && !submissions.some(Boolean) && data.parentId;
    const parentIds = directParent
      ? [directParent]
      : ids.length
        ? submissions.filter(Boolean).map((s) => s.parent_id)
        : [data.parentId].filter(Boolean);
    const parents = [...new Set(parentIds)]
      .map((id) => db.prepare('SELECT * FROM task_runs WHERE id=?').get(id))
      .filter(Boolean);
    const roots = [...new Set(parents.map((p) => p.root_id))];
    const linked = roots.length === 1 && (Boolean(directParent) || !ids.length || submissions.every(Boolean));
    const rootId = linked ? roots[0] : data.id;
    const parentId = linked && parents.length === 1 ? parents[0].id : null;
    const attribution = data.requireSubmission && !linked ? 'unlinked-input' : 'linked';
    db.prepare('INSERT INTO task_runs VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?)').run(
      data.id,
      rootId,
      parentId,
      clean(data.sessionId),
      clean(data.source),
      MODES.has(data.mode) ? data.mode : null,
      data.startedAt,
      'running',
      attribution
    );
    for (const parent of parents)
      db.prepare('INSERT OR IGNORE INTO task_run_links VALUES (?,?)').run(data.id, parent.id);
    for (const id of ids)
      db.prepare('INSERT OR IGNORE INTO task_inputs VALUES (?,?,?)').run(data.id, clean(id), 'submission');
    if (data.messageId)
      db.prepare('INSERT OR IGNORE INTO task_inputs VALUES (?,?,?)').run(data.id, clean(data.messageId), 'message');
    for (const id of ids)
      db.prepare(`UPDATE task_submissions SET consumed_by=?
      WHERE session_id=? AND submission_id=? AND consumed_by IS NULL AND rejected=0`).run(data.id, data.sessionId, id);
    return { id: data.id, rootId, sessionId: data.sessionId };
  }
  if (action === 'finish') {
    db.prepare('UPDATE task_runs SET finished_at=?,elapsed_ms=?,outcome=? WHERE id=? AND finished_at IS NULL').run(
      data.finishedAt,
      data.elapsedMs,
      data.outcome,
      data.id
    );
    return;
  }
  if (action === 'steering') {
    db.prepare("UPDATE task_runs SET attribution='mixed-input' WHERE id=?").run(data.id);
    for (const id of data.submissionIds || [])
      db.prepare(`UPDATE task_submissions SET consumed_by=?
      WHERE session_id=? AND submission_id=? AND consumed_by IS NULL`).run(data.id, data.sessionId, id);
    return;
  }
  if (action === 'sendStart') {
    db.prepare("INSERT INTO task_sends(id,run_id,outcome) VALUES (?,?,'running')").run(data.id, data.runId);
    return;
  }
  if (action === 'sendFinish') {
    db.prepare('UPDATE task_sends SET outcome=?,has_usage=?,finished_at=? WHERE id=?').run(
      data.outcome,
      Number(data.hasUsage === true),
      Date.now(),
      data.id
    );
    return;
  }
  throw new Error(`Unknown task usage operation: ${action}`);
}

// Called in the SAME transaction as the monetary event. Duplicate response IDs
// never charge twice. A conflicting owner is excluded, not silently reassigned.
export function linkTaskUsage(db, row, eventId, isNew) {
  const link = row.taskUsage;
  if (!link?.runId || !link.sendId) return;
  const prior = db.prepare('SELECT run_id FROM task_usage WHERE event_id=?').get(eventId);
  if (!isNew && !prior) {
    // A response ID already present before task capture is not evidence that
    // the historical spend belongs to the new execution.
    db.prepare('INSERT OR IGNORE INTO task_usage_conflicts VALUES (?,?)').run(eventId, link.runId);
    return;
  }
  if (prior && prior.run_id !== link.runId) {
    for (const id of [prior.run_id, link.runId])
      db.prepare('INSERT OR IGNORE INTO task_usage_conflicts VALUES (?,?)').run(eventId, id);
  }
  db.prepare(`INSERT INTO task_usage(event_id,run_id,send_id,input_measured,output_measured)
    SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM task_runs WHERE id=?)
    ON CONFLICT(event_id) DO UPDATE SET
      ambiguous=MAX(ambiguous,task_usage.run_id<>excluded.run_id),
      input_measured=MIN(input_measured,excluded.input_measured),
      output_measured=MIN(output_measured,excluded.output_measured)`).run(
    eventId,
    link.runId,
    link.sendId,
    Number(link.inputMeasured === true),
    Number(link.outputMeasured === true),
    link.runId
  );
}

export function readTaskUsage(db, sessionId, limit = 10) {
  const roots = db
    .prepare(`SELECT * FROM task_runs WHERE session_id=? AND root_id=id
    ORDER BY started_at DESC,id DESC LIMIT ?`)
    .all(sessionId, Math.min(50, Math.max(1, Math.trunc(limit) || 10)));
  const tasks = roots.map((root) => {
    const runs = db
      .prepare(`SELECT COUNT(*) runs,SUM(finished_at IS NULL) unsettled,
      SUM(outcome='failed') failed,SUM(outcome='cancelled') cancelled,
      SUM(attribution<>'linked') uncertainInputs,MAX(finished_at) lastFinishedAt
      FROM task_runs WHERE root_id=?`)
      .get(root.id);
    const sends = db
      .prepare(`SELECT COUNT(*) calls,SUM(s.outcome='running') unsettled,
      SUM(s.outcome='failed') failed,SUM(s.has_usage=0 AND s.outcome<>'delegated') unreported,MAX(s.finished_at) lastFinishedAt
      FROM task_sends s JOIN task_runs r ON r.id=s.run_id WHERE r.root_id=?`)
      .get(root.id);
    const pending = db
      .prepare(`SELECT COUNT(*) count FROM task_submissions s JOIN task_runs r ON r.id=s.parent_id
      WHERE r.root_id=? AND s.consumed_by IS NULL AND s.rejected=0`)
      .get(root.id).count;
    const unallocated = db
      .prepare(`SELECT COUNT(*) count FROM task_submissions s JOIN task_runs r ON r.id=s.parent_id
      JOIN task_runs consumer ON consumer.id=s.consumed_by
      WHERE r.root_id=? AND (consumer.root_id<>r.root_id OR consumer.attribution<>'linked')`)
      .get(root.id).count;
    const totals = db
      .prepare(`SELECT COUNT(*) records,
      COALESCE(SUM(e.input),0) input,COALESCE(SUM(e.output),0) output,
      COALESCE(SUM(e.cache_read),0) cacheRead,COALESCE(SUM(e.cache_write),0) cacheWrite,
      COALESCE(SUM(t.input_measured),0) inputMeasured,COALESCE(SUM(t.output_measured),0) outputMeasured
      FROM task_usage t JOIN task_runs r ON r.id=t.run_id JOIN usage_events e ON e.id=t.event_id
      WHERE r.root_id=? AND t.ambiguous=0`)
      .get(root.id);
    const costs = db
      .prepare(`SELECT json_extract(route.signature,'$[4]') source,COUNT(*) records,
      SUM(e.cost_usd) usd FROM task_usage t JOIN task_runs r ON r.id=t.run_id
      JOIN usage_events e ON e.id=t.event_id JOIN usage_routes route ON route.id=e.route
      WHERE r.root_id=? AND t.ambiguous=0 GROUP BY source`)
      .all(root.id);
    const ambiguous = db
      .prepare(`SELECT COUNT(DISTINCT t.event_id) count FROM task_usage_conflicts t JOIN task_runs r ON r.id=t.run_id
      WHERE r.root_id=?`)
      .get(root.id).count;
    return {
      id: root.id,
      inputs: db
        .prepare('SELECT input_id id,kind FROM task_inputs WHERE run_id=?')
        .all(root.id)
        .map((r) => ({ ...r })),
      source: root.source,
      mode: root.mode,
      startedAt: root.started_at,
      outcome: root.outcome,
      firstTurnMs: root.elapsed_ms,
      // A settlement span is NOT accepted completion or the sum of worker time.
      linkedSettlementMs:
        runs.unsettled || sends.unsettled || pending
          ? null
          : Math.max(0, Math.max(runs.lastFinishedAt || 0, sends.lastFinishedAt || 0) - root.started_at),
      runs: { ...runs },
      sends: { ...sends },
      pendingSubmissions: pending,
      unallocatedSubmissions: unallocated,
      totals: { ...totals },
      costs: costs.map((c) => ({ ...c })),
      ambiguousRecords: ambiguous,
    };
  });
  return { version: 1, sessionId, scope: 'linked-runtime-turns', tasks };
}
