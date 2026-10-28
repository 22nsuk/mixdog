// Import before runtime modules: shell-job records are written under it.
import '../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test, { after, mock } from 'node:test';
import { holdWorkspaceActivity } from '../../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo } from '../../../../shared/worktrees/test-support.mjs';
import { processTable, scriptedChildTree } from '../lib/process-table-fixture.mjs';

// In-memory native runner and a scripted process table.
const tasks = new Map();
const events = new EventEmitter();
const onCancel = new Map();
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
let onSweep = null;
const recordSweep = tree.namedExports.killProcessTrees;
tree.namedExports.killProcessTrees = async (pids) => {
  await recordSweep(pids);
  onSweep?.(pids);
};
mock.module('../../mcp/child-tree.mjs', { namedExports: tree.namedExports });

const {
  isShellJobRunning, killShellJob, peekShellJob, refreshShellJob, promoteForegroundShellJob,
  subscribeShellJobSettled, waitForShellJob, waitShellJobTerminated, watchBackgroundShellJob,
  otherSessionBackgroundShellJobCount, reconcileRecoveredShellJobCompletions,
} = await import('./shell-jobs.mjs');
const { cleanupArtifactOnTaskSettled } = await import('./bash-tool/transport-artifacts.mjs');
const {
  _shellJobRecordWritesSettledForTest,
  forceReleaseTerminationHold,
  noteShellOwnerSessionClosed,
  readShellJobRecord,
} = await import('./lib/shell-job-records.mjs');
const { cancelOwnedShellTrees } = await import('../lib/owned-shell-trees.mjs');
const { shellJobsStatusFresh } = await import('../../../../shared/statusline/statusline-segments.mjs');
const { cleanupBackgroundTasks, getBackgroundTask, registerBackgroundTask } = await import('../../../../shared/background-tasks.mjs');
const { executeTaskTool, stopBackgroundShellJob } = await import('./task-tool.mjs');
const { parseTaskNotification } = await import('../../../../shared/task-notification-envelope.mjs');

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
// A hoisted script the job still runs from, removed when the job settles.
function transportArtifact(repo, jobId) {
  const file = join(repo, `${jobId}-script.cjs`);
  writeFileSync(file, 'setInterval(() => {}, 1000);');
  cleanupArtifactOnTaskSettled(file, jobId);
  return file;
}

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
  await until(async () => {
    await _shellJobRecordWritesSettledForTest('job_bg_6100');
    return !isHeld(repo);
  });
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
  await until(async () => {
    await _shellJobRecordWritesSettledForTest('job_bg_6200');
    return !isHeld(repo);
  });
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
  assert.equal(done.terminal, false);
  assert.equal(done.status, 'running');
  assert.equal(done.workspaceReleased, true);
  assert.equal(isShellJobRunning('job_bg_6300'), true, 'release is not evidence of termination');
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(async () => {
    await _shellJobRecordWritesSettledForTest('job_bg_6300');
    return !isShellJobRunning('job_bg_6300');
  });
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
  const closing = cancelOwnedShellTrees('sess_closing');
  await flush();
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
  t.mock.timers.tick(7_000);
  await flush();
  assert.equal(isHeld(repo), true, 'an empty later table cannot reconstruct the missing snapshot');
  assert.equal((await closing).confirmed, false, 'owner close does not turn missing evidence into confirmation');
  assert.deepEqual(await forceReleaseTerminationHold('job_bg_6400', { callerSessionId: 'viewer', callerCwd: repo }), {
    released: true,
  });
  assert.equal(isHeld(repo), false);
  const done = await readShellJobRecord('job_bg_6400');
  assert.equal(done.terminal, false);
  assert.equal(done.status, 'running');
  assert.equal(done.workspaceReleased, true);
  assert.equal(isShellJobRunning('job_bg_6400'), true);
  const released = await shellJobsStatusFresh({ clientHostPid: process.pid });
  assert.ok(released.jobs.some((job) => job.taskId === 'job_bg_6400'), 'released work remains stoppable');
  assert.equal(released.jobs.find((job) => job.taskId === 'job_bg_6400')?.terminationUnconfirmed, undefined);
});

// The root ends on its own or by a cancel; a worker it started keeps running.
function endRoot(jobId, pid, ending) {
  const survivor = () => processTable([{ pid: pid + 1, ppid: pid, token: 'worker' }]);
  if (ending === 'cancelled') {
    onCancel.set(jobId, () => {
      tree.state.next = survivor;
    });
    killShellJob(jobId);
    return;
  }
  tree.state.next = survivor;
  setTask(jobId, 'completed');
}

for (const [ending, pid] of [
  ['completed', 6510],
  ['cancelled', 6520],
]) {
  test(`a transport artifact of a ${ending} background root stays until its tree is gone`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const repo = makeRepo();
    const jobId = `job_bg_${pid}`;
    tree.state.next = () => processTable([{ pid }, { pid: pid + 1, ppid: pid, token: 'worker' }]);
    await promote(repo, pid);
    await flush();
    const artifact = transportArtifact(repo, jobId);
    endRoot(jobId, pid, ending);
    await flush();
    assert.equal(tasks.get(jobId).status, ending, 'the native root is terminal');
    t.mock.timers.tick(5_000);
    await flush();
    assert.equal(existsSync(artifact), true, 'the surviving worker may still use it');
    assert.equal(isShellJobRunning(jobId), true, 'a process of the job still runs');
    tree.state.next = () => processTable([]);
    t.mock.timers.tick(5_000);
    await until(async () => {
      await _shellJobRecordWritesSettledForTest(jobId);
      return !existsSync(artifact);
    });
    assert.equal(isShellJobRunning(jobId), false);
  });
}

test('one whole lifecycle owns reads, waits and completion after the native result is evicted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_6600';
  tree.state.next = () => processTable([{ pid: 6600 }, { pid: 6601, ppid: 6600 }]);
  await promote(repo, 6600);
  await flush();
  const notices = [];
  const completed = watchBackgroundShellJob(jobId, {
    callerSessionId: 'sess_bg', notifyFn: (...args) => notices.push(args),
  });
  const calls = [];
  subscribeShellJobSettled(jobId, (detail) => calls.push(detail));
  tree.state.next = () => processTable([{ pid: 6601, ppid: 6600 }]);
  setTask(jobId, 'completed', { exitCode: 0, stdoutPreview: 'root output' });
  await flush();
  assert.equal(peekShellJob(jobId).status, 'running');
  assert.equal(refreshShellJob(jobId).terminationUnconfirmed, false, 'a known survivor remains stoppable');
  assert.equal(isHeld(repo), true);
  assert.equal(notices.length, 0);
  assert.equal(calls.length, 0);
  tasks.delete(jobId); // the native terminal cache's TTL/cap has no authority over this tree
  assert.equal(peekShellJob(jobId).stdoutPreview, 'root output');
  const later = [];
  assert.equal(typeof subscribeShellJobSettled(jobId, (detail) => later.push(detail)), 'function');
  const wait = waitForShellJob(jobId, { timeoutMs: 1 });
  t.mock.timers.tick(1);
  const waiting = await wait;
  assert.equal(waiting.status, 'running');
  assert.equal(waiting.waitTimedOut, true);
  await _shellJobRecordWritesSettledForTest(jobId);
  assert.equal(await reconcileRecoveredShellJobCompletions(), 0, 'a live tracker is not a lost restart task');
  assert.equal(notices.length, 0);
  assert.equal(isHeld(repo), true);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(async () => {
    await _shellJobRecordWritesSettledForTest(jobId);
    return !isShellJobRunning(jobId);
  });
  await completed;
  assert.equal(peekShellJob(jobId).status, 'completed', 'the final result survives native eviction too');
  assert.equal(peekShellJob(jobId).stdoutPreview, 'root output');
  assert.equal(notices.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(later.length, 1);
  assert.equal(isHeld(repo), false);
  assert.equal(otherSessionBackgroundShellJobCount(new Set(['sess_bg', 'sess_closing'])), 0);
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(notices.length, 1);
});

for (const [cancel, pid] of [['stop', 6700], ['owner', 6800]]) {
  test(`${cancel} still sweeps a known survivor after the native root has exited`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const repo = makeRepo();
    const jobId = `job_bg_${pid}`;
    tree.state.next = () => processTable([{ pid }, { pid: pid + 1, ppid: pid }]);
    await promote(repo, pid);
    await flush();
    tree.state.next = () => processTable([{ pid: pid + 1, ppid: pid }]);
    setTask(jobId, 'completed', { exitCode: 0 });
    await flush();
    assert.equal(peekShellJob(jobId).status, 'running');
    onSweep = (pids) => {
      if (pids.includes(pid + 1)) tree.state.next = () => processTable([]);
    };
    t.after(() => { onSweep = null; });
    let closing;
    if (cancel === 'stop') assert.equal(killShellJob(jobId).killed, true);
    else closing = cancelOwnedShellTrees('sess_bg');
    await flush();
    t.mock.timers.tick(5_000);
    await until(async () => {
      await _shellJobRecordWritesSettledForTest(jobId);
      return !isShellJobRunning(jobId);
    });
    if (closing) assert.equal((await closing).confirmed, true, 'ordinary owner close confirms the swept tree');
    assert.ok(tree.state.kills.includes(pid + 1));
    assert.equal(peekShellJob(jobId).status, 'cancelled');
    assert.equal(await waitShellJobTerminated(jobId), true);
    assert.equal(isHeld(repo), false);
  });
}

test('releasing unknown protection keeps observation and completion pending until evidence arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_6900';
  tree.state.next = () => processTable([{ pid: 6900 }, { pid: 6901, ppid: 6900 }]);
  await promote(repo, 6900);
  await flush();
  tree.state.next = () => { throw new Error('enumeration denied'); };
  setTask(jobId, 'completed', { exitCode: 0 });
  await until(() => peekShellJob(jobId).terminationUnconfirmed);
  let settled = 0;
  subscribeShellJobSettled(jobId, () => { settled++; });
  assert.equal((await forceReleaseTerminationHold(jobId, { callerSessionId: 'other' })).released, false);
  assert.equal((await forceReleaseTerminationHold(jobId, { callerSessionId: 'sess_bg' })).released, true);
  assert.equal(isHeld(repo), false);
  assert.equal(peekShellJob(jobId).workspaceReleased, true);
  assert.equal(peekShellJob(jobId).status, 'running');
  assert.equal(settled, 0);
  const waiting = waitShellJobTerminated(jobId, 1);
  t.mock.timers.tick(1);
  assert.equal(await waiting, false);
  const reads = tree.state.reads;
  tree.state.next = () => processTable([{ pid: 6901, ppid: 6900 }]);
  t.mock.timers.tick(5_000);
  await flush();
  assert.ok(tree.state.reads > reads, 'release did not stop observation');
  assert.equal(peekShellJob(jobId).terminationUnconfirmed, false);
  assert.equal(settled, 0);
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(async () => {
    await _shellJobRecordWritesSettledForTest(jobId);
    return settled === 1;
  });
  assert.equal(peekShellJob(jobId).status, 'completed');
});

test('a pending post-root observation keeps the task and its Stop row visible', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_bg_7000';
  tree.state.next = () => processTable([{ pid: 7000 }, { pid: 7001, ppid: 7000 }]);
  await promote(repo, 7000);
  await flush();
  let observe;
  let pendingObservation = true;
  tree.state.next = () => {
    if (!pendingObservation) return processTable([{ pid: 7001, ppid: 7000 }]);
    pendingObservation = false;
    return new Promise((resolve) => { observe = resolve; });
  };
  setTask(jobId, 'completed', { exitCode: 0 });
  await flush();
  await _shellJobRecordWritesSettledForTest(jobId);
  const record = await readShellJobRecord(jobId);
  assert.equal(record.lifecycleOwnerPid, process.pid);
  assert.equal(record.status, 'running');
  assert.equal(peekShellJob(jobId).status, 'running');
  const status = await shellJobsStatusFresh({ clientHostPid: process.pid });
  assert.ok(status.jobs.some((job) => job.taskId === jobId), 'root death cannot hide the owner-tracked row');
  t.mock.timers.tick(5_000);
  await until(() => peekShellJob(jobId).terminationUnconfirmed);
  observe(processTable([{ pid: 7001, ppid: 7000 }]));
  tree.state.next = () => processTable([{ pid: 7001, ppid: 7000 }]);
  await flush();
  t.mock.timers.tick(5_000);
  await until(() => !peekShellJob(jobId).terminationUnconfirmed);
  assert.equal(peekShellJob(jobId).status, 'running');
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await until(async () => {
    await _shellJobRecordWritesSettledForTest(jobId);
    return !isShellJobRunning(jobId);
  });
});

test('Stop during terminal persistence keeps the record, task and notification outcome consistent', async () => {
  const repo = makeRepo();
  const jobId = 'job_bg_7100';
  const notices = [];
  const context = {
    callerSessionId: 'sess_bg',
    notifyFn: (text, meta) => {
      notices.push({ text, meta });
      return true;
    },
  };
  tree.state.next = () => processTable([{ pid: 7100 }]);
  await promote(repo, 7100);
  await _shellJobRecordWritesSettledForTest(jobId);
  const task = registerBackgroundTask({
    taskId: jobId,
    surface: 'shell',
    operation: 'shell',
    context,
    notifyOnCancel: true,
    cancel: () => {
      killShellJob(jobId);
      return task.promise;
    },
  });
  task.promise = watchBackgroundShellJob(jobId, context);
  const originalRename = fsp.rename;
  let releaseWrite;
  let signalWriteStarted;
  const writeStarted = new Promise((resolve) => { signalWriteStarted = resolve; });
  // Hold only the terminal record's first rename. The actual persistence and
  // task/notification consumers run unchanged, on both sides of the Stop.
  fsp.rename = async (source, destination, ...args) => {
    if (String(destination).endsWith(`${jobId}.json`) && !releaseWrite) {
      await new Promise((resolve) => {
        releaseWrite = resolve;
        signalWriteStarted();
      });
    }
    return originalRename(source, destination, ...args);
  };
  syncBuiltinESMExports();
  try {
    tree.state.next = () => processTable([]);
    setTask(jobId, 'completed', { exitCode: 0 });
    await writeStarted;
    assert.equal(peekShellJob(jobId).status, 'running', 'Stop remains available while completion is being stored');
    const stopping = stopBackgroundShellJob(jobId, context);
    await flush();
    releaseWrite();
    assert.deepEqual(await stopping, { stopped: true });
    await task.promise;
    assert.equal(peekShellJob(jobId).status, 'cancelled');
    assert.equal((await readShellJobRecord(jobId)).status, 'cancelled');
    assert.equal(getBackgroundTask(jobId).status, 'cancelled');
    assert.equal((await waitForShellJob(jobId)).status, 'cancelled');
    assert.match(await executeTaskTool({ action: 'read', task_id: jobId }, context), /status: cancelled/);
    assert.equal(notices.length, 1);
    assert.equal(parseTaskNotification(notices[0].text).status, 'cancelled');
    assert.equal(notices[0].meta.status, 'cancelled');
  } finally {
    releaseWrite?.();
    fsp.rename = originalRename;
    syncBuiltinESMExports();
    cleanupBackgroundTasks({ force: true, callerSessionId: 'sess_bg', surface: 'shell' });
  }
});
