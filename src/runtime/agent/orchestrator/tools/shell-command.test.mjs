// Import before runtime modules: several paths are captured at module load.
import { fixtureRoot } from './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import test, { after, mock } from 'node:test';
import { holdWorkspaceActivity, tryAdmitWorkspaceActivity } from '../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo } from '../../../shared/worktrees/test-support.mjs';
import { processTable, scriptedChildTree } from './lib/process-table-fixture.mjs';
import { cancelBackgroundTask, getBackgroundTask } from '../../../shared/background-tasks.mjs';

// A spawn phase that reports success without leaving a child behind: the
// wiring below it (output capture, settle, deadlines) then throws. Inside an
// async Promise executor that throw reaches nobody, so before the fix the
// caller awaited execShellCommand forever. Mocked before the first import of
// shell-command.mjs, which is the module's only importer.
let spawn = async () => {};
mock.module('./lib/shell-run-spawn.mjs', { namedExports: { spawnShellChild: (...args) => spawn(...args) } });
const tree = scriptedChildTree();
mock.module('../mcp/child-tree.mjs', { namedExports: tree.namedExports });

const { execShellCommand } = await import('./shell-command.mjs');
const { createProcessTreeTracker } = await import('./lib/shell-descendants.mjs');
const { retainNativeTaskResult } = await import('./lib/native-spawn-client.mjs');
const { executeTaskTool, stopBackgroundShellJob } = await import('./builtin/task-tool.mjs');
after(cleanupTempDirs);

test('a wiring fault after spawn settles the run instead of hanging the caller', async () => {
  const releases = [];
  const admission = {
    async acquire() {
      return {
        signal: null,
        async detachDependency() {},
        async release() {
          releases.push('release');
        },
      };
    },
  };
  let hangTimer;
  const hang = new Promise((_, reject) => {
    hangTimer = setTimeout(() => reject(new Error('execShellCommand never settled')), 5_000);
  });
  try {
    const result = await Promise.race([
      execShellCommand({
        shell: process.execPath,
        shellArg: '',
        command: 'echo wiring-fault-regression',
        env: process.env,
        cwd: fixtureRoot,
        timeoutMs: 1_000,
        admission,
      }),
      hang,
    ]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.failurePhase, 'tool');
    assert.equal(result.failureReason, 'spawn failed');
    assert.ok(result.stderr.length > 0, 'the failure reaches the caller as stderr text');
    assert.deepEqual(releases, ['release'], 'the admission lease is not leaked by the failure path');
  } finally {
    clearTimeout(hangTimer);
  }
});

test('an output-wiring failure owns cleanup until the last process is gone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const error = new Error('stdout listener setup failed');
  let run;
  let outputPath;
  let readsAtKill = 0;
  let releases = 0;
  let rows = [{ pid: 4540 }, { pid: 4541, ppid: 4540, token: 'worker' }];
  tree.state.next = () => processTable(rows);
  tree.state.reads = 0;
  const child = Object.assign(new EventEmitter(), {
    pid: 4540, exitCode: null, signalCode: null, __nativeSpawn: true,
    stdout: { on() { throw error; } },
    kill() {
      readsAtKill = tree.state.reads;
      this.exitCode = 1;
      rows = [{ pid: 4541, ppid: 1, token: 'worker' }];
      this.emit('exit', 1, null);
      return true;
    },
  });
  spawn = async ({ run: current }) => {
    run = current;
    run.child = child;
    run.foregroundRecordInput = { command: 'node worker.js', cwd: repo, ownerSessionId: 'wiring-failure' };
    run.workspaceAdmission = tryAdmitWorkspaceActivity('wiring-failure', repo, { kind: 'command' });
    run.taskOutput.forceSpill();
    run.taskOutput.writeStdout('partial startup output');
    outputPath = run.taskOutput.stdoutPath;
  };
  const result = await execShellCommand({
    shell: process.execPath, command: 'echo wiring-fault-regression', cwd: repo,
    ownerSessionId: 'wiring-failure', timeoutMs: 1_000,
    admission: { acquire: async () => ({ release: async () => { releases += 1; } }) },
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  assert.equal(result.exitCode, 1);
  assert.equal(result.failureReason, 'spawn failed');
  assert.equal(result.stderr, error.message, 'the original setup failure reaches the caller');
  assert.ok(readsAtKill > 0, 'the setup failure captures process identities before killing');
  assert.equal(releases, 1, 'the failed call no longer occupies a foreground resource slot');
  assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
  assert.equal(existsSync(outputPath), true);
  let settled = false;
  result.settled.then(() => { settled = true; });
  await flush();
  assert.equal(settled, false, 'root exit does not settle its live descendant');
  rows = [];
  t.mock.timers.tick(5_000);
  await result.settled;
  await flush();
  assert.equal(run.workspaceAdmission, null);
  assert.doesNotThrow(() => holdWorkspaceActivity([repo])());
  assert.equal(existsSync(outputPath), false);
});

for (const cancellation of ['none', 'before root exit', 'after root exit']) {
  const cancelled = cancellation !== 'none';
  test(`a queued foreground command waits for its tree: ${cancelled ? `cancel ${cancellation}` : 'completion'}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const realKill = process.kill;
    t.mock.method(process, 'kill', (pid, signal) => {
      if (pid === -4550) throw Object.assign(new Error('fixture process group is absent'), { code: 'ESRCH' });
      return realKill(pid, signal);
    });
    const repo = makeRepo();
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    let rows = [{ pid: 4550 }, { pid: 4551, ppid: 4550, token: 'queued-worker' }];
    tree.state.next = () => processTable(rows);
    let run;
    spawn = async ({ run: current }) => {
      run = current;
      run.foregroundRecordInput = { command: 'queued worker', cwd: repo, ownerSessionId: 'queued-owner' };
      run.workspaceAdmission = tryAdmitWorkspaceActivity('queued-owner', repo, { kind: 'command' });
      run.child = Object.assign(new EventEmitter(), {
        pid: 4550, exitCode: null, signalCode: null, __nativeSpawn: true,
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        kill() {
          this.exitCode = 1;
          rows = [{ pid: 4551, ppid: 1, token: 'queued-worker' }];
          this.emit('close', 1, null);
          return true;
        },
      });
      run.terminationTracker = createProcessTreeTracker({ pid: run.child.pid });
      await run.terminationTracker.capture();
    };
    let admissions = 0;
    const queued = await execShellCommand({
      shell: process.execPath, command: 'queued worker', cwd: repo,
      ownerSessionId: 'queued-owner', timeoutMs: 0, autoBackgroundMs: 0, backgroundOnTimeout: true,
      admission: {
        async acquire() {
          if (++admissions === 1) throw Object.assign(new Error('saturated'), { admissionSaturated: true });
          return { release: async () => {} };
        },
      },
    });
    assert.equal(queued.backgrounded, true);
    await flush();
    const task = getBackgroundTask(run.foregroundRecordId);
    assert.ok(task);
    let stopping = null;
    if (cancellation === 'before root exit') cancelBackgroundTask(task.taskId, 'cancel queued foreground');
    else {
      run.child.exitCode = 0;
      rows = [{ pid: 4551, ppid: 4550, token: 'queued-worker' }];
      run.child.emit('close', 0, null);
    }
    await flush();
    if (cancellation === 'after root exit') {
      retainNativeTaskResult({ jobId: task.taskId, status: 'completed', exitCode: 0 });
      await executeTaskTool({ action: 'read', task_id: task.taskId }, { sessionId: 'queued-owner' });
      assert.equal(task.status, 'running', 'task read cannot finalize the queued run from its native root result');
      tree.state.kills.length = 0;
      stopping = stopBackgroundShellJob(task.taskId, { sessionId: 'queued-owner' });
      await flush();
      t.mock.timers.tick(200);
      await flush();
      assert.ok(tree.state.kills.includes(4551), 'task cancellation reaches the handed-off survivor');
    }
    try {
      assert.equal(task.status, 'running', 'a live descendant keeps the task active');
      assert.equal(task.finishedAt, null);
      assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
    } finally {
      rows = [];
      t.mock.timers.tick(5_000);
      await flush();
    }
    await queued.settled;
    assert.equal(task.status, cancelled ? 'cancelled' : 'completed');
    if (stopping) assert.deepEqual(await stopping, { stopped: true });
    assert.doesNotThrow(() => holdWorkspaceActivity([repo])());
  });
}
