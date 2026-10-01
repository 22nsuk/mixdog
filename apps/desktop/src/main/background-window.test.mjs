import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBackgroundWindow } from './background-window.ts';

function harness({ enabled = true, quitting = false } = {}) {
  const state = { hides: 0, prevented: 0 };
  const background = createBackgroundWindow({ enabled: () => enabled, quitting: () => quitting });
  const close = () =>
    background.onClose(
      {
        preventDefault: () => {
          state.prevented += 1;
        },
      },
      () => {
        state.hides += 1;
      }
    );
  return { state, close };
}

test('hide to tray: every close hides the window without asking', () => {
  const { state, close } = harness();
  close();
  close();
  assert.deepEqual([state.prevented, state.hides], [2, 2]);
});

test('quit on close, or an approved quit, lets the window close', () => {
  for (const options of [{ enabled: false }, { quitting: true }]) {
    const { state, close } = harness(options);
    close();
    assert.deepEqual([state.prevented, state.hides], [0, 0]);
  }
});
