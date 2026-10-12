import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _sessionForDisk, _storedSessionFromFile } from '../store/serialize.mjs';
import { inspectRouteDiagnostics } from '../../../../shared/route-diagnostics.mjs';

// Exercise the real turn preparation, including buildUserTurn and the
// preflight checkpoint. Only provider discovery, the local judge and disk
// persistence are replaced: no credentials, downloads or model requests.
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
const judge = await import('../../../../effort-judge/judge-client.mjs');
mock.module('../../../../effort-judge/judge-client.mjs', { namedExports: {
  ...judge, judgeTurn: async () => { judgeCalls++; return judged; },
  recordEffortDecision: () => {}, effortJudgeSupportsSteps: () => false,
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
