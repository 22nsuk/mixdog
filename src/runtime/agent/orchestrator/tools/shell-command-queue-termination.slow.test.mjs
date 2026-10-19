import { fixtureRoot } from './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { get } from 'node:http';
import { join, resolve } from 'node:path';
import { after, mock, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ResourceAdmissionController } from '../../../shared/resource-admission.mjs';
import { holdWorkspaceActivity } from '../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo, writeFile } from '../../../shared/worktrees/test-support.mjs';
import {
  cancelBackgroundTask,
  cancelBackgroundTasks,
  cleanupBackgroundTasks,
  getBackgroundTask,
  listBackgroundTasks,
} from '../../../shared/background-tasks.mjs';
import { parseTaskNotification } from '../../../shared/task-notification-envelope.mjs';
import { readProcessTable } from '../mcp/child-tree.mjs';
import { cancelOwnedShellTrees } from './lib/owned-shell-trees.mjs';
import {
  _resetNativeSpawnClientForTest,
  _setNativeSpawnBinaryForTest,
  cancelNativeTask,
  getNativeTask,
  shutdownNativeSpawnServer,
  waitNativeTask,
} from './lib/native-spawn-client.mjs';

process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

let fixture = null;
const { spawnShellWithRetry } = await import('./lib/shell-spawn-retry.mjs');
mock.module('./lib/shell-spawn-retry.mjs', {
  namedExports: {
    async spawnShellWithRetry(input) {
      const spawned = await spawnShellWithRetry(input);
      fixture.child = spawned.child;
      if (fixture.duringStartup) {
        fixture.spawnCreated.resolve();
        await fixture.returnSpawn.promise;
      }
      return spawned;
    },
  },
});
const { spawnShellChild } = await import('./lib/shell-run-spawn.mjs');
mock.module('./lib/shell-run-spawn.mjs', {
  namedExports: {
    async spawnShellChild(input) {
      // Observe the actual run so a failed negative control can stop only
      // its own termination watch and close its own retained resources.
      fixture.run = input.run;
      return spawnShellChild(input);
    },
  },
});
const { execShellCommand } = await import('./shell-command.mjs?queue-termination-regression');
const { executeTaskTool } = await import('./builtin/task-tool.mjs');
const { _shellJobRecordWritesSettledForTest, retireShellJobRecord } = await import(
  './builtin/lib/shell-job-records.mjs'
);

async function until(condition, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < deadline) await delay(25);
  assert.ok(await condition(), message);
}

function isRunning(pid) {
  try {
    const status = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
    return status !== '' && !status.startsWith('Z');
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function request(port) {
  return new Promise((resolveRequest, reject) => {
    const req = get({ host: '127.0.0.1', port, path: '/', agent: false }, (response) => {
      response.resume();
      response.on('end', () => resolveRequest(response.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(3_000, () => req.destroy(new Error('fixture HTTP request timed out')));
  });
}

after(async () => {
  await shutdownNativeSpawnServer('queued-termination-regression-finish');
  _resetNativeSpawnClientForTest();
  cleanupTempDirs();
  rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

for (const mode of ['foreground', 'startup', 'owner-close']) {
  const duringStartup = mode !== 'foreground';
  test(
    `queued shell ${mode} cancellation completes after the whole tree`,
    { timeout: 45_000, skip: process.platform === 'win32' ? 'POSIX detached process-group boundary' : false },
    async (t) => {
      const binary = resolve('native/mixdog-spawn/target/debug/mixdog-spawn');
      assert.ok(existsSync(binary), 'native spawn test binary missing: run npm run build:spawn:test');
      _setNativeSpawnBinaryForTest(binary);
      const repo = makeRepo();
      const ready = join(repo, 'queue-server-ready.json');
      const serverScript = writeFile(repo, 'queue-server.cjs', `
const { createServer } = require('node:http');
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => {});
const server = createServer((_request, response) => response.end('ready'));
server.listen(0, '127.0.0.1', () => writeFileSync(process.argv[2], JSON.stringify({
  pid: process.pid, parentPid: process.ppid, port: server.address().port,
})));
`);
      const parentScript = writeFile(repo, 'queue-parent.cjs', `
const { spawn } = require('node:child_process');
spawn(process.execPath, [process.argv[2], process.argv[3]], { detached: true, stdio: 'ignore' }).unref();
setInterval(() => {}, 1000);
`);
      const ownerSessionId = `queued-native-${mode}-${process.pid}`;
      const admission = new ResourceAdmissionController({ env: {}, limits: { maxShells: 1 } });
      const heldSlot = await admission.acquire('shell', { ownerKey: 'fixture-held-slot' });
      const current = {
        duringStartup,
        spawnCreated: deferred(),
        returnSpawn: deferred(),
        run: null,
        child: null,
        server: null,
      };
      fixture = current;
      let task = null;
      // The native client and production termination watch intentionally unref
      // after root exit. Keep this standalone fixture alive through the real
      // cancellation and cleanup, bounded beyond the test's 45-second ceiling.
      const keepAlive = setTimeout(() => {}, 60_000);
      t.after(async () => {
        try {
          current.returnSpawn.resolve();
          cancelBackgroundTasks({ callerSessionId: ownerSessionId, reason: 'fixture cleanup', notify: false });
          task ||= getBackgroundTask(listBackgroundTasks({ callerSessionId: ownerSessionId })[0]?.task_id);
          await heldSlot.release();
          if (current.server && isRunning(current.server.pid)) process.kill(current.server.pid, 'SIGKILL');
          if (current.child && isRunning(current.child.pid)) cancelNativeTask(task.taskId);
          if (current.child) await waitNativeTask(task.taskId, 3_000);
          if (current.server) await until(() => !isRunning(current.server.pid), 'fixture server cleanup failed');
          if (task) await Promise.race([task.promise, delay(1_000)]);
          if (current.run) {
            current.run.stopTerminationWatch?.();
            current.run.workspaceAdmission?.();
            current.run.workspaceAdmission = null;
            current.run.taskOutput.closeFds();
            await current.run.resourceLease?.release();
            current.run.resourceLease = null;
            retireShellJobRecord(current.run.foregroundRecordId);
            await _shellJobRecordWritesSettledForTest(current.run.foregroundRecordId);
          }
          cleanupBackgroundTasks({ callerSessionId: ownerSessionId, force: true });
        } finally {
          fixture = null;
          clearTimeout(keepAlive);
        }
      });

      // Saturate the actual admission controller. Its bounded foreground
      // acquisition expires while this test owns the only slot, so the real
      // command becomes a queued background task before any process starts.
      const queued = await execShellCommand({
        shell: process.execPath,
        directArgv: [parentScript, serverScript, ready],
        command: 'queued cancellation with a detached HTTP server',
        cwd: repo,
        env: process.env,
        timeoutMs: 0,
        autoBackgroundMs: 0,
        backgroundOnTimeout: true,
        admissionWaitMs: 1,
        ownerSessionId,
        admission,
      });
      assert.equal(queued.backgrounded, true, queued.stderr);
      const [listedTask] = listBackgroundTasks({ callerSessionId: ownerSessionId });
      task = getBackgroundTask(listedTask?.task_id);
      assert.ok(task, 'the saturated command registered its queued task');
      assert.equal(task.status, 'running');
      assert.equal(current.child, null, 'queueing did not bypass the held shell slot');
      const notices = [];
      // Subscribe the fixture's owner to the existing task context; the task
      // completion and notification implementation itself remains unchanged.
      task.notifyContext.notifyFn = (text) => {
        notices.push({ text, serverRunning: isRunning(current.server.pid) });
        return true;
      };
      await heldSlot.release();
      await until(() => existsSync(ready), 'the queued native server did not start');
      current.server = JSON.parse(readFileSync(ready, 'utf8'));
      assert.equal(await request(current.server.port), 200);
      const table = await readProcessTable();
      assert.equal(table.pgidOf.get(current.server.pid), current.server.pid);
      assert.notEqual(table.pgidOf.get(current.server.pid), table.pgidOf.get(current.server.parentPid));
      assert.equal(getNativeTask(task.taskId)?.pid, current.server.parentPid);
      if (duringStartup) {
        await current.spawnCreated.promise;
      } else {
        await until(() => current.run.abortHandler !== null, 'foreground cancellation handler was not installed');
      }

      let cancelResult = null;
      if (duringStartup) cancelBackgroundTask(task.taskId, 'owner cancelled queued shell', { notify: true });
      else {
        cancelResult = executeTaskTool(
          { action: 'cancel', task_id: task.taskId },
          { callerSessionId: ownerSessionId }
        );
      }
      assert.equal(task.status, 'running', 'cancel request does not claim completed termination');
      assert.equal(task.finishedAtMs, null);
      assert.equal(notices.length, 0, 'no cancellation completion is sent while the tree is still running');
      if (duringStartup) {
        assert.equal(await request(current.server.port), 200, 'startup keeps the tree intact for its pre-kill snapshot');
        assert.equal(getNativeTask(task.taskId)?.status, 'running');
        if (mode === 'owner-close') {
          // Session shutdown can arrive while the native handshake has
          // succeeded but the startup wrapper has not returned its child.
          // Let the root's terminal event pass before resuming startup.
          await cancelOwnedShellTrees(ownerSessionId);
          const native = await waitNativeTask(task.taskId, 3_000);
          assert.notEqual(native.status, 'running', 'owner cancellation reached the native root');
          assert.equal(task.status, 'running');
          assert.equal(notices.length, 0);
        }
        current.returnSpawn.resolve();
      } else {
        assert.match(await cancelResult, /status: completed/);
        assert.equal(isRunning(current.server.pid), false, 'task cancel reports success after tree termination');
      }
      await until(() => task.status !== 'running', 'queued task did not complete after tree termination');
      await task.promise;
      assert.equal(task.status, 'cancelled');
      assert.equal(isRunning(current.server.pid), false);
      assert.deepEqual(notices.map((notice) => notice.serverRunning), [false], 'completion followed server termination');
      assert.equal(parseTaskNotification(notices[0].text).status, 'cancelled');
      await assert.rejects(request(current.server.port), (error) => ['ECONNREFUSED', 'ECONNRESET'].includes(error.code));
      holdWorkspaceActivity([repo])();
      assert.equal(admission.snapshot().active.shell, 0, 'the queued command returned its shell slot');
    }
  );
}
