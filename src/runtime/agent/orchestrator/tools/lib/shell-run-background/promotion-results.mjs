/**
 * promotion-results.mjs — the ExecResult a promotion resolves the foreground
 * call with, one builder per outcome: cancelled during promotion, completed
 * during promotion, backgrounded, or cleanup failure.
 */
import { killShellJob, peekShellJob, subscribeShellJobSettled } from '../../builtin/shell-jobs.mjs';
import { adoptShellWorkspaceAdmission } from '../../builtin/lib/shell-job-records.mjs';
import { ExecResult } from '../../shell-exec-output.mjs';
import {
  cleanupFailedShellStartup,
  releaseAdmissionOnConfirmedTermination,
  releaseFailedStartupResources,
} from '../shell-run-settle.mjs';
import { clearForegroundRecord, detachAbortHandler, elapsedSinceStart } from '../shell-run-state.mjs';

const BACKGROUND_GUIDANCE =
  'Its result is delivered automatically when it finishes; use task wait only if you need it now.';

function backgroundVerb(reason, secs) {
  if (reason === 'timeout') return `moved to background at timeout after ${secs}s`;
  if (reason === 'input') return `moved to background on new user input after ${secs}s`;
  if (reason === 'notification') {
    return `moved to background after ${secs}s because a notification arrived (delivered to you now)`;
  }
  if (reason === 'interrupt') return `moved to background on interrupt after ${secs}s`;
  if (reason === 'background') return 'started in the background';
  return `moved to background after the ${secs}s hold`;
}

export function promotedSpillPaths(taskOutput) {
  return {
    stdoutPath: taskOutput.spilled ? taskOutput.stdoutPath : null,
    stdoutFileSize: taskOutput.stdoutFileSize,
    stderrPath: taskOutput.spilled ? taskOutput.stderrPath : null,
    stderrFileSize: taskOutput.stderrFileSize,
  };
}

/** Fields every promotion-time result shares: the partial capture and its spill. */
function capturedFields(run, { stdout, stderr, spill }) {
  return {
    stdout,
    stderr,
    ...spill,
    taskId: run.taskId,
    outputCaptureError: run.taskOutput.writeError,
  };
}

// A committed promotion has its own tree observer. Keep that completion
// boundary even when the foreground call returns a cancellation/error result.
// If no job owns it, the failed-startup boundary still owns this child.
async function cancelPromotion(run, jobId, { cleanupResources = false } = {}) {
  const errors = [];
  let resolveTermination;
  const terminated = new Promise((resolve) => { resolveTermination = resolve; });
  const unsubscribe = jobId ? subscribeShellJobSettled(jobId, resolveTermination) : null;
  if (unsubscribe) {
    run.terminationSettled = terminated;
    try {
      killShellJob(jobId);
    } catch (error) {
      errors.push(error);
    }
    if (run.workspaceAdmission) {
      if (peekShellJob(jobId)?.status === 'running') {
        // A failed handover can leave the foreground folder reservation
        // behind. The live job observer releases and retries both holds.
        adoptShellWorkspaceAdmission(jobId, run.workspaceAdmission);
        run.workspaceAdmission = null;
      } else {
        // The job's observer may have finished during handover. Its shared
        // tracker still proves termination; a fresh release watch retries
        // any remaining foreground hold instead of adopting it to no owner.
        releaseAdmissionOnConfirmedTermination(run, { markNow: false });
        run.terminationSettled = Promise.all([terminated, run.terminationSettled]);
      }
    }
  } else {
    try {
      await cleanupFailedShellStartup(run);
    } catch (error) {
      errors.push(error);
    }
  }
  // A successfully handed-over capture still flushes its decoder at close.
  // Only failed handovers or unowned children need this resource fallback.
  if (!unsubscribe || cleanupResources) {
    try {
      const error = await releaseFailedStartupResources(run);
      if (error) errors.push(error);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors.map((error) => String(error?.message || error));
}

/**
 * Cancellation raced in after promotion committed. Never report that
 * cancelled process as a successful still-running background task.
 */
export async function resolveCancelledAfterPromotion(run, jobId, capture) {
  run.killed = true;
  run.killCause = 'cancellation';
  detachAbortHandler(run);
  const cleanupErrors = await cancelPromotion(run, jobId);
  run.resolveResult(
    new ExecResult({
      ...capturedFields(run, capture),
      stderr: [capture.stderr, ...cleanupErrors].filter(Boolean).join('\n'),
      exitCode: null,
      signal: run.child.signalCode || null,
      timedOut: false,
      killed: true,
      killCause: run.killCause,
      partialOutput: true,
      backgrounded: false,
      settled: run.terminationSettled,
    })
  );
}

/**
 * Completed-during-promotion race: the child finished while promotion was
 * committing. Report a clean COMPLETED result instead of backgrounded — the
 * caller then never arms the completion watcher, so no redundant task
 * notification fires.
 */
export function resolveCompletedDuringPromotion(run, capture) {
  detachAbortHandler(run);
  run.resolveResult(
    new ExecResult({
      ...capturedFields(run, capture),
      exitCode: run.child.exitCode,
      signal: run.child.signalCode || null,
      timedOut: false,
      killed: false,
      partialOutput: false,
      backgrounded: false,
    })
  );
}

export function resolveBackgrounded(run, { jobId, reason, remainingBackgroundTimeoutMs }, capture) {
  // The promoted job now owns cancellation through task control. Retaining
  // the foreground caller's signal listener would keep the completed tool
  // frame alive and could later kill an unrelated, already-returned job.
  detachAbortHandler(run);
  const secs = Math.max(0, Math.round(elapsedSinceStart(run) / 1000));
  const verb = backgroundVerb(reason, secs);
  run.resolveResult(
    new ExecResult({
      ...capturedFields(run, capture),
      exitCode: null,
      signal: null,
      timedOut: false,
      killed: false,
      partialOutput: true,
      backgrounded: true,
      jobId,
      backgroundTimeoutMs: remainingBackgroundTimeoutMs,
      backgroundMessage: jobId
        ? `${verb}; still running. ${BACKGROUND_GUIDANCE}`
        : `${verb}; still running — judge from the partial output whether waiting can finish in budget, or diagnose and pursue an alternative.`,
    })
  );
}

/**
 * A promotion that threw (lease hand-over) keeps the same cleanup owners:
 * the native job confirms the tree, root exit releases capture descriptors,
 * and its unreferenced files are removed only after the tree is gone.
 */
export async function resolveCleanupFailure(run, error) {
  const { taskOutput } = run;
  run.autoBackgrounded = true;
  clearForegroundRecord(run);
  run.killed = true;
  run.killCause = 'resource-cleanup-error';
  detachAbortHandler(run);
  const cleanupErrors = await cancelPromotion(run, run.autoBackgroundJobId, { cleanupResources: true });
  run.settled = true;
  const deleteCapture = () => {
    try {
      taskOutput.deleteFiles();
    } catch {
      /* best-effort */
    }
  };
  if (run.terminationSettled) run.terminationSettled = run.terminationSettled.then(deleteCapture);
  else deleteCapture();
  run.resolveResult(
    new ExecResult({
      stdout: '',
      stderr: [`resource cleanup failed during background promotion: ${error?.message || error}`, ...cleanupErrors].join('; '),
      exitCode: 1,
      signal: run.child?.signalCode || null,
      timedOut: false,
      killed: true,
      killCause: run.killCause,
      taskId: run.taskId,
      partialOutput: true,
      outputCaptureError: taskOutput.writeError,
      failurePhase: 'tool',
      failureReason: 'resource cleanup failed',
      backgrounded: false,
      settled: run.terminationSettled,
    })
  );
}
