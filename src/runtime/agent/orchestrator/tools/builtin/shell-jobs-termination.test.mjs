// Import before runtime modules: shell-job records are written under it.
import '../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, mock } from 'node:test';
import { holdWorkspaceActivity } from '../../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo } from '../../../../shared/worktrees/test-support.mjs';
import { processTable, scriptedChildTree } from '../lib/process-table-fixture.mjs';
import {
  cancelBackgroundTasks,
  getBackgroundTask,
  registerBackgroundTask,
  startBackgroundTask,
} from '../../../../shared/background-tasks.mjs';
import { activeTaskWaitCountForSession, interruptTaskWaitForSession } from '../../session/task-wait-control.mjs';
import { parseTaskNotification } from '../../../../shared/task-notification-envelope.mjs';

// In-memory native runner and a scripted process table.
const tasks = new Map();
const events = new EventEmitter();
const onCancel = new Map();
function setTask(jobId, status) {
  const task = { ...tasks.get(jobId), status };
  tasks.set(jobId, task);
  events.emit(jobId, { ...task });
}
const noop = () => {};
mock.module('../lib/native-spawn-client.mjs', {
  namedExports: {
    getNativeTask: (jobId) => (tasks.has(jobId) ? { ...tasks.get(jobId) } : null),
    listNativeTasks: () => [...tasks.values()].map((task) => ({ ...task })),
    subscribeNativeTask: (jobId, listener) => {
      events.on(jobId, listener);
      return () => events.removeListener(jobId, listener);
    },
    cancelNativeTask: (jobId) => {
      if (!tasks.has(jobId)) return null;
      if (tasks.get(jobId).status !== 'running') return { ...tasks.get(jobId) };
      const terminalStatus = onCancel.get(jobId)?.();
      setTask(jobId, terminalStatus || 'cancelled');
      return { ...tasks.get(jobId) };
    },
    waitNativeTask: async (jobId) => (tasks.has(jobId) ? { ...tasks.get(jobId) } : null),
    releaseNativeTask: noop,
    promoteNativeTask: async ({ jobId, command, cwd, ownerSessionId }) => {
      tasks.set(jobId, { jobId, command, cwd, ownerSessionId, pid: Number(jobId.split('_').pop()), status: 'running' });
      return { ...tasks.get(jobId) };
    },
    setNativeTaskOutputPaths: noop,
    setNativeTaskStartedAt: noop,
    trackNativeForegroundTask: async () => null,
    cancelNativeTasks: () => ({ cancelled: 0, unconfirmed: [], confirmed: true }),
    tryNativeSpawn: () => null,
    ensureNativeSpawnServer: async () => null,
    warmNativeSpawnServer: async () => null,
    shutdownNativeSpawnServer: async () => {},
    setNativeSpawnRequestIdle: noop,
    nativeSpawnFileCaptureReady: () => false,
    nativeSpawnSupportsStdinPipe: () => false,
    _assertNativeSpawnCapabilitiesForTest: () => true,
    _resetNativeSpawnClientForTest: noop,
    _setNativeSpawnBinaryForTest: noop,
  },
});
const tree = scriptedChildTree();
mock.module('../../mcp/child-tree.mjs', { namedExports: tree.namedExports });

const {
  isShellJobRunning,
  killShellJob,
  otherSessionBackgroundShellJobCount,
  peekShellJob,
  promoteForegroundShellJob,
  shutdownShellJobs,
  subscribeShellJobSettled,
  waitForShellJob,
  waitShellJobTerminated,
  watchBackgroundShellJob,
} = await import('./shell-jobs.mjs');
const { executeTaskTool, stopBackgroundShellJob } = await import('./task-tool.mjs');
const { cleanupArtifactOnTaskSettled } = await import('./bash-tool/transport-artifacts.mjs');
const { renderBackgroundedResult } = await import('./bash-tool/backgrounded-result.mjs');
const { createProcessTreeTracker } = await import('../lib/shell-descendants.mjs');
const { _shellJobRecordWritesSettledForTest, forceReleaseTerminationHold, readShellJobRecord } = await import(
  './lib/shell-job-records.mjs'
);

after(cleanupTempDirs);

const flush = () => new Promise((resolve) => setImmediate(resolve));
// The record files are written through the job's async queue; wait on the
// observable state itself, a bounded number of event-loop turns.
async function until(read) {
  for (let turn = 0; turn < 1_000; turn += 1) {
    const value = await read();
    if (value) return value;
    await flush();
  }
  assert.fail('the expected record state never appeared');
}
const isHeld = (repo) => {
  try {
    holdWorkspaceActivity([repo])();
    return false;
  } catch (error) {
    assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
    return true;
  }
};
// The root pids are not live processes: the record's own reader (filed under
// the root pid) is dropped by the gate, exactly as after a real root exit.
const promote = (repo, pid) =>
  promoteForegroundShellJob({
    command: 'npm run dev',
    cwd: repo,
    pid,
    jobId: `job_bg_${pid}`,
    ownerSessionId: 'sess_bg',
  });

function registerTask(jobId, notices) {
  const context = {
    callerSessionId: 'sess_bg',
    routingSessionId: 'sess_bg',
    notifyFn: (message) => {
      notices.push(message);
      return true;
    },
  };
  registerBackgroundTask({ taskId: jobId, surface: 'shell', context, cancel: () => killShellJob(jobId) });
  return context;
}

async function untilUnconfirmed(jobId) {
  return until(async () => {
    await _shellJobRecordWritesSettledForTest(jobId);
    const record = await readShellJobRecord(jobId);
    return record?.terminationUnconfirmed ? record : null;
  });
}

test('promotion preserves foreground identities after their parent chain has exited', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_7800';
  tree.state.next = () => processTable([{ pid: 7800 }, { pid: 7801, ppid: 7800 }, { pid: 7802, ppid: 7801 }]);
  const terminationTracker = createProcessTreeTracker({ pid: 7800 });
  await terminationTracker.capture();
  tree.state.next = () => processTable([{ pid: 7802, ppid: 7801 }]);
  await promoteForegroundShellJob({
    command: 'npm run dev',
    cwd: repo,
    pid: 7800,
    jobId,
    ownerSessionId: 'sess_bg',
    terminationTracker,
  });
  const notices = [];
  watchBackgroundShellJob(jobId, registerTask(jobId, notices));
  killShellJob(jobId);
  await untilUnconfirmed(jobId);
  assert.ok(tree.state.kills.includes(7802), 'the promoted owner must retain the foreground snapshot');
  assert.equal(isHeld(repo), true);
  assert.deepEqual(notices, []);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => notices.length === 1);
  assert.equal(isHeld(repo), false);
});

for (const action of ['read-wait-stop', 'cancel']) {
  test(`task ${action} follows the queued owner while its native root is already terminal`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const jobId = `job_queued_owner_${action}`;
    const owner = `sess_queued_owner_${action}`;
    const context = { sessionId: owner, callerSessionId: owner };
    let finish;
    const settled = new Promise((resolve) => {
      finish = resolve;
    });
    t.after(() => finish());
    const notices = [];
    let ownerCancels = 0;
    let directNativeCancels = 0;
    tasks.set(jobId, { jobId, ownerSessionId: owner, status: 'cancelled', command: 'node server.js' });
    onCancel.set(jobId, () => {
      directNativeCancels += 1;
    });
    const task = startBackgroundTask({
      taskId: jobId,
      surface: 'shell',
      context: { ...context, notifyFn: (message) => notices.push(message) > 0 },
      cancelOwnsCompletion: true,
      cancel: () => {
        ownerCancels += 1;
      },
      run: async () => {
        await settled;
        return { status: 'cancelled', stdout_preview: 'done' };
      },
    });
    await flush();
    const scopedCancel = () => cancelBackgroundTasks({ executionSessionId: owner, notify: true });
    let completion;
    let wait;
    if (action === 'read-wait-stop') {
      scopedCancel();
      const read = await executeTaskTool({ action: 'read', task_id: jobId }, context);
      assert.match(read, /status: cancel-pending/);
      assert.equal(task.status, 'running');
      assert.notEqual(task.result?.status, 'cancelled', 'native terminal detail must not leak into the running result');
      assert.notEqual(task.completionAcknowledged, true);
      wait = executeTaskTool({ action: 'wait', task_id: jobId, timeout_ms: 30_000 }, context);
      completion = stopBackgroundShellJob(jobId, context);
    } else {
      completion = executeTaskTool({ action: 'cancel', task_id: jobId }, context);
    }
    let returned = false;
    completion.then(() => {
      returned = true;
    });
    await flush();
    assert.equal(ownerCancels, action === 'read-wait-stop' ? 2 : 1);
    assert.equal(directNativeCancels, 0, 'the queued owner must capture its tree before signalling the native root');
    assert.equal(task.status, 'running');
    assert.equal(returned, false, 'root exit does not settle the queued owner');
    assert.deepEqual(notices, []);

    finish();
    if (action === 'read-wait-stop') {
      assert.deepEqual(await completion, { stopped: true });
      assert.match(await wait, /status: cancelled/);
    } else {
      assert.match(await completion, /cancelled: shell/);
    }
    assert.equal(task.status, 'cancelled');
    assert.equal(notices.length, 1);
  });
}

for (const source of ['owner-close', 'task-cancel']) {
  test(`${source} after native root exit still sweeps before publishing a cancellation`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const repo = makeRepo();
    const pid = source === 'owner-close' ? 7600 : 7700;
    const jobId = `job_bg_${pid}`;
    const notices = [];
    tree.state.next = () => processTable([{ pid }, { pid: pid + 1, ppid: pid }]);
    await promote(repo, pid);
    await flush();
    tree.state.next = () => processTable([{ pid: pid + 1, ppid: 1 }]);
    setTask(jobId, 'completed');
    await untilUnconfirmed(jobId);
    renderBackgroundedResult({
      result: { jobId },
      command: 'npm run dev',
      cwd: repo,
      options: { sessionId: 'sess_bg', notifyFn: (message) => notices.push(message) > 0 },
      startedAtMs: Date.now(),
      stdout: '',
      stderr: '',
    });
    // The root can settle before its background result registers the task.
    // A same-turn close must win over the queued completion subscription.
    const cancellation =
      source === 'owner-close'
        ? cancelBackgroundTasks({ executionSessionId: 'sess_bg', reason: 'owner closed', notify: true })
        : executeTaskTool({ action: 'cancel', task_id: jobId }, { sessionId: 'sess_bg' });
    await flush();
    assert.equal(getBackgroundTask(jobId).status, 'running');
    assert.deepEqual(notices, [], 'a root that already exited still has a cancellable live tree');
    assert.equal((await waitForShellJob(jobId, { timeoutMs: 1 })).status, 'completed');
    t.mock.timers.tick(5_000);
    await until(() => tree.state.kills.includes(pid + 1));
    assert.equal(isHeld(repo), true);
    assert.deepEqual(notices, []);

    tree.state.next = () => processTable([]);
    t.mock.timers.tick(5_000);
    await until(() => notices.length === 1);
    await cancellation;
    assert.equal(getBackgroundTask(jobId).status, 'cancelled');
    assert.equal(parseTaskNotification(notices[0]).status, 'cancelled');
    await _shellJobRecordWritesSettledForTest(jobId);
    assert.equal((await readShellJobRecord(jobId)).status, 'cancelled');
    assert.equal(isHeld(repo), false);
  });
}

test('a cancellation notice and artifact settlement wait for the last tracked process', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_6400';
  const notices = [];
  tree.state.next = () => processTable([{ pid: 6400 }, { pid: 6401, ppid: 6400 }]);
  await promote(repo, 6400);
  const context = registerTask(jobId, notices);
  watchBackgroundShellJob(jobId, context);
  const settlements = [];
  subscribeShellJobSettled(jobId, (detail) => settlements.push(detail));
  onCancel.set(jobId, () => {
    tree.state.next = () => processTable([{ pid: 6401, ppid: 1 }]);
  });
  killShellJob(jobId);
  await untilUnconfirmed(jobId);
  assert.equal(notices.length, 0, 'the native terminal event is not a completed cancellation');
  assert.equal(settlements.length, 0, 'artifacts can still belong to the surviving process');
  assert.equal(getBackgroundTask(jobId).status, 'running');
  assert.equal(isShellJobRunning(jobId), true);
  assert.equal(peekShellJob(jobId).status, 'running');
  assert.equal(peekShellJob(jobId).nativeStatus, 'cancelled');
  assert.equal((await waitForShellJob(jobId)).status, 'cancelled', 'the raw root wait remains available');

  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => notices.length === 1 && !isHeld(repo));
  assert.equal(settlements.length, 1);
  assert.equal(getBackgroundTask(jobId).status, 'cancelled');
  assert.equal(isShellJobRunning(jobId), false);
  assert.equal(await waitShellJobTerminated(jobId, 1), true);
  setTask(jobId, 'cancelled');
  await flush();
  assert.equal(notices.length, 1, 'a duplicate native event cannot repeat the completion');
});

test('read, wait, stop and artifact cleanup retain an evicted native task until its tree settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_6500';
  const notices = [];
  tree.state.next = () => processTable([{ pid: 6500 }, { pid: 6501, ppid: 6500 }]);
  await promote(repo, 6500);
  const context = registerTask(jobId, notices);
  onCancel.set(jobId, () => {
    tree.state.next = () => processTable([{ pid: 6501, ppid: 1 }]);
  });
  killShellJob(jobId);
  await untilUnconfirmed(jobId);
  tasks.delete(jobId); // The native terminal cache expires before the tree.
  assert.equal(isShellJobRunning(jobId), true);
  assert.equal(otherSessionBackgroundShellJobCount(new Set(['another-session'])), 1);
  const artifact = join(repo, 'pending-script.sh');
  writeFileSync(artifact, 'echo still-owned');
  cleanupArtifactOnTaskSettled(artifact, jobId);
  t.mock.timers.tick(30 * 60_000);
  await flush();
  assert.equal(existsSync(artifact), true, 'the fallback cannot delete under a surviving process');

  const read = await executeTaskTool({ action: 'read', task_id: jobId }, context);
  assert.match(read, /status: cancel-pending/);
  assert.equal(getBackgroundTask(jobId).status, 'running');
  assert.notEqual(getBackgroundTask(jobId).completionAcknowledged, true);
  watchBackgroundShellJob(jobId, context);
  await flush();
  assert.equal(notices.length, 0, 'arming a watcher after root exit obeys the same boundary');

  const aborted = new AbortController();
  const abortWait = waitShellJobTerminated(jobId, 60_000, aborted.signal);
  aborted.abort();
  assert.equal(await abortWait, false, 'an interrupted wait leaves the tree tracked');

  for (const [reason, expected] of [
    ['user-message', /Wait ended by new user input.*Handle the new message first/],
    ['notification', /Wait ended because a notification arrived \(task_id: job_other\)/],
  ]) {
    const interrupted = executeTaskTool(
      { action: 'wait', task_id: jobId, timeout_ms: 30_000 },
      { ...context, sessionId: 'sess_bg' }
    );
    await until(() => activeTaskWaitCountForSession('sess_bg') === 1);
    await flush();
    assert.equal(interruptTaskWaitForSession('sess_bg', reason, 'job_other'), 1);
    const result = await interrupted;
    assert.match(result, /status: cancel-pending/);
    assert.match(result, expected, 'a pending cancellation must preserve why the wait ended');
    assert.equal(activeTaskWaitCountForSession('sess_bg'), 0);
  }

  let waitFinished = false;
  const wait = executeTaskTool({ action: 'wait', task_id: jobId, timeout_ms: 30_000 }, context).then((result) => {
    waitFinished = true;
    return result;
  });
  let stopFinished = false;
  const stop = stopBackgroundShellJob(jobId, context).then((result) => {
    stopFinished = true;
    return result;
  });
  await flush();
  assert.equal(waitFinished, false, 'a root terminal event does not complete task wait');
  assert.equal(stopFinished, false, 'repeat stop continues confirming the pending tree');

  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  const [waitResult, stopResult] = await Promise.all([wait, stop]);
  assert.match(waitResult, /status: cancelled/);
  assert.deepEqual(stopResult, { stopped: true });
  assert.equal(getBackgroundTask(jobId).status, 'cancelled');
  assert.equal(notices.length, 1);
  assert.equal(existsSync(artifact), false);
  assert.equal(otherSessionBackgroundShellJobCount(new Set(['another-session'])), 0);
});

test('releasing a cancelled job frees its folder without claiming its processes terminated', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_6600';
  const notices = [];
  tree.state.next = () => processTable([{ pid: 6600 }, { pid: 6601, ppid: 6600 }]);
  await promote(repo, 6600);
  const context = registerTask(jobId, notices);
  watchBackgroundShellJob(jobId, context);
  onCancel.set(jobId, () => {
    tree.state.next = () => processTable([{ pid: 6601, ppid: 1 }]);
  });
  killShellJob(jobId);
  await untilUnconfirmed(jobId);
  assert.deepEqual(await forceReleaseTerminationHold(jobId, { callerSessionId: 'sess_bg' }), { released: true });
  assert.equal(isHeld(repo), false);
  assert.equal(getBackgroundTask(jobId).status, 'running', 'release is only an admission decision');
  assert.equal(notices.length, 0);
  const confirmation = waitShellJobTerminated(jobId, 1);
  t.mock.timers.tick(1);
  assert.equal(await confirmation, false);

  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => notices.length === 1);
  assert.equal(getBackgroundTask(jobId).status, 'cancelled');
  assert.equal(await waitShellJobTerminated(jobId, 1), true);
});

test('a failed remote workspace release keeps observing and retries the consumed request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_6800';
  const notices = [];
  tree.state.next = () => processTable([{ pid: 6800 }, { pid: 6801, ppid: 6800 }]);
  await promote(repo, 6800);
  const context = registerTask(jobId, notices);
  watchBackgroundShellJob(jobId, context);
  onCancel.set(jobId, () => {
    tree.state.next = () => processTable([{ pid: 6801, ppid: 1 }]);
  });
  killShellJob(jobId);
  await untilUnconfirmed(jobId);

  const ledger = join(repo, '.git', 'mixdog-workspace-admission.json');
  const savedLedger = `${ledger}.saved`;
  renameSync(ledger, savedLedger);
  mkdirSync(ledger);
  let unavailable = true;
  const restoreLedger = () => {
    if (!unavailable) return;
    rmdirSync(ledger);
    renameSync(savedLedger, ledger);
    unavailable = false;
  };
  t.after(restoreLedger);
  assert.equal((await forceReleaseTerminationHold(jobId, { callerSessionId: 'sess_bg' })).released, false);
  writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'shell-jobs', `${jobId}.release-requested`), '');
  const reads = tree.state.reads;
  t.mock.timers.tick(5_000);
  await until(() => tree.state.reads > reads);
  await flush();
  assert.equal(getBackgroundTask(jobId).status, 'running');
  assert.equal(notices.length, 0);

  restoreLedger();
  t.mock.timers.tick(5_000);
  await until(async () => {
    await _shellJobRecordWritesSettledForTest(jobId);
    return (await readShellJobRecord(jobId)) === null;
  });
  assert.equal(isHeld(repo), false, 'the consumed request is retried after the ledger recovers');
  assert.equal(getBackgroundTask(jobId).status, 'running', 'releasing still does not complete the cancellation');
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => notices.length === 1);
});

test('owner shutdown silences a cancellation still waiting for its descendants', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_6700';
  const notices = [];
  tree.state.next = () => processTable([{ pid: 6700 }, { pid: 6701, ppid: 6700 }]);
  await promote(repo, 6700);
  const context = registerTask(jobId, notices);
  watchBackgroundShellJob(jobId, context);
  onCancel.set(jobId, () => {
    tree.state.next = () => processTable([{ pid: 6701, ppid: 1 }]);
  });
  killShellJob(jobId);
  await untilUnconfirmed(jobId);
  tasks.delete(jobId);
  const shutdown = shutdownShellJobs('owner-close', { scope: { ownerSessionId: 'sess_bg' } });
  await flush();
  t.mock.timers.tick(3_000);
  const result = await shutdown;
  assert.equal(result.cancelledWatchers, 1, 'a terminal root must not hide its deferred completion watch');
  assert.deepEqual(result.treeUnconfirmedJobs, [jobId]);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => !isHeld(repo));
  assert.equal(notices.length, 0, 'owner teardown can still silence a deferred cancellation');
});

for (const notify of [true, false]) {
  test(`a scoped close settles a promoted task after termination with notify=${notify}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const repo = makeRepo();
    const pid = notify ? 6900 : 7000;
    const jobId = `job_bg_${pid}`;
    const owner = `sess_scope_${pid}`;
    const notices = [];
    tree.state.next = () => processTable([{ pid }, { pid: pid + 1, ppid: pid }]);
    await promoteForegroundShellJob({ command: 'serve', cwd: repo, pid, jobId, ownerSessionId: owner });
    renderBackgroundedResult({
      result: { jobId },
      command: 'serve',
      cwd: repo,
      options: { sessionId: owner, notifyFn: (message) => notices.push(message) },
      startedAtMs: Date.now(),
      stdout: '',
      stderr: '',
    });
    onCancel.set(jobId, () => {
      tree.state.next = () => processTable([{ pid: pid + 1, ppid: 1 }]);
      // A root can finish just as its cancellation is requested. Generic
      // cancellation still owns the eventual outcome and its rendered notice.
      if (notify) return 'completed';
    });
    cancelBackgroundTasks({ executionSessionId: owner, reason: 'owner closed', notify });
    await untilUnconfirmed(jobId);
    assert.equal(getBackgroundTask(jobId).status, 'running');
    assert.equal(notices.length, 0, 'generic cancellation also waits for its shell owner');
    assert.equal((await waitForShellJob(jobId)).status, notify ? 'completed' : 'cancelled');
    tasks.delete(jobId);
    const shutdown = shutdownShellJobs('owner-close', { scope: { ownerSessionId: owner } });
    await flush();
    t.mock.timers.tick(3_000);
    assert.deepEqual((await shutdown).treeUnconfirmedJobs, [jobId]);
    assert.equal(getBackgroundTask(jobId).status, 'running');
    tree.state.next = () => processTable([]);
    t.mock.timers.tick(5_000);
    await until(() => getBackgroundTask(jobId).status === 'cancelled');
    assert.equal(notices.length, notify ? 1 : 0);
    if (notify) assert.equal(parseTaskNotification(notices[0]).status, 'cancelled');
    await _shellJobRecordWritesSettledForTest(jobId);
    assert.equal((await readShellJobRecord(jobId)).status, 'cancelled');
    assert.equal(isHeld(repo), false);
  });
}

test('a background job that exits on its own keeps the folder until its survivors are gone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  tree.state.next = () => processTable([{ pid: 6100 }, { pid: 6101, ppid: 6100 }]);
  await promote(repo, 6100);
  const notices = [];
  const context = registerTask('job_bg_6100', notices);
  watchBackgroundShellJob('job_bg_6100', context);
  await flush();
  tree.state.next = () => processTable([{ pid: 6101, ppid: 6100 }]);
  setTask('job_bg_6100', 'completed');
  await flush();
  assert.equal(notices.length, 1, 'a successful command still reports its result at root exit');
  assert.equal(getBackgroundTask('job_bg_6100').status, 'completed');
  assert.equal(isHeld(repo), true, 'the native terminal status is not termination');
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(isHeld(repo), true);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => !isHeld(repo));
});

test('a killed background job tracks a grandchild the kill orphaned', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  tree.state.next = () =>
    processTable([{ pid: 6200 }, { pid: 6201, ppid: 6200 }, { pid: 6202, ppid: 6201, token: 'worker' }]);
  await promote(repo, 6200);
  await flush();
  onCancel.set('job_bg_6200', () => {
    tree.state.next = () => processTable([{ pid: 6202, ppid: 6201, token: 'worker' }]);
  });
  assert.ok(killShellJob('job_bg_6200'));
  await flush();
  assert.equal(tasks.get('job_bg_6200').status, 'cancelled');
  assert.equal(isHeld(repo), true, 'the orphaned worker still runs');
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(isHeld(repo), true);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => !isHeld(repo));
});

test('a background job left unconfirmed is flagged on its record and can be force-released', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  tree.state.next = () => {
    throw new Error('process enumeration denied');
  };
  await promote(repo, 6300);
  await flush();
  setTask('job_bg_6300', 'completed');
  const record = await until(async () => {
    // Under load the record's file writes outlast any fixed number of
    // event-loop turns: read only once the writes queued so far have landed.
    await _shellJobRecordWritesSettledForTest('job_bg_6300');
    const current = await readShellJobRecord('job_bg_6300');
    return current?.terminationUnconfirmed ? current : null;
  });
  assert.equal(record.status, 'running', 'the record completes only with the lifecycle');
  assert.equal(record.terminationUnconfirmed, true);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(isHeld(repo), true, 'no timer releases it');
  assert.equal((await forceReleaseTerminationHold('job_bg_6300', { callerSessionId: 'someone-else' })).released, false);
  assert.deepEqual(await forceReleaseTerminationHold('job_bg_6300', { callerSessionId: 'sess_bg' }), {
    released: true,
  });
  assert.equal(isHeld(repo), false);
  const done = await readShellJobRecord('job_bg_6300');
  assert.equal(done.terminal, true);
  assert.equal(done.status, 'completed');
});
