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
  assert.equal(result.unmeasured, 3);
  assert.equal(result.rows[1].operation, 'send');
  assert.equal(delegationObservations([a], 'other').rows.length, 0);
});

test('older/missing snapshots are unavailable, not a fabricated zero-usage report', () => {
  for (const value of [undefined, null, 'bad', {}])
    assert.equal(delegationObservations(value, 'lead').available, false);
  assert.equal(delegationObservations([], '').available, false);
  assert.deepEqual(delegationObservations([], 'lead'), { available: true, rows: [], unmeasured: 0 });
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
