import assert from 'node:assert/strict';
import test from 'node:test';
import { createSlashExecutor } from './composer-slash-executor.ts';
import { createRemoteApi } from './remote-shim-api.ts';
import { publishedCeilings, withShim } from './remote-shim-test-harness.mjs';
import { requiredModelSelection, requiredNewTaskDraft } from '../main/ipc-validation.ts';
import { createProviderAuthApi } from '../../../../src/session-runtime/provider-auth-api.mjs';
import { listPresets } from '../../../../src/runtime/agent/orchestrator/config-presets.mjs';
import { makeResolveRoute } from '../../../../src/runtime/agent/orchestrator/runtime-core/config-helpers.mjs';

const preset = {
  id: 'remote-preset', name: 'Remote preset', provider: 'openai', model: 'remote-model',
  effort: 'high', fast: true, autoEffort: true, modelParameters: { serviceTier: 'priority' },
  contextPercent: 80, contextTokens: 640000, tools: 'readonly', type: 'agent',
};
const expected = {
  provider: 'openai', model: 'remote-model', effort: 'low', fast: false, autoEffort: false,
  modelParameters: {}, contextPercent: 40, contextTokens: 320000,
};
const runtime = createProviderAuthApi({
  cfgMod: { listPresets },
  displayConfig: () => ({ presets: [preset], modelSettings: { 'openai/remote-model': expected } }),
  resolveRoute: makeResolveRoute(() => 'fallback'),
});

async function nextCall(leg) {
  for (let i = 0; i < 6; i += 1) {
    const frame = await leg.nextPayload();
    if (['setRemoteLanes', 'synchronizeViews', 'setVisibleSessions', 'getSnapshot'].includes(frame.method)) {
      await leg.deliver({ id: frame.id, ok: true, value: true });
    } else return frame;
  }
  throw new Error('command frame did not arrive');
}

for (const supported of [false, true]) {
  for (const draft of [false, true]) {
    test(`resolved preset crosses real remote encryption and validation (${draft ? 'draft' : 'live'}, Auto support ${supported})`, async () => {
      await withShim({}, async ({ ctx, dial }) => {
        const api = createRemoteApi(ctx);
        window.mixdogDesktop = api;
        const leg = await dial({ routeAutoEffort: supported, ready: publishedCeilings(4096, 4096) });
        let staged;
        let prompts = 0;
        window.confirm = () => { prompts += 1; return true; };
        const execute = createSlashExecutor({
          draftMode: draft, sessionId: draft ? '' : 'remote-session', turnBusy: false,
          provider: 'openai', model: 'previous-model', effort: 'high', fast: false, fastCapable: true,
          onDraftModelSelection: (selection, options) => {
            assert.deepEqual(options, { replace: true });
            staged = selection;
          },
          invokeResult: (action) => action(),
          invokeCapabilityResult: (capability, args) => api.invokeCapability({ capability, args }),
          applySnapshot() {}, onRoutePreferenceApplied() {}, clearNotice() {},
          setAttachmentError(message) { assert.equal(message, ''); },
        });
        const pending = execute('/model Remote preset');
        const catalog = await nextCall(leg);
        assert.equal(catalog.method, 'invokeCapability');
        assert.equal(catalog.params[0].capability, 'listPresets');
        await leg.deliver({ id: catalog.id, ok: true, value: { value: runtime.listPresets() } });
        let sending = pending;
        if (draft) {
          assert.equal(await pending, true);
          assert.deepEqual(staged, expected);
          sending = api.submitNewTask('hello', { id: 'remote-preset-submit' }, { route: JSON.parse(JSON.stringify(staged)) });
        }
        const frame = await nextCall(leg);
        const wireExpected = { ...expected };
        if (!supported) delete wireExpected.autoEffort;
        if (draft) {
          assert.equal(frame.method, 'submitNewTask');
          assert.deepEqual(requiredNewTaskDraft(frame.params[2]), { route: wireExpected });
          assert.equal(frame.params[1].id, 'remote-preset-submit');
        } else {
          assert.equal(frame.method, 'setModelRoute');
          assert.equal(frame.params[1], 'remote-session');
          assert.deepEqual(requiredModelSelection(frame.params[0]), wireExpected);
        }
        await leg.deliver({ id: frame.id, ok: true, value: draft
          ? { accepted: true, sessionId: 'created', snapshot: { sessionId: 'created' } }
          : { ...wireExpected, sessionId: 'remote-session' } });
        await sending;
        assert.equal(prompts, 0, "preset selection preserves main's direct model-choice behavior");
        assert.equal(expected.autoEffort, false, 'old-host conversion does not mutate the resolved selection');
      });
    });
  }
}

test('an old remote host without resolved preset selections causes no route mutation', async () => {
  await withShim({}, async ({ ctx, dial }) => {
    const api = createRemoteApi(ctx);
    window.mixdogDesktop = api;
    window.confirm = () => assert.fail('an unresolved preset must not confirm');
    const leg = await dial({ ready: publishedCeilings(4096, 4096) });
    const errors = [];
    const execute = createSlashExecutor({
      sessionId: 'remote-session', turnBusy: false, provider: 'openai', model: 'previous-model',
      invokeCapabilityResult: (capability, args) => api.invokeCapability({ capability, args }),
      clearNotice() {}, setAttachmentError: (message) => errors.push(message),
    });
    const pending = execute('/model remote-preset');
    const frame = await nextCall(leg);
    assert.equal(frame.method, 'invokeCapability');
    await leg.deliver({ id: frame.id, ok: true, value: { value: [preset] } });
    assert.equal(await pending, false);
    assert.match(errors.at(-1), /Update the host/);
    assert.equal(ctx.pending.size, 0, 'no mutation RPC followed the read');
  });
});
