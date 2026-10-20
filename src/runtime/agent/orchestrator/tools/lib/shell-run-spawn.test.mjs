import './isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import test, { after, mock } from 'node:test';
import { holdWorkspaceActivity } from '../../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo } from '../../../../shared/worktrees/test-support.mjs';
import { processTable, scriptedChildTree } from './process-table-fixture.mjs';

let startup;
const published = [];
const tree = scriptedChildTree();
mock.module('../builtin/shell-jobs.mjs', {
  namedExports: {
    publishForegroundShellRecord: (input) => published.push(input),
    trackForegroundShellJob: async () => null,
    retireForegroundShellRecord() {},
  },
});
mock.module('./native-spawn-client.mjs', {
  namedExports: {
    nativeSpawnFileCaptureReady: () => false,
    nativeSpawnSupportsStdinPipe: () => false,
    setNativeTaskStartedAt() {},
    warmNativeSpawnServer: async () => false,
    setNativeSpawnRequestIdle() {},
    tryNativeSpawn: async () => null,
    cancelNativeTasks: () => ({ cancelled: 0, unconfirmed: [], confirmed: true }),
    cancelNativeTask: () => null,
    getNativeTask: () => null,
  },
});
mock.module('./shell-spawn-retry.mjs', {
  namedExports: {
    spawnShellWithRetry: async () => {
      if (startup.noChild) throw startup.error;
      startup.abort.abort(startup.error);
      return { child: startup.child, attachErrorHandler() {} };
    },
  },
});
mock.module('../../mcp/child-tree.mjs', { namedExports: tree.namedExports });
const { spawnShellChild } = await import('./shell-run-spawn.mjs');
const { createShellRun } = await import('./shell-run-state.mjs');
const { forceReleaseTerminationHold } = await import('../builtin/lib/shell-job-records.mjs');

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

function failedStartup({ survivor = false, noChild = false, alreadyExited = false } = {}) {
  const repo = makeRepo();
  const pid = 4243;
  const child = Object.assign(new EventEmitter(), {
    pid, exitCode: alreadyExited ? 0 : null, signalCode: null, __nativeSpawn: true,
  });
  const rows = alreadyExited ? [] : [{ pid }, ...(survivor ? [{ pid: 4244, ppid: pid, token: 'worker' }] : [])];
  startup = { child, rows, abort: new AbortController(), error: new Error('startup aborted after spawn'), noChild };
  const scenario = startup;
  child.kill = () => {
    scenario.readsAtKill = tree.state.reads;
    if (survivor) {
      child.exitCode = 1;
      scenario.rows = [{ pid: 4244, ppid: 1, token: 'worker' }];
      child.emit('exit', 1, null);
    }
    return true;
  };
  tree.state.reads = 0;
  tree.state.next = () => processTable(scenario.rows);
  const suffix = survivor ? 'survivor' : noChild ? 'no_child' : alreadyExited ? 'exited' : 'live';
  const run = createShellRun({ abortSignal: scenario.abort.signal, resolve() {}, jobId: `job_startup_${suffix}` });
  run.taskOutput.forceSpill();
  run.taskOutput.writeStdout('startup output');
  const outputPath = run.taskOutput.stdoutPath;
  let releases = 0;
  run.resourceLease = {
    release: async () => { releases += 1; },
  };
  const spawn = () => spawnShellChild({
    run,
    cwd: repo,
    shell: process.execPath,
    directArgv: ['-e', ''],
    command: 'node',
    abortSignal: scenario.abort.signal,
    ownerSessionId: 'startup-failure',
  });
  return { repo, run, scenario, spawn, outputPath, releases: () => releases };
}

test('a failed startup retains ownership until its live child is confirmed gone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { repo, run, scenario, spawn, releases, outputPath } = failedStartup();
  await assert.rejects(spawn(), (error) => error === scenario.error);
  await flush();
  assert.equal(run.killUnconfirmed, true);
  assert.equal(run.terminationTracker.complete, true);
  assert.ok(scenario.readsAtKill > 0, 'identities are captured before the kill');
  assert.equal(releases(), 1, 'a failed foreground call returns its resource slot');
  assert.equal(isHeld(repo), true);
  assert.equal(existsSync(outputPath), true);
  const record = published.at(-1);
  assert.equal(record?.terminationUnconfirmed, true);
  assert.equal(record.jobId, run.foregroundRecordId);
  assert.equal(record.command, 'node');
  assert.equal(record.cwd, repo);
  assert.equal(record.ownerSessionId, 'startup-failure');
  assert.equal((await forceReleaseTerminationHold(run.foregroundRecordId, { callerSessionId: 'other' })).released, false);
  scenario.child.exitCode = 1;
  scenario.rows = [];
  scenario.child.emit('exit', 1, null);
  await flush();
  assert.equal(isHeld(repo), true, 'the exit event does not substitute for the next observation');
  t.mock.timers.tick(5_000);
  await run.treeSettled;
  await flush();
  assert.equal(isHeld(repo), false);
  assert.equal(existsSync(outputPath), false);
});

test('a failed startup keeps its workspace and capture after a terminal root leaves a descendant', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { repo, run, scenario, spawn, outputPath } = failedStartup({ survivor: true });
  await assert.rejects(spawn());
  await flush();
  assert.equal(scenario.child.exitCode, 1);
  assert.equal(isHeld(repo), true, 'a native terminal root is not complete tree termination');
  assert.equal(existsSync(outputPath), true, 'the surviving process can still use its capture');
  let settled = false;
  run.treeSettled.then(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  assert.ok(tree.state.kills.includes(4244), 'known surviving descendants are still swept');
  scenario.rows = [];
  t.mock.timers.tick(5_000);
  await run.treeSettled;
  await flush();
  assert.equal(isHeld(repo), false);
  assert.equal(existsSync(outputPath), false);
});

test('a startup that never creates a child releases its workspace, capture and resource slot immediately', async () => {
  const { repo, scenario, spawn, outputPath, releases } = failedStartup({ noChild: true });
  await assert.rejects(spawn(), (error) => error === scenario.error);
  assert.equal(isHeld(repo), false);
  assert.equal(existsSync(outputPath), false);
  assert.equal(releases(), 1);
});

test('a startup failure after a natural root exit can confirm an empty tree without a pre-kill snapshot', async () => {
  const { repo, run, scenario, spawn, outputPath } = failedStartup({ alreadyExited: true });
  await assert.rejects(spawn(), (error) => error === scenario.error);
  await run.treeSettled;
  await flush();
  assert.equal(scenario.readsAtKill, undefined, 'an already exited root needs no new kill');
  assert.equal(isHeld(repo), false);
  assert.equal(existsSync(outputPath), false);
});
