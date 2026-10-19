import '../../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, mock } from 'node:test';
import { holdWorkspaceActivity, tryAdmitWorkspaceActivity } from '../../../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo } from '../../../../../shared/worktrees/test-support.mjs';
import { processTable, scriptedChildTree } from '../../lib/process-table-fixture.mjs';
import {
  cancelBackgroundTasks,
  completeBackgroundTask,
  getBackgroundTask,
  hasActiveBackgroundTasks,
  registerBackgroundTask,
} from '../../../../../shared/background-tasks.mjs';
import { withTurnProgress } from '../../../session/agent-pool-progress.mjs';
import { isTurnInFlight } from '../../../session/manager/runtime-state.mjs';

const tree = scriptedChildTree();
mock.module('../../../mcp/child-tree.mjs', { namedExports: tree.namedExports });
const { renderCompletedResult } = await import('./completed-result.mjs');
const { adoptShellWorkspaceAdmission } = await import('../lib/shell-job-records.mjs');

after(cleanupTempDirs);

const flush = () => new Promise((resolve) => setImmediate(resolve));
const isHeld = (repo) => {
  try {
    holdWorkspaceActivity([repo])();
    return false;
  } catch (error) {
    assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
    return true;
  }
};

// A finished foreground command hands its folder reservation to the processes
// it left running; the reservation must end with the last of them.
test('the folder reservation handed to survivors is released once they are gone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_survivor_handoff';
  adoptShellWorkspaceAdmission(jobId, tryAdmitWorkspaceActivity('session', repo, { kind: 'command' }));
  const survivor = { pid: process.pid, ppid: 1, token: 'survivor' };
  tree.state.next = () => processTable([survivor]);
  renderCompletedResult({
    result: {
      exitCode: 0,
      stdout: '',
      stderr: '',
      descendants: {
        taskId: jobId,
        rootPid: 7100,
        groupPid: null,
        killPids: [process.pid],
        watchPids: [process.pid],
        watch: [{ pid: process.pid, token: 'survivor', name: 'node.exe' }],
        reachable: true,
      },
    },
    command: 'node server.js',
    analysisCommand: 'node server.js',
    cwd: repo,
    options: { sessionId: 'session' },
    startedAtMs: Date.now(),
    stdout: '',
    stderr: '',
    timeout: 0,
  });
  await flush();
  assert.equal(isHeld(repo), true, 'the survivor still runs');
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await flush();
  await flush();
  assert.equal(isHeld(repo), false);
});

// An app the command launched on purpose (Start-Process 'Docker Desktop.exe')
// stays tracked for `task cancel`, but the idle agent is not waiting on it: its
// Agents row must not read "waiting" for as long as the app lives, and the
// task still settles when the last process is gone.
test('survivors a finished command left running do not hold the idle agent row waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = 'sess_survivor_pool';
  const survivor = { pid: process.pid, ppid: 1, token: 'survivor' };
  tree.state.next = () => processTable([survivor]);
  renderCompletedResult({
    result: {
      exitCode: 0,
      stdout: '',
      stderr: '',
      descendants: {
        taskId: 'job_survivor_pool',
        rootPid: 7200,
        groupPid: null,
        killPids: [process.pid],
        watchPids: [process.pid],
        watch: [{ pid: process.pid, token: 'survivor', name: 'Docker Desktop.exe' }],
        reachable: true,
      },
    },
    command: "Start-Process 'Docker Desktop.exe'",
    analysisCommand: "Start-Process 'Docker Desktop.exe'",
    cwd: process.cwd(),
    options: { sessionId: owner },
    startedAtMs: Date.now(),
    stdout: '',
    stderr: '',
    timeout: 0,
  });
  await flush();
  const scope = { callerSessionId: owner, surface: 'shell' };
  const idleRow = (hasRunningTasks) =>
    withTurnProgress(
      [{ sessionId: owner, agent: 'worker', status: 'idle' }],
      () => undefined,
      isTurnInFlight,
      hasRunningTasks
    )[0];
  assert.equal(hasActiveBackgroundTasks(scope), true, 'the survivor task is live and cancellable');
  const awaited = (sid) => hasActiveBackgroundTasks({ ...scope, callerSessionId: sid, awaitedOnly: true });
  assert.equal(idleRow(awaited).awaitingTask, undefined);
  const handedOff = registerBackgroundTask({ surface: 'shell', context: { callerSessionId: owner } });
  assert.equal(idleRow(awaited).awaitingTask, 'background', 'a handed-off job still reads waiting');
  completeBackgroundTask(handedOff.taskId, { status: 'completed', notify: false });
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await flush();
  await flush();
  assert.equal(hasActiveBackgroundTasks(scope), false, 'the task settled once the survivors were gone');
});

test('closing an owner waits for its survivors and retries their workspace release before completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const owner = 'sess_survivor_close';
  const jobId = 'job_survivor_close';
  const notices = [];
  adoptShellWorkspaceAdmission(jobId, tryAdmitWorkspaceActivity(owner, repo, { kind: 'command' }));
  const survivor = { pid: 7501, ppid: 1, token: 'survivor-close' };
  tree.state.next = () => processTable([survivor]);
  renderCompletedResult({
    result: {
      exitCode: 0,
      stdout: '',
      stderr: '',
      descendants: {
        taskId: jobId,
        rootPid: 7500,
        groupPid: null,
        killPids: [survivor.pid],
        watchPids: [survivor.pid],
        watch: [{ pid: survivor.pid, token: survivor.token, name: 'node.exe' }],
        reachable: true,
      },
    },
    command: 'node server.js',
    analysisCommand: 'node server.js',
    cwd: repo,
    options: {
      sessionId: owner,
      notifyFn: (message) => {
        notices.push(message);
        return true;
      },
    },
    startedAtMs: Date.now(),
    stdout: '',
    stderr: '',
    timeout: 0,
  });
  await flush();
  const task = getBackgroundTask(jobId);
  const cancel = () => cancelBackgroundTasks({ executionSessionId: owner, reason: 'owner closed', notify: true });
  const kills = tree.state.kills.length;
  assert.deepEqual(cancel(), { cancelled: 1 });
  await flush();
  assert.ok(tree.state.kills.length > kills);
  assert.equal(task.status, 'running');
  assert.equal(isHeld(repo), true);
  assert.deepEqual(notices, [], 'a bounded kill result is not a completion');

  const firstKills = tree.state.kills.length;
  assert.deepEqual(cancel(), { cancelled: 1 });
  await flush();
  assert.ok(tree.state.kills.length > firstKills, 'a repeated cancellation retries the survivor kill');
  assert.equal(task.status, 'running');
  assert.deepEqual(notices, []);

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
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await flush();
  await flush();
  assert.equal(task.status, 'running', 'failed admission release retains the completion owner for retry');
  assert.deepEqual(notices, []);

  restoreLedger();
  t.mock.timers.tick(5_000);
  await task.promise;
  assert.equal(task.status, 'cancelled');
  assert.equal(task.result.status, 'cancelled');
  assert.equal(isHeld(repo), false);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /cancelled/);
});
