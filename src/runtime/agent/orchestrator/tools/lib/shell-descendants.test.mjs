import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { processTable, scriptedChildTree } from './process-table-fixture.mjs';

const tree = scriptedChildTree();
mock.module('../../mcp/child-tree.mjs', { namedExports: tree.namedExports });
const { createProcessTreeTracker, killShellDescendants, probeShellDescendants, waitForShellDescendants } = await import(
  './shell-descendants.mjs'
);

const flush = () => new Promise((resolve) => setImmediate(resolve));
const ROOT = 5100;

test('a pre-kill capture keeps a grandchild whose parent link broke', async () => {
  const tracker = createProcessTreeTracker({ pid: ROOT });
  tree.state.next = () =>
    processTable([{ pid: ROOT }, { pid: 5101, ppid: ROOT }, { pid: 5102, ppid: 5101, token: 'grandchild' }]);
  assert.equal(await tracker.capture(), true);
  tree.state.next = () => processTable([{ pid: 5102, ppid: 5101, token: 'grandchild' }]);
  assert.equal(await tracker.observe({ rootExited: true }), 'running');
  assert.deepEqual(
    tracker.live.map((entry) => entry.pid),
    [5102]
  );
  tree.state.next = () => processTable([]);
  assert.equal(await tracker.observe({ rootExited: true }), 'gone');
});

test('without a pre-exit capture the observation stays unknown, never empty', async () => {
  const tracker = createProcessTreeTracker({ pid: ROOT });
  tree.state.next = () => {
    throw new Error('process enumeration denied');
  };
  await assert.rejects(tracker.capture());
  await assert.rejects(tracker.observe({ rootExited: true }));
  tree.state.next = () => processTable([]);
  assert.equal(await tracker.observe({ rootExited: true }), 'unknown', 'an empty table after the kill proves nothing');
  assert.equal(await tracker.observe({ rootExited: true }), 'unknown');
});

test('a failed fresh capture cannot reuse a promotion baseline or a post-kill root observation', async () => {
  const tracker = createProcessTreeTracker({ pid: ROOT });
  tree.state.next = () => processTable([{ pid: ROOT }, { pid: 5101, ppid: ROOT }]);
  assert.equal(await tracker.capture(), true);
  tree.state.next = () => { throw new Error('pre-kill enumeration failed'); };
  await assert.rejects(tracker.capture());
  assert.equal(tracker.complete, false);
  // A partial kill can break a new child's ancestry before the root exits.
  tree.state.next = () => processTable([{ pid: ROOT }, { pid: 5102 }]);
  assert.equal(await tracker.observe({ rootExited: false }), 'running');
  assert.equal(tracker.complete, false, 'a post-kill root sighting cannot restore the missing ancestry');
  tree.state.next = () => processTable([{ pid: 5102 }]);
  assert.equal(await tracker.observe(), 'unknown');
});

test('an older capture finishing late cannot validate a newer failed capture', async () => {
  const tracker = createProcessTreeTracker({ pid: ROOT });
  let answerOlder;
  tree.state.next = () => new Promise((resolve) => { answerOlder = resolve; });
  const older = tracker.capture();
  tree.state.next = () => { throw new Error('newer capture failed'); };
  await assert.rejects(tracker.capture());
  answerOlder(processTable([{ pid: ROOT }, { pid: 5101, ppid: ROOT }]));
  assert.equal(await older, false);
  tree.state.next = () => processTable([{ pid: 5101, ppid: 1 }]);
  assert.equal(await tracker.observe(), 'running', 'older positive identities still support cleanup');
  tree.state.next = () => processTable([]);
  assert.equal(await tracker.observe(), 'unknown', 'older completeness cannot prove the later tree ended');
});

test('lost root ownership cannot learn a new identity from a late capture or a reused pid', async () => {
  const tracker = createProcessTreeTracker({ pid: ROOT });
  let answer;
  tree.state.next = () => new Promise((resolve) => { answer = resolve; });
  const pending = tracker.capture();
  tracker.requireRootIdentity();
  answer(processTable([{ pid: ROOT, token: 'unverified-root' }]));
  assert.equal(await pending, false, 'a read finishing after handle loss cannot establish the old identity');
  tree.state.next = () => processTable([
    { pid: ROOT, token: 'reused-root' },
    { pid: 5110, ppid: ROOT, token: 'unrelated-child' },
  ]);
  assert.equal(await tracker.capture(), false);
  assert.equal(await tracker.observe({ rootExited: false }), 'unknown');
  assert.deepEqual(tracker.live, [], 'neither the bare pid nor its descendants are actionable');
  tree.state.next = () => processTable([]);
  assert.equal(await tracker.observe({ rootExited: false }), 'unknown');
});

test('after root ownership is lost only previously identified processes can authorize cleanup', async () => {
  const tracker = createProcessTreeTracker({ pid: ROOT });
  tree.state.next = () => processTable([
    { pid: ROOT, token: 'original-root' },
    { pid: 5111, ppid: ROOT, token: 'original-worker' },
  ]);
  assert.equal(await tracker.capture(), true);
  tracker.requireRootIdentity();
  assert.equal(tracker.complete, true, 'identity restriction preserves a completed pre-kill capture');
  tree.state.next = () => processTable([
    { pid: ROOT, token: 'reused-root' },
    { pid: 5110, ppid: ROOT, token: 'unrelated-child' },
    { pid: 5111, ppid: 1, token: 'original-worker' },
  ]);
  assert.equal(await tracker.capture(), false);
  assert.equal(await tracker.observe({ rootExited: false }), 'running');
  assert.deepEqual(tracker.live.map((entry) => entry.pid), [5111]);
  tree.state.next = () => processTable([{ pid: 5110, ppid: ROOT, token: 'unrelated-child' }]);
  assert.equal(await tracker.observe({ rootExited: false }), 'unknown', 'a missing root cannot validate new dangling ancestry');
  assert.deepEqual(tracker.live, []);
});

test('a pending pre-kill capture can finish after handle loss when the root identity was already known', async () => {
  const tracker = createProcessTreeTracker({ pid: ROOT });
  tree.state.next = () => processTable([{ pid: ROOT, token: 'original-root' }]);
  assert.equal(await tracker.capture(), true);
  let answer;
  tree.state.next = () => new Promise((resolve) => { answer = resolve; });
  const pending = tracker.capture();
  tracker.requireRootIdentity();
  answer(processTable([
    { pid: ROOT, token: 'original-root' },
    { pid: 5112, ppid: ROOT, token: 'pre-kill-worker' },
  ]));
  assert.equal(await pending, true, 'the late capture matches identity established before transport loss');
  tree.state.next = () => processTable([]);
  assert.equal(await tracker.observe({ rootExited: false }), 'gone');
});

// POSIX first consults the real kernel for the (fake) group, so the scripted
// table is only reached on Windows.
test('the post-exit probe compares identities, not pids', { skip: process.platform !== 'win32' }, async () => {
  tree.state.next = () =>
    processTable([
      { pid: ROOT, token: 'reused-root' },
      { pid: process.pid, ppid: ROOT, token: 'child-of-the-reuse' },
    ]);
  assert.equal(await probeShellDescendants({ pid: ROOT }), null);
  tree.state.next = () => processTable([{ pid: process.pid, ppid: ROOT, token: 'orphan' }]);
  const handle = await probeShellDescendants({ pid: ROOT });
  assert.deepEqual(handle.watch, [{ pid: process.pid, token: 'orphan', name: 'node.exe' }]);
});

test('a survivor whose pid was recycled ends the wait', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const handle = {
    rootPid: ROOT,
    groupPid: null,
    killPids: [process.pid],
    watchPids: [process.pid],
    watch: [{ pid: process.pid, token: 'survivor', name: 'node.exe' }],
  };
  tree.state.next = () => processTable([{ pid: process.pid, ppid: 1, token: 'survivor' }]);
  let done = false;
  const waiting = waitForShellDescendants(handle).then((value) => {
    done = value;
  });
  await flush();
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(done, false);
  tree.state.next = () => processTable([{ pid: process.pid, ppid: 1, token: 'recycled' }]);
  t.mock.timers.tick(5_000);
  await waiting;
  assert.equal(done, true);
});

test('a recycled pid is never a kill target', async () => {
  tree.state.kills.length = 0;
  tree.state.next = () => processTable([{ pid: 5200, token: 'someone-else' }]);
  const outcome = await killShellDescendants({
    rootPid: ROOT,
    groupPid: null,
    killPids: [5200],
    watchPids: [5200],
    watch: [{ pid: 5200, token: 'survivor', name: 'node.exe' }],
  });
  assert.deepEqual(tree.state.kills, []);
  assert.equal(outcome.terminated, true);
});
