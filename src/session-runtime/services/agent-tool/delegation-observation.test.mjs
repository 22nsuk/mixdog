import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginDelegationObservation,
  admitDelegationObservation,
  runDelegationObservation,
  finishDelegationObservation,
} from './delegation-observation.mjs';

const start = (mode = 'balanced') => {
  const job = { meta: {} };
  beginDelegationObservation(job, { callerSessionId: 'owner', orchestrationMode: mode }, 100);
  return job;
};

for (const mode of ['focused', 'balanced', 'swarm', 'none', null, 'future-mode']) {
  test(`delegation observations preserve the dispatch mode: ${mode}`, () => {
    const context = { callerSessionId: 'owner', orchestrationMode: mode };
    const job = { meta: {} };
    beginDelegationObservation(job, context, 100);
    context.orchestrationMode = 'swarm';
    admitDelegationObservation(job, 140);
    runDelegationObservation(job, 160);
    const result = {
      content: 'private handoff',
      usage: { inputTokens: 15, outputTokens: 0, costUsd: 42 },
      toolCallsTotal: 2,
    };
    finishDelegationObservation(job, 'completed', result, 260);
    assert.deepEqual(job.meta.delegation, {
      version: 1,
      callerSessionId: 'owner',
      mode: mode === 'future-mode' ? null : mode,
      phase: 'finished',
      outcome: 'completed',
      queueWaitMs: 40,
      preparationMs: 20,
      executionMs: 100,
      elapsedMs: 160,
      inputTokens: 15,
      outputTokens: 0,
      toolCalls: 2,
    });
    result.usage.inputTokens = 999;
    assert.equal(job.meta.delegation.inputTokens, 15);
    assert.equal(JSON.stringify(job.meta).includes('private handoff'), false);
    assert.equal(JSON.stringify(job.meta).includes('costUsd'), false);
  });
}

test('unknown usage is not zero and counters are not coerced', () => {
  for (const bad of [undefined, null, '', '12', true, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const job = start();
    finishDelegationObservation(
      job,
      'failed',
      { usage: { inputTokens: bad, outputTokens: bad }, toolCallsTotal: bad },
      150
    );
    assert.equal(job.meta.delegation.inputTokens, null);
    assert.equal(job.meta.delegation.outputTokens, null);
    assert.equal(job.meta.delegation.toolCalls, null);
    assert.equal(job.meta.delegation.executionMs, null);
  }
});

test('admission cancellation freezes before a late provider result and keeps usage unknown', () => {
  const job = start();
  finishDelegationObservation(job, 'cancelled', null, 150);
  const cancelled = job.meta.delegation;
  admitDelegationObservation(job, 200);
  runDelegationObservation(job, 210);
  finishDelegationObservation(job, 'completed', { usage: { inputTokens: 500 } }, 300);
  assert.equal(job.meta.delegation, cancelled);
  assert.equal(cancelled.queueWaitMs, 50);
  assert.equal(cancelled.preparationMs, null);
  assert.equal(cancelled.executionMs, null);
  assert.equal(cancelled.inputTokens, null);
});

test('preparation failures and watchdog partial handoffs have separate outcomes', () => {
  const prep = start();
  admitDelegationObservation(prep, 120);
  finishDelegationObservation(prep, 'failed', null, 180);
  assert.equal(prep.meta.delegation.preparationMs, 60);
  assert.equal(prep.meta.delegation.executionMs, null);
  const partial = start();
  admitDelegationObservation(partial, 110);
  runDelegationObservation(partial, 140);
  finishDelegationObservation(partial, 'partial', null, 200);
  assert.equal(partial.meta.delegation.outcome, 'partial');
  assert.equal(partial.meta.delegation.executionMs, 60);
});

test('terminal snapshots survive meta merges and same-tag/session reuse', () => {
  const first = start('focused');
  first.meta = { ...first.meta, tag: 'same', sessionId: 'worker' };
  admitDelegationObservation(first, 120);
  runDelegationObservation(first, 130);
  finishDelegationObservation(first, 'completed', { usage: { inputTokens: 10, outputTokens: 3 } }, 200);
  const frozen = first.meta.delegation;
  const second = start('swarm');
  second.meta = { ...second.meta, tag: 'same', sessionId: 'worker' };
  finishDelegationObservation(second, 'completed', { usage: { inputTokens: 20, outputTokens: 4 } }, 300);
  finishDelegationObservation(first, 'failed', null, 400);
  assert.equal(first.meta.delegation, frozen);
  assert.equal(first.meta.delegation.inputTokens, 10);
  assert.equal(second.meta.delegation.inputTokens, 20);
});

test('unobserved jobs and repeated lifecycle reports are harmless', () => {
  for (const job of [null, undefined, {}, { meta: {} }]) {
    admitDelegationObservation(job);
    runDelegationObservation(job);
    finishDelegationObservation(job, 'failed');
  }
  const job = start();
  admitDelegationObservation(job, 120);
  admitDelegationObservation(job, 500);
  runDelegationObservation(job, 140);
  runDelegationObservation(job, 600);
  finishDelegationObservation(job, 'not-an-outcome', null, 700);
  assert.equal(job.meta.delegation.outcome, null);
  finishDelegationObservation(job, 'completed', null, 200);
  assert.equal(job.meta.delegation.queueWaitMs, 20);
  assert.equal(job.meta.delegation.executionMs, 60);
});
