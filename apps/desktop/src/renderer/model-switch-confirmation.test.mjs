import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { confirmSessionModelChange } from './model-switch-confirmation.ts';
import { createSlashExecutor } from './composer-slash-executor.ts';

function fixture(t, { accepted = true, draft = false, preset = false, sessionModel } = {}) {
  const previousWindow = globalThis.window;
  const prompts = [];
  const writes = [];
  const snapshots = [];
  const preferences = [];
  const drafts = [];
  const errors = [];
  const target = { provider: 'anthropic', model: 'claude-next', display: 'Next' };
  globalThis.window = {
    confirm(message) {
      assert.equal(writes.length, 0, 'confirmation precedes the backend mutation');
      assert.equal(preferences.length, 0, 'confirmation precedes preference writes');
      prompts.push(message);
      return accepted;
    },
    mixdogDesktop: {
      listProviderModels: async () => [target],
      setModelRoute: async (selection, id) => {
        writes.push({ selection, id });
        return { ...target, sessionId: id, sessionProvider: target.provider, sessionModel: target.model };
      },
    },
  };
  t.after(() => { globalThis.window = previousWindow; });
  const execute = createSlashExecutor({
    draftMode: draft,
    sessionId: draft ? '' : 'session-existing',
    turnBusy: false,
    provider: 'openai',
    model: 'gpt-current',
    sessionProvider: sessionModel ? target.provider : undefined,
    sessionModel,
    effort: 'high',
    fast: false,
    fastCapable: false,
    onDraftModelSelection: (next) => drafts.push(next),
    onRoutePreferenceApplied: (next) => preferences.push(next),
    invokeResult: async (action) => action(),
    invokeCapabilityResult: async (name) => {
      assert.equal(name, 'listPresets');
      return { value: preset ? [{ id: 'next-preset', ...target }] : [] };
    },
    applySnapshot: (snapshot) => snapshots.push(snapshot),
    clearNotice() {},
    setAttachmentError: (message) => errors.push(message),
    onOpenSettings() {},
  });
  return { execute, target, prompts, writes, snapshots, preferences, drafts, errors };
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
          ? { provider: '', model: 'next-preset' }
          : { provider: h.target.provider, model: h.target.model });
        assert.deepEqual(h.preferences[0], { provider: h.target.provider, model: h.target.model });
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
