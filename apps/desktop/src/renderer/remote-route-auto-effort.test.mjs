// Real shim + E2EE framing; the legacy selection field list is frozen from
// ipc-validation.ts at v1.1.2 (22d55fe1). Value validation uses today's host.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteApi } from './remote-shim-api.ts';
import { requiredModelSelection } from '../main/ipc-validation.ts';
import { automationAutoEffortSuffix } from './automation-editor-support.ts';
import { publishedCeilings, withShim, until, FakeSocket } from './remote-shim-test-harness.mjs';
import { inspectRouteDiagnostics, readRouteDiagnostics } from '../../../../src/runtime/shared/route-diagnostics.mjs';

const legacyFields = new Set(['provider', 'model', 'effort', 'fast', 'modelParameters', 'contextPercent']);
const selection = Object.freeze({
  provider: 'anthropic', model: 'opus', effort: 'high', fast: true,
  modelParameters: Object.freeze({ service_tier: 'priority' }), contextPercent: 75,
});
function validateSelection(value, supported) {
  if (!supported) assert.deepEqual(Object.keys(value).filter((key) => !legacyFields.has(key)), []);
  return requiredModelSelection(value);
}
async function answer(leg, pending, value = null) {
  const frame = await leg.nextPayload();
  await leg.deliver({ id: frame.id, ok: true, value });
  await pending;
  return frame;
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
        const requested = { ...selection, ...(autoEffort === undefined ? {} : { autoEffort }) };
        // Like a saved draft restored after an app restart, not a shared object.
        const restored = JSON.parse(JSON.stringify(requested));
        for (const [name, send, pick] of operations) {
          const frame = await answer(leg, send(api, restored));
          const actual = validateSelection(pick(frame), supported);
          const expected = { ...selection, ...(supported && autoEffort !== undefined ? { autoEffort } : {}) };
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
      assert.equal(pick(frame).autoEffort, false);
    });
  });
}

test('a route waiting on view sync is projected for the reconnected host, in both directions', async () => {
  for (const initial of [false, true]) {
    await withShim({}, async ({ ctx, dial }) => {
      const api = createRemoteApi(ctx);
      const first = await dial({ routeAutoEffort: initial, ready: publishedCeilings(4096, 4096) });
      let release;
      let waiting = false;
      ctx.peerViewSync = true;
      ctx.viewSync.ready = () => { waiting = true; return new Promise((resolve) => { release = resolve; }); };
      const pending = api.setModelRoute({ ...selection, autoEffort: false }, 's1');
      await until(() => waiting, 'the old view-sync wait');
      first.ws.readyState = FakeSocket.CLOSED;
      first.ws.onclose({ code: 1006, reason: 'test reconnect' });
      const second = await dial({ routeAutoEffort: !initial, ready: publishedCeilings(4096, 4096) });
      release();
      const frame = await answer(second, pending);
      assert.deepEqual(validateSelection(frame.params[0], !initial), { ...selection, ...(!initial ? { autoEffort: false } : {}) });
      assert.equal(api.routeAutoEffort, !initial);
    });
  }
});

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
      assert.deepEqual(frame.params, [request]);
      await leg.deliver({ id: frame.id, ok: true, value: status });
      const received = await pending;
      assert.deepEqual(received, status);
      assert.equal(Boolean(readRouteDiagnostics(received.routeDiagnostics, 's1')), Boolean(status.routeDiagnostics));
    }
  });
});
