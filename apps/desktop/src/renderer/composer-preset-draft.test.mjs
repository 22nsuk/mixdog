import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { createSlashExecutor } from './composer-slash-executor.ts';
import { registerSessionIpc } from '../main/ipc-sessions.ts';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { requiredModelSelection } from '../main/ipc-validation.ts';
import { createProviderAuthApi } from '../../../../src/session-runtime/provider-auth-api.mjs';
import { listPresets } from '../../../../src/runtime/agent/orchestrator/config-presets.mjs';
import { makeResolveRoute } from '../../../../src/runtime/agent/orchestrator/runtime-core/config-helpers.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['navigator'],
});
const { useDraftPanePreferences } = await import('./use-draft-pane-preferences.ts');
const { useAppSubmitRouting } = await import('./use-app-submit-routing.ts');
const { routePreferenceStore } = await import('./app-route-preference.ts');
const DRAFT = { kind: 'new', draftId: 'preset-draft' };
const resolveProject = (candidate) => String(candidate || '');

async function mountDraft(config, submissions) {
  const runtime = createProviderAuthApi({
    cfgMod: { listPresets }, displayConfig: () => config,
    resolveRoute: makeResolveRoute(() => 'fallback'),
  });
  const handlers = new Map();
  registerSessionIpc({
    handle: (name, handler) => handlers.set(name, handler),
    host: {
      submitNewTask(content, options, draft) {
        submissions.push({ content, options, draft });
        return { accepted: true, sessionId: 'created-session', snapshot: { sessionId: 'created-session' } };
      },
    },
    invokeDesktopOperation: async () => {},
  });
  window.mixdogDesktop = {
    rendererDiagnostic() {},
    submitNewTask: async (...args) => handlers.get(DESKTOP_IPC.submitNewTask)(null, ...args),
    setModelRoute() { assert.fail('a draft cannot mutate a live route'); },
  };
  window.confirm = () => assert.fail('a draft cannot prompt for a live route change');
  let prefs;
  let routing;
  function Harness() {
    const selectionRef = useRef(DRAFT);
    prefs = useDraftPanePreferences({
      selection: DRAFT, selectionRef, snapshot: {},
      projectCatalogValidated: true, preferredDraftProjectPath: '',
      effectiveDraftProjectPath: resolveProject,
    });
    routing = useAppSubmitRouting({
      selectionRef, focusedLeafIdRef: useRef('leaf'),
      paneLeavesRef: useRef([{ type: 'leaf', id: 'leaf', tabs: [DRAFT], activeKey: 'new:preset-draft' }]),
      navigationEpoch: useRef(0),
      resolvedDraftPrefsFor: prefs.resolvedDraftPrefsFor,
      effectiveDraftProjectPath: resolveProject,
      clearNewTaskPreferences: prefs.clearNewTaskPreferences,
      setNewTaskDeferred: prefs.setNewTaskDeferred,
      stageCreatedSession() {}, activateSelection() {}, promoteSelectionInLeaf() {},
      registerWorkspaceSelection() {}, applySessionLaneResult() {},
    });
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness)));
  return {
    selection: () => prefs.resolvedDraftPrefsFor(DRAFT.draftId).modelSelection,
    focused: () => prefs.newTaskModelSelection,
    choose: async (name) => {
      const execute = createSlashExecutor({
        draftMode: true, turnBusy: false, provider: 'openai', model: 'draft-model',
        effort: 'high', fast: false, fastCapable: true,
        onDraftModelSelection: prefs.stageNewTaskModelSelection,
        invokeCapabilityResult: async () => ({ value: runtime.listPresets() }),
        clearNotice() {}, setAttachmentError(message) { assert.equal(message, ''); },
      });
      await act(async () => assert.equal(await execute(`/model ${name}`), true));
    },
    submit: async () => {
      await act(async () => {
        assert.equal(await routing.paneDraftSubmitFor(DRAFT, 'leaf')('hello', { id: 'preset-submit' }), true);
      });
    },
    rememberLive: async (selection) => {
      await act(async () => prefs.rememberSessionRouteForNextTask(selection, { replace: true, modelChoice: true }));
    },
    inherited: () => prefs.lastNewTaskPrefs.current.modelSelection,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

for (const saved of [false, true]) {
  test(`a tuned preset ${saved ? 'with saved overrides' : 'without overrides'} stages, restores, and submits through IPC`, async () => {
    window.localStorage.clear();
    const preset = {
      id: 'tuned', name: 'Tuned preset', provider: 'openai', model: `draft-model-${saved}`,
      effort: 'high', fast: true, autoEffort: false, modelParameters: { serviceTier: 'priority' },
      contextPercent: 80, contextTokens: 640000, tools: 'readonly', type: 'agent',
    };
    const overrides = {
      effort: 'low', fast: false, autoEffort: true, modelParameters: {}, contextPercent: 40, contextTokens: 320000,
    };
    const config = {
      presets: [preset],
      ...(saved ? { modelSettings: { [`openai/${preset.model}`]: overrides } } : {}),
    };
    const expected = {
      provider: preset.provider, model: preset.model, effort: 'high', fast: true, autoEffort: false,
      modelParameters: { serviceTier: 'priority' }, contextPercent: 80, contextTokens: 640000,
      ...(saved ? overrides : {}),
    };
    const before = structuredClone(config);
    const submissions = [];
    const first = await mountDraft(config, submissions);
    try {
      await first.choose('TUNED PRESET');
      assert.deepEqual(first.selection(), expected);
      assert.deepEqual(first.focused(), expected);
      assert.deepEqual(requiredModelSelection(first.selection()), expected);
    } finally {
      await first.unmount();
    }
    const restored = await mountDraft(config, submissions);
    try {
      assert.deepEqual(restored.selection(), expected);
      assert.deepEqual(restored.focused(), expected);
      await restored.submit();
      assert.deepEqual(submissions, [{ content: 'hello', options: { id: 'preset-submit' }, draft: { route: expected } }]);
      assert.deepEqual(config, before, 'listing/staging/submitting never rewrites saved config');
    } finally {
      await restored.unmount();
    }
  });
}

test('a resolved preset replaces same-model cached tuning, including omitted fields, after restoration', async () => {
  window.localStorage.clear();
  const identity = { provider: 'openai', model: 'preset-replacement' };
  const stale = { ...identity, effort: 'high', fast: true, autoEffort: false,
    modelParameters: { serviceTier: 'priority' }, contextPercent: 80, contextTokens: 640000 };
  routePreferenceStore.remember(stale);
  const config = { presets: [{ id: 'plain', name: 'Plain', ...identity, tools: 'full' }] };
  const expected = { ...identity, fast: false, autoEffort: true, modelParameters: {} };
  const submissions = [];
  const first = await mountDraft(config, submissions);
  try {
    await first.choose('plain');
    assert.deepEqual(first.selection(), expected);
    assert.deepEqual(routePreferenceStore.get(identity.provider, identity.model), expected);
  } finally {
    await first.unmount();
  }
  const restored = await mountDraft(config, submissions);
  try {
    assert.deepEqual(restored.selection(), expected);
    await restored.submit();
    assert.deepEqual(submissions[0].draft.route, expected);
    await restored.rememberLive(stale);
    await restored.rememberLive(expected);
    assert.deepEqual(restored.inherited(), expected, 'successful live presets also replace omitted cached tuning');
  } finally {
    await restored.unmount();
  }
});
