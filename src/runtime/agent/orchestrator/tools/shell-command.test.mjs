// Import before runtime modules: several paths are captured at module load.
import { fixtureRoot } from './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fstatSync } from 'node:fs';
import test, { mock } from 'node:test';

// A spawn phase that reports success without leaving a child behind: the
// wiring below it (output capture, settle, deadlines) then throws. Inside an
// async Promise executor that throw reaches nobody, so before the fix the
// caller awaited execShellCommand forever. Mocked before the first import of
// shell-command.mjs, which is the module's only importer.
let spawnPhase = async () => {};
mock.module('./lib/shell-run-spawn.mjs', {
  namedExports: { spawnShellChild: (...args) => spawnPhase(...args) },
});

const { execShellCommand } = await import('./shell-command.mjs');

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

test('a spawn rejection without a child closes direct capture and returns the shell lane', async (t) => {
  let output;
  let stdoutFd;
  let stderrFd;
  let captureClosed = false;
  let releases = 0;
  spawnPhase = async ({ run }) => {
    output = run.taskOutput;
    output.openDirectCapture();
    stdoutFd = output.stdoutFd;
    stderrFd = output.stderrFd;
    const closeFds = output.closeFds.bind(output);
    output.closeFds = () => {
      closeFds();
      if (captureClosed) return;
      // Observe immediately after close: later asynchronous I/O may reuse
      // these descriptor numbers for unrelated files.
      assert.throws(() => fstatSync(stdoutFd), { code: 'EBADF' });
      assert.throws(() => fstatSync(stderrFd), { code: 'EBADF' });
      captureClosed = true;
    };
    throw Object.assign(new Error('fixture shell not found'), { code: 'ENOENT' });
  };
  t.after(() => {
    output?.closeFds();
    spawnPhase = async () => {};
  });
  const result = await execShellCommand({
    shell: 'fixture-missing-shell',
    command: 'fixture command',
    cwd: fixtureRoot,
    admission: { acquire: async () => ({ release: async () => releases++ }) },
  });
  assert.equal(result.failureReason, 'spawn failed');
  assert.match(result.stderr, /fixture shell not found/);
  assert.equal(releases, 1);
  assert.equal(typeof stdoutFd, 'number', 'direct stdout capture was open before the spawn error');
  assert.equal(typeof stderrFd, 'number', 'direct stderr capture was open before the spawn error');
  assert.equal(captureClosed, true);
});

test('an unconfirmed startup child retains capture and the shell lane until its exit', async (t) => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  let output;
  let stdoutFd;
  let releases = 0;
  // The spawn phase has already tried cancellation and handed the workspace
  // to its termination watch. Exercise the orchestrator's resource cleanup
  // while that native root still has not acknowledged termination.
  spawnPhase = async ({ run }) => {
    run.child = child;
    run.killUnconfirmed = true;
    output = run.taskOutput;
    output.openDirectCapture();
    stdoutFd = output.stdoutFd;
    throw new Error('fixture startup termination unconfirmed');
  };
  const exit = () => {
    child.exitCode = 1;
    child.emit('exit', 1, null);
  };
  t.after(() => {
    exit();
    output?.closeFds();
    spawnPhase = async () => {};
  });
  const result = await execShellCommand({
    shell: process.execPath,
    command: 'fixture command',
    cwd: fixtureRoot,
    admission: { acquire: async () => ({ release: async () => releases++ }) },
  });
  assert.equal(result.failureReason, 'spawn failed');
  assert.match(result.stderr, /fixture startup termination unconfirmed/);
  assert.equal(releases, 0, 'the live root still owns the shell lane');
  assert.equal(typeof stdoutFd, 'number');
  assert.doesNotThrow(() => fstatSync(stdoutFd), 'capture remains open while the root is alive');
  exit();
  assert.throws(() => fstatSync(stdoutFd), { code: 'EBADF' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases, 1);
});
