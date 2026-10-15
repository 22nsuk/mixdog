import './usage-test-support.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger, makeUsageRecord, getUsageLedger, closeUsageLedgers } from './usage-ledger.mjs';
import {
  withTaskRun,
  currentTaskRun,
  registerTaskSubmission,
  withTaskCaller,
  noteTaskSteering,
} from './task-usage-context.mjs';
import { accountProviderSend } from './usage-accounting.mjs';
import { noteAbandonedUsage } from './usage-context.mjs';

const begin = (ledger, id, sessionId = 'lead', extra = {}) =>
  ledger.taskOperation('begin', {
    id,
    sessionId,
    startedAt: 1000,
    source: 'prompt',
    mode: 'balanced',
    ...extra,
  });
const row = (id, runId, extra = {}) => ({
  ...makeUsageRecord({
    id,
    ts: 2000,
    provider: 'openai',
    model: 'one',
    inputTokens: 10,
    outputTokens: 3,
    costUsd: 0.5,
    sessionId: 'worker',
    ...extra,
  }),
  taskUsage: { runId, sendId: id, inputMeasured: true, outputMeasured: true },
});
const memory = (t) => {
  const db = new UsageLedger(':memory:');
  t.after(() => db.close());
  return db;
};

test('linked descendants aggregate once without borrowing reused-session or foreign-root usage', async (t) => {
  const ledger = memory(t);
  begin(ledger, 'a');
  begin(ledger, 'b', 'worker', { parentId: 'a' });
  begin(ledger, 'c', 'worker', { parentId: 'b' });
  begin(ledger, 'd', 'other');
  begin(ledger, 'reused', 'worker', { parentId: 'd' });
  const a = row('first', 'a'),
    b = row('second', 'b'),
    c = row('third', 'c');
  ledger.record([a, b, c, row('foreign', 'reused')]);
  ledger.record([a, b]);
  const task = (await ledger.taskUsageAsync('lead')).tasks[0];
  assert.equal(task.runs.runs, 3);
  assert.equal(task.totals.records, 3);
  assert.equal(task.totals.input, 30);
  assert.equal(task.costs[0].usd, 1.5);
  assert.equal(task.linkedSettlementMs, null);
  assert.deepEqual((await ledger.taskUsageAsync('unknown')).tasks, []);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM events').get().n, 4);
});

test('ambiguous response ownership excludes the record instead of billing two roots', async (t) => {
  const ledger = memory(t);
  begin(ledger, 'a');
  begin(ledger, 'b', 'other');
  ledger.record([row('duplicate', 'a'), row('duplicate', 'b')]);
  assert.equal((await ledger.taskUsageAsync('lead')).tasks[0].totals.records, 0);
  assert.equal((await ledger.taskUsageAsync('lead')).tasks[0].ambiguousRecords, 1);
  assert.equal((await ledger.taskUsageAsync('other')).tasks[0].totals.records, 0);
  assert.equal(ledger.db.prepare('SELECT SUM(input) n FROM events').get().n, 10);
});

test('queued submission ownership survives another ledger connection; mixed and missing owners never inherit a root', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-task-store-'));
  const ledger = new UsageLedger(join(dir, 'ledger.sqlite'));
  t.after(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
  begin(ledger, 'a');
  begin(ledger, 'b', 'other');
  for (const [id, parentId] of [
    ['q1', 'a'],
    ['q2', 'a'],
    ['q3', 'b'],
    ['q4', 'a'],
  ])
    ledger.taskOperation('submit', { sessionId: 'worker', submissionId: id, parentId, requestedAt: 1100 });
  const second = new UsageLedger(ledger.path);
  assert.equal(begin(second, 'child', 'worker', { submissionIds: ['q1', 'q2'], requireSubmission: true }).rootId, 'a');
  assert.equal(
    begin(second, 'mixed', 'worker', { submissionIds: ['q3', 'q4'], requireSubmission: true }).rootId,
    'mixed'
  );
  assert.equal(
    begin(second, 'unknown', 'worker', { submissionIds: ['lost'], requireSubmission: true, parentId: 'a' }).rootId,
    'unknown'
  );
  second.close();
  const workers = (await ledger.taskUsageAsync('worker')).tasks;
  assert.equal(workers.length, 2);
  assert.ok(workers.every((r) => r.runs.uncertainInputs === 1));
  assert.equal((await ledger.taskUsageAsync('lead')).tasks[0].runs.runs, 2);
});

test('no historical backfill; counts distinguish measured zero and unproven normalized zero', async (t) => {
  const ledger = memory(t);
  ledger.record([makeUsageRecord({ id: 'old', ts: 1000, provider: 'openai', model: 'one' })]);
  begin(ledger, 'new');
  ledger.record([row('old', 'new')]);
  const measured = row('zero', 'new', { inputTokens: 0, outputTokens: 0 });
  const unknown = row('unknown', 'new', { inputTokens: 0, outputTokens: 0 });
  unknown.taskUsage.inputMeasured = false;
  unknown.taskUsage.outputMeasured = false;
  ledger.record([measured, unknown]);
  const task = (await ledger.taskUsageAsync('lead')).tasks[0];
  assert.equal(task.totals.records, 2);
  assert.equal(task.totals.input, 0);
  assert.equal(task.totals.inputMeasured, 1);
  assert.equal(task.totals.outputMeasured, 1);
  assert.equal(task.ambiguousRecords, 1, 'a historical response ID cannot be retroactively attributed');
});

test('terminal timing stays unknown while descendants, sends or registered work remain unsettled', async (t) => {
  const ledger = memory(t);
  begin(ledger, 'a');
  begin(ledger, 'b', 'worker', { parentId: 'a' });
  ledger.taskOperation('finish', { id: 'a', finishedAt: 2000, elapsedMs: 1000, outcome: 'completed' });
  ledger.taskOperation('sendStart', { id: 'send', runId: 'b' });
  ledger.taskOperation('finish', { id: 'b', finishedAt: 3000, elapsedMs: 500, outcome: 'cancelled' });
  assert.equal((await ledger.taskUsageAsync('lead')).tasks[0].linkedSettlementMs, null);
  ledger.taskOperation('sendFinish', { id: 'send', outcome: 'failed', hasUsage: false });
  ledger.taskOperation('submit', { sessionId: 'worker', submissionId: 'queued', parentId: 'a', requestedAt: 3100 });
  assert.equal((await ledger.taskUsageAsync('lead')).tasks[0].linkedSettlementMs, null);
  ledger.taskOperation('reject', { sessionId: 'worker', submissionId: 'queued' });
  const task = (await ledger.taskUsageAsync('lead')).tasks[0];
  assert.equal(task.firstTurnMs, 1000);
  assert.ok(task.linkedSettlementMs >= 2000);
  assert.equal(task.runs.cancelled, 1);
  assert.equal(task.sends.unreported, 1);
});

test('actual accounting captures concurrent roots, retries, compaction, partial failures, zero and nested fallback once', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-task-accounting-'));
  const before = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = join(dir, 'ledger.sqlite');
  t.after(async () => {
    await getUsageLedger().settleWrites();
    closeUsageLedgers();
    if (before === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = before;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const usage = (n) => ({ inputTokens: n, outputTokens: 0, inputTokensComplete: true, outputTokensComplete: true });
  const send = (fn, opts = {}) => accountProviderSend('openai', {}, fn, 'one', opts);
  const run = (id, sessionId, fn, extra = {}) =>
    withTaskRun({ id, sessionId, startedAt: Date.now(), source: 'prompt', ...extra }, fn);
  await Promise.all([
    run('a', 'lead', async () => {
      await send(async () => ({ usage: usage(0) }));
      await run('child', 'worker', () =>
        send(async () => {
          noteAbandonedUsage(usage(2), 'one');
          return { usage: usage(3) };
        })
      );
      await send(() => send(async () => ({ usage: usage(5) })), { requestKind: 'compact', usageSessionId: 'lead' });
      await assert.rejects(
        send(async () => {
          throw Object.assign(new Error('expected'), { partialUsage: usage(7) });
        })
      );
      await send(async () => ({ content: 'unreported' }));
      await registerTaskSubmission('worker', 'later');
    }),
    run('other', 'other', () => send(async () => ({ usage: usage(100) }))),
  ]);
  await run('queued', 'worker', () => send(async () => ({ usage: usage(11) })), {
    submissionIds: ['later'],
    requireSubmission: true,
  });
  const task = (await getUsageLedger().taskUsageAsync('lead')).tasks[0];
  assert.equal(task.totals.input, 28);
  assert.equal(task.totals.records, 6);
  assert.equal(task.runs.runs, 3);
  assert.equal(task.totals.inputMeasured, 6);
  assert.equal(task.sends.unreported, 1);
  assert.equal(task.sends.failed, 1);
  assert.equal(task.pendingSubmissions, 0);
  await withTaskCaller({ taskRunId: 'a', callerSessionId: 'wrong' }, () => assert.equal(currentTaskRun(), null));
  await withTaskCaller({ taskRunId: 'a', callerSessionId: 'lead' }, async () => {
    assert.equal(currentTaskRun().id, 'a');
    noteTaskSteering([{ ids: ['new-input'] }]);
  });
  await getUsageLedger().settleWrites();
  assert.equal((await getUsageLedger().taskUsageAsync('lead')).tasks[0].runs.uncertainInputs, 1);
});
