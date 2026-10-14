import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { cleanupBackgroundTasks, getBackgroundTask } from '../../../runtime/shared/background-tasks.mjs';

// Install synthetic boundaries before loading the flow's transitive imports:
// these lifecycle tests must not prepare real agents or access user stores.
mock.module('../../../runtime/agent/orchestrator/agent-runtime/session-builder.mjs', {
  namedExports: {
    prepareAgentSession: () => {
      throw new Error('unexpected real session preparation');
    },
  },
});
mock.module('../../../runtime/agent/orchestrator/providers/registry.mjs', {
  namedExports: { getProvider: () => undefined },
});
mock.module('../../../runtime/agent/orchestrator/session/store.mjs', {
  namedExports: {
    loadSession: () => null,
    readSessionLifecycleStateFromDisk: () => ({ state: 'absent', generation: 0 }),
    saveSessionAsync: async () => {},
    registerSessionPurgeHook: () => () => {},
  },
});
mock.module('../../../vendor/statusline/src/gateway/session-routes.mjs', {
  namedExports: {
    clearGatewaySessionRoute: () => true,
    writeGatewaySessionRoutes: () => true,
  },
});
const { createSpawnFlow } = await import('./spawn-flow.mjs');

test('agent job lifecycle publishes status immediately and after terminal settlement', async () => {
  let publications = 0;
  const flow = createSpawnFlow({
    mgr: { closeSession() {} },
    notifyStatusChange: () => {
      publications += 1;
    },
  });

  const job = flow.startJob('spawn', { tag: 'status-test' }, async () => ({ content: 'done' }), {
    callerSessionId: 'lead-test',
    clientHostPid: process.pid,
  });

  assert.equal(job.status, 'running');
  assert.equal(publications, 1);
  await job.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(job.status, 'completed');
  assert.ok(publications >= 2);
  cleanupBackgroundTasks({ surface: 'agent', force: true });
});

test('agent job completion uses immutable caller owner and never invokes stale notify context', async () => {
  const deliveries = [];
  let staleCalls = 0;
  const flow = createSpawnFlow({
    mgr: { closeSession() {} },
    notifySessionCompletion(sessionId, text, meta) {
      deliveries.push({ sessionId, text, meta });
      return true;
    },
  });

  const job = flow.startJob('spawn', { tag: 'owner-test' }, async () => ({ content: 'owner handoff' }), {
    callerSessionId: 'lead-owner',
    routingSessionId: 'wrong-lead',
    clientHostPid: process.pid,
    notifyFn() {
      staleCalls += 1;
      return true;
    },
  });

  await job.promise;
  assert.equal(staleCalls, 0);
  assert.ok(deliveries.length >= 1);
  assert.ok(deliveries.every((entry) => entry.sessionId === 'lead-owner'));
  assert.ok(deliveries.every((entry) => entry.meta.caller_session_id === 'lead-owner'));
  assert.match(deliveries.at(-1).text, /owner handoff/);
  cleanupBackgroundTasks({ surface: 'agent', force: true });
});

test('a user-cancelled Agent turn settles the worker row as cancelled, not error', async () => {
  const updates = [];
  const flow = createSpawnFlow({
    mgr: {
      getSession: () => ({ messages: [] }),
    },
    upsertWorkerSessionDeferred(_session, _tag, patch) {
      updates.push(patch);
    },
    emitSubagentEvent() {},
    scheduleReap() {},
    createTurnReviewCollector: () => ({
      onToolResult() {},
      complete() {},
    }),
    sessionSurface: {
      canonical: true,
      canRun: () => true,
      async runTurn() {
        throw new Error('cancelled by agent close');
      },
    },
  });
  const job = { taskId: 'task-agent-cancelled', status: 'cancelled' };

  await assert.rejects(
    flow.runSpawn(
      {
        args: {},
        tag: 'cancelled-worker',
        session: { id: 'sess_cancelled_worker' },
        agent: 'worker',
        preset: { provider: 'test-provider', model: 'test-model' },
        presetName: 'worker-route',
        workerCwd: 'C:\\Project\\tree',
        prompt: 'cancel me',
        watchdogPolicy: null,
      },
      { callerSessionId: 'sess_lead' },
      job
    ),
    /cancelled by agent close/
  );

  assert.equal(updates.at(-1).status, 'cancelled');
  assert.equal(updates.at(-1).stage, 'cancelled');
});

const { createSendFlow } = await import('./send-flow.mjs');

for (const canonical of [true, false]) {
  for (const mode of ['focused', 'balanced', 'swarm']) {
    for (const operation of ['spawn', 'send']) {
      test(`${operation}/${mode}/${canonical ? 'canonical' : 'in-process'} captures usage before handoff rendering`, async () => {
        const session = {
          id: `observed-${operation}-${mode}`,
          agent: 'worker',
          provider: 'test',
          model: 'model',
          messages: [],
        };
        const raw = { content: 'measured handoff', usage: { inputTokens: 70, outputTokens: 12 }, toolCallsTotal: 4 };
        const mgr = { getSession: () => session, askSession: async () => raw, closeSession() {} };
        const surface = canonical
          ? {
              canonical: true,
              canRun: () => true,
              async runTurn({ onTerminalResult }) {
                onTerminalResult?.(raw);
                return raw;
              },
            }
          : null;
        const registry = { tagForSession: () => 'same', upsertWorkerSessionDeferred() {}, scheduleReap() {} };
        const flow = createSpawnFlow({
          mgr,
          sessionSurface: surface,
          upsertWorkerSessionDeferred() {},
          emitSubagentEvent() {},
          scheduleReap() {},
          notifyStatusChange() {},
          notifySessionCompletion: () => true,
          createTurnReviewCollector: () => ({ onToolResult() {}, complete() {} }),
        });
        const context = { callerSessionId: `lead-${mode}`, orchestrationMode: mode };
        let job;
        if (operation === 'spawn') {
          job = flow.startJob(
            'spawn',
            { tag: 'same' },
            (job, owner) =>
              flow.runSpawn(
                {
                  args: {},
                  tag: 'same',
                  session,
                  agent: 'worker',
                  preset: { provider: 'test', model: 'model' },
                  presetName: 'worker',
                  prompt: 'work',
                  watchdogPolicy: null,
                },
                owner,
                job
              ),
            context
          );
        } else {
          const sends = createSendFlow({
            mgr,
            sessionSurface: surface,
            canUseSessionSurface: () => canonical,
            registry,
            spawnFlow: flow,
            views: {
              isSessionBusy: () => false,
              renderJob: (task) => ({ task_id: task.taskId, type: 'send', status: task.status }),
            },
          });
          const ack = await sends.dispatchToExistingSession(
            { args: {}, session, sessionId: session.id, prompt: 'follow up' },
            context
          );
          job = getBackgroundTask(/agent task: (\S+)/.exec(ack)[1]);
        }
        await job.promise;
        assert.equal(job.status, 'completed');
        assert.equal(job.meta.delegation.mode, mode);
        assert.equal(job.meta.delegation.callerSessionId, `lead-${mode}`);
        assert.equal(job.meta.delegation.inputTokens, 70);
        assert.equal(job.meta.delegation.outputTokens, 12);
        assert.equal(job.meta.delegation.toolCalls, 4);
        assert.equal(typeof job.meta.delegation.executionMs, 'number');
        assert.equal(job.result.usage, undefined, 'the handoff body still uses its existing contract');
        cleanupBackgroundTasks({ surface: 'agent', force: true });
      });
    }
  }
}
