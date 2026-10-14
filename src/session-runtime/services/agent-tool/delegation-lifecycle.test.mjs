import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobStarter } from './spawn-flow/job-start.mjs';
import { runDelegationObservation } from './delegation-observation.mjs';
import { terminalResultHook, reconcileJobWatchdogPartial } from './job-task-reconcile.mjs';
import { createJobRender } from './job-views/job-render.mjs';
import {
  cancelBackgroundTask,
  cleanupBackgroundTasks,
  renderBackgroundTask,
} from '../../../runtime/shared/background-tasks.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function harness(admission) {
  const published = [];
  const closes = [];
  let releases = 0;
  const starter = createJobStarter({
    mgr: { closeSession: (id) => closes.push(id) },
    notifyStatusChange: () => published.push(true),
    notifySessionCompletion: () => true,
    admission: admission || {
      acquire: async () => ({
        release: async () => {
          releases++;
        },
      }),
      runWithLease: (_lease, run) => run(),
    },
  });
  return { starter, published, closes, releases: () => releases };
}
const context = (mode, owner = 'lead-a') => ({
  callerSessionId: owner,
  orchestrationMode: mode,
  clientHostPid: process.pid,
});
const clear = () => cleanupBackgroundTasks({ surface: 'agent', force: true });

for (const operation of ['spawn', 'send']) {
  for (const mode of ['focused', 'balanced', 'swarm']) {
    test(`${operation}/${mode}: freezes raw result measurements before terminal handoff and slow settlement`, async () => {
      const { starter, releases } = harness();
      const storage = deferred();
      const relayed = deferred();
      const job = starter(
        operation,
        { tag: 'reused', sessionId: 'same-session' },
        async (job) => {
          runDelegationObservation(job);
          terminalResultHook({
            job,
            turnReview: { complete() {} },
            completionValue: (result) => ({ content: result.content }),
            notifyEarly() {},
          })({ content: 'done', usage: { inputTokens: 100, outputTokens: 20 }, toolCallsTotal: 3 });
          relayed.resolve();
          await storage.promise;
          return { content: 'done' };
        },
        context(mode)
      );
      await relayed.promise;
      assert.equal(job.status, 'completed');
      assert.equal(job.meta.delegation.mode, mode);
      assert.equal(job.meta.delegation.inputTokens, 100);
      assert.equal(job.meta.delegation.toolCalls, 3);
      assert.equal(job.meta.delegation.outcome, 'completed');
      const frozen = job.meta.delegation;
      storage.resolve();
      await job.promise;
      assert.equal(job.meta.delegation, frozen);
      assert.equal(releases(), 1);
      clear();
    });
  }
}

test('admission failure is observed and publishes terminal status without a lease', async () => {
  const h = harness({
    acquire: async () => {
      throw new Error('admission unavailable');
    },
  });
  const job = h.starter('spawn', {}, () => assert.fail('must not execute'), context('focused'));
  await job.promise;
  await tick();
  assert.equal(job.status, 'failed');
  assert.equal(job.meta.delegation.outcome, 'failed');
  assert.equal(job.meta.delegation.preparationMs, null);
  assert.equal(job.meta.delegation.inputTokens, null);
  assert.ok(h.published.length >= 2);
  clear();
});

test('cancellation while waiting never starts work, even if admission resolves late', async () => {
  const grant = deferred();
  let released = false;
  const h = harness({ acquire: () => grant.promise, runWithLease: (_lease, run) => run() });
  const job = h.starter('spawn', {}, () => assert.fail('cancelled job ran'), context('swarm'));
  await Promise.resolve();
  cancelBackgroundTask(job.taskId);
  grant.resolve({
    release: async () => {
      released = true;
    },
  });
  await job.promise;
  assert.equal(job.status, 'cancelled');
  assert.equal(job.meta.delegation.outcome, 'cancelled');
  assert.equal(job.meta.delegation.executionMs, null);
  assert.equal(job.meta.delegation.inputTokens, null);
  assert.equal(released, true);
  clear();
});

test('watchdog partial handoff is not recorded as a verified successful job', async () => {
  const h = harness();
  const job = h.starter(
    'spawn',
    {},
    async (job) => {
      runDelegationObservation(job);
      const value = { content: 'partial', stallAbort: true };
      reconcileJobWatchdogPartial(job, value);
      return value;
    },
    context('balanced')
  );
  await job.promise;
  assert.equal(job.status, 'completed', 'existing handoff behavior is unchanged');
  assert.equal(job.meta.delegation.outcome, 'partial');
  assert.equal(job.meta.delegation.outputTokens, null);
  clear();
});

test('projection preserves owner isolation, returns detached observations and never renders object junk', async () => {
  const h = harness();
  const a = h.starter(
    'spawn',
    { tag: 'same', sessionId: 'shared-session' },
    async () => ({ content: 'a' }),
    context('focused')
  );
  const b = h.starter(
    'send',
    { tag: 'same', sessionId: 'shared-session' },
    async () => ({ content: 'b' }),
    context('swarm', 'lead-b')
  );
  await Promise.all([a.promise, b.promise]);
  const views = createJobRender({ progress: { sessionProgressExtras: () => ({}), jobWorkerSnapshot: () => ({}) } });
  const rows = views.listJobs({ callerSessionId: 'lead-a', clientHostPid: process.pid });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delegation.mode, 'focused');
  rows[0].delegation.mode = 'swarm';
  assert.equal(views.renderJob(a).delegation.mode, 'focused');
  assert.doesNotMatch(renderBackgroundTask(a), /\[object Object\]|delegation:/);
  clear();
});
