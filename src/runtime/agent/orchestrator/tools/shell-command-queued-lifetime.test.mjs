import { fixtureRoot } from './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { mock } from 'node:test';
import { processTable, scriptedChildTree } from './lib/process-table-fixture.mjs';
import { cancelBackgroundTask, getBackgroundTask } from '../../../shared/background-tasks.mjs';

// Replace process creation and OS observation, while exercising the real
// admission queue, foreground runner, tree observer and task registry.
const ROOT = 6940;
const worker = { pid: 6941, ppid: ROOT, token: 'worker', pgid: ROOT };
const tree = scriptedChildTree();
mock.module('../mcp/child-tree.mjs', { namedExports: tree.namedExports });
let spawnedRun;
let spawnFailure = null;
let runReady;
let runReported;
mock.module('./lib/shell-run-spawn.mjs', {
  namedExports: {
    cleanupFailedShellChild: async () => {},
    spawnShellChild: async ({ run, ownerSessionId, cwd, command }) => {
      spawnedRun = run;
      const ready = runReady;
      const reported = runReported;
      const resolveResult = run.resolveResult;
      run.resolveResult = (result) => {
        const accepted = resolveResult(result);
        if (accepted) reported.resolve(result);
        return accepted;
      };
      if (spawnFailure) {
        run.treeSettled = spawnFailure;
        throw new Error('startup failed after process creation');
      }
      run.foregroundRecordInput = { ownerSessionId, cwd, command };
      run.child = Object.assign(new EventEmitter(), {
        pid: ROOT,
        exitCode: null,
        signalCode: null,
        __nativeSpawn: true,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => {
          exitRoot(137);
          return true;
        },
      });
      // The remaining exit/abort wiring is synchronous. Await its listener
      // registration instead of counting event-loop turns before spawn.
      run.child.on('newListener', (event) => {
        if (event === 'exit') ready.resolve(run);
      });
      registerForegroundOwnedTree(run, ownerSessionId);
    },
  },
});
const { execShellCommand } = await import('./shell-command.mjs');
const { registerForegroundOwnedTree } = await import('./lib/shell-run-state.mjs');
const flush = () => new Promise((resolve) => setImmediate(resolve));
function exitRoot(code) {
  const child = spawnedRun.child;
  child.exitCode = code;
  tree.state.next = () => processTable([{ ...worker, ppid: 1 }]);
  child.emit('exit', code, null);
  child.emit('close', code, null);
}
function queueCommand(taskId) {
  runReady = Promise.withResolvers();
  runReported = Promise.withResolvers();
  let acquisitions = 0;
  return execShellCommand({
    shell: process.execPath,
    command: 'node launcher.js',
    cwd: fixtureRoot,
    env: process.env,
    timeoutMs: 0,
    backgroundOnTimeout: true,
    ownerSessionId: `owner-${taskId}`,
    jobId: taskId,
    admission: {
      acquire: async () => {
        if (acquisitions++ === 0) throw Object.assign(new Error('shell lane saturated'), { admissionSaturated: true });
        return { release: async () => {} };
      },
    },
  });
}

for (const rootExit of ['natural', 'cancelled']) {
  test(`a queued command whose root is ${rootExit} stays running until every descendant exits`, { timeout: 5_000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const realKill = process.kill;
    t.mock.method(process, 'kill', (pid, signal) =>
      pid === -ROOT && signal === 0 ? true : realKill.call(process, pid, signal)
    );
    spawnedRun = null;
    tree.state.next = () => processTable([{ pid: ROOT }, worker]);
    tree.state.kills.length = 0;
    const taskId = `job_queued_${rootExit}_tree`;
    const result = await queueCommand(taskId);
    assert.equal(result.backgrounded, true);
    await runReady.promise;
    assert.equal(typeof spawnedRun.abortHandler, 'function');
    const task = getBackgroundTask(taskId);
    if (rootExit === 'natural') {
      exitRoot(0);
      await runReported.promise;
      assert.equal(task.status, 'running', 'a root result cannot finish the queued task');
    }
    cancelBackgroundTask(taskId, 'stop', { notify: false });
    await runReported.promise;
    assert.ok(spawnedRun.treeSettled);
    // Finish the scripted observer's first pass before advancing its clock.
    await flush();
    assert.equal(task.status, 'running', 'cancellation waits for actual termination');
    let settled = false;
    void result.settled.then(() => { settled = true; });
    // New descendants can appear after the root returned and after Stop.
    const later = { pid: 6942, ppid: worker.pid, token: 'later' };
    tree.state.next = () => processTable([{ ...worker, ppid: 1 }, later]);
    t.mock.timers.tick(5_000);
    await flush();
    assert.ok(tree.state.kills.includes(later.pid), 'late descendants join the same cancellation sweep');
    assert.equal(task.status, 'running');
    assert.equal(settled, false);
    tree.state.next = () => processTable([]);
    t.mock.timers.tick(5_000);
    await result.settled;
    assert.equal(task.status, 'cancelled');
    assert.equal(settled, true);
    assert.equal(spawnedRun.abortHandler, null, 'the listener ends with its tree');
  });
}

test('a queued startup failure does not finish its task while cleanup still owns a tree', { timeout: 5_000 }, async () => {
  spawnedRun = null;
  let finishTree;
  spawnFailure = new Promise((resolve) => { finishTree = resolve; });
  try {
    const result = await queueCommand('job_queued_failed_startup');
    await runReported.promise;
    const task = getBackgroundTask('job_queued_failed_startup');
    assert.equal(task.status, 'running');
    cancelBackgroundTask(task.taskId, 'stop', { notify: false });
    assert.equal(task.status, 'running');
    finishTree();
    await result.settled;
    assert.equal(task.status, 'cancelled');
  } finally {
    finishTree();
    spawnFailure = null;
  }
});
