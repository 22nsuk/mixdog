import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'mixdog-delegation-compact-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
const { runPreSendCompactPass } = await import(
  '../../../runtime/agent/orchestrator/session/pre-send-compact.mjs'
);
const { finishLoop } = await import('../../../runtime/agent/orchestrator/session/loop/loop-state.mjs');
const { addUsage } = await import('../../../runtime/agent/orchestrator/session/loop/usage.mjs');
const { beginDelegationObservation, finishDelegationObservation } = await import(
  './delegation-observation.mjs'
);
const { delegationObservations } = await import('../../../ui/delegation-observations.mjs');

process.on('exit', () => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('returned-turn observations retain usage folded in by real pre-send compaction', async () => {
  const summary = [
    '## Goal',
    '- continue the fixture task',
    '## Constraints & Preferences',
    '- preserve the current request',
    '## Progress',
    '### Done',
    '- prior dialogue summarized',
    '### In Progress',
    '- respond to the current request',
    '### Blocked',
    '- (none)',
    '## Key Decisions',
    '- (none)',
    '## Next Steps',
    '- finish the current request',
    '## Critical Context',
    '- fixture only',
    '## Relevant Files',
    '- (none)',
  ].join('\n');
  const session = {
    id: `delegation-compact-${process.pid}`,
    owner: 'agent',
    provider: 'compact-fixture',
    model: 'fixture',
    cwd: root,
    contextWindow: 20_000,
    compactBoundaryTokens: 20_000,
    messages: [
      { role: 'user', content: `old request ${'context '.repeat(12_000)}` },
      { role: 'assistant', content: `old answer ${'detail '.repeat(12_000)}` },
      { role: 'user', content: 'current request' },
    ],
    tools: [],
    compaction: { auto: true },
  };
  let calls = 0;
  const compacted = await runPreSendCompactPass({
    compactionConfig: {},
    provider: {
      name: session.provider,
      async send() {
        calls++;
        return { content: summary, usage: { inputTokens: 40, outputTokens: 4 } };
      },
    },
    messages: session.messages,
    model: session.model,
    requestTools: [],
    sessionRef: session,
    sessionId: session.id,
    cwd: root,
    opts: {},
    signal: null,
    iterations: 1,
    lastUsage: { inputTokens: 10, outputTokens: 2 },
    firstTurnUsage: null,
    providerState: null,
    reactiveOverflowRetryPending: false,
    loopUsageMetricsTurnId: () => 'fixture-turn',
    loopUsageMetricsEpoch: () => 0,
  });
  assert.equal(compacted.compactChanged, true);
  assert.ok(calls > 0, 'the actual compactor must consume provider usage');
  const finalUsage = { inputTokens: 7, outputTokens: 3 };
  const result = finishLoop({
    response: { content: 'done', usage: finalUsage },
    lastUsage: addUsage(compacted.lastUsage, finalUsage),
    toolCallsTotal: 0,
    noToolTurn: { providerContinuations: 0 },
  });
  assert.equal(result.usage.inputTokens, 17 + calls * 40);
  assert.equal(result.usage.outputTokens, 5 + calls * 4);
  const job = { meta: {} };
  beginDelegationObservation(job, { callerSessionId: 'lead', orchestrationMode: 'focused' });
  finishDelegationObservation(job, 'completed', result);
  const model = delegationObservations([{ task_id: 'compacted', delegation: job.meta.delegation }], 'lead');
  assert.equal(model.rows[0].inputTokens, result.usage.inputTokens);
  assert.equal(model.rows[0].outputTokens, result.usage.outputTokens);
  assert.equal(model.inputMeasured, 1);
  assert.equal(model.outputMeasured, 1);
});
