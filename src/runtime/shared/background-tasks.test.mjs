import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

import {
  acknowledgeBackgroundTaskCompletion,
  cancelBackgroundTask,
  cancelBackgroundTasks,
  cleanupBackgroundTasks,
  completeBackgroundTask,
  getBackgroundTask,
  hasActiveBackgroundTasks,
  reconcileBackgroundTask,
  registerBackgroundTask,
  renderBackgroundTask,
  renderBackgroundTaskNotification,
  settleCancelledBackgroundTask,
  startBackgroundTask,
} from './background-tasks.mjs';
import { modelVisibleToolCompletionMessage } from './tool-execution-contract.mjs';
import { executeTaskTool } from '../agent/orchestrator/tools/builtin/task-tool.mjs';
import {
  _dropPendingMessageState,
  drainPendingMessages,
  enqueuePendingMessage,
  markCompletionEntry,
  settlePendingMessageWrites,
} from '../agent/orchestrator/session/manager/pending-messages.mjs';
import { _clearDeliveredCompletions } from '../agent/orchestrator/session/manager/delivered-completions.mjs';
import { parseTaskNotification, renderShellCompletionEnvelope } from './task-notification-envelope.mjs';

test('task output reports each error once while preserving metadata and verbatim results', () => {
  const body = '  stdout\r\nstderr\n\n';
  const task = {
    taskId: 'job_lossless',
    surface: 'shell',
    operation: 'shell',
    status: 'failed',
    startedAt: '2026-09-21T00:00:00Z',
    finishedAt: '2026-09-21T00:00:01Z',
    error: 'terminated by signal',
    meta: { cwd: '/work', stdout: '/logs/out', stderr: '/logs/err' },
    resultText: body,
  };
  const output = renderBackgroundTask(task, { includeResult: true });
  assert.match(output, /surface: shell\nstatus: failed/);
  assert.ok(output.endsWith(body));
  for (const value of [task.taskId, task.startedAt, task.finishedAt, '/logs/out', '/logs/err'])
    assert.ok(output.includes(value));
  assert.doesNotMatch(output, /cwd: \/work/);
  const withoutBody = renderBackgroundTask({ ...task, resultText: '' }, { includeResult: true });
  assert.equal(withoutBody.split(task.error).length - 1, 1);
  assert.match(withoutBody, /status: failed/);
  const distinct = renderBackgroundTask({ ...task, operation: 'test' });
  assert.match(distinct, /surface: shell\noperation: test/);
  assert.match(distinct, /cwd: \/work/);
});

test('stdout/stderr log paths collapse for both spill suffix forms', () => {
  const base = { taskId: 'job_logs', surface: 'shell', operation: 'shell', status: 'running', startedAt: 't0' };
  for (const suffix of ['', '.log']) {
    const output = renderBackgroundTask({
      ...base,
      meta: { stdout: `C:/out/shell_1.stdout${suffix}`, stderr: `C:/out/shell_1.stderr${suffix}` },
    });
    assert.match(output, new RegExp(`logs: C:/out/shell_1\\.\\{stdout,stderr\\}${suffix.replace('.', '\\.')}$`, 'm'));
    assert.doesNotMatch(output, /^std(out|err): /m);
  }
});

test('agent notifications bypass the card renderer and retain the entire final message', () => {
  const result = `  final message\n${'full result '.repeat(4_000)}\n`;
  const notifications = [];
  const task = registerBackgroundTask({
    surface: 'agent',
    label: 'tidy-skill',
    meta: { tag: 'tidy-skill', provider: 'provider', model: 'model' },
    renderResult: () => 'card-only result metadata',
    context: { notifyFn: (text) => notifications.push(text) },
  });
  try {
    completeBackgroundTask(task.taskId, { result: { content: result } });
    assert.equal(notifications.length, 1);
    assert.equal(parseTaskNotification(notifications[0]).result, result);
    assert.equal(notifications[0], renderBackgroundTaskNotification(task));
    assert.doesNotMatch(notifications[0], /card-only|provider:|model:|<usage>/);
    assert.match(
      renderBackgroundTask(task, { includeResult: true }),
      /provider: provider[\s\S]*card-only result metadata/
    );
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});

test('explicit resultText is not capped at the previous 32k task-record limit', () => {
  const task = registerBackgroundTask({ surface: 'agent' });
  const resultText = 'x'.repeat(40_001);
  try {
    completeBackgroundTask(task.taskId, { resultText, notify: false });
    assert.equal(task.resultText, resultText);
    assert.equal(parseTaskNotification(renderBackgroundTaskNotification(task)).result, resultText);
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});

test('terminal task read ACKs queued and racing completion notifications', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-task-read-ack-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const sessionId = `sess_task_read_ack_${process.pid}`;
  const taskId = `task_read_ack_${process.pid}`;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const task = registerBackgroundTask({
      taskId,
      surface: 'shell',
      operation: 'shell',
      context: { callerSessionId: sessionId },
    });
    const instruction = `Async shell task ${taskId} (completed, exit 0) finished.`;
    completeBackgroundTask(taskId, {
      status: 'completed',
      resultText: 'command output',
      resultType: 'shell_task_result',
      instruction,
      notify: false,
    });
    const completionText = renderBackgroundTask(task, { includeResult: true });
    const visible = modelVisibleToolCompletionMessage(completionText, {
      type: 'shell_task_result',
      execution_surface: 'shell',
      execution_id: taskId,
      status: 'completed',
      instruction,
    });
    const entry = markCompletionEntry(visible, { executionId: taskId });
    assert.ok(enqueuePendingMessage(sessionId, entry) > 0);
    await settlePendingMessageWrites({ throwOnTimeout: true });

    assert.match(await executeTaskTool({ action: 'read', task_id: taskId }, { sessionId }), /status: completed/);
    assert.equal(getBackgroundTask(taskId).completionAcknowledged, true);

    // Covers both orderings: already queued before the read, and a fallback
    // enqueue that races in after the read ACK.
    assert.ok(enqueuePendingMessage(sessionId, entry) > 0);
    assert.deepEqual(drainPendingMessages(sessionId), []);
    await settlePendingMessageWrites({ throwOnTimeout: true });
  } finally {
    _dropPendingMessageState(sessionId);
    await settlePendingMessageWrites({ throwOnTimeout: true }).catch(() => {});
    cleanupBackgroundTasks({ force: true });
    _clearDeliveredCompletions();
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('the owner tool start notice drops surface and cwd while other envelopes keep surface', () => {
  const task = registerBackgroundTask({
    surface: 'shell',
    operation: 'shell',
    label: 'npm test',
    meta: { cwd: 'C:/work', stdout: 'C:/logs/s.stdout', stderr: 'C:/logs/s.stderr' },
  });
  try {
    const notice = renderBackgroundTask(task, { ownerTool: true });
    assert.match(notice, /^background task\ntask_id: /);
    assert.match(notice, /^label: npm test$/m);
    assert.match(notice, /^logs: C:\/logs\/s\.\{stdout,stderr\}$/m);
    assert.doesNotMatch(notice, /^(surface|cwd):/m);
    const envelope = renderBackgroundTask(task);
    assert.match(envelope, /^surface: shell$/m);
    assert.match(envelope, /^cwd: C:\/work$/m);
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});

const CANCEL_OWNER = 'sess_cancel_owner';

function controlledRun() {
  const run = {};
  run.promise = new Promise((resolve, reject) => {
    run.resolve = resolve;
    run.reject = reject;
  });
  return run;
}

function startCancellableAgent(notifications, run) {
  return startBackgroundTask({
    surface: 'agent',
    label: 'worker',
    meta: { tag: 'worker' },
    notifyOnCancel: true,
    context: { callerSessionId: CANCEL_OWNER, notifyFn: (text) => notifications.push(text) },
    run: () => run.promise,
  });
}

test('a cancelled agent task notifies its owner once, as cancelled, carrying the partial result', async () => {
  const notifications = [];
  const run = controlledRun();
  const task = startCancellableAgent(notifications, run);
  try {
    cancelBackgroundTask(task.taskId, 'cancelled by agent close');
    assert.equal(task.status, 'cancelled');
    assert.equal(notifications.length, 0, 'delivery waits for the run to stop');
    settleCancelledBackgroundTask(task.taskId, { result: { content: 'partial work' } });
    run.reject(new Error('Session closed'));
    await task.promise;
    // Later reconcile / settle windows never re-fire it.
    reconcileBackgroundTask(task.taskId, { status: 'completed', result: { content: 'late' } });
    settleCancelledBackgroundTask(task.taskId, { result: { content: 'later' } });
    assert.equal(notifications.length, 1);
    const parsed = parseTaskNotification(notifications[0]);
    assert.equal(parsed.status, 'cancelled');
    assert.equal(parsed.result, 'partial work');
    assert.match(parsed.summary, /was cancelled \(cancelled by agent close\)/);
    assert.equal(task.status, 'cancelled');
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});

test('a cancelled agent run that resolves without partial output sends the header-only cancelled notification', async () => {
  const notifications = [];
  const run = controlledRun();
  const task = startCancellableAgent(notifications, run);
  try {
    cancelBackgroundTasks({ surface: 'agent', callerSessionId: CANCEL_OWNER, reason: 'parent Agent turn aborted' });
    run.resolve({ content: '' });
    await task.promise;
    assert.equal(notifications.length, 1);
    const parsed = parseTaskNotification(notifications[0]);
    assert.equal(parsed.status, 'cancelled');
    assert.equal(parsed.result, '');
    assert.match(parsed.summary, /\(parent Agent turn aborted\)/);
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});

test('a cancelled agent run that never settles still notifies, header-only, after the grace period', async () => {
  const notifications = [];
  const run = controlledRun();
  mock.timers.enable({ apis: ['setTimeout'] });
  const task = startCancellableAgent(notifications, run);
  try {
    cancelBackgroundTask(task.taskId, 'cancelled by task control');
    mock.timers.tick(9_999);
    assert.equal(notifications.length, 0);
    mock.timers.tick(1);
    assert.equal(notifications.length, 1);
    assert.equal(parseTaskNotification(notifications[0]).result, '');
    settleCancelledBackgroundTask(task.taskId, { result: { content: 'too late' } });
    run.reject(new Error('closed'));
    await task.promise;
    assert.equal(notifications.length, 1);
  } finally {
    mock.timers.reset();
    cleanupBackgroundTasks({ force: true });
  }
});

test('an acknowledged cancelled agent task is never notified', async () => {
  const notifications = [];
  const run = controlledRun();
  const task = startCancellableAgent(notifications, run);
  try {
    cancelBackgroundTask(task.taskId, 'cancelled by agent close');
    assert.ok(acknowledgeBackgroundTaskCompletion(task.taskId));
    settleCancelledBackgroundTask(task.taskId, { result: { content: 'partial work' } });
    run.reject(new Error('Session closed'));
    await task.promise;
    assert.equal(notifications.length, 0);
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});

test('execution-scoped cancellation follows binding, independently of surface and notification owner', () => {
  const cancelled = [];
  const add = (label, owner, sessionId, surface = 'tool') =>
    registerBackgroundTask({
      label,
      surface,
      context: { callerSessionId: owner, clientHostPid: process.pid },
      meta: sessionId ? { sessionId } : {},
      cancel: () => cancelled.push(label),
    });
  try {
    add('shell', 'parent', null, 'shell');
    add('local', 'parent');
    const pending = add('pending', 'parent');
    const bound = add('bound', 'parent');
    bound.meta.sessionId = 'child';
    const agent = add('agent', 'parent', 'child', 'agent');
    const generic = add('generic', 'parent', 'child');
    add('sibling', 'sibling');
    add('unattributed', null);
    cancelBackgroundTasks({ executionSessionId: 'parent', notify: false });
    assert.deepEqual(cancelled.sort(), ['local', 'pending', 'shell']);
    assert.equal(pending.status, 'cancelled');
    for (const task of [bound, agent, generic]) assert.equal(task.status, 'running');
    cancelBackgroundTasks({ executionSessionId: 'child', notify: false });
    assert.deepEqual(cancelled.sort(), ['agent', 'bound', 'generic', 'local', 'pending', 'shell']);
    for (const task of [bound, agent, generic]) assert.equal(task.status, 'cancelled');
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});

test('intentional caller cancellation and process exit cancel agent tasks silently', async () => {
  const notifications = [];
  const runs = [controlledRun(), controlledRun()];
  try {
    const deleted = startCancellableAgent(notifications, runs[0]);
    cancelBackgroundTasks({ reason: 'caller-cancel', notify: false, callerSessionId: CANCEL_OWNER });
    const exited = startCancellableAgent(notifications, runs[1]);
    cancelBackgroundTasks({ reason: 'cli-exit', notify: false });
    assert.equal(deleted.status, 'cancelled');
    assert.equal(exited.status, 'cancelled');
    for (const task of [deleted, exited]) {
      settleCancelledBackgroundTask(task.taskId, { result: { content: 'partial' } });
      reconcileBackgroundTask(task.taskId, { status: 'completed', result: { content: 'late' } });
    }
    for (const run of runs) run.reject(new Error('closed'));
    await Promise.all([deleted.promise, exited.promise]);
    assert.equal(notifications.length, 0);
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});

test('an intentional caller cancellation silences an agent cancellation still waiting for its run to settle', async () => {
  const notifications = [];
  const runs = [controlledRun(), controlledRun()];
  try {
    const bulk = startCancellableAgent(notifications, runs[0]);
    cancelBackgroundTask(bulk.taskId, 'cancelled by agent close');
    cancelBackgroundTasks({ reason: 'caller-cancel', notify: false, callerSessionId: CANCEL_OWNER });
    const single = startCancellableAgent(notifications, runs[1]);
    cancelBackgroundTask(single.taskId, 'cancelled by agent close');
    cancelBackgroundTask(single.taskId, 'desktop-session-delete', { notify: false });
    for (const task of [bulk, single]) {
      assert.equal(task.status, 'cancelled');
      settleCancelledBackgroundTask(task.taskId, { result: { content: 'partial work' } });
    }
    for (const run of runs) run.reject(new Error('Session closed'));
    await Promise.all([bulk.promise, single.promise]);
    assert.equal(notifications.length, 0);
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});

test('shell task cancellation keeps its notification behavior', async () => {
  const notifications = [];
  const shellTask = () =>
    registerBackgroundTask({
      surface: 'shell',
      operation: 'shell',
      label: 'sleep 100',
      context: { callerSessionId: CANCEL_OWNER, notifyFn: (text) => notifications.push(text) },
    });
  try {
    const single = shellTask();
    cancelBackgroundTask(single.taskId, 'cancelled by task control');
    const bulk = shellTask();
    cancelBackgroundTasks({ surface: 'shell', callerSessionId: CANCEL_OWNER, reason: 'cancelled' });
    assert.equal(single.status, 'cancelled');
    assert.equal(bulk.status, 'cancelled');
    assert.equal(notifications.length, 0);
    shellTask();
    cancelBackgroundTasks({ surface: 'shell', callerSessionId: CANCEL_OWNER, reason: 'dispose', notify: true });
    assert.equal(notifications.length, 1);
    assert.equal(parseTaskNotification(notifications[0]).status, 'cancelled');
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});

test('an owner-confirmed cancellation stays active until settlement, retaining output and one final notice', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const notifications = [];
  const attempts = [];
  const task = registerBackgroundTask({
    surface: 'shell',
    cancelOwnsCompletion: true,
    notifyOnCancel: true,
    context: { callerSessionId: CANCEL_OWNER, notifyFn: (text) => notifications.push(text) },
    cancel: () => attempts.push({ requested: task.cancelRequested, status: task.status }),
  });
  try {
    assert.deepEqual(
      cancelBackgroundTasks({ callerSessionId: CANCEL_OWNER, reason: 'owner stopped', notify: true }),
      { cancelled: 1 }
    );
    assert.equal(task.status, 'running', 'request delivery is not owner-confirmed termination');
    assert.equal(task.finishedAt, null);
    assert.equal(hasActiveBackgroundTasks({ callerSessionId: CANCEL_OWNER }), true);
    assert.deepEqual(attempts, [{ requested: true, status: 'running' }], 'intent precedes a reentrant owner hook');
    t.mock.timers.tick(30_000);
    assert.deepEqual(notifications, [], 'the legacy cancellation-notice grace cannot complete this task');
    cancelBackgroundTask(task.taskId, 'retry cancellation', { notify: true });
    assert.equal(attempts.length, 2, 'a still-running owner can retry its cancellation');
    assert.equal(task.cancelRequestedReason, 'owner stopped');
    const output = '  output before the command stopped\r\n';
    const result = { exit_code: 0, stdout: output };
    const resultText = renderShellCompletionEnvelope({
      jobId: task.taskId,
      status: 'completed',
      exitCode: 0,
      result: output,
    });
    completeBackgroundTask(task.taskId, { status: 'completed', result, resultText });
    assert.equal(task.status, 'cancelled', 'a requested cancellation wins a racing successful owner result');
    assert.equal(task.error, 'owner stopped');
    assert.equal(task.result, result);
    assert.equal(task.resultText, resultText, 'the owner result remains available verbatim');
    assert.equal(hasActiveBackgroundTasks({ callerSessionId: CANCEL_OWNER }), false);
    assert.equal(notifications.length, 1);
    const notice = parseTaskNotification(notifications[0]);
    assert.equal(notice.status, 'cancelled');
    assert.equal(notice.result, output);
    completeBackgroundTask(task.taskId, { status: 'failed', error: 'late error' });
    reconcileBackgroundTask(task.taskId, { status: 'completed', result: 'late output' });
    assert.equal(notifications.length, 1);
    assert.equal(task.result, result);
    assert.equal(task.error, 'owner stopped');
  } finally {
    t.mock.timers.reset();
    cleanupBackgroundTasks({ force: true });
  }
});

test('an owner can settle synchronously inside cancel after the requested status and notification policy are recorded', () => {
  try {
    for (const notify of [true, false]) {
      const notifications = [];
      const task = registerBackgroundTask({
        surface: 'shell',
        cancelOwnsCompletion: true,
        context: { notifyFn: (text) => notifications.push(text) },
        cancel: () => completeBackgroundTask(task.taskId, { result: { stdout: 'already stopped' } }),
      });
      cancelBackgroundTask(task.taskId, 'synchronous stop', { notify });
      assert.equal(task.status, 'cancelled');
      assert.equal(task.error, 'synchronous stop');
      assert.equal(notifications.length, notify ? 1 : 0);
      if (notify) assert.equal(parseTaskNotification(notifications[0]).status, 'cancelled');
    }
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});

test('owner settlement can explicitly suppress a requested cancellation notice', () => {
  const notifications = [];
  const task = registerBackgroundTask({
    surface: 'shell',
    cancelOwnsCompletion: true,
    context: { notifyFn: (text) => notifications.push(text) },
  });
  try {
    cancelBackgroundTask(task.taskId, 'requested stop', { notify: true });
    assert.equal(task.status, 'running');
    completeBackgroundTask(task.taskId, { result: { stdout: 'owner handled the result' }, notify: false });
    assert.equal(task.status, 'cancelled');
    assert.deepEqual(task.result, { stdout: 'owner handled the result' });
    assert.deepEqual(notifications, []);
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});

test('explicit silence dominates repeated owner-confirmed cancellation and later completion retries', () => {
  try {
    for (const firstNotify of [true, false]) {
      const notifications = [];
      const task = registerBackgroundTask({
        surface: 'shell',
        cancelOwnsCompletion: true,
        context: { callerSessionId: CANCEL_OWNER, notifyFn: (text) => notifications.push(text) },
      });
      cancelBackgroundTask(task.taskId, 'initial cancellation', { notify: firstNotify });
      cancelBackgroundTasks({ callerSessionId: CANCEL_OWNER, reason: 'session deleted', notify: false });
      cancelBackgroundTask(task.taskId, 'late retry', { notify: true });
      assert.equal(task.status, 'running');
      assert.equal(task.cancelNotify, 'silent');
      assert.equal(task.cancelRequestedReason, 'initial cancellation');
      completeBackgroundTask(task.taskId, {
        status: 'failed',
        error: new Error('owner cleanup failed'),
        result: { stdout: 'partial output' },
      });
      assert.equal(task.status, 'cancelled');
      assert.match(task.error, /owner cleanup failed/, 'the owner failure is not replaced by the cancellation reason');
      assert.deepEqual(task.result, { stdout: 'partial output' });
      reconcileBackgroundTask(task.taskId, { status: 'completed', result: 'late result' });
      assert.deepEqual(notifications, [], 'teardown silence also blocks a later reconciliation notice');
    }
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});

for (const outcome of ['resolve', 'reject']) {
  test(`an owner-confirmed task whose run ${outcome}s after cancellation settles once as cancelled`, async () => {
    const notifications = [];
    const run = controlledRun();
    const task = startBackgroundTask({
      surface: 'shell',
      cancelOwnsCompletion: true,
      context: { notifyFn: (text) => notifications.push(text) },
      run: () => run.promise,
    });
    const result = { stdout: 'partial result' };
    try {
      cancelBackgroundTask(task.taskId, 'requested stop', { notify: true });
      assert.equal(task.status, 'running');
      assert.equal(task.finishedAt, null);
      assert.deepEqual(notifications, []);
      if (outcome === 'resolve') run.resolve(result);
      else run.reject(new Error('run stopped with an error'));
      await task.promise;
      assert.equal(task.status, 'cancelled');
      if (outcome === 'resolve') {
        assert.equal(task.result, result);
        assert.equal(task.error, 'requested stop');
      } else {
        assert.match(task.error, /run stopped with an error/);
      }
      assert.equal(notifications.length, 1);
      assert.equal(parseTaskNotification(notifications[0]).status, 'cancelled');
      reconcileBackgroundTask(task.taskId, { status: 'completed' });
      assert.equal(notifications.length, 1);
    } finally {
      run.resolve();
      await task.promise;
      cleanupBackgroundTasks({ force: true });
    }
  });
}

test('a delivered result object is released (text and metadata kept) except for shell/agent readers', () => {
  const sent = [];
  const make = (surface) =>
    registerBackgroundTask({
      surface,
      label: 'x',
      meta: { tag: 'keep-me' },
      context: { notifyFn: (text) => sent.push(text) },
    });
  const generic = make('github');
  const shell = make('shell');
  const agent = make('agent');
  try {
    for (const t of [generic, shell, agent]) {
      completeBackgroundTask(t.taskId, { result: { content: 'body-' + t.surface, exit_code: 0 } });
    }
    assert.equal(sent.length, 3);
    assert.equal(generic.result, undefined);
    assert.ok(generic.resultText.includes('body-github'));
    assert.equal(generic.meta.tag, 'keep-me');
    assert.match(renderBackgroundTask(generic, { includeResult: true }), /body-github/);
    assert.equal(shell.result.exit_code, 0);
    assert.equal(agent.result.content, 'body-agent');
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});
