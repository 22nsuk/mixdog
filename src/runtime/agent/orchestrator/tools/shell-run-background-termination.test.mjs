import './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { mock } from 'node:test';
import { processTable, scriptedChildTree } from './lib/process-table-fixture.mjs';

// Promotion is committed (or fails) on demand. Its tree completion is a
// separate event from root exit, as it is for the native shell-job owner.
let current;
mock.module('./lib/shell-run-background/promote-job.mjs', {
  namedExports: {
    promoteWithRetry: async ({ run }) => {
      if (current.mode === 'unowned') throw new Error('promotion bridge failed');
      if (current.mode === 'already-completed') {
        tree.state.next = () => processTable([{ pid: run.child.pid }]);
        await run.terminationTracker.capture();
        run.child.exitCode = 0;
        tree.state.next = () => processTable([]);
      }
      return { job: { jobId: current.run.foregroundRecordId } };
    },
    handOverLease: async () => {
      if (current.mode === 'cancel') current.abort.abort('cancel during handoff');
      else throw new Error('handoff lease failed');
    },
    killAfterFailedPromotion: () => assert.fail('this fixture reaches promotion settlement'),
  },
});
mock.module('./builtin/shell-jobs.mjs', {
  namedExports: {
    killShellJob: () => {
      current.ownerKills += 1;
      return { status: 'running' };
    },
    subscribeShellJobSettled: (_jobId, onSettled) => {
      current.onTreeSettled = onSettled;
      if (current.mode === 'already-completed') queueMicrotask(() => onSettled({ status: 'completed' }));
      return () => {};
    },
    peekShellJob: () => ({ status: current.mode === 'already-completed' ? 'completed' : 'running' }),
    waitForShellJob: async () => ({ nativeStatus: 'running', status: 'running' }),
    publishForegroundShellRecord: () => {},
    retireForegroundShellRecord: () => {},
  },
});
const tree = scriptedChildTree();
mock.module('../mcp/child-tree.mjs', { namedExports: tree.namedExports });

const { createAutoBackground } = await import('./lib/shell-run-background.mjs');
const { releaseShellJobWorkspace } = await import('./builtin/lib/shell-job-records.mjs');
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(read) {
  for (let i = 0; i < 100; i += 1) {
    if (read()) return;
    await flush();
  }
  assert.fail('promotion never reached the expected boundary');
}

function fixture(mode) {
  const abort = new AbortController();
  const state = {
    mode,
    abort,
    result: null,
    ownerKills: 0,
    rawKills: 0,
    closes: 0,
    deletes: 0,
    resourceReleases: 0,
    workspaceReleases: 0,
    workspaceReleaseFailures: 0,
    onTreeSettled: null,
  };
  const child = Object.assign(new EventEmitter(), {
    pid: 987650,
    exitCode: null,
    signalCode: null,
    __nativeSpawn: true,
    kill: () => { state.rawKills += 1; },
  });
  state.run = {
    child,
    abortSignal: abort.signal,
    taskId: 'task-promotion',
    foregroundRecordId: 'job_promotion',
    foregroundRecordInput: { command: 'worker', cwd: '.', ownerSessionId: 'sess-promotion' },
    startMs: Date.now(),
    settled: false,
    autoBackgrounded: false,
    killed: false,
    timedOut: false,
    taskOutput: {
      spilled: true,
      stdoutPath: 'out.log',
      stderrPath: 'err.log',
      stdoutFileSize: 8,
      stderrFileSize: 0,
      forceSpill() {},
      getStdout: async () => 'partial\n',
      getStderr: async () => '',
      closeFds: () => { state.closes += 1; },
      deleteFiles: () => { state.deletes += 1; },
    },
    resourceLease: { release: async () => { state.resourceReleases += 1; } },
    workspaceAdmission: () => {
      if (state.workspaceReleaseFailures-- > 0) throw new Error('workspace ledger is temporarily unavailable');
      state.workspaceReleases += 1;
    },
    resolveResult: (result) => { state.result = result; },
    isResolved: () => state.result !== null,
  };
  current = state;
  return state;
}

function begin(run) {
  createAutoBackground({
    run,
    command: 'worker',
    cwd: '.',
    promotedTimeoutMs: 0,
    backgroundDeadlineMs: 0,
  })({ reason: 'threshold' });
}

for (const mode of ['cancel', 'cleanup']) {
  test(`${mode} during a committed promotion carries whole-tree settlement without a raw kill`, async () => {
    const state = fixture(mode);
    begin(state.run);
    await until(() => state.result);
    assert.equal(state.result.backgrounded, false);
    assert.equal(state.result.killed, true);
    assert.equal(state.rawKills, 0, 'the native tree owner must finish its snapshot before killing');
    assert.equal(state.ownerKills, 1);
    assert.ok(state.result.settled instanceof Promise, 'the queued owner must be able to await this tree');
    let settled = false;
    state.result.settled.then(() => { settled = true; });
    state.run.child.exitCode = 1;
    state.run.child.emit('exit', 1, null);
    await flush();
    assert.equal(settled, false, 'root exit is not descendant termination');
    assert.equal(state.deletes, 0, 'a live descendant may still own the spill');
    assert.equal(state.workspaceReleases, 0);
    if (mode === 'cancel') assert.equal(state.result.stdout, 'partial\n');
    else assert.match(state.result.stderr, /handoff lease failed/);
    releaseShellJobWorkspace(state.run.foregroundRecordId);
    state.onTreeSettled({ status: 'cancelled' });
    await state.result.settled;
    assert.equal(settled, true);
    assert.equal(state.deletes, mode === 'cleanup' ? 1 : 0);
    assert.equal(state.workspaceReleases, 1);
  });
}

test('promotion cleanup without a committed owner uses foreground confirmation and root-exit resource cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = fixture('unowned');
  tree.state.next = () => processTable([{ pid: state.run.child.pid }]);
  try {
    begin(state.run);
    await until(() => state.result);
    assert.match(state.result.stderr, /promotion bridge failed/);
    assert.match(state.result.stderr, /termination could not be confirmed/);
    assert.equal(state.rawKills, 0);
    assert.equal(state.ownerKills, 1);
    assert.ok(state.result.settled instanceof Promise);
    assert.equal(state.closes, 0);
    assert.equal(state.deletes, 0);
    assert.equal(state.resourceReleases, 0);
    assert.equal(state.workspaceReleases, 0);
    state.run.child.exitCode = 1;
    state.run.child.emit('exit', 1, null);
    tree.state.next = () => processTable([]);
    t.mock.timers.tick(5_000);
    await until(() => state.workspaceReleases === 1);
    await state.result.settled;
    assert.equal(state.closes, 1);
    assert.equal(state.deletes, 1, 'unreferenced files are removed after confirmed tree termination');
    assert.equal(state.resourceReleases, 1);
  } finally {
    state.run.stopTerminationWatch?.();
    t.mock.timers.reset();
  }
});

test('cleanup after the promoted tree already finished retries the remaining foreground hold', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = fixture('already-completed');
  state.workspaceReleaseFailures = 1;
  try {
    begin(state.run);
    await until(() => state.result);
    assert.match(state.result.stderr, /handoff lease failed/);
    assert.ok(state.result.settled instanceof Promise);
    let settled = false;
    state.result.settled.then(() => { settled = true; });
    await flush();
    assert.equal(state.workspaceReleases, 0);
    assert.equal(settled, false, 'a failed foreground release is still owned after the native observer ended');
    t.mock.timers.tick(5_000);
    await until(() => state.workspaceReleases === 1);
    await state.result.settled;
    assert.equal(state.deletes, 1);
    assert.equal(state.workspaceReleases, 1);
  } finally {
    state.run.stopTerminationWatch?.();
    t.mock.timers.reset();
  }
});
