import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelRouteApi } from './model-route-api.mjs';
import { makeResolveRoute } from '../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';

// Real route adoption with controlled discovery/persistence. No provider I/O.
function fixture() {
  const initial = { provider: 'custom-boundary', model: 'first', effort: 'medium', fast: false };
  const next = { provider: 'custom-boundary', model: 'second', effort: 'high', fast: false };
  const makeSession = (id) => ({ id, ...initial, messages: [
    { role: 'user', content: 'task' }, { role: 'assistant', content: 'reply' },
  ] });
  const state = { config: { modelSettings: {} }, route: { ...initial }, session: makeSession('original'), activeTurns: 0 };
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const writes = [];
  const api = createModelRouteApi({
    getConfig: () => state.config, getConfigHasSecrets: () => false,
    getRoute: () => state.route, setRouteState: (route) => { writes.push('route'); state.route = route; },
    getActiveTurnCount: () => state.activeTurns,
    getSession: () => state.session, setSession: (session) => { state.session = session; },
    cfgMod: { loadConfig: () => state.config },
    resolveRoute: makeResolveRoute(() => 'custom-boundary'),
    ensureProvidersReady: async () => {},
    lookupModelMeta: async (_provider, model) => {
      entered.resolve();
      await release.promise;
      return { id: model, contextWindow: 100000, reasoningLevels: ['low', 'medium', 'high'] };
    },
    adoptConfig: (config) => { writes.push('config'); state.config = config; },
    persistLeadRoute: () => null,
    saveConfigAndAdopt: (config) => { writes.push('persist'); state.config = config; },
    refreshRouteEffort: async () => {},
    refreshStatuslineUsageSnapshot: () => writes.push('status'),
    scheduleStatuslineUsageRefresh() {}, invalidateContextStatusCache() {}, statusRoutes: {},
    mgr: { updateSessionRoute(id, fields) {
      assert.equal(id, state.session.id, 'the durable address must remain current');
      writes.push('session'); Object.assign(state.session, fields); return state.session;
    } },
  });
  return { api, state, entered, release, writes, next, makeSession };
}

for (const [name, invoke] of [
  ['addressed route', (f) => f.api.setRoute(f.next, { applyToCurrentSession: true })],
  ['session-surface route', (f) => f.api.setRoute(f.next, { switchEstablished: true })],
  ['quota continuation', (f) => f.api.continueSessionInModel('original', f.next)],
]) {
  for (const removed of [false, true]) {
    test(`${name} rejects a ${removed ? 'removed' : 'replaced'} session before any route persistence`, async () => {
      const f = fixture();
      const pending = invoke(f);
      const rejected = assert.rejects(pending, /not the active session/);
      await f.entered.promise;
      f.state.session = removed ? null : f.makeSession('replacement');
      const before = structuredClone(f.state);
      f.release.resolve();
      await rejected;
      assert.deepEqual(f.state, before);
      assert.deepEqual(f.writes, [], 'no settings, route, status or session write is authorized');
    });
  }
}

test('a refreshed copy of the same durable session receives the switch and its boundary', async () => {
  const f = fixture();
  const original = f.state.session;
  const pending = f.api.setRoute(f.next, { switchEstablished: true });
  await f.entered.promise;
  f.state.session = structuredClone(original);
  f.release.resolve();
  const result = await pending;
  assert.equal(f.state.session.id, 'original');
  assert.equal(f.state.session.model, 'second');
  assert.equal(original.model, 'first');
  assert.equal(result.modelSwitch.modelId, 'second');
  assert.deepEqual(f.state.session.messages[1].meta.modelSwitches, [result.modelSwitch]);
});

test('validate-only discovery remains free of route, configuration and session writes', async () => {
  const f = fixture();
  const before = structuredClone(f.state);
  const pending = f.api.setRoute(f.next, { validateOnly: true });
  await f.entered.promise;
  f.release.resolve();
  await pending;
  assert.deepEqual(f.state, before);
  assert.deepEqual(f.writes, []);
});

for (const quota of [false, true]) {
  test(`${quota ? 'quota continuation' : 'bound model choice'} refuses a turn that starts during discovery`, async () => {
    const f = fixture();
    const pending = quota
      ? f.api.continueSessionInModel('original', f.next)
      : f.api.setRoute(f.next, { switchEstablished: true });
    const rejected = assert.rejects(pending, /response is running/);
    await f.entered.promise;
    f.state.activeTurns = 1;
    const before = structuredClone(f.state);
    f.release.resolve();
    await rejected;
    assert.deepEqual(f.state, before);
    assert.deepEqual(f.writes, []);
  });
}

test('same-model tuning and an unaddressed next-session choice remain allowed during a turn', async () => {
  for (const bound of [false, true]) {
    const f = fixture();
    f.state.activeTurns = 1;
    const selection = bound ? { ...f.next, model: 'first' } : f.next;
    const pending = f.api.setRoute(selection, bound ? { switchEstablished: true } : {});
    await f.entered.promise;
    f.release.resolve();
    await pending;
    assert.equal(f.state.session.model, 'first');
    assert.equal(f.state.route.model, bound ? 'first' : 'second');
  }
});
