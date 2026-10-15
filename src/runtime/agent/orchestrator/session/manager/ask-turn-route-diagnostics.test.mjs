import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _sessionForDisk, _storedSessionFromFile } from '../store/serialize.mjs';
import { inspectRouteDiagnostics } from '../../runtime-core/route-diagnostics.mjs';

// Exercise the real turn preparation, including buildUserTurn and the
// preflight checkpoint. Provider discovery, the local judge, the prefetch
// bridge and disk persistence are controlled: no credentials or model requests.
const provider = {
  config: {}, customConfig: { protocol: 'openai-chat' },
  getCachedModelInfo: (id) => ({ id, contextWindow: 10000, reasoningLevels: ['low', 'medium', 'high'] }),
};
const registry = await import('../../providers/registry.mjs');
mock.module('../../providers/registry.mjs', { namedExports: { ...registry, getProvider: () => provider } });
let saved = null;
const store = await import('../store.mjs');
mock.module('../store.mjs', { namedExports: {
  ...store, saveSessionAsync: async (session) => { saved = JSON.parse(JSON.stringify(_sessionForDisk(session))); },
} });
let judged = { probs: [0, 0, 1, 0], ms: 1 };
let judgeCalls = 0;
let judgeStarted = null;
const judge = await import('../../../../effort-judge/judge-client.mjs');
mock.module('../../../../effort-judge/judge-client.mjs', { namedExports: {
  ...judge, judgeTurn: async () => { judgeCalls++; judgeStarted?.(); return judged; },
  recordEffortDecision: () => {}, effortJudgeSupportsSteps: () => false,
} });
let prefetchWait = null;
mock.module('./prefetch-bridge.mjs', { namedExports: {
  _tryBridgeExplicitPrefetch: async () => {
    if (!prefetchWait) return null;
    prefetchWait.entered.resolve();
    return prefetchWait.release.promise;
  },
} });
const { prepareAskTurn } = await import('./ask-turn-execute.mjs');
const { resolveTurnAutoEffort } = await import('./ask-turn-auto-effort.mjs');

function environment(t, mode) {
  const before = process.env.MIXDOG_AUTO_EFFORT;
  const trace = process.env.MIXDOG_AGENT_TRACE_DISABLE;
  process.env.MIXDOG_AUTO_EFFORT = mode;
  process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
  t.after(() => {
    if (before === undefined) delete process.env.MIXDOG_AUTO_EFFORT;
    else process.env.MIXDOG_AUTO_EFFORT = before;
    if (trace === undefined) delete process.env.MIXDOG_AGENT_TRACE_DISABLE;
    else process.env.MIXDOG_AGENT_TRACE_DISABLE = trace;
  });
}
function session(extra = {}) {
  return { id: 'route-diag', provider: 'custom-diag', model: 'test', effort: 'medium',
    contextWindow: 10000, tools: [], messages: [], sessionStartMetaInjected: true, ...extra };
}

for (const [mode, skipped, reason, prepared] of [
  ['on', false, 'selected', 'high'],
  ['observe', false, 'observe-only', 'medium'],
  ['off', false, 'master-off', 'medium'],
  ['on', true, 'judge-unavailable', 'medium'],
]) {
  test(`turn preparation persists ${reason} before its checkpoint without changing saved effort`, async (t) => {
    environment(t, mode);
    judged = skipped ? { skipped: 'timeout' } : { probs: [0, 0, 1, 0], ms: 1 };
    saved = null;
    const active = session();
    let atCheckpoint;
    const preparedTurn = await prepareAskTurn({
      sessionId: active.id,
      input: { prompt: 'fix a test', context: 'private-context-must-not-appear-in-receipt' },
      opened: {
        turn: { session: active }, runtime: {}, turnSignal: new AbortController().signal,
        askGeneration: 1, turnToken: 'turn-1', startedAt: 1700000000000,
        checkpoint: { schedule: () => { atCheckpoint = inspectRouteDiagnostics(active); } },
      },
    });
    assert.equal(active.effort, 'medium');
    assert.equal(preparedTurn.turnEffort, prepared);
    assert.equal(atCheckpoint.lastTurn.auto.reason, reason);
    assert.equal(atCheckpoint.lastTurn.auto.source, 'environment');
    assert.equal(atCheckpoint.lastTurn.configured.effort, 'medium');
    assert.equal(atCheckpoint.lastTurn.preparedEffort, prepared);
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-route-receipt-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'route-diag.json'), JSON.stringify(saved));
    const restored = _storedSessionFromFile(dir, 'route-diag.json');
    assert.deepEqual(inspectRouteDiagnostics(restored).lastTurn, atCheckpoint.lastTurn);
    assert.equal(Object.hasOwn(restored, 'liveTurnMessages'), false);
    assert.doesNotMatch(JSON.stringify(atCheckpoint), /fix a test|private-context/);
  });
}

for (const [reason, extra, input] of [
  ['route-off', { autoEffort: false }, { prompt: 'do the task' }],
  ['runtime-prompt', {}, { prompt: 'notification', promptSource: { source: 'runtime' } }],
  ['empty-or-tagged-prompt', {}, { prompt: '<runtime>not a request</runtime>' }],
]) {
  test(`${reason} is observable without calling the judge or changing the null contract`, async (t) => {
    environment(t, 'on');
    judgeCalls = 0;
    let decision;
    const result = await resolveTurnAutoEffort({ sessionId: 's', session: session(extra), provider, input,
      onDecision: (value) => { decision = value; } });
    assert.equal(result, null);
    assert.equal(judgeCalls, 0);
    assert.equal(decision.reason, reason);
    assert.equal(decision.applied, false);
  });
}

test('parallel prefetch tuning is captured at the actual preparation boundary and stays immutable', async (t) => {
  environment(t, 'off');
  prefetchWait = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  t.after(() => { prefetchWait = null; });
  const active = session({
    fast: false, autoEffort: true, modelParameters: { serviceTier: 'default' },
  });
  let atCheckpoint;
  const pending = prepareAskTurn({
    sessionId: active.id,
    input: { prompt: 'fix a test' },
    opened: {
      turn: { session: active }, runtime: {}, turnSignal: new AbortController().signal,
      askGeneration: 1, turnToken: 'turn-tuning', startedAt: 1700000000000,
      checkpoint: { schedule: () => {
        atCheckpoint = inspectRouteDiagnostics(active);
        active.effort = 'low';
        active.modelParameters.serviceTier = 'flex';
      } },
    },
  });
  await prefetchWait.entered.promise;
  active.effort = 'high';
  active.fast = true;
  active.autoEffort = false;
  active.modelParameters.serviceTier = 'priority';
  prefetchWait.release.resolve(null);
  const prepared = await pending;
  assert.equal(prepared.turnEffort, 'high');
  assert.equal(atCheckpoint.lastTurn.preparedEffort, 'high');
  assert.equal(atCheckpoint.lastTurn.configured.effort, 'high');
  assert.equal(atCheckpoint.lastTurn.configured.fast, true);
  assert.equal(atCheckpoint.lastTurn.configured.autoEffort, false);
  assert.equal(atCheckpoint.lastTurn.configured.serviceTier, 'priority');
  assert.equal(atCheckpoint.current.effort, 'high');
  assert.equal(atCheckpoint.current.fast, true);
  assert.equal(atCheckpoint.current.autoEffort, false);
  assert.equal(atCheckpoint.current.serviceTier, 'priority');
  assert.equal(active.effort, 'low');
  assert.equal(active.modelParameters.serviceTier, 'flex');
  assert.deepEqual(inspectRouteDiagnostics(saved).lastTurn, atCheckpoint.lastTurn);
});

test('an unavailable judge retains the existing post-wait fallback effort semantics', async (t) => {
  environment(t, 'on');
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  judgeStarted = entered.resolve;
  judged = release.promise;
  t.after(() => {
    judgeStarted = null;
    judged = { probs: [0, 0, 1, 0], ms: 1 };
  });
  const active = session();
  const pending = prepareAskTurn({
    sessionId: active.id,
    input: { prompt: 'fix a test' },
    opened: {
      turn: { session: active }, runtime: {}, turnSignal: new AbortController().signal,
      askGeneration: 1, turnToken: 'turn-judge-wait', startedAt: 1700000000000,
      checkpoint: { schedule() {} },
    },
  });
  await entered.promise;
  active.effort = 'high';
  release.resolve({ skipped: 'timeout' });
  const prepared = await pending;
  const report = inspectRouteDiagnostics(active);
  assert.equal(prepared.turnEffort, 'high');
  assert.equal(report.lastTurn.auto.reason, 'judge-unavailable');
  assert.equal(report.lastTurn.configured.effort, 'high');
  assert.equal(report.lastTurn.preparedEffort, 'high');
});

for (const mode of ['on', 'observe']) {
  test(`${mode} preserves the out-of-range fast path without a judge call`, async (t) => {
    environment(t, mode);
    judgeCalls = 0;
    let decision;
    const result = await resolveTurnAutoEffort({
      sessionId: 'route-diag', session: session({ effort: 'max' }), provider,
      input: { prompt: 'fix a test' }, onDecision: (value) => { decision = value; },
    });
    assert.equal(result, null);
    assert.equal(judgeCalls, 0);
    assert.equal(decision.reason, 'outside-auto-range');
    assert.equal(decision.mode, mode);
  });
}

test('diagnostic capture keeps user-turn preparation concurrent with the pending judge', async (t) => {
  environment(t, 'on');
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  judgeStarted = entered.resolve;
  judged = release.promise;
  prefetchWait = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  t.after(() => {
    judgeStarted = null;
    judged = { probs: [0, 0, 1, 0], ms: 1 };
    prefetchWait = null;
  });
  const active = session();
  let checkpointed = false;
  const pending = prepareAskTurn({
    sessionId: active.id, input: { prompt: 'fix a test' },
    opened: {
      turn: { session: active }, runtime: {}, turnSignal: new AbortController().signal,
      askGeneration: 1, turnToken: 'parallel', startedAt: 1700000000000,
      checkpoint: { schedule() { checkpointed = true; } },
    },
  });
  await entered.promise;
  let prefetchEntered = false;
  prefetchWait.entered.promise.then(() => { prefetchEntered = true; });
  // Give the actual buildUserTurn continuation a turn, with the judge still
  // unresolved. Always release both gates before asserting/teardown.
  await new Promise((resolve) => setImmediate(resolve));
  const overlapped = prefetchEntered;
  const savedEarly = checkpointed;
  prefetchWait.release.resolve(null);
  release.resolve({ probs: [0, 0, 1, 0], ms: 1 });
  const prepared = await pending;
  assert.equal(overlapped, true, 'the user turn starts before the judge resolves');
  assert.equal(savedEarly, false, 'no incomplete preparation is checkpointed');
  assert.equal(prepared.turnEffort, 'high');
  assert.equal(inspectRouteDiagnostics(active).lastTurn.preparedEffort, 'high');
});
