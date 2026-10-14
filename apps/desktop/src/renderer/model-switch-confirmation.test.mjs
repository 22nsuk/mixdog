import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { confirmSessionModelChange } from './model-switch-confirmation.ts';
import { createSlashExecutor } from './composer-slash-executor.ts';
import { registerSessionIpc } from '../main/ipc-sessions.ts';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { requiredModelSelection } from '../main/ipc-validation.ts';

function fixture(t, { accepted = true, draft = false, preset = false, legacy = false, sameModel = false, sessionModel } = {}) {
  const previousWindow = globalThis.window;
  const prompts = [];
  const writes = [];
  const snapshots = [];
  const preferences = [];
  const preferenceOptions = [];
  const drafts = [];
  const errors = [];
  const target = { provider: 'anthropic', model: 'claude-next', display: 'Next' };
  const selection = {
    provider: target.provider, model: target.model, effort: 'low', fast: false, autoEffort: false,
    modelParameters: { serviceTier: 'priority' }, contextPercent: 80, contextTokens: 640000,
  };
  const handlers = new Map();
  registerSessionIpc({
    handle: (name, handler) => handlers.set(name, handler),
    host: {
      setModelRoute(next, id) {
        writes.push({ selection: next, id });
        return { ...target, ...next, sessionId: id, sessionProvider: target.provider, sessionModel: target.model };
      },
    },
    invokeDesktopOperation: async () => {},
  });
  globalThis.window = {
    confirm(message) {
      assert.equal(writes.length, 0, 'confirmation precedes the backend mutation');
      assert.equal(preferences.length, 0, 'confirmation precedes preference writes');
      prompts.push(message);
      return accepted;
    },
    mixdogDesktop: {
      listProviderModels: async () => [target],
      setModelRoute: async (selection, id) => handlers.get(DESKTOP_IPC.setModelRoute)(null, selection, id),
    },
  };
  t.after(() => { globalThis.window = previousWindow; });
  const execute = createSlashExecutor({
    draftMode: draft,
    sessionId: draft ? '' : 'session-existing',
    turnBusy: false,
    provider: sameModel ? target.provider : 'openai',
    model: sameModel ? target.model : 'gpt-current',
    sessionProvider: sessionModel ? target.provider : undefined,
    sessionModel,
    effort: 'high',
    fast: false,
    fastCapable: false,
    onDraftModelSelection: (next) => drafts.push(next),
    onRoutePreferenceApplied: (next, options) => {
      preferences.push(next);
      preferenceOptions.push(options);
    },
    invokeResult: async (action) => action(),
    invokeCapabilityResult: async (name) => {
      assert.equal(name, 'listPresets');
      return { value: preset ? [{
        id: 'next-preset', provider: 'raw-provider', model: 'raw-model',
        effort: 'high', fast: true, tools: 'readonly', type: 'agent',
        ...(legacy ? {} : { selection }),
      }] : [] };
    },
    applySnapshot: (snapshot) => snapshots.push(snapshot),
    clearNotice() {},
    setAttachmentError: (message) => errors.push(message),
    onOpenSettings() {},
  });
  return { execute, target, selection, prompts, writes, snapshots, preferences, preferenceOptions, drafts, errors };
}

for (const accepted of [true, false]) {
  for (const preset of [false, true]) {
    test(`/model ${preset ? 'preset' : 'model'} ${accepted ? 'applies only after confirmation' : 'cancel leaves the session unchanged'}`, async (t) => {
      const h = fixture(t, { accepted, preset });
      const result = await h.execute(`/model ${preset ? 'next-preset' : h.target.model}`);
      assert.deepEqual(h.errors.filter(Boolean), []);
      assert.equal(h.prompts.length, 1);
      assert.match(h.prompts[0], /prompt cache/);
      assert.match(h.prompts[0], /cost and latency/);
      assert.match(h.prompts[0], /conversation will be kept/);
      assert.equal(h.writes.length, accepted ? 1 : 0);
      assert.equal(h.snapshots.length, accepted ? 1 : 0);
      assert.equal(h.preferences.length, accepted ? 1 : 0);
      if (accepted) {
        assert.equal(h.writes[0].id, 'session-existing');
        assert.deepEqual(h.writes[0].selection, preset
          ? h.selection
          : { provider: h.target.provider, model: h.target.model });
        assert.deepEqual(h.preferences[0], preset ? h.selection : { provider: h.target.provider, model: h.target.model });
      } else {
        assert.equal(result, false, 'a cancelled command keeps the composer draft');
      }
    });
  }
}

test('a draft model choice does not confirm or write to a live session', async (t) => {
  const h = fixture(t, { draft: true, accepted: false });
  await h.execute(`/model ${h.target.model}`);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.drafts, [{ provider: h.target.provider, model: h.target.model }]);
});

test('a draft preset stages its entire resolved selection without a live write', async (t) => {
  const h = fixture(t, { draft: true, preset: true, accepted: false });
  assert.equal(await h.execute('/model next-preset'), true);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.drafts, [h.selection]);
});

test('a same-model preset applies tuning without confirmation or counting as a model choice', async (t) => {
  const h = fixture(t, { preset: true, accepted: false, sameModel: true });
  assert.equal(await h.execute('/model next-preset'), true);
  assert.equal(h.prompts.length, 0);
  assert.deepEqual(h.writes[0].selection, h.selection);
  assert.deepEqual(h.preferenceOptions, [{ replace: true }]);
});

for (const draft of [false, true]) {
  test(`an old host's unresolved preset is refused for ${draft ? 'drafts' : 'live sessions'}`, async (t) => {
    const h = fixture(t, { preset: true, legacy: true, draft });
    assert.equal(await h.execute('/model next-preset'), false);
    assert.match(h.errors.at(-1), /Update the host or select a concrete model/);
    assert.deepEqual(h.prompts, []);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.drafts, []);
    assert.deepEqual(h.preferences, []);
  });
}

test('the real boundary still rejects provider-less selectors and preset metadata', () => {
  assert.throws(() => requiredModelSelection({ provider: '', model: 'next-preset' }), /selection.provider/);
  assert.throws(() => requiredModelSelection({ provider: 'anthropic', model: 'claude-next', tools: 'full' }), /unsupported/);
});

test('same-model tuning and a new-task selection do not prompt', async (t) => {
  const h = fixture(t, { accepted: false });
  const current = { provider: 'openai', model: 'gpt-current' };
  assert.equal(confirmSessionModelChange({ ...current, effort: 'low' }, current, 'session-existing'), true);
  assert.equal(confirmSessionModelChange(h.target, current, ''), true);
  assert.equal(h.prompts.length, 0);
});

test('/model compares against the actual session model rather than its saved selection', async (t) => {
  const h = fixture(t, { sessionModel: 'claude-old', accepted: false });
  await h.execute(`/model ${h.target.model}`);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.writes.length, 0);
});

test('the warning has a Korean translation for cache, cost, latency and confirmation', async (t) => {
  const h = fixture(t, { accepted: false });
  await h.execute(`/model ${h.target.model}`);
  const korean = JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'))[h.prompts[0]];
  assert.match(korean, /프롬프트 캐시/);
  assert.match(korean, /비용과 응답 시간/);
  assert.match(korean, /기존 대화는 유지/);
  assert.match(korean, /변경하시겠습니까/);
});
