import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { getUsageLedger } from './usage-ledger.mjs';

const context = new AsyncLocalStorage();
export const currentTaskRun = () => context.getStore() || null;
// Queue pumps execute under the task releasing a slot, not necessarily the
// task that submitted the next callback. Bind only this attribution context.
export function bindTaskRun(callback) {
  const owner = currentTaskRun();
  return (...args) => context.run(owner, () => callback(...args));
}

// Accounting evidence must never replay a paid call, lose a cancellation, or
// reject an otherwise valid tool operation. Failures stay visible in stderr.
export async function recordTaskOperation(action, data) {
  try {
    return (await getUsageLedger()?.taskOperationAsync(action, data)) ?? null;
  } catch (error) {
    process.stderr.write(`[task-usage] ${action} not saved: ${error?.message || error}\n`);
    return null;
  }
}

export async function withTaskRun(data, run) {
  const parent = currentTaskRun();
  // Pending submissions from this process were enqueued before this turn.
  // The canonical surface awaits registration before dispatching across IPC.
  try {
    await getUsageLedger()?.settleWrites();
  } catch {
    /* recordTaskOperation reports the unavailable store */
  }
  const { signal, allowParent, ...stored } = data;
  const identity = await recordTaskOperation('begin', {
    ...stored,
    parentId: data.allowParent !== false && parent?.sessionId !== data.sessionId ? parent?.id : null,
  });
  const started = performance.now();
  let outcome = 'completed';
  try {
    return await context.run(identity, run);
  } catch (error) {
    outcome = signal?.aborted ? 'cancelled' : 'failed';
    throw error;
  } finally {
    if (identity)
      await recordTaskOperation('finish', {
        id: identity.id,
        outcome: signal?.aborted ? 'cancelled' : outcome,
        finishedAt: Date.now(),
        elapsedMs: Math.max(0, Math.round(performance.now() - started)),
      });
  }
}

// The ID rides the internal tool context, never the model's tool arguments.
// Check the caller against durable ownership after an IPC boundary.
export async function withTaskCaller(caller, run) {
  if (!caller?.taskRunId) return context.run(null, run);
  const parent = await recordTaskOperation('parent', { id: caller.taskRunId, sessionId: caller.callerSessionId || '' });
  return context.run(parent ? { id: parent.id, rootId: parent.root_id, sessionId: parent.session_id } : null, run);
}

export function registerTaskSubmission(sessionId, submissionId) {
  const parent = currentTaskRun();
  return parent
    ? recordTaskOperation('submit', { sessionId, submissionId, parentId: parent.id, requestedAt: Date.now() })
    : Promise.resolve();
}

export function noteTaskSteering(entries) {
  const run = currentTaskRun();
  if (run && entries?.length)
    void recordTaskOperation('steering', {
      id: run.id,
      sessionId: run.sessionId,
      submissionIds: entries.flatMap((entry) => entry.ids || [entry.id]).filter(Boolean),
    });
}
