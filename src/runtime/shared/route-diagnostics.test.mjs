import assert from 'node:assert/strict';
import test from 'node:test';
import { autoEffortDecisionSnapshot, captureRouteDiagnostics, routeSettingsSnapshot, readRouteDiagnostics } from './route-diagnostics.mjs';
import { inspectRouteDiagnostics } from '../agent/orchestrator/runtime-core/route-diagnostics.mjs';
import { makeSummaryMessage } from '../agent/orchestrator/session/compact/messages.mjs';
import { renderTaskCompletionEnvelope } from './task-notification-envelope.mjs';

const configured = { id: 's1', provider: 'openai', model: 'gpt-6', effort: 'high', fast: false, autoEffort: true, contextWindow: 200000 };
const decision = { mode: 'on', source: 'built-in', reason: 'selected', selectedEffort: 'low', applied: true };
function user(overrides = {}) {
  return {
    role: 'user', content: 'private prompt',
    meta: { routeDiagnostics: captureRouteDiagnostics(configured, { decision, turnEffort: 'low', at: 1000 }), ...overrides },
  };
}
const inspect = (messages, rest = {}) => inspectRouteDiagnostics({ ...configured, messages, ...rest });

test('captures configured settings separately from the runtime preparation', () => {
  const result = inspect([user()]);
  assert.equal(result.current.effort, 'high');
  assert.equal(result.lastTurn.configured.effort, 'high');
  assert.equal(result.lastTurn.preparedEffort, 'low');
  assert.equal(result.lastTurn.auto.selectedEffort, 'low');
  assert.equal(result.lastTurn.auto.applied, true);
  assert.equal(result.lastTurn.recordedEffort, null);
  assert.equal(result.evidence, 'runtime-prepared-not-provider-confirmed');
});

test('an observation is not reported as an applied decision', () => {
  const receipt = captureRouteDiagnostics(configured, {
    decision: { ...decision, mode: 'observe', reason: 'observe-only', applied: false }, turnEffort: 'high',
  });
  const result = inspect([{ role: 'user', meta: { routeDiagnostics: receipt } }]);
  assert.equal(result.lastTurn.auto.selectedEffort, 'low');
  assert.equal(result.lastTurn.auto.applied, false);
  assert.equal(result.lastTurn.preparedEffort, 'high');
});

for (const reason of ['master-off', 'route-off', 'runtime-prompt', 'empty-or-tagged-prompt', 'unsupported-route', 'judge-unavailable', 'outside-auto-range']) {
  test(`keeps a ${reason} fallback distinguishable from an Auto selection`, () => {
    const receipt = captureRouteDiagnostics(configured, { decision: { mode: 'on', source: 'environment', reason, applied: false }, turnEffort: 'high' });
    assert.equal(receipt.auto.reason, reason);
    assert.equal(receipt.auto.applied, false);
    assert.equal(receipt.auto.selectedEffort, null);
    assert.equal(receipt.preparedEffort, 'high');
  });
}

test('uses live messages, then survives a persisted JSON round trip', () => {
  const live = [user()];
  const active = inspect([{ role: 'user' }], { liveTurnMessages: live });
  assert.equal(active.lastTurn.preparedEffort, 'low');
  const restored = inspect(JSON.parse(JSON.stringify(live)));
  assert.deepEqual(restored, active);
  assert.equal(inspect(live, { liveTurnMessages: [] }).lastTurn, null);
});

test('later route changes do not rewrite the historical preparation', () => {
  const messages = [user()];
  const result = inspect(messages, { provider: 'anthropic', model: 'claude-opus-5', effort: 'max', autoEffort: false });
  assert.equal(result.current.model, 'claude-opus-5');
  assert.equal(result.current.autoEffort, false);
  assert.equal(result.lastTurn.configured.model, 'gpt-6');
  assert.equal(result.lastTurn.configured.effort, 'high');
  assert.equal(result.lastTurn.preparedEffort, 'low');
});

test('does not reuse an earlier receipt for a newer unrecorded turn', () => {
  assert.equal(inspect([user(), { role: 'user', content: 'new task' }]).lastTurn, null);
  assert.equal(inspect([{ role: 'user', meta: { effortConfiguration: { effort: 'medium' } } }]).lastTurn, null);
});

test('tool-step effort updates do not mutate the turn preparation', () => {
  const messages = [user({ effortConfiguration: { effort: 'low' } }), { role: 'tool', meta: { effortConfiguration: { effort: 'medium' } } }, { role: 'tool', meta: { effortConfiguration: { effort: 'high' } } }];
  const before = JSON.stringify(messages);
  const result = inspect(messages);
  assert.equal(result.lastTurn.preparedEffort, 'low');
  assert.equal(result.lastTurn.recordedEffort, 'high');
  assert.equal(result.lastTurn.effortSource, 'tool-step');
  assert.equal(JSON.stringify(messages), before);
});

test('turn configuration is evidence, but assistant text is never an effort record', () => {
  const result = inspect([user({ effortConfiguration: { effort: 'medium' } }), { role: 'assistant', meta: { effortConfiguration: { effort: 'max' } } }]);
  assert.equal(result.lastTurn.recordedEffort, 'medium');
  assert.equal(result.lastTurn.effortSource, 'turn-configuration');
});

test('body-free allowlists omit provider secrets, arbitrary params, errors and probabilities', () => {
  const receipt = captureRouteDiagnostics({ ...configured, apiKey: 'secret', modelParameters: { serviceTier: 'priority', custom: 'sensitive parameter' } }, {
    decision: { ...decision, request: 'secret request', probs: [0, 1], judge: 'secret error payload' }, turnEffort: 'low',
  });
  receipt.password = 'secret';
  receipt.auto.error = 'secret';
  const result = inspect([{ role: 'user', content: 'secret prompt', meta: { routeDiagnostics: receipt } }]);
  const encoded = JSON.stringify(result);
  for (const value of ['secret', 'sensitive parameter', 'probs', 'apiKey', 'password']) assert.equal(encoded.includes(value), false);
  assert.equal(result.lastTurn.configured.serviceTier, 'priority');
  assert.equal(result.lastTurn.auto.judge, 'other');
});

test('round trip preserves absent-vs-recorded Auto and explicit false', () => {
  const { autoEffort: _omitted, ...legacyRoute } = configured;
  const receipt = captureRouteDiagnostics(legacyRoute);
  const result = inspect([{ role: 'user', meta: { routeDiagnostics: receipt } }]);
  assert.equal(result.lastTurn.configured.autoEffort, true);
  assert.equal(result.lastTurn.configured.autoEffortSource, 'implicit-default');
  assert.equal(routeSettingsSnapshot({ autoEffort: false }).autoEffort, false);
  assert.equal(routeSettingsSnapshot({ autoEffort: false }).autoEffortSource, 'recorded-field');
});

test('future or incomplete receipts remain unknown', () => {
  for (const receipt of [null, {}, { version: 2 }, { version: 1, configured: {} }, { version: 1, configured: [] }]) {
    assert.equal(inspect([{ role: 'user', meta: { routeDiagnostics: receipt } }]).lastTurn, null);
  }
});

test('bounds values and rejects control characters and unknown enums', () => {
  const value = routeSettingsSnapshot({ provider: 'p\nsecret', model: 'x'.repeat(201), effort: 'guess', fast: 'yes', contextWindow: Infinity, modelParameters: { serviceTier: 'secret' } });
  for (const key of ['provider', 'model', 'effort', 'fast', 'contextWindow', 'serviceTier']) assert.equal(value[key], null);
  assert.deepEqual(autoEffortDecisionSnapshot(null), { mode: null, source: null, reason: null, judge: null, selectedEffort: null, applied: null });
  assert.equal(routeSettingsSnapshot(null).model, null);
});

test('draft diagnostics do not invent a previous execution', () => {
  const result = inspectRouteDiagnostics(null, configured);
  assert.equal(result.currentSource, 'route');
  assert.equal(result.current.model, 'gpt-6');
  assert.equal(result.lastTurn, null);
});

test('the client boundary rejects a stale session and unsupported host versions', () => {
  const current = inspect([user()]);
  assert.deepEqual(readRouteDiagnostics(current, 's1'), current);
  assert.equal(readRouteDiagnostics(current, 's2'), null);
  assert.equal(readRouteDiagnostics({ ...current, version: 2 }, 's1'), null);
  assert.equal(readRouteDiagnostics(undefined, 's1'), null);
  assert.equal(readRouteDiagnostics({ version: 1, current: {} }), null);
});


test('inherited transcripts cannot masquerade as a preparation made in the new session', () => {
  assert.equal(inspect([user()], { id: 'inherited' }).lastTurn, null);
  const current = inspect([user()]);
  current.lastTurn.sessionId = 'other-session';
  assert.equal(readRouteDiagnostics(current, 's1').lastTurn, null);
});

test('judge availability uses real client codes without copying loader error details', () => {
  for (const state of ['unsupported', 'installing', 'model-missing', 'warming', 'busy', 'timeout']) {
    assert.equal(autoEffortDecisionSnapshot({ judge: state }).judge, state);
  }
  assert.equal(autoEffortDecisionSnapshot({ judge: 'load-error: /private/model/path secret' }).judge, 'load-error');
  assert.equal(autoEffortDecisionSnapshot({ judge: 'effort judge exited' }).judge, 'worker-exited');
});

test('drafts, sessions and receipts preserve the selected window and configured service tier', () => {
  const route = {
    ...configured, selectedContextWindow: 300000, contextWindow: 200000,
    fast: false, modelParameters: { serviceTier: 'ultrafast', privateOption: 'secret' },
  };
  const receipt = captureRouteDiagnostics(route, { turnEffort: 'high' });
  const session = { ...route, messages: [{ role: 'user', content: 'request', meta: { routeDiagnostics: receipt } }] };
  const draft = inspectRouteDiagnostics(null, route);
  const active = inspectRouteDiagnostics(session);
  for (const settings of [draft.current, active.current, active.lastTurn.configured]) {
    assert.equal(settings.contextWindow, 300000);
    assert.equal(settings.serviceTier, 'ultrafast');
    assert.equal(settings.fast, false, 'configured tier is not proof that Fast was applied');
    assert.equal(Object.hasOwn(settings, 'modelParameters'), false);
  }
  for (const report of [draft, active]) {
    assert.deepEqual(readRouteDiagnostics(JSON.parse(JSON.stringify(report))), report);
    assert.equal(report.evidence, 'runtime-prepared-not-provider-confirmed');
  }
  assert.equal(routeSettingsSnapshot({ contextWindow: 200000 }).contextWindow, 200000);
});

for (const [name, synthetic] of [
  ['explicit skill context', { role: 'user', meta: { source: 'skill-context' }, content: '<system-reminder>\nExplicit skill selection result:\nskill loaded\n</system-reminder>' }],
  ['injected skill body', { role: 'user', meta: 'skill', content: '<skill>private skill body</skill>' }],
  ['interruption', { role: 'user', content: '[Request interrupted by user]' }],
  ['process restart', { role: 'user', content: '[Request interrupted by process restart]' }],
  ['recovery', { role: 'user', meta: { source: 'stream-cut-recovery' }, content: 'Continue the response.' }],
  ['task notification', { role: 'user', content: renderTaskCompletionEnvelope({ id: 'task-1', status: 'completed', result: 'private result' }) }],
  ['compaction continuation', { role: 'user', meta: { source: 'compact-active-turn-continuation' }, content: 'Continue the active turn.' }],
]) {
  test(`${name} without a receipt does not hide the latest recorded turn`, () => {
    const messages = [user(), { role: 'tool', meta: { effortConfiguration: { effort: 'medium' } } }, synthetic];
    const before = JSON.stringify(messages);
    const result = inspect(messages);
    assert.equal(result.lastTurn.preparedEffort, 'low');
    assert.equal(result.lastTurn.recordedEffort, 'medium');
    assert.equal(result.lastTurn.effortSource, 'tool-step');
    assert.equal(JSON.stringify(messages), before);
  });
}

test('a runtime-authored turn with a receipt owns its preparation', () => {
  const receipt = captureRouteDiagnostics(configured, {
    decision: { mode: 'on', source: 'built-in', reason: 'runtime-prompt', applied: false },
    turnEffort: 'high',
  });
  const result = inspect([user(), {
    role: 'user', content: 'Continue the goal.',
    meta: { source: 'goal-continuation', routeDiagnostics: receipt },
  }]);
  assert.equal(result.lastTurn.auto.reason, 'runtime-prompt');
  assert.equal(result.lastTurn.preparedEffort, 'high');
});

test('invalid, future and inherited receipts on synthetic turns still block older history', () => {
  for (const receipt of [null, {}, { ...captureRouteDiagnostics(configured), version: 2 }, captureRouteDiagnostics({ ...configured, id: 'other' })]) {
    assert.equal(inspect([user(), {
      role: 'user', content: 'Continue the goal.',
      meta: { source: 'goal-continuation', routeDiagnostics: receipt },
    }]).lastTurn, null);
  }
});

test('queued human instructions and image-only requests invalidate an older receipt', () => {
  for (const content of ['Please change direction.', [{ type: 'image', url: 'attachment:test' }]]) {
    assert.equal(inspect([user(), { role: 'user', content }]).lastTurn, null);
  }
});

test('a compaction summary is a boundary, not a bridge to a removed or older receipt', () => {
  const summary = makeSummaryMessage('Compacted conversation.');
  assert.equal(inspect([summary]).lastTurn, null);
  assert.equal(inspect([user(), summary]).lastTurn, null);
  assert.equal(inspect([summary, user()]).lastTurn.preparedEffort, 'low');
});
