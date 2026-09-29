import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

let persisted;
mock.module('../tui-steering-persist.mjs', {
  namedExports: {
    appendTuiSteeringPersist: () => persisted,
    dropTuiSteeringPersist: () => Promise.resolve(),
    drainTuiSteeringPersist: async () => [],
  },
});
const { createSessionFlow } = await import('../session-flow.mjs');

function busyFlow() {
  const state = { busy: true, commandBusy: false, queued: [] };
  const pending = [];
  let nextId = 0;
  const flow = createSessionFlow({
    runtime: { id: 'session-persistence' },
    flags: {},
    pending,
    pendingNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    nextId: () => `queued-${++nextId}`,
    tuiDebug() {},
    pushUserOrSyntheticItem() {},
    flushDeferredExecutionPendingResumeKick() {},
    runTurn: async () => 'done',
  });
  return { state, pending, flow };
}

test('a steering prompt a turn already took stays accepted when its durable mirror fails', async () => {
  const f = busyFlow();
  let fail;
  persisted = new Promise((resolve) => {
    fail = () => resolve(false);
  });
  const accepted = f.flow.enqueue('steer this', { id: 'submit-1', awaitPersistence: true });
  const steered = f.flow.drainPendingSteering({ turnEpoch: 1 });
  assert.deepEqual(
    steered.map((message) => message.content),
    ['steer this']
  );
  fail();
  assert.equal(await accepted, true);
});

test('a steering prompt still queued is withdrawn and rejected when its durable mirror fails', async () => {
  const f = busyFlow();
  persisted = Promise.resolve(false);
  assert.equal(await f.flow.enqueue('steer this', { id: 'submit-2', awaitPersistence: true }), false);
  assert.deepEqual(f.pending, []);
  assert.deepEqual(f.state.queued, []);
  assert.deepEqual(f.flow.drainPendingSteering({ turnEpoch: 1 }), []);
});
