// Import before runtime modules: several paths are captured at module load.
import './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

let handoverError = null;
let cancelError = null;
const cancelledJobs = [];
mock.module('./builtin/shell-jobs.mjs', {
  namedExports: {
    peekShellJob: () => null,
    waitForShellJob: async () => null,
    publishForegroundShellRecord() {},
    retireForegroundShellRecord() {},
    killShellJob: (jobId) => {
      cancelledJobs.push(jobId);
      if (cancelError) throw cancelError;
    },
  },
});

// Normally the child exits while promotion is committing; a failed handover
// instead leaves the promoted process alive for its existing owner to clean up.
mock.module('./lib/shell-run-background/promote-job.mjs', {
  namedExports: {
    promoteWithRetry: async ({ run }) => {
      if (!handoverError) run.child.exitCode = 0;
      return { job: { jobId: 'job-1' } };
    },
    handOverLease: async () => {
      if (handoverError) throw handoverError;
    },
    killAfterFailedPromotion: () => {},
  },
});

const { createAutoBackground } = await import('./lib/shell-run-background.mjs');

test('completed-during-promotion resolves with the final read, not the mid-run snapshot', async () => {
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
  const run = {
    taskOutput,
    abortSignal: null,
    child: { exitCode: null, signalCode: null },
    taskId: 'task-1',
    startMs: Date.now(),
    settled: false,
    autoBackgrounded: false,
    killed: false,
    timedOut: false,
    resolveResult: (value) => {
      result = value;
    },
    isResolved: () => result !== undefined,
  };
  const autoBackground = createAutoBackground({
    run,
    command: 'x',
    cwd: '.',
    promotedTimeoutMs: 0,
    backgroundDeadlineMs: 0,
  });
  autoBackground({ reason: 'threshold' });
  for (let i = 0; i < 50 && !result; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(result, 'resolved');
  assert.equal(result.backgrounded, false);
  assert.equal(result.stdout, 'ok \uFFFD');
  assert.deepEqual(reads, [false, true]);
});

test('failed promotion handover still returns its failure when secondary cancellation throws', async () => {
  handoverError = new Error('handover failed');
  cancelError = new Error('cancellation failed');
  cancelledJobs.length = 0;
  let finishTree;
  const treeSettled = new Promise((resolve) => {
    finishTree = resolve;
  });
  let result;
  let deleted = 0;
  let workspaceReleased = 0;
  let leaseReleased = 0;
  const run = {
    taskOutput: {
      writeError: null,
      forceSpill() {},
      deleteFiles() {
        deleted += 1;
      },
    },
    abortSignal: null,
    child: { exitCode: null, signalCode: null },
    taskId: 'task-promotion-failure',
    startMs: Date.now(),
    treeSettled,
    workspaceAdmission: () => {
      workspaceReleased += 1;
    },
    resourceLease: {
      release: async () => {
        leaseReleased += 1;
      },
    },
    resolveResult: (value) => {
      result = value;
    },
    isResolved: () => result !== undefined,
  };
  try {
    createAutoBackground({ run, command: 'x', cwd: '.', promotedTimeoutMs: 0, backgroundDeadlineMs: 0 })();
    // Crossing an event-loop turn also exposes any unhandled rejection from
    // the asynchronous cleanup catch to the test runner.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(result, 'secondary cleanup errors must not strand the tool result');
    assert.equal(result.backgrounded, false);
    assert.equal(result.failurePhase, 'tool');
    assert.match(result.stderr, /handover failed.*cancellation failed/);
    assert.deepEqual(cancelledJobs, ['job-1']);
    assert.equal(leaseReleased, 1);
    assert.equal(result.settled, treeSettled);
    let physicallySettled = false;
    result.settled.then(() => {
      physicallySettled = true;
    });
    await Promise.resolve();
    assert.equal(physicallySettled, false);
    assert.equal(deleted, 0);
    assert.equal(workspaceReleased, 0);

    finishTree(true);
    await result.settled;
    assert.equal(deleted, 1);
    assert.equal(workspaceReleased, 1);
  } finally {
    handoverError = null;
    cancelError = null;
    finishTree(true);
  }
});
