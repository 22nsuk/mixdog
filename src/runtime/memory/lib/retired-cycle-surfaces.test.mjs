import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test, { mock } from 'node:test';
import {
  markCycleRequest,
  consumeCycleRequests,
  scheduleCoalescedCycleRetry,
  cancelCoalescedCycleRetries,
} from './memory-cycle-requests.mjs';
import { createMaintenanceActions } from './memory-action-handlers/maintenance-actions.mjs';

test('retired cycle requests cannot be written, consumed or armed for retry', async () => {
  let accessed = 0;
  const db = {
    query: async () => {
      accessed++;
      return { rows: [] };
    },
    transaction: async () => {
      accessed++;
    },
  };
  await assert.rejects(markCycleRequest(db, 'cycle2'), /invalid cycle/);
  await assert.rejects(consumeCycleRequests(db, 'cycle2'), /invalid cycle/);
  assert.throws(
    () => scheduleCoalescedCycleRetry(db, 'cycle2', () => assert.fail('retired retry ran')),
    /invalid cycle/
  );
  assert.equal(accessed, 0);
  assert.equal(cancelCoalescedCycleRetries(db), 0);
});

test('status ignores old review backlog and error metadata but keeps summarization status', async () => {
  const { status } = createMaintenanceActions({
    getDb: () => ({ query: async () => ({ rows: [] }) }),
    entryStats: async () => ({
      total: 10,
      roots: 4,
      unchunked_leaves: 6,
      byStatus: [],
      byCategory: [],
      core_entries: 1,
      core_embed_null: 0,
      cycle2_pending_roots: 99999,
    }),
    getCycleLastRun: async () => ({
      cycle1: Date.now(),
      cycle2: Date.now(),
      cycle2_last_error: 'retired review failure',
    }),
  });
  const result = await status();
  assert.match(result.text, /cycle1_raw=6/);
  assert.match(result.text, /last_cycle1: 0m ago/);
  assert.doesNotMatch(result.text, /cycle2|99999|retired review failure/);
});

test('old cycle2 state files do not revive a spinner or backlog warning', async (t) => {
  let state;
  const read = mock.method(fs, 'readFile', async (file) => {
    assert.match(String(file), /memory-cycle-state\.json$/);
    return JSON.stringify(state);
  });
  syncBuiltinESMExports();
  mock.timers.enable({ apis: ['Date'], now: 10_000_000 });
  t.after(() => {
    read.mock.restore();
    syncBuiltinESMExports();
    mock.timers.reset();
  });
  const { memoryCycleStatus } = await import('../../shared/statusline/statusline-segments.mjs');
  const refresh = async (cycle, unchunked) => {
    mock.timers.tick(1001);
    state = {
      updatedAt: Date.now(),
      running: { cycle, started_at: Date.now() - 100, pid: process.pid },
      backlog: { unchunked, cycle2_pending: 99999 },
    };
    memoryCycleStatus();
    await new Promise((resolve) => setImmediate(resolve));
    return memoryCycleStatus();
  };
  assert.equal(await refresh('cycle2', 0), null);
  assert.deepEqual(await refresh('cycle2', 700), { kind: 'backlog', pending: 700 });
  const running = await refresh('cycle1', 0);
  assert.deepEqual(running, { kind: 'running', startedAt: state.running.started_at });
});
