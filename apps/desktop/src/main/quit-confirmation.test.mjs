import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createQuitConfirmation } from './quit-confirmation.ts';

function harness({ inspect, response = 0, deadlineMs } = {}) {
  const shown = [];
  const confirmation = createQuitConfirmation({
    inspect,
    show: async (options) => {
      shown.push(options);
      return { response, checkboxChecked: false };
    },
    nativeT: (key) => key,
    deadlineMs,
  });
  return { confirmation, shown };
}

test('quits silently when no agent is working', async () => {
  const { confirmation, shown } = harness({ inspect: async () => false });
  assert.equal(await confirmation.confirm(), true);
  assert.equal(shown.length, 0);
});

test('asks while agents work; Quit approves and Cancel keeps the app', async () => {
  const quit = harness({ inspect: async () => true, response: 0 });
  assert.equal(await quit.confirmation.confirm(), true);
  assert.equal(quit.shown.length, 1);
  assert.equal(quit.shown[0].cancelId, 1);

  const cancel = harness({ inspect: async () => true, response: 1 });
  assert.equal(await cancel.confirmation.confirm(), false);
});

test('a failed or late inspection counts as work in progress', async () => {
  const failed = harness({ inspect: async () => Promise.reject(new Error('daemon gone')), response: 1 });
  assert.equal(await failed.confirmation.confirm(), false);
  assert.equal(failed.shown.length, 1);

  const late = harness({ inspect: () => new Promise(() => {}), response: 1, deadlineMs: 10 });
  assert.equal(await late.confirmation.confirm(), false);
  assert.equal(late.shown.length, 1);
});

test('repeated quit requests join the open decision', async () => {
  let inspections = 0;
  const { confirmation, shown } = harness({
    inspect: async () => {
      inspections += 1;
      return true;
    },
  });
  const [first, second] = await Promise.all([confirmation.confirm(), confirmation.confirm()]);
  assert.deepEqual([first, second], [true, true]);
  assert.equal(inspections, 1);
  assert.equal(shown.length, 1);
});
