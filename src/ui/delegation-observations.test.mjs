import assert from 'node:assert/strict';
import test from 'node:test';
import { delegationObservations } from './delegation-observations.mjs';

const job = (id, mode, patch = {}) => ({
  task_id: id,
  type: 'spawn',
  tag: 'shared',
  sessionId: 'reused',
  model: 'm',
  startedAt: '2026-10-14T00:00:00.000Z',
  delegation: {
    version: 1,
    callerSessionId: 'lead',
    mode,
    phase: 'finished',
    outcome: 'completed',
    inputTokens: 7,
    ...patch,
  },
});

test('all delegation modes share a read model; missing mode stays unknown', () => {
  const result = delegationObservations(
    [
      job('a', 'focused'),
      job('b', 'balanced'),
      job('c', 'swarm'),
      job('d', null),
      job('e', 'future'),
      job('f', 'none'),
    ],
    'lead'
  );
  assert.equal(result.rows.length, 6);
  assert.deepEqual(
    result.rows.map((row) => row.mode),
    ['focused', 'balanced', 'swarm', null, null, 'none']
  );
  assert.equal(result.unmeasured, 0);
});

test('deduplicates job ids, not reused tags or sessions; does not attribute sibling or legacy data', () => {
  const a = job('a', 'focused');
  const result = delegationObservations(
    [
      a,
      a,
      { ...job('b', 'swarm'), type: 'send' },
      job('sibling', 'swarm', { callerSessionId: 'other' }),
      { task_id: 'legacy', status: 'completed' },
      job('new-version', 'swarm', { version: 2 }),
    ],
    'lead'
  );
  assert.equal(result.rows.length, 2);
  assert.equal(result.unmeasured, 2);
  assert.equal(result.retained, 4);
  assert.equal(result.rows[1].operation, 'send');
  assert.equal(delegationObservations([a], 'other').rows.length, 0);
});

test('older/missing snapshots are unavailable, not a fabricated zero-usage report', () => {
  for (const value of [undefined, null, 'bad', {}])
    assert.equal(delegationObservations(value, 'lead').available, false);
  assert.equal(delegationObservations([], '').available, false);
  assert.deepEqual(delegationObservations([], 'lead'), {
    available: true, rows: [], unmeasured: 0, retained: 0, inputMeasured: 0, outputMeasured: 0,
  });
  assert.equal(delegationObservations(undefined, 'lead').retained, null);
  assert.equal(delegationObservations(undefined, 'lead').inputMeasured, null);
  assert.equal(delegationObservations(undefined, 'lead').outputMeasured, null);
});

test('coverage counts each retained job once and measures input/output independently across outcomes', () => {
  const jobs = [
    job('zero', 'focused', { inputTokens: 0, outputTokens: 0 }),
    job('failed', 'balanced', { outcome: 'failed', inputTokens: 7, outputTokens: null }),
    job('cancelled', 'swarm', { outcome: 'cancelled', inputTokens: null, outputTokens: 9 }),
    job('partial', null, { outcome: 'partial', inputTokens: '0', outputTokens: -1 }),
    job('running', 'focused', { phase: 'running', outcome: null, inputTokens: null }),
    { taskId: 'legacy' },
    job('future', 'swarm', { version: 2, inputTokens: 100, outputTokens: 100 }),
    job('foreign', 'swarm', { callerSessionId: 'other' }),
    job('foreign-future', 'swarm', { callerSessionId: 'other', version: 2 }),
    { delegation: { inputTokens: 200 } },
  ];
  jobs.push(jobs[0]);
  const result = delegationObservations(JSON.parse(JSON.stringify(jobs)), 'lead');
  assert.equal(result.retained, 7);
  assert.equal(result.unmeasured, 2);
  assert.equal(result.inputMeasured, 2);
  assert.equal(result.outputMeasured, 2);
});

test('rejects invalid counters and keeps measured zero; observations round-trip over the wire', () => {
  const source = job('a', 'balanced', {
    inputTokens: null,
    outputTokens: 0,
    queueWaitMs: '0',
    elapsedMs: -1,
    toolCalls: Infinity,
  });
  const result = delegationObservations(JSON.parse(JSON.stringify([source])), 'lead').rows[0];
  assert.equal(result.inputTokens, null);
  assert.equal(result.outputTokens, 0);
  assert.equal(result.queueWaitMs, null);
  assert.equal(result.elapsedMs, null);
  assert.equal(result.toolCalls, null);
});

test('orders recent jobs first without dropping active jobs above the registry soft capacity', () => {
  const old = job('a', 'focused');
  const recent = { ...job('b', 'swarm'), startedAt: '2026-10-14T01:00:00.000Z' };
  assert.equal(delegationObservations([old, recent], 'lead').rows[0].id, 'b');
  assert.equal(
    delegationObservations(
      Array.from({ length: 500 }, (_, i) => job(String(i), 'swarm')),
      'lead'
    ).rows.length,
    500
  );
});
