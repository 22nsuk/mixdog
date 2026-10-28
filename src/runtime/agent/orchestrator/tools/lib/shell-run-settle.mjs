// Settle phase of one foreground shell run: the root result, capture cleanup
// after the whole tree ends, and bounded foreground resource admission.
import { ExecResult, SHELL_OUTPUT_INLINE_CAP } from '../shell-exec-output.mjs';
import { createProcessTreeTracker, probeShellDescendants, watchTermination } from './shell-descendants.mjs';
import { unregisterOwnedShellTree } from './owned-shell-trees.mjs';
import {
  clearTerminationHold,
  markShellJobTerminationUnconfirmed,
  registerTerminationHold,
  releaseShellJobWorkspace,
  takeReleaseRequest,
} from '../builtin/lib/shell-job-records.mjs';
import {
  clearForegroundRecord,
  clearForegroundTimers,
  detachAbortHandler,
  keepPendingShellRecord,
  releaseResourceLease,
} from './shell-run-state.mjs';

// Unconfirmed-kill cleanup ceiling: the result is already reported, but the
// tree may still be alive. Returning the resource lease waits for the root's
// real exit, bounded so an unkillable tree cannot pin the shell lane forever.
// Capture cleanup and actual settlement still follow the whole tree.
const UNCONFIRMED_KILL_CLEANUP_CEILING_MS = 60_000;

/** Settles once a held run's whole tree is confirmed gone: what its result
 *  left in use defers to this, including after a workspace-only release. */
function treeSettled(run) {
  if (!run.treeSettled) {
    run.treeSettled = new Promise((resolve) => {
      run.resolveTreeSettled = resolve;
    });
  }
  return run.treeSettled;
}

/** Lifecycle completion of a run whose result is already reported: release
 *  `run.workspaceAdmission` and retire the live record only once the root AND
 *  every descendant identity captured before the kill are confirmed gone. One
 *  observation loop at the termination cadence; running, unknown (incomplete
 *  snapshot, failed table read) and a failing release all re-check, and no
 *  timer ever releases on its own. */
export function releaseAdmissionOnConfirmedTermination(run, { markNow = true, sweep = false } = {}) {
  const { child } = run;
  if (!child || run.stopTerminationWatch) return;
  let recordTracked = markNow;
  if (markNow) keepPendingShellRecord(run);
  treeSettled(run);
  const releaseWorkspace = async () => {
    run.workspaceAdmission?.();
    run.workspaceAdmission = null;
    run.workspaceReleased = true;
    await releaseShellJobWorkspace(run.foregroundRecordId);
    clearTerminationHold(run.foregroundRecordId);
  };
  const finish = async () => {
    await releaseWorkspace();
    clearForegroundRecord(run);
    detachAbortHandler(run);
    if (run.ownedTree) unregisterOwnedShellTree(run.foregroundRecordId, run.ownedTree);
    run.resolveTreeSettled();
  };
  registerTerminationHold(run.foregroundRecordId, {
    ownerSessionId: run.foregroundRecordInput?.ownerSessionId || null,
    cwd: run.foregroundRecordInput?.cwd || null,
    release: releaseWorkspace,
  });
  run.terminationTracker = run.terminationTracker || createProcessTreeTracker({ pid: child.pid });
  run.stopTerminationWatch = watchTermination({
    tracker: run.terminationTracker,
    rootExited: () => child.exitCode != null || child.signalCode != null,
    // A killed run is not over while processes it started still run.
    sweep: () => sweep || run.killed === true || run.ownerCancelled === true,
    onTerminated: finish,
    onObservation: (state) => {
      if (state === 'gone') return;
      const unconfirmed = state === 'unknown' || sweep || run.killed === true || run.ownerCancelled === true;
      if (!recordTracked && !run.workspaceReleased) {
        keepPendingShellRecord(run, unconfirmed);
        recordTracked = true;
      } else {
        void markShellJobTerminationUnconfirmed(run.foregroundRecordId, unconfirmed);
      }
    },
    releaseRequested: () => takeReleaseRequest(run.foregroundRecordId),
    onReleaseRequested: releaseWorkspace,
  });
}

// Promotion resolves the call and hands the child's lifecycle to the
// shell-jobs registry, but the spill FDs stay owned by THIS runner and
// nothing else would ever close them — one leaked descriptor pair per
// promoted command. Released when the promoted job's whole tree ends.
export function createPromotedCaptureRelease(run) {
  let released = false;
  let waiting = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      // Flush the decoders before the capture closes: held bytes (a pending
      // encoding decision or a split character) would otherwise be lost.
      const stdoutTail = run.stdoutDecoder.end();
      const stderrTail = run.stderrDecoder.end();
      if (stdoutTail) run.taskOutput.writeStdout(stdoutTail);
      if (stderrTail) run.taskOutput.writeStderr(stderrTail);
    } catch {
      /* best-effort */
    }
    try {
      // The spill files stay, even when empty: the promoted task record and
      // its completion notice point at these paths.
      run.taskOutput.closeFds();
    } catch {
      /* best-effort */
    }
  };
  run.releasePromotedCapture = () => {
    // A root close may arrive during an uncommitted promotion. The successful
    // handoff invokes this again with the job's whole-tree promise attached;
    // a failed handoff returns to the foreground settle path instead.
    if (waiting || !run.treeSettled) return;
    waiting = true;
    void run.treeSettled.then(release);
  };
  return run.releasePromotedCapture;
}

function deferResourceLeaseToChildExit(run) {
  let done = false;
  let ceiling = null;
  const cleanup = () => {
    if (done) return;
    done = true;
    clearTimeout(ceiling);
    try {
      run.child.removeListener('close', cleanup);
      run.child.removeListener('exit', cleanup);
    } catch {
      /* not an emitter */
    }
    void releaseResourceLease(run);
  };
  try {
    run.child.once('close', cleanup);
    run.child.once('exit', cleanup);
  } catch {
    /* child may already be gone */
  }
  ceiling = setTimeout(cleanup, UNCONFIRMED_KILL_CLEANUP_CEILING_MS);
  if (ceiling.unref) ceiling.unref();
}

// getStdout/getStderr can throw on a spilled-file read failure (EBADF after
// unlink race, EACCES). Without this catch the rejection bubbles up and
// leaves the outer settle promise unresolved, hanging the call. Capture as
// writeError so the caller sees outputCaptureError and the partial inline
// buffer (if any) is still surfaced via partialOutput.
export async function readCapturedOutput(taskOutput, final = false) {
  let stdout = '';
  let stderr = '';
  try {
    stdout = await taskOutput.getStdout(final);
  } catch (err) {
    taskOutput.writeError = taskOutput.writeError || err;
  }
  try {
    stderr = await taskOutput.getStderr(final);
  } catch (err) {
    taskOutput.writeError = taskOutput.writeError || err;
  }
  return { stdout, stderr };
}

// The shell is gone — did it leave anything RUNNING? Answered from the
// process group / process tree the spawn layer already owns, never from the
// command text. A handle here means the caller reports a tracked task
// instead of a clean finish; null means nothing survived.
async function probeSurvivingDescendants(run) {
  if (run.killed || run.timedOut || !run.child?.pid) return null;
  const descendants = await probeShellDescendants({
    pid: run.child.pid,
  });
  if (descendants) descendants.taskId = run.foregroundRecordId;
  return descendants;
}

export function createSettle(run, releasePromotedCapture) {
  return async (exitCode, signal) => {
    if (run.settled) return;
    if (run.autoBackgrounded) {
      // A failed promotion settles the run with this close instead.
      run.promotionClose = [exitCode, signal];
      releasePromotedCapture();
      return;
    }
    run.settled = true;
    const { taskOutput } = run;
    const confirmKill = run.killed === true && !run.killUnconfirmed && Boolean(run.child?.pid);
    clearForegroundTimers(run);
    const stdoutTail = run.stdoutDecoder.end();
    const stderrTail = run.stderrDecoder.end();
    if (stdoutTail) taskOutput.writeStdout(stdoutTail);
    if (stderrTail) taskOutput.writeStderr(stderrTail);
    let { stdout, stderr } = await readCapturedOutput(taskOutput, true);
    if (run.spawnError && !stderr) stderr = String(run.spawnError.message || run.spawnError);
    // Inline-only path: nothing spilled. Nothing to clean up.
    // Spilled but within the inline cap: getStdout/getStderr already
    // returned the whole file, so the files would only duplicate the
    // inline body — drop them. Past the cap the rendered body is head+tail
    // carrying a "full output at <path>" marker, so the files MUST survive.
    // The test compares captured BYTES, not rendered UTF-16 length: a CJK
    // head+tail holds ~1/3 the char count of its byte size and under a
    // length test would delete the very file its own marker names.
    const dropCapture =
      !run.killUnconfirmed && taskOutput.spilled && taskOutput.totalDiskBytes() <= SHELL_OUTPUT_INLINE_CAP;
    let descendants = null;
    let descendantsUnknown = false;
    try {
      descendants = await probeSurvivingDescendants(run);
    } catch (error) {
      descendantsUnknown = true;
      taskOutput.writeError = taskOutput.writeError || error;
      exitCode = exitCode || 1;
      run.failureReason = 'Remaining child processes could not be verified; workspace cleanup is blocked.';
    }
    if (descendants || descendantsUnknown) {
      run.terminationTracker = run.terminationTracker || createProcessTreeTracker({
        pid: run.child.pid,
        members: descendants?.watch,
        exitObserved: true,
      });
      run.terminationTracker.acceptExitObservation();
    }
    const lifecycleHeld = run.killUnconfirmed || confirmKill || descendants || descendantsUnknown;
    if (lifecycleHeld) {
      releaseAdmissionOnConfirmedTermination(run, { markNow: run.killUnconfirmed || descendantsUnknown });
    } else {
      clearForegroundRecord(run);
      detachAbortHandler(run);
      if (run.ownedTree) unregisterOwnedShellTree(run.foregroundRecordId, run.ownedTree);
    }
    const releaseCapture = () => (dropCapture ? taskOutput.deleteFiles() : taskOutput.closeFds());
    if (lifecycleHeld) void treeSettled(run).then(releaseCapture);
    else releaseCapture();
    if (run.killUnconfirmed) deferResourceLeaseToChildExit(run);
    else void releaseResourceLease(run);
    if (!lifecycleHeld && run.workspaceAdmission) {
      try {
        run.workspaceAdmission();
        run.workspaceAdmission = null;
      } catch (error) {
        taskOutput.writeError = taskOutput.writeError || error;
        exitCode = exitCode || 1;
        run.failureReason = 'workspace admission cleanup failed';
      }
    }
    run.resolveResult(
      new ExecResult({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut: run.timedOut,
        killed: run.killed,
        killCause: run.killCause,
        stdoutPath: taskOutput.spilled && !dropCapture ? taskOutput.stdoutPath : null,
        stdoutFileSize: taskOutput.stdoutFileSize,
        stderrPath: taskOutput.spilled && !dropCapture ? taskOutput.stderrPath : null,
        stderrFileSize: taskOutput.stderrFileSize,
        taskId: run.taskId,
        partialOutput: run.partialOutput,
        outputCaptureError: taskOutput.writeError,
        failurePhase: run.failurePhase,
        failureReason: run.failureReason,
        descendants,
        settled: run.treeSettled,
      })
    );
  };
}
