import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelRouteApi } from './model-route-api.mjs';
import { createContextStatus } from '../runtime/agent/orchestrator/runtime-core/context-status.mjs';
import { createRuntimeFacade } from './runtime-facade.mjs';
import { createContextState } from '../tui/session/context-state.mjs';
import { SUMMARY_PREFIX } from '../runtime/agent/orchestrator/session/compact.mjs';
import { makeResolveRoute } from '../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';

const sourceRoute = { provider: 'openai', model: 'gpt-5.4', effort: 'high', fast: false };
const heirRoute = {
  provider: 'openai',
  model: 'gpt-5.3-codex',
  effort: 'low',
  fast: true,
  contextPercent: 70,
};

function fixture(extra = {}) {
  let config = { modelSettings: {} };
  const state = {
    activeTurnCount: 0,
    updates: [],
    route: { ...sourceRoute, contextPercent: 100, effectiveEffort: 'high' },
    session: {
      id: 'session-route-lock',
      ...sourceRoute,
      contextPercent: 100,
      contextWindow: 128_000,
      rawContextWindow: 128_000,
      compactBoundaryTokens: 128_000,
      compaction: { auto: true, boundaryTokens: 128_000 },
      messages: [
        { role: 'user', content: 'Keep working on this task.' },
        { role: 'assistant', content: 'Working on it.' },
      ],
      providerState: { continuation: 'source-provider' },
      ...extra,
    },
  };
  let resolveRequestedRoute = (_config, requested) => ({ ...state.route, ...requested });
  let onAdopt = () => {};
  const api = createModelRouteApi({
    getConfig: () => config,
    getConfigHasSecrets: () => false,
    getRoute: () => state.route,
    setRouteState: (value) => {
      state.route = value;
      onAdopt();
    },
    getSession: () => state.session,
    getActiveTurnCount: () => state.activeTurnCount,
    setSession: (value) => {
      state.session = value;
    },
    cfgMod: { loadConfig: () => config },
    resolveRoute: (config, requested) => resolveRequestedRoute(config, requested),
    lookupModelMeta: async (_provider, model) => ({
      id: model,
      fastCapable: true,
      reasoningLevels: ['low', 'medium', 'high'],
      contextWindow: 512_000,
      maxContextWindow: 512_000,
    }),
    ensureProvidersReady: async () => {},
    adoptConfig: (value) => {
      config = value;
    },
    persistLeadRoute: () => null,
    saveConfigAndAdopt: (value) => {
      config = value;
    },
    refreshRouteEffort: async () => {
      state.route = { ...state.route, effectiveEffort: state.route.effort, selectedContextWindow: 512_000 };
    },
    refreshStatuslineUsageSnapshot() {},
    scheduleStatuslineUsageRefresh() {},
    invalidateContextStatusCache() {},
    statusRoutes: {},
    mgr: {
      updateSessionRoute(id, next, options) {
        state.updates.push({ id, next, options });
        Object.assign(state.session, next, {
          contextWindow: 512_000,
          rawContextWindow: 512_000,
          compactBoundaryTokens: 512_000,
        });
        return state.session;
      },
    },
  });
  return {
    api,
    state,
    getConfig: () => config,
    setResolver: (resolve) => { resolveRequestedRoute = resolve; },
    onAdopt: (run) => { onAdopt = run; },
  };
}

for (const [name, extra] of [
  ['established', {}],
  ['first in-flight turn', { messages: [], liveTurnMessages: [{ role: 'user', content: 'First task' }] }],
  ['compacted', { messages: [{ role: 'user', content: `${SUMMARY_PREFIX}\nRetained task` }] }],
]) {
  test(`${name} conversation keeps model, context and provider state for a default selection`, async () => {
    const { api, state } = fixture(extra);
    const before = structuredClone(state.session);
    await api.setRoute(heirRoute);
    assert.equal(state.route.model, heirRoute.model, 'the heir selection is retained');
    assert.deepEqual(state.session, before, 'a default selection cannot rewrite the source');
    await api.setEffort('medium');
    await api.setFast(false);
    assert.deepEqual(state.session, before, 'heir tuning cannot leak into the source model');
  });
}

for (const [name, extra] of [
  ['established', {}],
  ['compacted', { messages: [{ role: 'user', content: `${SUMMARY_PREFIX}\nRetained task` }] }],
  ['failed compaction', { lastCompaction: { outcome: 'failed', error: 'summary request failed' } }],
]) {
  test(`explicit live apply moves an idle ${name} conversation without requiring compaction`, async () => {
    const { api, state } = fixture(extra);
    const before = structuredClone(state.session);
    await api.setRoute(heirRoute, { applyToCurrentSession: true });
    assert.equal(state.session.id, before.id);
    assert.equal(state.session.model, heirRoute.model);
    assert.equal(state.session.contextWindow, 512_000);
    assert.deepEqual(state.session.messages, before.messages);
    assert.deepEqual(state.session.lastCompaction, before.lastCompaction);
    assert.equal(state.updates.length, 1);
    assert.deepEqual(state.updates[0].options, { crossProvider: true });
  });
}

test('explicit live apply also moves an idle conversation to another provider', async () => {
  const { api, state } = fixture();
  const messages = structuredClone(state.session.messages);
  await api.setRoute({ ...heirRoute, provider: 'anthropic' }, { applyToCurrentSession: true });
  assert.equal(state.session.provider, 'anthropic');
  assert.deepEqual(state.session.messages, messages);
  assert.deepEqual(state.updates[0].options, { crossProvider: true });
});

for (const active of ['count', 'transcript']) {
  test(`explicit model change rejects an active turn detected by ${active} before route adoption`, async () => {
    const { api, state } = fixture(
      active === 'transcript' ? { liveTurnMessages: [{ role: 'user', content: 'Running task' }] } : {}
    );
    if (active === 'count') state.activeTurnCount = 1;
    const before = structuredClone(state);
    await assert.rejects(api.setRoute(heirRoute, { applyToCurrentSession: true }), /while a turn is running/);
    assert.deepEqual(state, before);
  });
}

test('effort and Fast update the current model without touching its context or cache', async () => {
  const { api, state } = fixture();
  await api.setEffort('low');
  await api.setFast(true);
  assert.equal(state.session.effort, 'low');
  assert.equal(state.session.fast, true);
  const before = structuredClone(state.session);
  await api.setRoute(
    {
      ...sourceRoute,
      effort: 'medium',
      fast: false,
      contextPercent: 50,
    },
    { applyToCurrentSession: true }
  );
  assert.deepEqual(state.session, { ...before, effort: 'medium', fast: false });
});

test('live apply rechecks active turns after asynchronous model resolution', async () => {
  const { api, state } = fixture();
  const operation = api.setRoute(heirRoute, { applyToCurrentSession: true });
  state.activeTurnCount = 1;
  const before = structuredClone(state);
  await assert.rejects(operation, /while a turn is running/);
  assert.deepEqual(state, before);
});

test('route adoption and live model application finish before another turn can start', async () => {
  const h = fixture();
  const observed = [];
  h.onAdopt(() => {
    queueMicrotask(() => {
      observed.push({ routeModel: h.state.route.model, sessionModel: h.state.session.model });
      h.state.activeTurnCount = 1;
    });
  });
  await h.api.setRoute(heirRoute, { applyToCurrentSession: true });
  assert.deepEqual(observed, [{ routeModel: heirRoute.model, sessionModel: heirRoute.model }]);
  assert.equal(h.state.session.id, 'session-route-lock');
});

test('a preset resolving to the current model can tune an active session', async () => {
  const h = fixture();
  h.getConfig().presets = [{ id: 'current-model', ...sourceRoute }];
  h.getConfig().default = 'current-model';
  h.setResolver(makeResolveRoute(() => sourceRoute.provider));
  h.state.activeTurnCount = 1;
  await h.api.setRoute({ model: 'current-model', effort: 'low' }, { applyToCurrentSession: true });
  assert.equal(h.state.session.model, sourceRoute.model);
  assert.equal(h.state.session.effort, 'low');
  assert.equal(h.state.updates.length, 0);
});

test('omitting a model cannot apply a different next-session selection during a turn', async () => {
  const { api, state } = fixture();
  await api.setRoute(heirRoute);
  state.activeTurnCount = 1;
  const before = structuredClone(state);
  await assert.rejects(api.setRoute({ effort: 'medium' }, { applyToCurrentSession: true }), /while a turn is running/);
  assert.deepEqual(state, before);
});

test('same-model live tuning remains available while a turn is running', async () => {
  const { api, state } = fixture();
  state.activeTurnCount = 1;
  await api.setRoute({ ...sourceRoute, effort: 'low' }, { applyToCurrentSession: true });
  assert.equal(state.session.model, sourceRoute.model);
  assert.equal(state.session.effort, 'low');
  assert.equal(state.updates.length, 0);
});

test('an addressed empty heir can choose a model without changing its durable id', async () => {
  const { api, state } = fixture({ messages: [] });
  await api.setRoute(heirRoute, { applyToCurrentSession: true });
  assert.equal(state.session.id, 'session-route-lock');
  assert.equal(state.session.model, heirRoute.model);
  assert.equal(state.session.contextWindow, 512_000);
});

test('a conversation whose prompts were refused before any reply follows the new model in place', async () => {
  const refused = [{ role: 'user', content: 'First task' }];
  const { api, state } = fixture({ messages: refused });
  await api.setRoute(heirRoute, { applyToCurrentSession: true });
  assert.equal(state.session.id, 'session-route-lock');
  assert.equal(state.session.model, heirRoute.model);
  assert.deepEqual(state.session.messages, refused, 'the refused prompt is kept for retry');
});

test('heir selection leaves the source context gauge and compact trigger unchanged', async () => {
  const { api, state } = fixture({ tools: [] });
  const contextApi = createContextStatus({
    getSession: () => state.session,
    getRoute: () => state.route,
    getCurrentCwd: () => process.cwd(),
    getMode: () => 'full',
  });
  const runtime = createRuntimeFacade({
    state,
    getContextStatus: contextApi.contextStatus,
    getAutoClear: () => ({}),
    getSystemShell: () => ({}),
    getWebSearchRoute: () => null,
    getWorkflow: () => null,
    getOrchestrationMode: () => 'none',
  });
  let display = {
    sessionId: state.session.id,
    clientHostPid: process.pid,
    ...sourceRoute,
    contextWindow: 128_000,
    rawContextWindow: 128_000,
    displayContextWindow: 128_000,
    compactBoundaryTokens: 128_000,
    autoCompactTokenLimit: 115_200,
  };
  const { routeState } = createContextState({
    runtime,
    getState: () => display,
    updateState: (patch) => {
      display = { ...display, ...patch };
    },
    getPendingSessionReset: () => false,
  });
  const before = contextApi.contextStatus();
  await api.setRoute(heirRoute);
  const after = contextApi.contextStatus();
  assert.equal(after.model, sourceRoute.model);
  assert.equal(after.provider, sourceRoute.provider);
  assert.equal(after.contextWindow, before.contextWindow);
  assert.equal(after.compaction.triggerTokens, before.compaction.triggerTokens);
  assert.equal(after.usedTokens, before.usedTokens);
  const next = routeState();
  assert.equal(next.model, heirRoute.model);
  assert.equal(next.contextPercent, heirRoute.contextPercent);
  assert.equal(next.displayContextWindow, display.displayContextWindow);
  assert.equal(next.autoCompactTokenLimit, display.autoCompactTokenLimit);
});

test('snapshot sessionProvider/sessionModel track the session route, not the selected route', async () => {
  const build = (state) => {
    const runtime = createRuntimeFacade({
      state,
      getContextStatus: () => ({}),
      getAutoClear: () => ({}),
      getSystemShell: () => ({}),
      getWebSearchRoute: () => null,
      getWorkflow: () => null,
      getOrchestrationMode: () => 'none',
    });
    let display = {};
    return createContextState({
      runtime,
      getState: () => display,
      updateState: (patch) => {
        display = { ...display, ...patch };
      },
      getPendingSessionReset: () => false,
    }).routeState;
  };
  const history = fixture();
  const historyState = build(history.state);
  await history.api.setRoute(heirRoute, { applyToCurrentSession: true });
  const kept = historyState();
  assert.equal(kept.model, heirRoute.model);
  assert.equal(kept.sessionModel, heirRoute.model);
  assert.equal(kept.sessionProvider, sourceRoute.provider);
  assert.equal(kept.sessionModel, kept.model);

  const empty = fixture({ messages: [] });
  const emptyState = build(empty.state);
  await empty.api.setRoute(heirRoute, { applyToCurrentSession: true });
  assert.equal(emptyState().sessionModel, heirRoute.model);
});

test('continueSessionInModel moves an established session in place', async () => {
  const { api, state } = fixture();
  const result = await api.continueSessionInModel('session-route-lock', heirRoute);
  assert.equal(result, true);
  assert.equal(state.session.id, 'session-route-lock');
  assert.equal(state.session.model, heirRoute.model);
  assert.equal(state.session.effort, 'low');
  assert.equal(state.route.model, heirRoute.model);
  assert.equal(state.session.contextWindow, 512_000);
});

test('continueSessionInModel rejects a session that is not the addressed one', async () => {
  const { api, state } = fixture();
  await assert.rejects(api.continueSessionInModel('other-session', heirRoute), /not the active session/);
  assert.equal(state.session.model, sourceRoute.model);
});
