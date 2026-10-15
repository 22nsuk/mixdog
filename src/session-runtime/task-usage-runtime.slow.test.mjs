import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'mixdog-task-runtime-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_USAGE_LEDGER_PATH = join(root, 'usage.sqlite');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
writeFileSync(join(root, 'fixture.txt'), 'task evidence fixture');
const { createSession } = await import('../runtime/agent/orchestrator/session/manager/session-lifecycle.mjs');
const { askSession } = await import('../runtime/agent/orchestrator/session/manager/ask-session.mjs');
const { deleteSession } = await import('../runtime/agent/orchestrator/session/store.mjs');
const { _withRegisteredProviderForTestAsync } = await import('../runtime/agent/orchestrator/providers/registry.mjs');
const { wrapProviderAdmission } = await import('../runtime/agent/orchestrator/providers/admission-scheduler.mjs');
const { getUsageLedger, closeUsageLedgers } = await import('../runtime/shared/llm/usage-ledger.mjs');
const { currentTaskRun, withTaskCaller, withTaskRun } = await import('../runtime/shared/llm/task-usage-context.mjs');
const { enqueuePendingMessage } = await import('../runtime/agent/orchestrator/session/manager/pending-messages.mjs');
const { createAgentTurns } = await import('../standalone/session-service/agent-tree/agent-turns.mjs');
const { createUsageStatsApi } = await import('./usage-stats-api.mjs');
process.on('exit', () => {
  closeUsageLedgers();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function sessionFor(provider) {
  const session = createSession({
    provider,
    model: 'fixture',
    cwd: root,
    skipSkills: true,
    schemaAllowedTools: ['read'],
    workflow: { id: 'headless', delegatesAgents: false },
  });
  session.visibility = 'agent-only';
  session.orchestrationMode = 'balanced';
  return session;
}

test('busy-worker steering records an allocation gap instead of charging another root for a merged turn', async () => {
  const providerName = 'task-steering-fixture';
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let sends = 0;
  const provider = wrapProviderAdmission(
    {
      name: providerName,
      contextWindow: 128000,
      async send(messages) {
        if (++sends === 1) {
          entered.resolve();
          await release.promise;
        } else assert.match(JSON.stringify(messages), /queued task input/);
        return { content: 'done', toolCalls: [], usage: { inputTokens: 5, outputTokens: 1 } };
      },
    },
    providerName
  );
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const worker = sessionFor(providerName);
    const work = askSession(worker.id, 'original task', null, null, root);
    try {
      await entered.promise;
      await withTaskRun(
        { id: 'steering-root', sessionId: 'steering-owner', source: 'prompt', startedAt: Date.now() },
        async () => {
          assert.ok(enqueuePendingMessage(worker.id, 'queued task input') > 0);
        }
      );
    } finally {
      release.resolve();
    }
    try {
      await work;
      const source = (await getUsageLedger().taskUsageAsync('steering-owner')).tasks[0];
      const target = (await getUsageLedger().taskUsageAsync(worker.id)).tasks[0];
      assert.equal(source.pendingSubmissions, 0);
      assert.equal(source.unallocatedSubmissions, 1);
      assert.equal(source.totals.records, 0);
      assert.equal(target.runs.uncertainInputs, 1);
      assert.equal(target.totals.input, 10);
      assert.equal(sends, 2);
    } finally {
      deleteSession(worker.id);
    }
  });
});

test('actual ask/read/provider/ledger/API path creates a new root for each reused-session turn and preserves failed spend', async () => {
  const providerName = 'task-runtime-fixture';
  let sends = 0,
    fail = false;
  const provider = wrapProviderAdmission(
    {
      name: providerName,
      contextWindow: 128000,
      async send(messages) {
        sends++;
        if (fail)
          throw Object.assign(new Error('fixture failure'), { partialUsage: { inputTokens: 7, outputTokens: 1 } });
        if (sends % 2 === 0) assert.match(JSON.stringify(messages), /task evidence fixture/);
        return {
          content: sends % 2 ? '' : 'done',
          usage: { inputTokens: 10, outputTokens: 2 },
          toolCalls:
            sends % 2 ? [{ id: `read-${sends}`, name: 'read', arguments: { path: join(root, 'fixture.txt') } }] : [],
        };
      },
    },
    providerName
  );
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const session = sessionFor(providerName);
    try {
      await askSession(session.id, 'read fixture', null, null, root);
      await askSession(session.id, 'read again', null, null, root);
      fail = true;
      await assert.rejects(askSession(session.id, 'failed request', null, null, root), /fixture failure/);
      const api = createUsageStatsApi({
        getSessionId: () => session.id,
        importHistory: async () => {},
        accountPool: () => ({ accounts: [] }),
      });
      const snapshot = await api.getSessionUsage();
      assert.equal(snapshot.taskUsage.tasks.length, 3);
      const failed = snapshot.taskUsage.tasks.find((r) => r.outcome === 'failed');
      assert.equal(failed.totals.input, 7);
      assert.deepEqual(
        snapshot.taskUsage.tasks.filter((r) => r.outcome === 'completed').map((r) => r.totals.input),
        [20, 20]
      );
      assert.equal(
        snapshot.taskUsage.tasks.reduce((n, r) => n + r.totals.records, 0),
        5
      );
      assert.ok(snapshot.taskUsage.tasks.every((r) => r.mode === 'balanced' && r.runs.runs === 1));
      assert.ok(
        snapshot.taskUsage.tasks.every((r) => r.totals.inputMeasured === 0),
        'legacy numeric usage is not falsely certified'
      );
    } finally {
      deleteSession(session.id);
    }
  });
});

test('canonical agent turn links across lost async context using its registered submission, including worker reuse', async () => {
  const providerName = 'task-canonical-fixture';
  let lead,
    child,
    childTurns,
    sends = 0;
  const provider = wrapProviderAdmission(
    {
      name: providerName,
      contextWindow: 128000,
      async send(_messages, _model, _tools, opts) {
        sends++;
        if (opts.sessionId === lead.id) {
          await childTurns.runAgentTurn({ session: child, prompt: 'child' });
          await childTurns.runAgentTurn({ session: child, prompt: 'reuse child' });
        }
        return { content: 'done', toolCalls: [], usage: { inputTokens: 5, outputTokens: 1 } };
      },
    },
    providerName
  );
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    lead = sessionFor(providerName);
    child = sessionFor(providerName);
    const runtime = {
      isWireSafe: true,
      readModelMessages: async () => ({ messageCount: 0, messages: [] }),
      submitAndWait: async (prompt, options) =>
        withTaskCaller(null, async () => {
          assert.equal(currentTaskRun(), null, 'simulate a different runtime process');
          const result = await askSession(child.id, prompt, null, null, root, null, {
            transcriptMeta: { ...options.transcriptMeta, checkpointId: options.id },
          });
          return { status: 'done', result };
        }),
    };
    childTurns = createAgentTurns({
      registry: { get: (id) => (id === child.id ? child : null) },
      rehydrateAgentSessions: async () => {},
      entryForSession: async () => ({ runtime }),
      retainUnwatched() {},
      createSession() {},
      takeWatchdogStop() {},
      takeCancelTranscript() {},
    });
    try {
      await askSession(lead.id, 'delegate', null, null, root);
      const snapshot = await getUsageLedger().taskUsageAsync(lead.id);
      assert.equal(snapshot.tasks.length, 1);
      const task = snapshot.tasks[0];
      assert.equal(task.runs.runs, 3);
      assert.equal(task.totals.input, 15);
      assert.equal(sends, 3);
      assert.equal(task.pendingSubmissions, 0);
      assert.equal(task.runs.uncertainInputs, 0);
      assert.equal((await getUsageLedger().taskUsageAsync(child.id)).tasks.length, 0);
    } finally {
      deleteSession(lead.id);
      deleteSession(child.id);
    }
  });
});
