import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionRouteApi } from './routes.mjs';

function fixture() {
  let state = {
    sessionId: 'session-live-model',
    provider: 'openai',
    model: 'old-model',
    effort: 'high',
    busy: false,
    commandBusy: false,
    stats: {},
  };
  const session = { id: state.sessionId, provider: state.provider, model: state.model };
  let live = { ...state };
  const calls = [];
  const previews = [];
  let onRoute = async (next) => next;
  let quotaResets = 0;
  const api = createSessionRouteApi({
    runtime: {
      session,
      async setRoute(next, options) {
        const resolved = await onRoute(next, options);
        const provider = resolved.provider || live.provider;
        const model = resolved.model || live.model;
        if (
          options.applyToCurrentSession && state.busy &&
          (provider !== session.provider || model !== session.model)
        ) throw new Error('Cannot change the session model while a turn is running.');
        calls.push({ next, options });
        live = { ...live, ...resolved };
        if (options.applyToCurrentSession) Object.assign(session, resolved);
        return live;
      },
    },
    getState: () => state,
    set(patch) {
      previews.push(patch);
      state = { ...state, ...patch };
    },
    routeState: () => ({ provider: live.provider, model: live.model, effort: live.effort }),
    flushEmitImmediate() {},
    syncContextStats() {},
    supersedeQuotaResume() {
      quotaResets += 1;
    },
  });
  return {
    api,
    session,
    calls,
    previews,
    getState: () => state,
    setState: (patch) => { state = { ...state, ...patch }; },
    onRoute: (run) => { onRoute = run; },
    quotaResets: () => quotaResets,
  };
}

test('a busy live model change is refused without preview, persistence or quota-reset changes', async () => {
  const h = fixture();
  h.setState({ busy: true });
  const before = h.getState();
  await assert.rejects(
    h.api.setRoute({ provider: 'openai', model: 'new-model', applyToCurrentSession: true }),
    /while a turn is running/
  );
  assert.deepEqual(h.getState(), before);
  assert.equal(h.calls.length, 0);
  assert.ok(h.previews.every((patch) => patch.model !== 'new-model'));
  assert.equal(h.quotaResets(), 0);
});

test('an idle addressed change updates the real session and published route', async () => {
  const h = fixture();
  await h.api.setRoute({ provider: 'anthropic', model: 'new-model', applyToCurrentSession: true });
  assert.deepEqual(h.calls[0].options, { applyToCurrentSession: true, keepMainModel: false });
  assert.equal(h.session.model, 'new-model');
  assert.equal(h.session.provider, 'anthropic');
  assert.equal(h.getState().model, 'new-model');
  assert.equal(h.getState().commandBusy, false);
});

test('same-model tuning and next-session selections remain available during a turn', async () => {
  const h = fixture();
  h.setState({ busy: true });
  await h.api.setRoute({
    provider: 'openai',
    model: 'old-model',
    effort: 'low',
    applyToCurrentSession: true,
  });
  await h.api.setRoute({ provider: 'anthropic', model: 'next-model' });
  assert.equal(h.calls.length, 2);
  assert.equal(h.session.model, 'old-model');
  assert.equal(h.session.effort, 'low');
  assert.equal(h.getState().model, 'next-model');
});

test('a serialized live model change checks busy again before its runtime write', async () => {
  const h = fixture();
  const gate = Promise.withResolvers();
  h.onRoute(async (next) => { await gate.promise; return next; });
  const first = h.api.setRoute({ effort: 'low', applyToCurrentSession: true });
  const second = h.api.setRoute({ model: 'new-model', applyToCurrentSession: true });
  const rejection = assert.rejects(second, /while a turn is running/);
  h.setState({ busy: true });
  gate.resolve();
  await first;
  await rejection;
  assert.equal(h.calls.length, 1);
  assert.equal(h.session.model, 'old-model');
  assert.equal(h.getState().model, 'old-model');
  assert.equal(h.getState().effort, 'low', 'the earlier committed tuning is published after rejection');
  assert.equal(h.getState().commandBusy, false);
});

test('a preset resolving to the current model can tune it during a turn', async () => {
  const h = fixture();
  h.setState({ busy: true });
  h.onRoute(async (next) => ({ ...next, model: 'old-model', effort: 'low' }));
  await h.api.setRoute({ model: 'same-model-preset', applyToCurrentSession: true });
  assert.equal(h.session.model, 'old-model');
  assert.equal(h.session.effort, 'low');
  assert.equal(h.getState().model, 'old-model');
  assert.ok(h.previews.every((patch) => patch.model !== 'same-model-preset'));
});

test('an omitted-model request refused by the runtime never previews tuning or cancels quota wait', async () => {
  const h = fixture();
  await h.api.setRoute({ provider: 'anthropic', model: 'next-model' });
  h.setState({ busy: true });
  const before = h.getState();
  const quotaResets = h.quotaResets();
  h.previews.length = 0;
  await assert.rejects(
    h.api.setRoute({ effort: 'low', applyToCurrentSession: true }),
    /while a turn is running/
  );
  assert.deepEqual(h.getState(), before);
  assert.ok(h.previews.every((patch) => patch.effort !== 'low'));
  assert.equal(h.quotaResets(), quotaResets);
});

test('a rejected later live selection still publishes the earlier committed model', async () => {
  const h = fixture();
  const gate = Promise.withResolvers();
  h.onRoute(async (next) => {
    await gate.promise;
    if (next.model === 'rejected-model') throw new Error('model rejected');
    return next;
  });
  const first = h.api.setRoute({ model: 'accepted-model', applyToCurrentSession: true });
  const second = h.api.setRoute({ model: 'rejected-model', applyToCurrentSession: true });
  const rejection = assert.rejects(second, /model rejected/);
  gate.resolve();
  await first;
  await rejection;
  assert.equal(h.session.model, 'accepted-model');
  assert.equal(h.getState().model, 'accepted-model');
  assert.equal(h.getState().commandBusy, false);
  assert.ok(h.previews.every((patch) => patch.model !== 'rejected-model'));
});
