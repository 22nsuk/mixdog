import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmComputerTurnsStopped } from './stop-turns.ts';
import { createComputerOverlayController } from './controls.ts';
import { computerUseOverlayPresentation } from './model.ts';

test('every owner receives Stop even when one abort fails; raw errors never reach the pill', async () => {
  const calls = [];
  await assert.rejects(
    confirmComputerTurnsStopped(['a', 'b'], async (id) => {
      calls.push(id);
      if (id === 'a') throw new Error('private runtime error');
    }),
    (error) => {
      assert.match(error.message, /computer_stop_unconfirmed/);
      assert.doesNotMatch(error.message, /private/);
      return true;
    }
  );
  assert.deepEqual(calls, ['a', 'b']);
  await confirmComputerTurnsStopped([], async () => {
    assert.fail('no owner to abort');
  });
});

test('a missing daemon reply expires and a late reply cannot turn the failure into success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  const pending = confirmComputerTurnsStopped(
    ['a'],
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const rejected = assert.rejects(pending, /computer_stop_unconfirmed.*timed out/);
  t.mock.timers.tick(10_000);
  await rejected;
  finish();
  await assert.rejects(pending, /computer_stop_unconfirmed/);
});

test('repeated Stop shares one completion and a failed Stop can be retried', async () => {
  let calls = 0,
    fail;
  const controller = createComputerOverlayController(
    {
      stop: async () => {
        calls++;
        if (calls === 1)
          await new Promise((_, reject) => {
            fail = reject;
          });
      },
    },
    () => {}
  );
  const first = controller.invoke('stop', ['fixture']);
  const second = controller.invoke('stop', ['fixture']);
  assert.equal(first, second);
  assert.equal(calls, 1);
  fail(new Error('computer_stop_unconfirmed'));
  await Promise.all([first, second]);
  assert.deepEqual(controller.state(), { busy: false, error: 'stop' });
  const presentation = computerUseOverlayPresentation(
    {
      revision: 1,
      userControlActive: true,
      takeoverReason: 'user_stop',
      takeoverGeneration: 3,
      cleanupState: 'ready',
      pausedSessionIds: ['fixture'],
      activities: [],
      cursors: [],
      targetLeases: [],
    },
    'ko',
    controller.state()
  );
  assert.equal(presentation.attention, true);
  assert.equal(presentation.visible, true);
  await controller.invoke('stop', ['fixture']);
  assert.equal(calls, 2);
  assert.deepEqual(controller.state(), { busy: false, error: '' });
});

test('a session holding the user window keeps the controls on screen between commands', () => {
  const snapshot = {
    revision: 1,
    userControlActive: false,
    takeoverGeneration: 0,
    cleanupState: 'ready',
    pausedSessionIds: [],
    activities: [],
    cursors: [],
    keystrokes: [],
    targetLeases: [{ sessionId: 'holder', windowId: 'hwnd:0x1', expiresAt: null }],
  };
  // A command runs for a fraction of a second; the user reaches for Stop
  // between commands, when the session still holds their window.
  const held = computerUseOverlayPresentation(snapshot, 'ko');
  assert.equal(held.visible, true);
  assert.deepEqual(held.sessionIds, ['holder']);
  // Releasing the target ends the hold, and nothing is left on screen.
  const released = computerUseOverlayPresentation({ ...snapshot, targetLeases: [] }, 'ko');
  assert.equal(released.visible, false);
});

test('target-local cleanup failure is reported as a cleanup error', async () => {
  const controller = createComputerOverlayController(
    {
      stop: async () => {
        throw new Error('computer_background_cleanup_unconfirmed');
      },
    },
    () => {}
  );
  await controller.invoke('stop', []);
  assert.equal(controller.state().error, 'cleanup');
});

test('a lost control surface reports its pause failure without calling task-ending Stop', async () => {
  const controller = createComputerOverlayController(
    {
      stop: async () => {
        assert.fail('Pause must not cancel the task');
      },
      pause: async () => {
        throw new Error('computer_cleanup_pending');
      },
    },
    () => {}
  );
  await controller.invoke('pause', ['fixture']);
  assert.equal(controller.state().error, 'cleanup');
});

test('a control that never settles releases the pill and accepts the next press', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const controller = createComputerOverlayController(
    {
      stop: () => {
        calls += 1;
        return new Promise(() => {});
      },
    },
    () => {}
  );
  const first = controller.invoke('stop', ['fixture']);
  t.mock.timers.tick(15_000);
  await first;
  // The unanswered request must not hold the pill busy or swallow the next
  // Stop, which is the user's only guaranteed way out.
  assert.deepEqual(controller.state(), { busy: false, error: 'failed' });
  const second = controller.invoke('stop', ['fixture']);
  t.mock.timers.tick(15_000);
  await second;
  assert.equal(calls, 2);
});
