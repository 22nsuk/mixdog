import assert from 'node:assert/strict';
import test from 'node:test';
import { runCycle2 } from './memory-cycle2.mjs';
import { recordReviewFailure, quarantinedIds, recordReviewSuccess } from './memory-cycle2-quarantine.mjs';
import { createIdleLease } from './embedding-idle-lease.mjs';

function fakeDb(ids) {
  const db = {
    selects: 0,
    async query(sql, args = []) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      if (sql.includes('CROSS JOIN LATERAL')) return { rows: [] };
      if (sql.includes('FROM entries')) {
        db.selects++;
        const skip = new Set((args[1] ?? []).map(Number));
        return {
          rows: ids
            .filter((id) => !skip.has(id))
            .map((id) => ({ id: String(id), ts: id, element: 'e', summary: `s${id}`, project_id: 'p' })),
        };
      }
      return { rows: [] };
    },
  };
  db._pool = { connect: async () => ({ query: db.query, release() {} }) };
  return db;
}

const config = { coalesce_max_drains: 0, failure_max_attempts: 3, failure_backoff_ms: 1000, dead_letter_rearm_ms: 100_000 };

function runAt(db, now, callLlm) {
  return runCycle2(db, config, {
    preset: 'test',
    callLlm,
    now: () => now,
    coalescedRetry: true,
    catchUpDrainPass: true,
    flushEmbeddings: async () => ({ attempted: 0, succeeded: 0, failed: [] }),
  });
}

test('a batch that keeps failing is capped, dead-lettered without re-enqueue, then re-armed', async () => {
  const db = fakeDb([1, 2]);
  let calls = 0;
  const bad = async () => {
    calls++;
    return '[{"id":1,"action":"bogus"},{"id":2,"action":"keep"}]';
  };
  for (const now of [0, 5000, 10_000]) {
    const result = await runAt(db, now, bad);
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid cycle2 review verdict/);
  }
  assert.equal(calls, 3);
  // Dead-lettered: later ticks neither call the model nor fail.
  for (const now of [20_000, 40_000, 90_000]) {
    const result = await runAt(db, now, bad);
    assert.equal(result.ok, true);
    assert.equal(result.processed, 0);
  }
  assert.equal(calls, 3);
  // Timed re-arm gives the batch a fresh set of attempts.
  const rearmed = await runAt(db, 120_000, bad);
  assert.equal(rearmed.ok, false);
  assert.equal(calls, 4);
});

test('a failed batch cools down before its next attempt', async () => {
  const db = fakeDb([1, 2]);
  let calls = 0;
  const bad = async () => {
    calls++;
    return '[]';
  };
  await runAt(db, 0, bad);
  assert.equal((await runAt(db, 500, bad)).ok, true);
  assert.equal(calls, 1);
  assert.equal((await runAt(db, 1500, bad)).ok, false);
  assert.equal(calls, 2);
});

test('the raw invalid verdict is reported once per batch and success clears state', () => {
  const db = {};
  const error = Object.assign(new Error('invalid cycle2 review verdict'), { rawVerdict: 'x'.repeat(5000) });
  const first = recordReviewFailure(db, [3, 4], error, {}, 0);
  assert.equal(first.firstFailure, true);
  assert.equal(first.raw.length, 2000);
  assert.equal(recordReviewFailure(db, [4, 3], error, {}, 1).firstFailure, false);
  assert.deepEqual(quarantinedIds(db, 2).sort(), [3, 4]);
  recordReviewSuccess(db, [3, 4]);
  assert.deepEqual(quarantinedIds(db, 2), []);
});

test('the embed idle lease holds until it expires', () => {
  let t = 0;
  const lease = createIdleLease(() => t);
  assert.equal(lease.active(), false);
  lease.hold(1000);
  t = 999;
  assert.equal(lease.active(), true);
  t = 1000;
  assert.equal(lease.active(), false);
});
