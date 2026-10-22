// Actual promotion, admission files, records and Git; only native IPC and the
// process table are substituted, as in shell-jobs-termination.test.mjs.
import './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { processTable, scriptedChildTree } from './lib/process-table-fixture.mjs';
import {
  finishWorkspaceActivity,
  holdWorkspaceActivity,
  releaseAll,
  tryAdmitWorkspaceActivity,
} from '../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, git, makeRepo } from '../../../shared/worktrees/test-support.mjs';
import { samePath } from '../../../shared/worktrees/paths.mjs';

const tasks = new Map();
const events = new EventEmitter();
let child;
let beforePromotion = async () => {};
const noop = () => {};
mock.module('./lib/native-spawn-client.mjs', {
  namedExports: {
    getNativeTask: (id) => (tasks.has(id) ? { ...tasks.get(id) } : null),
    listNativeTasks: () => [...tasks.values()].map((task) => ({ ...task })),
    subscribeNativeTask: (id, listener) => {
      events.on(id, listener);
      return () => events.removeListener(id, listener);
    },
    cancelNativeTask: (id) => {
      child.kill();
      return tasks.get(id);
    },
    waitNativeTask: async (id) => tasks.get(id),
    releaseNativeTask: noop,
    promoteNativeTask: async ({ jobId, command, cwd, ownerSessionId }) => {
      await beforePromotion();
      const task = {
        jobId,
        command,
        cwd,
        ownerSessionId,
        pid: child.pid,
        status: child.exitCode == null && child.signalCode == null ? 'running' : 'completed',
      };
      tasks.set(jobId, task);
      return { ...task };
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
mock.module('../mcp/child-tree.mjs', { namedExports: tree.namedExports });
const { createShellRun } = await import('./lib/shell-run-state.mjs');
const { createAutoBackground } = await import('./lib/shell-run-background.mjs');
const { createSettle } = await import('./lib/shell-run-settle.mjs');
const { killShellJob, otherSessionBackgroundShellJobCount, publishForegroundShellRecord, waitShellJobTerminated } =
  await import('./builtin/shell-jobs.mjs');
const { _shellJobRecordWritesSettledForTest, readShellJobRecord, retireShellJobRecord } = await import(
  './builtin/lib/shell-job-records.mjs'
);
const { createWorkspaceTransitions } = await import('../../../../session-runtime/workspace/transitions.mjs');

process.env.MIXDOG_ADMISSION_HEAL_MS = '600000';
// The test runner removes the isolated profile after this process exits.
after(cleanupTempDirs);

const cases = [
  { name: 'successful handoff', grant: 0, failures: 0 },
  ...['primary', 'mirror'].flatMap((copy) => [
    { name: `${copy} first grant fails twice`, copy, grant: 1, failures: 2 },
    { name: `${copy} second grant fails twice`, copy, grant: 2, failures: 2 },
    { name: `${copy} second grant fails once then retry succeeds`, copy, grant: 2, failures: 1 },
  ]),
  {
    name: 'failed rollback retries without discarding foreground ownership',
    copy: 'mirror',
    grant: 2,
    failures: 1,
    rollbackFails: true,
  },
];

for (const scenario of cases) {
  test(`promotion admission transaction: ${scenario.name}`, { timeout: 30_000 }, async (t) => {
    const repo = makeRepo();
    git(repo, 'branch', 'feature');
    const jobId = `job_promotion_${cases.indexOf(scenario)}`;
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.__nativeSpawn = true;
    const exited = once(child, 'exit');
    const closed = once(child, 'close');
    tree.state.next = () =>
      processTable(child.exitCode == null && child.signalCode == null ? [{ pid: child.pid }] : []);
    const resultPromise = Promise.withResolvers();
    const run = createShellRun({ resolve: resultPromise.resolve, jobId });
    run.child = child;
    run.commandStartedAtMs = Date.now();
    run.foregroundRecordInput = { command: 'test command', cwd: repo, ownerSessionId: 'sess_promotion' };
    const parent = tryAdmitWorkspaceActivity('sess_promotion', repo, { kind: 'command' });
    const root = tryAdmitWorkspaceActivity('sess_promotion', repo, { kind: 'command', pid: child.pid });
    run.workspaceAdmission = () => releaseAll([parent, root]);
    publishForegroundShellRecord({ ...run.foregroundRecordInput, jobId, pid: child.pid });
    run.foregroundRecordPublished = true;
    await _shellJobRecordWritesSettledForTest(jobId);
    const foreground = await readShellJobRecord(jobId);
    const ledger = join(repo, '.git', 'mixdog-workspace-admission.json');
    const mirror = `${ledger}.management`;
    const leases = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).leases;
    const originalTokens = new Set(leases(ledger).map((lease) => lease.token));
    const target = scenario.copy === 'primary' ? ledger : mirror;
    let failures = 0;
    let rollbackFailures = 0;
    let faultEnabled = true;
    const rename = fs.renameSync;
    const fault = t.mock.method(fs, 'renameSync', (from, to, ...args) => {
      if (faultEnabled && samePath(to, target)) {
        const added = leases(from).filter((lease) => lease.kind === 'command' && !originalTokens.has(lease.token));
        if (scenario.grant && added.length === scenario.grant && failures < scenario.failures) {
          failures += 1;
          throw Object.assign(new Error('injected promotion grant failure'), { code: 'EIO' });
        }
        if (scenario.rollbackFails && failures > 0 && added.length === 0 && rollbackFailures === 0) {
          rollbackFailures += 1;
          throw Object.assign(new Error('injected admission rollback failure'), { code: 'EIO' });
        }
      }
      return rename(from, to, ...args);
    });
    syncBuiltinESMExports();
    let attempts = 0;
    const retries = [];
    beforePromotion = async () => {
      attempts += 1;
      if (attempts === 1) return;
      // Observe between attempts without throwing assertions into the native
      // request: that would replace the admission failure being exercised.
      await _shellJobRecordWritesSettledForTest(jobId);
      retries.push({
        record: await readShellJobRecord(jobId),
        foregroundOwned: run.foregroundRecordPublished,
        promotedCount: otherSessionBackgroundShellJobCount(new Set()),
        tokens: [ledger, mirror].map((file) => new Set(leases(file).map((lease) => lease.token))),
      });
    };
    run.settle = createSettle(run, noop);
    child.on('close', (exitCode, signal) => {
      const task = tasks.get(jobId);
      if (task) {
        Object.assign(task, { status: 'completed', exitCode, signal });
        events.emit(jobId, { ...task });
      }
      void run.settle(exitCode, signal);
    });
    const transitions = createWorkspaceTransitions({
      getSession: () => null,
      getCurrentCwd: () => repo,
      findRegisteredProject: async () => repo,
      listLiveSessions: () => [],
      listWorkspaceConsumers: async () => [],
      countOwnShellJobs: async () => 0,
    });
    let deadline;
    try {
      createAutoBackground({
        run,
        ...run.foregroundRecordInput,
        backgroundDeadlineMs: 0,
      })({ reason: 'threshold' });
      const result = await Promise.race([
        resultPromise.promise,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('promotion did not settle')), 15_000);
        }),
      ]);
      clearTimeout(deadline);
      assert.equal(failures, scenario.failures);
      assert.equal(rollbackFailures, scenario.rollbackFails ? 1 : 0);
      assert.equal(attempts, scenario.failures ? 2 : 1);
      for (const retry of retries) {
        assert.deepEqual(retry.record, foreground, 'a failed attempt must not replace the foreground record');
        assert.equal(retry.foregroundOwned, true);
        assert.equal(retry.promotedCount, 0);
        assert.deepEqual(retry.tokens[0], originalTokens);
        // A failed rollback mirror write remains pending until the next grant.
        if (!scenario.rollbackFails) assert.deepEqual(retry.tokens[1], originalTokens);
      }
      faultEnabled = false;
      if (scenario.failures === 2) {
        assert.equal(result.backgrounded, false);
        assert.equal(result.killed, true);
        assert.match(result.killCause, /background-promotion-failed/);
      } else {
        assert.equal(result.backgrounded, true);
        assert.equal(run.foregroundRecordPublished, false);
        assert.equal(run.workspaceAdmission, null);
        await _shellJobRecordWritesSettledForTest(jobId);
        const background = await readShellJobRecord(jobId);
        assert.equal(background.foreground, undefined);
        assert.equal(background.status, 'running');
        assert.equal(otherSessionBackgroundShellJobCount(new Set()), 1);
        assert.throws(() => holdWorkspaceActivity([repo]), { details: { reason: 'folder-in-use' } });
        killShellJob(jobId);
      }
      await exited;
      await closed;
      await run.treeSettled;
      assert.equal(await waitShellJobTerminated(jobId, 5_000), true);
      await _shellJobRecordWritesSettledForTest(jobId);
      const record = await readShellJobRecord(jobId);
      if (scenario.failures === 2) assert.equal(record, null, 'failed promotion remains owned by foreground cleanup');
      else assert.equal(record?.terminal, true);
      assert.equal(otherSessionBackgroundShellJobCount(new Set()), 0);
      holdWorkspaceActivity([repo])();
      for (const file of [ledger, mirror]) assert.deepEqual(leases(file), []);
      assert.equal(
        (
          await transitions.mergeProjectBranch({
            projectPath: repo,
            branch: 'feature',
            target: 'main',
          })
        ).merged,
        true,
        'terminated work must not leave a running record blocking actual management'
      );
    } finally {
      clearTimeout(deadline);
      faultEnabled = false;
      fault.mock.restore();
      syncBuiltinESMExports();
      beforePromotion = async () => {};
      if (child.exitCode == null && child.signalCode == null) child.kill();
      await exited;
      await closed;
      run.stopTerminationWatch?.();
      finishWorkspaceActivity(parent, root);
      retireShellJobRecord(jobId);
      await _shellJobRecordWritesSettledForTest(jobId);
      run.taskOutput.deleteFiles();
      tasks.delete(jobId);
      events.removeAllListeners(jobId);
    }
  });
}
