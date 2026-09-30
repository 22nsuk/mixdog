import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createBackgroundWindow } from './background-window.ts';

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness({ enabled = true, quitting = false, response = 0, platform = 'win32' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-background-'));
  const state = { enabled, quitting, response, notices: 0, hides: 0, prevented: 0, quits: 0 };
  const noticeMarkerPath = join(directory, 'nested', 'background-notice-acknowledged');
  const background = createBackgroundWindow({
    enabled: () => state.enabled,
    quitting: () => state.quitting,
    noticeMarkerPath,
    quitInstead: () => {
      state.quits += 1;
    },
    showNotice: async () => {
      state.notices += 1;
      return { response: state.response, checkboxChecked: false };
    },
    nativeT: (key) => key,
    platform,
  });
  const close = async () => {
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
    await settle();
  };
  return { state, close, noticeMarkerPath, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('the first close explains once, then every close just hides', async () => {
  const { state, close, noticeMarkerPath, cleanup } = harness();
  try {
    await close();
    assert.deepEqual([state.prevented, state.notices, state.hides], [1, 1, 1]);
    assert.equal(existsSync(noticeMarkerPath), true);
    await close();
    assert.deepEqual([state.prevented, state.notices, state.hides], [2, 1, 2]);
  } finally {
    cleanup();
  }
});

test('choosing to quit remembers the answer and quits instead of hiding', async () => {
  const { state, close, noticeMarkerPath, cleanup } = harness({ response: 1 });
  try {
    await close();
    assert.deepEqual([state.prevented, state.notices, state.hides, state.quits], [1, 1, 0, 1]);
    assert.equal(existsSync(noticeMarkerPath), true);
  } finally {
    cleanup();
  }
});

test('dismissing the notice keeps the window and asks again next time', async () => {
  const { state, close, noticeMarkerPath, cleanup } = harness({ response: 2 });
  try {
    await close();
    assert.deepEqual([state.prevented, state.hides], [1, 0]);
    assert.equal(existsSync(noticeMarkerPath), false);
    state.response = 0;
    await close();
    assert.deepEqual([state.notices, state.hides], [2, 1]);
  } finally {
    cleanup();
  }
});

test('macOS hides without a notice: the Dock icon is the way back', async () => {
  const { state, close, cleanup } = harness({ platform: 'darwin' });
  try {
    await close();
    assert.deepEqual([state.prevented, state.notices, state.hides], [1, 0, 1]);
  } finally {
    cleanup();
  }
});

test('the setting off, or an approved quit, lets the window close', async () => {
  for (const options of [{ enabled: false }, { quitting: true }]) {
    const { state, close, cleanup } = harness(options);
    try {
      await close();
      assert.deepEqual([state.prevented, state.notices, state.hides], [0, 0, 0]);
    } finally {
      cleanup();
    }
  }
});
