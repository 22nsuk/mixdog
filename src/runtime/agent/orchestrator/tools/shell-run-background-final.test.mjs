// Import before runtime modules: several paths are captured at module load.
import './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { processTable, scriptedChildTree } from './lib/process-table-fixture.mjs';

// The root can exit while the promotion acknowledgment is pending. Exercise
// the real foreground owner and auto-background caller around that boundary.
let jobStatus = 'completed';
let jobSettled = null;
let promotionGate = null;
let exitDuringPromotion = true;
const cancelledJobs = [];
mock.module('./lib/shell-run-background/promote-job.mjs', {
  namedExports: {
    promoteWithRetry: async ({ run }) => {
      if (exitDuringPromotion) run.child.exitCode = 0;
      await promotionGate?.();
      return { job: { jobId: 'job-1' } };
    },
    handOverLease: async (run) => { run.treeSettled = jobSettled; },
    killAfterFailedPromotion: () => {},
  },
});
mock.module('./builtin/shell-jobs.mjs', {
  namedExports: {
    peekShellJob: () => ({ jobId: 'job-1', status: jobStatus }),
    killShellJob: (jobId) => { cancelledJobs.push(jobId); },
    publishForegroundShellRecord: () => {},
    retireForegroundShellRecord: () => {},
    trackForegroundShellJob: async () => null,
    waitForShellJob: async () => null,
  },
});
const tree = scriptedChildTree();
mock.module('../mcp/child-tree.mjs', { namedExports: tree.namedExports });

const { createAutoBackground } = await import('./lib/shell-run-background.mjs');
const { registerForegroundOwnedTree } = await import('./lib/shell-run-state.mjs');
const { cancelOwnedShellTrees, unregisterOwnedShellTree } = await import('./lib/owned-shell-trees.mjs');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function promotionRun() {
  const reads = [];
  const taskOutput = {
    spilled: true,
    stdoutPath: 'out.log',
    stderrPath: 'err.log',
    stdoutFileSize: 5,
    stderrFileSize: 0,
    writeError: null,
    forceSpill() {},
    async getStdout(final = false) {
      reads.push(final);
      return final ? 'ok \uFFFD' : 'ok ';
    },
    async getStderr() {
      return '';
    },
  };
  let result;
  let resolveResult;
  const promise = new Promise((resolve) => { resolveResult = resolve; });
  const run = {
    taskOutput,
    abortSignal: null,
    child: { pid: 4800, exitCode: null, signalCode: null },
    foregroundRecordId: 'job-1',
    taskId: 'task-1',
    startMs: Date.now(),
    settled: false,
    autoBackgrounded: false,
    killed: false,
    timedOut: false,
    resolveResult: (value) => {
      result = value;
      resolveResult(value);
    },
    isResolved: () => result !== undefined,
  };
  const promote = createAutoBackground({
    run,
    command: 'x',
    cwd: '.',
    promotedTimeoutMs: 0,
    backgroundDeadlineMs: 0,
  });
  return { run, reads, promise, promote };
}

for (const status of ['completed', 'running']) {
  test(`root exit during promotion preserves the ${status} whole-job result`, async () => {
    jobStatus = status;
    let finishJob;
    jobSettled = new Promise((resolve) => { finishJob = resolve; });
    if (status === 'completed') finishJob();
    const { reads, promise, promote } = promotionRun();
    promote({ reason: 'threshold' });
    const result = await promise;
    if (status === 'completed') {
      assert.equal(result.backgrounded, false);
      assert.equal(result.stdout, 'ok \uFFFD');
      assert.deepEqual(reads, [false, true]);
    } else {
      assert.equal(result.backgrounded, true, 'a root exit cannot complete a live descendant task');
      assert.equal(result.jobId, 'job-1');
      assert.equal(result.stdout, 'ok ');
      assert.deepEqual(reads, [false], 'output is still a mid-run snapshot');
      assert.equal(result.settled, jobSettled, 'the caller retains the handed-over job lifetime');
      let settled = false;
      void result.settled.then(() => { settled = true; });
      await Promise.resolve();
      assert.equal(settled, false);
      finishJob();
      await result.settled;
      assert.equal(settled, true);
    }
  });
}

for (const rootExited of [true, false]) {
  test(`owner close during promotion preserves cancellation with root exited=${rootExited}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const owner = `owner-promotion-${rootExited}`;
    jobStatus = 'running';
    exitDuringPromotion = rootExited;
    cancelledJobs.length = 0;
    let finishJob;
    jobSettled = new Promise((resolve) => { finishJob = resolve; });
    let acknowledgePromotion;
    promotionGate = () => new Promise((resolve) => { acknowledgePromotion = resolve; });
    const { run, promise, promote } = promotionRun();
    tree.state.next = () => processTable([{ pid: 4800 }, { pid: 4801, ppid: 4800 }]);
    registerForegroundOwnedTree(run, owner);
    try {
      promote({ reason: 'threshold' });
      await flush();
      assert.equal(typeof acknowledgePromotion, 'function', 'registration has not acknowledged the handoff');
      const closing = cancelOwnedShellTrees(owner);
      await flush();
      assert.equal(run.ownerCancelled, true, 'the still-registered foreground owner retains the close request');
      if (!rootExited) {
        assert.equal(run.terminationTracker.complete, true, 'the pre-kill snapshot still precedes cancellation');
        run.child.exitCode = 0;
      }
      acknowledgePromotion();
      const result = await promise;
      assert.deepEqual(cancelledJobs, ['job-1'], 'the committed job inherits cancellation without an abort signal');
      assert.equal(result.backgrounded, false);
      assert.equal(result.killed, true);
      assert.equal(result.settled, jobSettled);
      finishJob();
      unregisterOwnedShellTree(run.foregroundRecordId, run.ownedTree);
      await closing;
    } finally {
      acknowledgePromotion?.();
      finishJob();
      unregisterOwnedShellTree(run.foregroundRecordId, run.ownedTree);
      promotionGate = null;
      exitDuringPromotion = true;
    }
  });
}
