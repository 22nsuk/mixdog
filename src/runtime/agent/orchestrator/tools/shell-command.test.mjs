// Import before runtime modules: several paths are captured at module load.
import { fixtureRoot } from './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// A spawn phase that reports success without leaving a child behind: the
// wiring below it (output capture, settle, deadlines) then throws. Inside an
// async Promise executor that throw reaches nobody, so before the fix the
// caller awaited execShellCommand forever. Mocked before the first import of
// shell-command.mjs, which is the module's only importer.
let spawnPhase = async () => {};
mock.module('./lib/shell-run-spawn.mjs', {
  namedExports: {
    cleanupFailedShellChild: async () => {},
    spawnShellChild: (input) => spawnPhase(input),
  },
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

test('a failed startup passes its continuing tree lifetime to the caller', async () => {
  let finishTree;
  const treeSettled = new Promise((resolve) => {
    finishTree = resolve;
  });
  spawnPhase = async ({ run }) => {
    // spawnShellChild already retains a failed startup's tree. Its caller
    // must preserve that lifetime when it turns the throw into an ExecResult.
    run.treeSettled = treeSettled;
    throw new Error('startup failed after a child was created');
  };
  try {
    const result = await execShellCommand({
      shell: process.execPath,
      command: 'startup-failure',
      env: process.env,
      cwd: fixtureRoot,
      admission: { acquire: async () => ({ release: async () => {} }) },
    });
    assert.equal(result.failureReason, 'spawn failed');
    assert.equal(result.settled, treeSettled, 'artifact owners must not treat the failed result as tree completion');
    let ended = false;
    void result.settled.then(() => { ended = true; });
    await Promise.resolve();
    assert.equal(ended, false);
    finishTree();
    await result.settled;
    assert.equal(ended, true);
  } finally {
    finishTree();
    spawnPhase = async () => {};
  }
});
