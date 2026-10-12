// Real shim + E2EE framing; the legacy selection field list is frozen from
// ipc-validation.ts at v1.1.2 (22d55fe1). Value validation uses today's host.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteApi } from './remote-shim-api.ts';
import { requiredModelSelection } from '../main/ipc-validation.ts';
import { automationAutoEffortSuffix } from './automation-editor-support.ts';
import { publishedCeilings, withShim, until, settle, FakeSocket } from './remote-shim-test-harness.mjs';
import { readRouteDiagnostics } from '../../../../src/runtime/shared/route-diagnostics.mjs';
import { inspectRouteDiagnostics } from '../../../../src/runtime/agent/orchestrator/runtime-core/route-diagnostics.mjs';
import { createRemoteViewSync } from './remote-view-sync.ts';
import { remoteConnectionInterruptedError } from './remote-connection-state.ts';

const legacyFields = new Set(['provider', 'model', 'effort', 'fast', 'modelParameters', 'contextPercent']);
const selection = Object.freeze({
  provider: 'anthropic', model: 'opus', effort: 'high', fast: true,
  modelParameters: Object.freeze({ serviceTier: 'priority' }), contextPercent: 80,
});
const routeMethods = {
  select: 'setModelRoute',
  inherit: 'inheritSession',
  continue: 'continueSessionInModel',
  draft: 'submitNewTask',
};
const sideMethods = new Set(['setRemoteLanes', 'synchronizeViews', 'setVisibleSessions', 'getSnapshot']);

function validateSelection(value, supported) {
  if (!supported) assert.deepEqual(Object.keys(value).filter((key) => !legacyFields.has(key)), []);
  return requiredModelSelection(value);
}

function withAuto(base, include, autoEffort) {
  if (!include) return { ...base };
  return { ...base, autoEffort };
}

/** Reconnect replay publishes setRemoteLanes before a route call, and a
 *  view-syncing host publishes synchronizeViews before either. Answer those
 *  by method; the route frame is whichever call this test started. */
async function answer(leg, pending, value = null) {
  for (let i = 0; i < 6; i += 1) {
    const frame = await leg.nextPayload();
    if (sideMethods.has(frame.method)) {
      await leg.deliver({ id: frame.id, ok: true, value: true });
      continue;
    }
    if (!Object.values(routeMethods).includes(frame.method)) {
      throw new Error(`unexpected frame ${String(frame.method)}`);
    }
    await leg.deliver({ id: frame.id, ok: true, value });
    await pending;
    return frame;
  }
  throw new Error('route frame did not arrive');
}

/** The production gate: ready() stays pending until synchronizeViews settles,
 *  and close() rejects that wait as interrupted. */
function holdViewSync(ctx) {
  let waiting = 0;
  const sync = createRemoteViewSync({
    synchronize: () => ctx.invoke('synchronizeViews', [[]]),
    state: (state) => {
      if (state === 'connected') ctx.publishLanes();
    },
    error() {},
    interrupted: remoteConnectionInterruptedError,
  });
  ctx.viewSync = {
    open: () => sync.open(),
    close: () => sync.close(),
    request: () => sync.request(),
    ready: () => {
      waiting += 1;
      return sync.ready();
    },
  };
  return { waiting: () => waiting };
}

function drop(leg) {
  leg.ws.readyState = FakeSocket.CLOSED;
  leg.ws.onclose({ code: 1006, reason: 'test reconnect' });
}

const operations = [
  ['select', (api, value) => api.setModelRoute(value, 's1'), (frame) => frame.params[0]],
  ['inherit', (api, value) => api.inheritSession('s1', value, null), (frame) => frame.params[1]],
  ['continue', (api, value) => api.continueSessionInModel('s1', value), (frame) => frame.params[1]],
  ['draft', (api, value) => api.submitNewTask('hello', { id: 'stable-submit' }, { projectPath: '/p', route: value }), (frame) => frame.params[2].route],
];

for (const supported of [false, true]) {
  for (const autoEffort of [undefined, false, true]) {
    test(`host capability ${supported}: restored selection with Auto ${autoEffort} preserves every other option`, async () => {
      await withShim({}, async ({ ctx, dial }) => {
        const api = createRemoteApi(ctx);
        const leg = await dial({ routeAutoEffort: supported, ready: publishedCeilings(4096, 4096) });
        const requested = autoEffort === undefined ? { ...selection } : { ...selection, autoEffort };
        // Like a saved draft restored after an app restart, not a shared object.
        const restored = JSON.parse(JSON.stringify(requested));
        for (const [name, send, pick] of operations) {
          const frame = await answer(leg, send(api, restored));
          assert.equal(frame.method, routeMethods[name]);
          const actual = validateSelection(pick(frame), supported);
          const expected = withAuto(selection, supported ? autoEffort !== undefined : false, autoEffort);
          assert.deepEqual(actual, expected, name);
          assert.deepEqual(restored, requested, 'compatibility never mutates the saved selection');
          if (name === 'draft') {
            assert.equal(frame.params[1].id, 'stable-submit');
            assert.equal(frame.params[2].projectPath, '/p');
          }
        }
        assert.equal(api.routeAutoEffort, supported);
        window.mixdogDesktop = api;
        assert.equal(automationAutoEffortSuffix(false), supported ? '+noauto' : '');
        assert.equal(automationAutoEffortSuffix(true), '');
      });
    });
  }
}

for (const [name, send, pick] of operations) {
  test(`${name} waits for the cold handshake before deciding whether to omit Auto`, async () => {
    await withShim({}, async ({ ctx, dial }) => {
      const api = createRemoteApi(ctx);
      const opening = dial({ routeAutoEffort: true, ready: publishedCeilings(4096, 4096) });
      // dial has not delivered the challenge yet. The old eager conversion
      // permanently removed this flag before call() waited for the handshake.
      const pending = send(api, { ...selection, autoEffort: false });
      const frame = await answer(await opening, pending);
      assert.equal(frame.method, routeMethods[name]);
      assert.equal(pick(frame).autoEffort, false);
    });
  });
}

test('a call waiting on view sync rejects as interrupted on socket close and never reaches the next host', async () => {
  await withShim({}, async ({ ctx, dial }) => {
    const gate = holdViewSync(ctx);
    const api = createRemoteApi(ctx);
    const first = await dial({
      routeAutoEffort: true,
      ready: { ...publishedCeilings(4096, 4096), viewSync: 1 },
    });
    const requested = { ...selection, autoEffort: false };
    const pending = [
      api.setModelRoute(requested, 's1'),
      api.inheritSession('s1', requested, null),
      api.continueSessionInModel('s1', requested),
    ];
    const syncFrame = await first.nextPayload();
    assert.equal(syncFrame.method, 'synchronizeViews');
    await until(() => gate.waiting() === pending.length, 'calls waiting on view sync');
    assert.equal(first.ws.sent.length, 2, 'the waiting calls were not sent');
    drop(first);
    for (const call of pending) {
      await assert.rejects(call, { code: 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED' });
    }
    assert.equal(first.ws.sent.length, 2, 'close did not flush the waiting calls');
    const second = await dial({ routeAutoEffort: false, ready: publishedCeilings(4096, 4096) });
    const replay = await second.nextPayload();
    assert.equal(replay.method, 'setRemoteLanes');
    await second.deliver({ id: replay.id, ok: true, value: true });
    await settle();
    assert.equal(second.ws.sent.length, 2, 'the interrupted calls never reached the next host');
  });
});

for (const initial of [false, true]) {
  for (const viewSync of [false, true]) {
    test(`calls made disconnected project for the reconnected host (capability ${initial} -> ${!initial}, viewSync ${viewSync ? 1 : 'off'})`, async () => {
      await withShim({}, async ({ ctx, dial }) => {
        if (viewSync) holdViewSync(ctx);
        const api = createRemoteApi(ctx);
        const nextSupported = !initial;
        const requested = { ...selection, autoEffort: false };
        const restored = JSON.parse(JSON.stringify(requested));
        for (const [name, send, pick] of operations) {
          const prior = await dial({ routeAutoEffort: initial, ready: publishedCeilings(4096, 4096) });
          drop(prior);
          const opening = dial({
            routeAutoEffort: nextSupported,
            ready: { ...publishedCeilings(4096, 4096), ...(viewSync ? { viewSync: 1 } : {}) },
          });
          const pending = send(api, restored);
          const frame = await answer(await opening, pending);
          assert.equal(frame.method, routeMethods[name], name);
          const actual = validateSelection(pick(frame), nextSupported);
          const expected = withAuto(selection, nextSupported, false);
          assert.deepEqual(actual, expected, name);
          assert.deepEqual(restored, requested, 'compatibility never mutates the saved selection');
          if (name === 'draft') {
            assert.equal(frame.params[1].id, 'stable-submit');
            assert.equal(frame.params[2].projectPath, '/p');
          }
          drop(await opening);
        }
        assert.equal(api.routeAutoEffort, nextSupported);
      });
    });
  }
}

test('current hosts accept an older client omission without inventing a route override', () => {
  assert.deepEqual(requiredModelSelection(selection), selection);
  assert.throws(() => requiredModelSelection({ ...selection, autoEffort: 'false' }), /autoEffort|boolean/i);
  assert.throws(() => requiredModelSelection({ ...selection, unknownOption: true }), /unsupported|unknown/i);
});

test('diagnostics use the existing capability envelope and remain optional for old hosts', async () => {
  await withShim({}, async ({ ctx, dial }) => {
    const api = createRemoteApi(ctx);
    const leg = await dial({ ready: publishedCeilings(4096, 4096) });
    const request = { capability: 'contextStatus', sessionId: 's1', args: [{ inspect: true }] };
    for (const status of [{ sessionId: 's1' }, { sessionId: 's1', routeDiagnostics: inspectRouteDiagnostics({ id: 's1', ...selection, messages: [] }) }]) {
      const pending = api.invokeCapability(request);
      const frame = await leg.nextPayload();
      assert.equal(frame.method, 'invokeCapability');
      assert.deepEqual(frame.params, [request]);
      await leg.deliver({ id: frame.id, ok: true, value: status });
      const received = await pending;
      assert.deepEqual(received, status);
      assert.equal(Boolean(readRouteDiagnostics(received.routeDiagnostics, 's1')), Boolean(status.routeDiagnostics));
    }
  });
});
