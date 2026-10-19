import { fixtureRoot } from './isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { get } from 'node:http';
import { join, resolve } from 'node:path';
import { after, mock, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { holdWorkspaceActivity } from '../../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo, writeFile } from '../../../../shared/worktrees/test-support.mjs';
import { readProcessTable } from '../../mcp/child-tree.mjs';
import {
  _resetNativeSpawnClientForTest,
  _setNativeSpawnBinaryForTest,
  shutdownNativeSpawnServer,
  waitNativeTask,
} from './native-spawn-client.mjs';

process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';

// Keep native process creation, task tracking, cancellation, process-table
// reads and workspace admission real. Only delay the spawn wrapper's return
// until its detached server is ready, then fail the remaining startup phase.
const { spawnShellWithRetry } = await import('./shell-spawn-retry.mjs');
let startup = null;
mock.module('./shell-spawn-retry.mjs', {
  namedExports: {
    async spawnShellWithRetry(input) {
      const spawned = await spawnShellWithRetry(input);
      const fixture = startup;
      fixture.child = spawned.child;
      await until(() => existsSync(fixture.ready), 'the detached server did not start');
      fixture.server = JSON.parse(readFileSync(fixture.ready, 'utf8'));
      assert.equal(fixture.server.parentPid, spawned.child.pid);
      assert.equal(await request(fixture.server.port), 200, 'the server accepts requests before cancellation');
      const table = await readProcessTable();
      assert.notEqual(table.pgidOf.get(fixture.server.pid), table.pgidOf.get(spawned.child.pid));
      assert.equal(table.pgidOf.get(fixture.server.pid), fixture.server.pid, 'the server owns a separate group');
      assert.throws(() => holdWorkspaceActivity([fixture.repo]), { code: 'WORKTREE_BUSY_JOBS' });
      if (fixture.mode === 'abort') fixture.abort.abort(fixture.error);
      return {
        ...spawned,
        attachErrorHandler(handler) {
          spawned.attachErrorHandler(handler);
          // Record the real server's state at the exact lease-release call,
          // without throwing inside a cleanup callback or delaying the release.
          const release = fixture.run.workspaceAdmission;
          fixture.run.workspaceAdmission = () => {
            fixture.releaseStates.push(isRunning(fixture.server.pid));
            release();
          };
          if (fixture.mode === 'listener-error') throw fixture.error;
        },
      };
    },
  },
});
const { spawnShellChild } = await import('./shell-run-spawn.mjs');
const { createShellRun } = await import('./shell-run-state.mjs');
const { _shellJobRecordWritesSettledForTest, retireShellJobRecord } = await import(
  '../builtin/lib/shell-job-records.mjs'
);
mock.module('./shell-run-spawn.mjs', {
  namedExports: {
    async spawnShellChild(input) {
      startup.run = input.run;
      const result = await spawnShellChild(input);
      if (startup.mode === 'wiring-error') {
        const error = startup.error;
        input.run.child.stdout.on = () => {
          throw error;
        };
      }
      return result;
    },
  },
});
// The builtin/session import cycle can already have loaded this module. A
// fresh instance observes the passthrough spawn wrapper and runs its real
// post-spawn wiring and setup-failure cleanup.
const { execShellCommand } = await import('../shell-command.mjs?startup-regression');

async function until(condition, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await delay(25);
  assert.ok(condition(), message);
}

function isRunning(pid) {
  try {
    // A zombie holds no socket or workspace; match the runtime's definition
    // of termination on both Linux and macOS, including non-reaping containers.
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
  await shutdownNativeSpawnServer('startup-regression-finish');
  _resetNativeSpawnClientForTest();
  cleanupTempDirs();
  rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

for (const mode of ['abort', 'listener-error', 'wiring-error']) {
  test(
    `native startup ${mode} keeps the workspace until its detached HTTP server is gone`,
    { timeout: 45_000, skip: process.platform === 'win32' ? 'POSIX detached process-group boundary' : false },
    async (t) => {
      const binary = resolve('native/mixdog-spawn/target/debug/mixdog-spawn');
      assert.ok(existsSync(binary), 'native spawn test binary missing: run npm run build:spawn:test');
      _setNativeSpawnBinaryForTest(binary);
      const repo = makeRepo();
      const ready = join(repo, 'server-ready.json');
      const serverScript = writeFile(
        repo,
        'server.cjs',
        `const { createServer } = require('node:http');
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => {});
const server = createServer((_request, response) => response.end('ready'));
server.listen(0, '127.0.0.1', () => writeFileSync(process.argv[2], JSON.stringify({
  pid: process.pid, parentPid: process.ppid, port: server.address().port,
})));
`
      );
      const parentScript = writeFile(
        repo,
        'parent.cjs',
        `const { spawn } = require('node:child_process');
spawn(process.execPath, [process.argv[2], process.argv[3]], { detached: true, stdio: 'ignore' }).unref();
setInterval(() => {}, 1000);
`
      );
      const abort = new AbortController();
      const run = mode === 'wiring-error' ? null : createShellRun({ abortSignal: abort.signal, resolve() {} });
      const fixture = { mode, repo, ready, abort, run, error: new Error(`startup ${mode}`), releaseStates: [] };
      startup = fixture;
      t.after(async () => {
        const run = fixture.run;
        if (!run) return;
        // Only this fixture's exact processes are eligible for cleanup when
        // a negative control leaves its detached server alive.
        run.stopTerminationWatch?.();
        if (fixture.server && isRunning(fixture.server.pid)) process.kill(fixture.server.pid, 'SIGKILL');
        if (fixture.child && isRunning(fixture.child.pid)) fixture.child.kill('SIGKILL');
        if (fixture.child) await waitNativeTask(run.foregroundRecordId, 3_000);
        if (fixture.server) await until(() => !isRunning(fixture.server.pid), 'fixture server cleanup failed');
        run.workspaceAdmission?.();
        run.workspaceAdmission = null;
        run.taskOutput.closeFds();
        retireShellJobRecord(run.foregroundRecordId);
        await _shellJobRecordWritesSettledForTest(run.foregroundRecordId);
        startup = null;
      });
      const input = {
        cwd: repo,
        shell: process.execPath,
        directArgv: [parentScript, serverScript, ready],
        command: 'startup boundary with a detached HTTP server',
        env: process.env,
        abortSignal: abort.signal,
        ownerSessionId: `startup-${mode}`,
      };
      if (mode === 'wiring-error') {
        const result = await execShellCommand(input);
        assert.equal(result.failurePhase, 'tool');
        assert.ok(result.stderr.includes(fixture.error.message), 'the setup error reaches the caller');
      } else {
        await assert.rejects(
          spawnShellChild({ run, ...input }),
          (error) => error === fixture.error || error.errors?.includes(fixture.error)
        );
      }
      if (fixture.run.workspaceAdmission) {
        assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
      }
      await until(
        () => fixture.run.workspaceAdmission === null,
        'workspace admission did not finish after termination'
      );
      assert.deepEqual(fixture.releaseStates, [false], 'workspace was released while the detached server ran');
      assert.equal(isRunning(fixture.server.pid), false);
      await assert.rejects(request(fixture.server.port), (error) => ['ECONNREFUSED', 'ECONNRESET'].includes(error.code));
      holdWorkspaceActivity([repo])();
    }
  );
}
