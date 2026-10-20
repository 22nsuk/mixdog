// Import before runtime modules: shell-job records are written under it.
import '../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, mock } from 'node:test';
import { holdWorkspaceActivity, tryAdmitWorkspaceActivity } from '../../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo } from '../../../../shared/worktrees/test-support.mjs';
import { processTable, scriptedChildTree } from '../lib/process-table-fixture.mjs';

// In-memory native runner and a scripted process table.
const tasks = new Map();
const events = new EventEmitter();
const onCancel = new Map();
const pendingPromotions = new Map();
const ownerCancels = new Map();
function setTask(jobId, status, detail = {}) {
  const task = { ...tasks.get(jobId), ...detail, status };
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
      onCancel.get(jobId)?.();
      setTask(jobId, 'cancelled');
      return { ...tasks.get(jobId) };
    },
    waitNativeTask: async (jobId) => (tasks.has(jobId) ? { ...tasks.get(jobId) } : null),
    releaseNativeTask: noop,
    promoteNativeTask: async ({ jobId, command, cwd, ownerSessionId }) => {
      tasks.set(jobId, { jobId, command, cwd, ownerSessionId, pid: Number(jobId.split('_').pop()), status: 'running' });
      await pendingPromotions.get(jobId);
      return { ...tasks.get(jobId) };
    },
    setNativeTaskOutputPaths: noop,
    retainNativeTaskResult: (detail) => tasks.set(detail.jobId, { ...detail }),
    setNativeTaskStartedAt: noop,
    trackNativeForegroundTask: async () => null,
    cancelNativeTasks: ({ ownerSessionId } = {}) =>
      ownerCancels.get(ownerSessionId)?.() || { cancelled: 0, unconfirmed: [], confirmed: true },
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
  peekShellJob,
  promoteForegroundShellJob,
  shutdownShellJobs,
  subscribeShellJobSettled,
  waitForShellJob,
  waitShellJobTerminated,
  watchBackgroundShellJob,
} = await import('./shell-jobs.mjs');
const { getBackgroundTask, registerBackgroundTask } = await import('../../../../shared/background-tasks.mjs');
const { executeTaskTool } = await import('./task-tool.mjs');
const { cleanupArtifactOnTaskSettled } = await import('./bash-tool/transport-artifacts.mjs');
const {
  _shellJobRecordWritesSettledForTest,
  forceReleaseTerminationHold,
  noteShellOwnerSessionClosed,
  readShellJobRecord,
} = await import('./lib/shell-job-records.mjs');
const { cancelOwnedShellTrees } = await import('../lib/owned-shell-trees.mjs');
const { createShellRun, registerForegroundOwnedTree } = await import('../lib/shell-run-state.mjs');
const { handOverLease, promoteWithRetry } = await import('../lib/shell-run-background/promote-job.mjs');
const { shellJobsStatusFresh } = await import('../../../../shared/statusline/statusline-segments.mjs');

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

function registerTask(jobId, notices, ownerSessionId = 'sess_bg') {
  const task = registerBackgroundTask({
    taskId: jobId,
    surface: 'shell',
    operation: 'shell',
    context: {
      callerSessionId: ownerSessionId,
      notifyFn: (text) => {
        notices.push(text);
        return true;
      },
    },
    cancel: () => killShellJob(jobId),
  });
  watchBackgroundShellJob(jobId, task.notifyContext);
  return task;
}

test('native transport failure keeps a surviving background root and its transport artifact owned', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_7300';
  const artifact = join(repo, 'command-script.js');
  writeFileSync(artifact, 'the live root still needs this script');
  tree.state.next = () => processTable([{ pid: 7300 }]);
  await promote(repo, 7300);
  await flush();
  tree.state.kills.length = 0;
  const settled = [];
  subscribeShellJobSettled(jobId, (detail) => settled.push(detail));
  cleanupArtifactOnTaskSettled(artifact, jobId);
  setTask(jobId, 'failed', {
    rootExitObserved: false,
    error: 'native spawn server exited',
    exitCode: null,
    signal: null,
  });
  await flush();
  try {
    assert.equal(isHeld(repo), true, 'server loss is not evidence that the root exited');
    assert.equal(peekShellJob(jobId)?.status, 'running');
    assert.equal(settled.length, 0);
    assert.equal(existsSync(artifact), true);
    assert.ok(tree.state.kills.includes(7300), 'cleanup sweeps the positively identified root');
  } finally {
    tree.state.next = () => processTable([]);
    t.mock.timers.tick(5_000);
    await until(() => !isHeld(repo));
  }
  await until(() => settled.length === 1 && !existsSync(artifact));
  assert.equal(settled[0].status, 'failed', 'cleanup does not turn transport failure into cancellation');
  assert.equal(settled[0].error, 'native spawn server exited');
});

test('native transport failure after a captured background kill can confirm the tree is gone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_7400';
  tree.state.next = () => processTable([{ pid: 7400 }, { pid: 7401, ppid: 7400 }]);
  await promote(repo, 7400);
  await flush();
  onCancel.set(jobId, () => {
    // The native kill reaches the captured tree, but IPC is lost before a
    // root_exit event can arrive. Its pre-kill evidence is still valid.
    tree.state.next = () => processTable([]);
    setTask(jobId, 'failed', { rootExitObserved: false, error: 'native spawn server exited' });
  });
  killShellJob(jobId);
  await until(() => !isHeld(repo));
  assert.equal(peekShellJob(jobId)?.status, 'cancelled');
  assert.equal(peekShellJob(jobId)?.error, 'native spawn server exited');
});

test('a background job that exits on its own keeps the folder until its survivors are gone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  tree.state.next = () => processTable([{ pid: 6100 }, { pid: 6101, ppid: 6100 }]);
  await promote(repo, 6100);
  await flush();
  tree.state.next = () => processTable([{ pid: 6101, ppid: 6100 }]);
  setTask('job_bg_6100', 'completed');
  await flush();
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
  await _shellJobRecordWritesSettledForTest('job_bg_6300');
  assert.equal(await readShellJobRecord('job_bg_6300'), null, 'release retires only the workspace hold');
  assert.equal(peekShellJob('job_bg_6300')?.status, 'running', 'release is not evidence of termination');
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => !isShellJobRunning('job_bg_6300'));
});

test('closing a job owner without a snapshot keeps its hold visible until explicit release', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  // No identity snapshot ever lands: neither the promotion baseline nor the
  // pre-kill read.
  tree.state.next = () => {
    throw new Error('process enumeration denied');
  };
  await promoteForegroundShellJob({
    command: 'npm run dev',
    cwd: repo,
    pid: 6400,
    jobId: 'job_bg_6400',
    ownerSessionId: 'sess_closing',
  });
  await flush();
  // The session close: owner cancel, then the owner is noted closed.
  await cancelOwnedShellTrees('sess_closing');
  noteShellOwnerSessionClosed('sess_closing');
  tree.state.next = () => processTable([{ pid: 6402, ppid: 1, token: 'detached-worker', pgid: 6402 }]);
  setTask('job_bg_6400', 'cancelled');
  const record = await until(async () => {
    await _shellJobRecordWritesSettledForTest('job_bg_6400');
    const current = await readShellJobRecord('job_bg_6400');
    return current?.terminationUnconfirmed || current?.terminal ? current : null;
  });
  assert.equal(record.status, 'running', 'the native root exit cannot confirm an incomplete tree');
  assert.equal(record.terminationUnconfirmed, true);
  assert.equal(isHeld(repo), true);
  const status = await shellJobsStatusFresh({ clientHostPid: process.pid });
  assert.equal(status.orphaned.find((job) => job.taskId === 'job_bg_6400')?.terminationUnconfirmed, true);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(isHeld(repo), true, 'an empty later table cannot reconstruct the missing snapshot');
  assert.deepEqual(
    await forceReleaseTerminationHold('job_bg_6400', { callerSessionId: 'viewer', callerCwd: repo }),
    { released: true }
  );
  assert.equal(isHeld(repo), false);
  await _shellJobRecordWritesSettledForTest('job_bg_6400');
  assert.equal(await readShellJobRecord('job_bg_6400'), null);
  assert.equal(peekShellJob('job_bg_6400')?.status, 'running', 'missing evidence remains unknown after release');
  const released = await shellJobsStatusFresh({ clientHostPid: process.pid });
  assert.equal((released.orphaned || []).some((job) => job.taskId === 'job_bg_6400'), false);
});

test('task reads, completion notices and transport artifacts follow the cancelled tree, not its root', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_6500';
  const artifact = join(repo, 'command-script.js');
  writeFileSync(artifact, 'the child still needs this script');
  tree.state.next = () => processTable([{ pid: 6500 }, { pid: 6501, ppid: 6500, token: 'worker' }]);
  await promote(repo, 6500);
  await flush();
  const notices = [];
  registerTask(jobId, notices);
  const settled = [];
  subscribeShellJobSettled(jobId, (detail) => settled.push(detail));
  cleanupArtifactOnTaskSettled(artifact, jobId);
  onCancel.set(jobId, () => {
    tree.state.next = () => processTable([{ pid: 6501, ppid: 1, token: 'worker' }]);
  });
  killShellJob(jobId);
  await flush();
  assert.equal(tasks.get(jobId).status, 'cancelled', 'the native root really is terminal');
  assert.equal(getBackgroundTask(jobId).status, 'running', 'the surviving child keeps the task open');
  assert.equal(peekShellJob(jobId)?.status, 'running');
  const read = await executeTaskTool({ action: 'read', task_id: jobId }, { callerSessionId: 'sess_bg' });
  assert.match(read, /status: running/);
  assert.equal(getBackgroundTask(jobId).status, 'running', 'task read cannot complete it from native status');
  assert.equal(notices.length, 0);
  assert.equal(settled.length, 0);
  assert.equal(existsSync(artifact), true);
  assert.equal(isHeld(repo), true);
  const waiting = waitForShellJob(jobId, { timeoutMs: 1_000 });
  await flush();
  t.mock.timers.tick(1_000);
  const timed = await waiting;
  assert.equal(timed.status, 'running');
  assert.equal(timed.waitTimedOut, true);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => getBackgroundTask(jobId).status === 'cancelled' && !existsSync(artifact) && !isHeld(repo));
  assert.equal(notices.length, 1);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, 'cancelled');
  setTask(jobId, 'cancelled');
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(notices.length, 1, 'duplicate native events cannot deliver a second completion');
  assert.equal(settled.length, 1);
});

test('a tree remains observable and finishes after its terminal native detail is evicted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_6600';
  tree.state.next = () => processTable([{ pid: 6600 }, { pid: 6601, ppid: 6600 }]);
  await promote(repo, 6600);
  await flush();
  tree.state.next = () => processTable([{ pid: 6601, ppid: 1 }]);
  setTask(jobId, 'completed', { exitCode: 0, stdoutPreview: 'root output retained' });
  await flush();
  tasks.delete(jobId); // native retention expiry/server release, while the child still runs
  assert.equal(peekShellJob(jobId)?.status, 'running', 'the lifecycle owns its last native detail');
  assert.equal(isShellJobRunning(jobId), true);
  const notices = [];
  const task = registerTask(jobId, notices); // late consumer, after native state was dropped
  const settled = [];
  assert.equal(typeof subscribeShellJobSettled(jobId, (detail) => settled.push(detail)), 'function');
  const aborted = new AbortController();
  const waiting = waitForShellJob(jobId, { timeoutMs: 60_000, signal: aborted.signal });
  aborted.abort();
  assert.equal((await waiting)?.status, 'running', 'an interrupted wait retains the observable task');
  assert.equal(notices.length, 0);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => task.status === 'completed' && !isHeld(repo));
  assert.equal(notices.length, 1);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].exitCode, 0);
  assert.equal(task.result.exit_code, 0);
  assert.equal(task.result.stdout_preview, 'root output retained');
});

test('workspace force-release does not complete a live tree or delete its artifacts, and sweeping continues', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_6700';
  const artifact = join(repo, 'still-used-script.js');
  writeFileSync(artifact, 'still in use');
  tree.state.next = () => processTable([{ pid: 6700 }, { pid: 6701, ppid: 6700 }]);
  await promote(repo, 6700);
  await flush();
  onCancel.set(jobId, () => {
    tree.state.next = () => processTable([{ pid: 6701, ppid: 1 }]);
  });
  killShellJob(jobId);
  await until(async () => {
    await _shellJobRecordWritesSettledForTest(jobId);
    return (await readShellJobRecord(jobId))?.terminationUnconfirmed;
  });
  // Register after native exit so this case specifically exercises release
  // and artifact ownership, independently of a native-event listener race.
  const notices = [];
  const task = registerTask(jobId, notices);
  cleanupArtifactOnTaskSettled(artifact, jobId);
  assert.deepEqual(await forceReleaseTerminationHold(jobId, { callerSessionId: 'sess_bg' }), { released: true });
  await flush();
  assert.equal(isHeld(repo), false, 'the user explicitly released the folder');
  assert.equal(task.status, 'running', 'workspace release cannot report process completion');
  assert.equal(notices.length, 0);
  assert.equal(existsSync(artifact), true);
  const killsBefore = tree.state.kills.filter((pid) => pid === 6701).length;
  t.mock.timers.tick(5_000);
  await flush();
  assert.ok(tree.state.kills.filter((pid) => pid === 6701).length > killsBefore, 'known survivors are still swept');
  assert.equal(existsSync(artifact), true);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => task.status === 'cancelled' && !existsSync(artifact));
  assert.equal(notices.length, 1);
});

test('a task can cancel surviving descendants after its root exited naturally', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_6800';
  tree.state.next = () => processTable([{ pid: 6800 }, { pid: 6801, ppid: 6800 }]);
  await promote(repo, 6800);
  await flush();
  tree.state.next = () => processTable([{ pid: 6801, ppid: 1 }]);
  setTask(jobId, 'completed', { exitCode: 0 });
  await flush();
  const killsBefore = tree.state.kills.filter((pid) => pid === 6801).length;
  killShellJob(jobId);
  await flush();
  t.mock.timers.tick(5_000);
  await flush();
  assert.ok(tree.state.kills.filter((pid) => pid === 6801).length > killsBefore, 'cancellation reaches the remaining tree');
  assert.equal(peekShellJob(jobId)?.status, 'running');
  const settled = [];
  subscribeShellJobSettled(jobId, (detail) => settled.push(detail));
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => settled.length > 0 && !isHeld(repo));
  assert.equal(settled[0].status, 'cancelled');
});

test('owner cancellation during pending promotion transfers its late pre-kill capture to the background tree', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_6900';
  const owner = 'sess_promoting';
  const child = Object.assign(new EventEmitter(), { pid: 6900, exitCode: null, signalCode: null });
  const run = createShellRun({ resolve() {}, jobId });
  Object.assign(run, {
    child,
    autoBackgrounded: true,
    workspaceAdmission: tryAdmitWorkspaceActivity(owner, repo, { kind: 'command' }),
  });
  registerForegroundOwnedTree(run, owner);
  const captures = [];
  tree.state.next = () => new Promise((resolve) => captures.push(resolve));
  let releasePromotion;
  pendingPromotions.set(jobId, new Promise((resolve) => { releasePromotion = resolve; }));
  let ownerCancelSent = false;
  ownerCancels.set(owner, () => {
    ownerCancelSent = true;
    child.signalCode = 'SIGTERM';
    tree.state.next = () => processTable([{ pid: 6902, ppid: 1, token: 'grandchild' }]);
    setTask(jobId, 'cancelled', { signal: 'SIGTERM' });
    return { cancelled: 1, unconfirmed: [], confirmed: true };
  });
  t.after(() => {
    pendingPromotions.delete(jobId);
    ownerCancels.delete(owner);
  });
  const promotion = promoteWithRetry(
    { run, command: 'build', cwd: repo, ownerSessionId: owner },
    { remainingBackgroundTimeoutMs: 0 }
  );
  await until(() => tasks.has(jobId));
  const capturesBeforeCancel = captures.length;
  const cancelling = cancelOwnedShellTrees(owner);
  await until(() => captures.length > capturesBeforeCancel);
  assert.equal(ownerCancelSent, false, 'owner cancellation first waits for its snapshot');
  t.mock.timers.tick(2_000);
  await cancelling;
  assert.equal(ownerCancelSent, true, 'the kill still reaches the root at the snapshot bound');
  releasePromotion();
  assert.equal((await promotion).job.jobId, jobId);
  await handOverLease(run);
  let settled = false;
  run.treeSettled.then(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  assert.equal(isHeld(repo), true, 'adoption cannot release on the already-exited root');
  // The read began before cancellation, but its result reaches the runtime
  // after promotion. Neither the pending read nor its identities may be lost.
  const beforeKill = processTable([
    { pid: 6900 },
    { pid: 6901, ppid: 6900 },
    { pid: 6902, ppid: 6901, token: 'grandchild' },
  ]);
  for (const resolve of captures) resolve(beforeKill);
  await flush();
  t.mock.timers.tick(5_000);
  await flush();
  assert.ok(tree.state.kills.includes(6902), 'the adopted tree sweeps the detached grandchild');
  assert.equal(settled, false);
  assert.equal(isHeld(repo), true);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => settled && !isHeld(repo));
  assert.equal((await run.treeSettled).status, 'cancelled');
});

test('scoped shutdown includes an evicted terminal root while its descendants remain alive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const otherRepo = makeRepo();
  const jobId = 'job_bg_7000';
  const otherJobId = 'job_bg_7100';
  tree.state.next = () => processTable([{ pid: 7000 }, { pid: 7001, ppid: 7000 }, { pid: 7100 }]);
  await promoteForegroundShellJob({
    command: 'build', cwd: repo, pid: 7000, jobId, ownerSessionId: 'sess_shutdown',
  });
  await promoteForegroundShellJob({
    command: 'server', cwd: otherRepo, pid: 7100, jobId: otherJobId, ownerSessionId: 'sess_other_shutdown',
  });
  await flush();
  tree.state.next = () => processTable([{ pid: 7001, ppid: 1 }, { pid: 7100 }]);
  setTask(jobId, 'completed', { exitCode: 0 });
  await flush();
  tasks.delete(jobId);
  const notices = [];
  const task = registerTask(jobId, notices, 'sess_shutdown');
  let returned = false;
  const stopping = shutdownShellJobs('session-close', { scope: { ownerSessionId: 'sess_shutdown' } }).then((result) => {
    returned = true;
    return result;
  });
  await flush();
  assert.equal(returned, false, 'shutdown waits for the surviving tree, despite native cache eviction');
  t.mock.timers.tick(3_000);
  const outcome = await stopping;
  assert.equal(outcome.cancelledJobs, 1);
  assert.equal(outcome.cancelledWatchers, 0, 'shutdown preserves the physical completion consumer');
  assert.deepEqual(outcome.treeUnconfirmedJobs, [jobId]);
  assert.equal(task.status, 'running');
  assert.equal(notices.length, 0);
  assert.equal(tasks.get(otherJobId).status, 'running', 'another owner is outside the shutdown scope');
  assert.equal(isHeld(repo), true);
  t.mock.timers.tick(2_000);
  await flush();
  assert.ok(tree.state.kills.includes(7001), 'shutdown continues sweeping after its bounded wait');
  assert.equal(tree.state.kills.includes(7100), false);
  tree.state.next = () => processTable([{ pid: 7100 }]);
  t.mock.timers.tick(5_000);
  await until(() => !isHeld(repo));
  await flush();
  assert.equal(peekShellJob(jobId)?.status, 'cancelled');
  assert.equal(task.status, 'cancelled', 'shutdown still delivers physical settlement to the task');
  assert.equal(notices.length, 1);
  assert.equal(isHeld(otherRepo), true);
  tree.state.next = () => processTable([]);
  setTask(otherJobId, 'completed', { exitCode: 0 });
  await until(() => !isHeld(otherRepo));
});

test('transient waiters and subscriptions detach from an unconfirmed tree without retaining lifetime handlers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_7200';
  const run = createShellRun({ resolve() {}, jobId });
  run.child = { pid: 7200, exitCode: null, signalCode: null };
  tree.state.next = () => { throw new Error('process enumeration unavailable'); };
  await promoteForegroundShellJob({ command: 'build', cwd: repo, pid: 7200, jobId, run, ownerSessionId: 'sess_bg' });
  setTask(jobId, 'completed', { exitCode: 0 });
  await flush();
  // A Promise reaction cannot be detached. This existing lifetime promise
  // remains pending for an unknown tree, so repeated short-lived consumers
  // must not append reactions that retain their callbacks until it ends.
  const lifetimeThen = t.mock.method(run.treeSettled, 'then');
  let cancelledCalls = 0;
  for (let round = 0; round < 3; round += 1) {
    const unsubscribe = subscribeShellJobSettled(jobId, () => { cancelledCalls += 1; });
    unsubscribe();
    const abort = new AbortController();
    const waiting = waitForShellJob(jobId, { timeoutMs: 60_000, signal: abort.signal });
    abort.abort();
    assert.equal((await waiting).status, 'running');
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  }
  const timeoutSignal = new AbortController();
  const timed = waitForShellJob(jobId, { timeoutMs: 250, signal: timeoutSignal.signal });
  t.mock.timers.tick(250);
  assert.equal((await timed).waitTimedOut, true);
  assert.equal(getEventListeners(timeoutSignal.signal, 'abort').length, 0);
  const bounded = waitShellJobTerminated(jobId, 250);
  t.mock.timers.tick(250);
  assert.equal(await bounded, false);
  assert.equal(lifetimeThen.mock.callCount(), 0, 'finished waits retain no irreversible lifetime-promise handlers');
  let activeCalls = 0;
  subscribeShellJobSettled(jobId, () => { activeCalls += 1; });
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(() => activeCalls === 1 && !isHeld(repo));
  assert.equal(cancelledCalls, 0, 'unsubscribed consumers never fire');
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(activeCalls, 1);
});
