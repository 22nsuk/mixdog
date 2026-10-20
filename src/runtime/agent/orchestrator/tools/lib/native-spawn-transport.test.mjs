import './isolated-test-env.mjs';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test, { afterEach, mock } from 'node:test';

// Only the server transport is replaced. The native client parses the real
// protocol and emits its own child/task events as it does after IPC loss.
let server;
const { default: childProcessDefault, ...childProcessNamed } = childProcess;
mock.module('node:child_process', {
  defaultExport: childProcessDefault,
  namedExports: {
    ...childProcessNamed,
    spawn() {
      server = new EventEmitter();
      server.stdout = new PassThrough();
      server.requests = [];
      server.stdin = new Writable({
        write(chunk, _encoding, done) {
          server.requests.push(JSON.parse(String(chunk)));
          done();
        },
      });
      server.kill = () => true;
      server.send = (message) => server.stdout.write(`${JSON.stringify(message)}\n`);
      queueMicrotask(() => server.send({
        ready: true,
        caps: { trackedForeground: true, promoteTask: true, cancelOwner: true },
      }));
      return server;
    },
  },
});
const {
  _resetNativeSpawnClientForTest,
  _setNativeSpawnBinaryForTest,
  ensureNativeSpawnServer,
  getNativeTask,
  tryNativeSpawn,
} = await import('./native-spawn-client.mjs');

afterEach(() => {
  _resetNativeSpawnClientForTest();
  server?.stdout.destroy();
  server?.stdin.destroy();
});

async function startTrackedChild() {
  _setNativeSpawnBinaryForTest(process.execPath);
  await ensureNativeSpawnServer();
  const spawned = tryNativeSpawn({ shell: 'shell', argv: [], spawnOptions: { jobId: 'transport-job' } });
  const requestId = server.requests.at(-1).id;
  const errors = [];
  const closes = [];
  spawned.attachErrorHandler((error) => errors.push(error));
  spawned.child.on('close', (code, signal) => closes.push({ code, signal }));
  server.send({ id: requestId, event: 'spawned', pid: 7320 });
  server.send({
    event: 'task_started',
    task: { jobId: 'transport-job', requestId, pid: 7320, status: 'running' },
  });
  return { child: spawned.child, requestId, errors, closes };
}

test('native server loss emits a diagnostic failure without root-exit evidence', async () => {
  const { child, errors, closes } = await startTrackedChild();
  server.emit('exit', 1, null);
  assert.equal(child.rootExitObserved, false);
  assert.equal(child.exitCode, 1, 'the synthetic status remains diagnostic');
  assert.equal(errors.length, 1);
  assert.deepEqual(closes, [{ code: 1, signal: null }]);
  const task = getNativeTask('transport-job');
  assert.equal(task.status, 'failed');
  assert.equal(task.rootExitObserved, false);
  assert.equal(task.error, 'native spawn server exited');
});

test('real root exit before native server loss preserves its evidence and exit status', async () => {
  const { child, requestId, errors, closes } = await startTrackedChild();
  server.send({ id: requestId, event: 'root_exit', code: 0, signal: null });
  server.emit('exit', 1, null);
  assert.equal(child.rootExitObserved, true);
  assert.equal(child.exitCode, 0, 'transport failure cannot overwrite the real root status');
  assert.equal(errors.length, 1, 'lost output drain is still reported as a transport failure');
  assert.deepEqual(closes, [{ code: 0, signal: null }]);
  const task = getNativeTask('transport-job');
  assert.equal(task.status, 'failed');
  assert.equal(task.rootExitObserved, true, 'teardown retains evidence before clearing pending requests');
  assert.equal(task.error, 'native spawn server exited');
});

test('a native wait error with no exit status does not invent root-exit evidence', async () => {
  const { child, requestId } = await startTrackedChild();
  server.send({ id: requestId, event: 'root_exit', code: null, signal: null });
  server.send({
    event: 'task_complete',
    task: {
      jobId: 'transport-job', requestId, pid: 7320, status: 'failed',
      exitCode: null, signal: null, error: 'child wait failed',
    },
  });
  server.send({ id: requestId, event: 'exit', code: null, signal: null });
  assert.equal(child.rootExitObserved, false);
  assert.equal(getNativeTask('transport-job').rootExitObserved, false);
});
