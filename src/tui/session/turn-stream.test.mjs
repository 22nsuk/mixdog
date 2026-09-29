import assert from 'node:assert/strict';
import test from 'node:test';

import { applyStageChange, createTurnStream } from './turn-stream.mjs';

function streamWithSpinner() {
  let state = { spinner: { mode: 'requesting' } };
  const stream = createTurnStream({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    isCurrentTurn: () => true,
  });
  return { stream, spinner: () => state.spinner };
}

test('a reconnect wait counts down live and stops once the stage moves on', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const { stream, spinner } = streamWithSpinner();
  await applyStageChange(stream, 'reconnecting', {
    attempt: 1,
    max: 3,
    reason: 'Connection lost',
    retryAt: 1_000_000 + 15_000,
    message: 'Connection lost · retry 1/3 in 15s',
  });
  assert.equal(spinner().mode, 'reconnecting');
  assert.equal(spinner().verb, 'Connection lost · retry 1/3 in 15s');
  t.mock.timers.tick(1_000);
  assert.equal(spinner().verb, 'Connection lost · retry 1/3 in 14s');
  t.mock.timers.tick(5_000);
  assert.equal(spinner().verb, 'Connection lost · retry 1/3 in 9s');

  await applyStageChange(stream, 'requesting');
  assert.equal(spinner().mode, 'requesting');
  const settled = spinner().verb;
  t.mock.timers.tick(3_000);
  assert.equal(spinner().verb, settled);
});

test('a reconnect notice without a retry time keeps its own message', async () => {
  const { stream, spinner } = streamWithSpinner();
  await applyStageChange(stream, 'reconnecting', { message: 'Reconnecting... 2/3' });
  assert.equal(spinner().verb, 'Reconnecting... 2/3');
});
