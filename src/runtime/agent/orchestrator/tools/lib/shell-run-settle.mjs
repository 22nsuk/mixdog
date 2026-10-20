// Settle phase of one foreground shell run: the terminal result once the
// child is gone (or its kill could not be confirmed), plus the capture /
// lease cleanup that a promoted or unconfirmed-kill child defers to its own
// real exit.
import { ExecResult, SHELL_OUTPUT_INLINE_CAP, treeKill } from '../shell-exec-output.mjs';
import {
  createProcessTreeTracker,
  killAfterSnapshot,
  killShellDescendants,
  probeShellDescendants,
  waitForShellDescendants,
  watchTermination,
} from './shell-descendants.mjs';
import { registerOwnedShellTree, unregisterOwnedShellTree } from './owned-shell-trees.mjs';
import {
  adoptShellWorkspaceAdmission,
  clearTerminationHold,
  registerTerminationHold,
  releaseShellJobWorkspace,
  takeReleaseRequest,
} from '../builtin/lib/shell-job-records.mjs';
import {
  capturePreKill,
  clearForegroundRecord,
  clearForegroundTimers,
  detachAbortHandler,
  keepTerminationUnconfirmedRecord,
  releaseResourceLease,
  shellRootExitObserved,
} from './shell-run-state.mjs';

// Unconfirmed-kill cleanup ceiling: the result is already reported, but the
// tree may still be alive. Returning its foreground resource lease remains
// bounded so it cannot pin the shell lane forever. Capture files and workspace
// admission have their own lifetimes; this ceiling never deletes live output.
const UNCONFIRMED_KILL_CLEANUP_CEILING_MS = 60_000;

/** Lifecycle completion of a run whose result is already reported: release
 *  `run.workspaceAdmission` and retire the live record only once the root AND
 *  every descendant identity captured before the kill are confirmed gone. One
 *  observation loop at the termination cadence; running, unknown (incomplete
 *  snapshot, failed table read) and a failing release all re-check, and no
 *  timer ever releases on its own. */
export function releaseAdmissionOnConfirmedTermination(run, { markNow = true } = {}) {
  const { child } = run;
  if (!child || run.stopTerminationWatch) return run.treeSettled;
  let resolveTerminated;
  run.treeSettled = new Promise((resolve) => { resolveTerminated = resolve; });
  // Visible as "termination unconfirmed" until the lifecycle ends, with an
  // explicit user force-release as the only other way out. An unconfirmed
  // kill is marked at once; an owner-cancelled tree whose root is already
  // gone only once its first observation is not 'gone'.
  if (markNow && !run.workspaceReleased) keepTerminationUnconfirmedRecord(run);
  const release = () => {
    run.workspaceAdmission?.();
    run.workspaceAdmission = null;
    run.workspaceReleased = true;
    clearTerminationHold(run.foregroundRecordId);
    clearForegroundRecord(run);
  };
  registerTerminationHold(run.foregroundRecordId, {
    ownerSessionId: run.foregroundRecordInput?.ownerSessionId || null,
    cwd: run.foregroundRecordInput?.cwd || null,
    release,
  });
  run.terminationTracker = run.terminationTracker || createProcessTreeTracker({ pid: child.pid });
  run.stopTerminationWatch = watchTermination({
    tracker: run.terminationTracker,
    rootExited: () => shellRootExitObserved(child),
    // A killed run is not over while processes it started still run.
    sweep: () => run.killed === true,
    onTerminated: () => {
      release();
      if (run.ownedTree) unregisterOwnedShellTree(run.foregroundRecordId, run.ownedTree);
      resolveTerminated(true);
    },
    onUnconfirmed: markNow ? null : () => {
      if (!run.workspaceReleased) keepTerminationUnconfirmedRecord(run);
    },
    releaseRequested: () => takeReleaseRequest(run.foregroundRecordId),
    onRelease: release,
  });
  return run.treeSettled;
}

// Promotion resolves the call and hands the child's lifecycle to the
// shell-jobs registry, but the spill FDs stay owned by THIS runner and
// nothing else would ever close them — one leaked descriptor pair per
// promoted command. The registry's tree settlement owns their release.
export function createPromotedCaptureRelease(run) {
  let released = false;
  return () => {
    if (released) return;
    if (!run.treeSettled) return;
    released = true;
    void run.treeSettled.then(() => {
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
    });
  };
}

function deferCleanupToChildExit(run) {
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
  releaseAdmissionOnConfirmedTermination(run);
  if (run.child.exitCode != null || run.child.signalCode != null) cleanup();
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
    tracker: run.terminationTracker,
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
    clearForegroundTimers(run);
    detachAbortHandler(run);
    if (run.child?.pid && run.child.rootExitObserved === false) {
      // A synthetic native close reports the failed transport, not an OS
      // exit. The old pid may already be reused: only pre-existing identity
      // evidence can authorize a fresh capture and a physical cleanup sweep.
      run.terminationTracker = run.terminationTracker || createProcessTreeTracker({ pid: run.child.pid });
      run.terminationTracker.requireRootIdentity();
      const alreadyKilled = run.killed === true;
      run.killed = true;
      run.killCause = run.killCause || 'native-failed';
      run.killUnconfirmed = true;
      if (!alreadyKilled) await killAfterSnapshot(capturePreKill(run), () => treeKill(run.child));
    }
    const stdoutTail = run.stdoutDecoder.end();
    const stderrTail = run.stderrDecoder.end();
    if (stdoutTail) taskOutput.writeStdout(stdoutTail);
    if (stderrTail) taskOutput.writeStderr(stderrTail);
    let { stdout, stderr } = await readCapturedOutput(taskOutput, true);
    if (run.spawnError && !stderr) stderr = String(run.spawnError.message || run.spawnError);
    let descendants = null;
    let descendantsUnknown = false;
    try {
      descendants = await probeSurvivingDescendants(run);
    } catch (error) {
      descendantsUnknown = true;
      taskOutput.writeError = taskOutput.writeError || error;
      exitCode = exitCode || 1;
      run.failureReason = 'Remaining child processes could not be verified; workspace cleanup is blocked.';
      // The root exited on its own, so it is observed after exit like any
      // settle; the held admission joins the termination watch and the
      // explicit force-release, and the record is kept, marked unconfirmed.
      // (The probe runs only for an unkilled root, so the lifecycle is not
      // already held here.)
      run.terminationTracker = run.terminationTracker || createProcessTreeTracker({ pid: run.child.pid });
      run.terminationTracker.acceptExitObservation();
      releaseAdmissionOnConfirmedTermination(run);
    }
    // Owner cancellation remains live while output and the descendant probe
    // are awaited. Select cleanup only now, using any identities the probe
    // observed, so a late cancellation also keeps sweeping that same tree.
    if (run.killed && descendants) {
      run.terminationTracker = descendants.tracker;
      descendants = null;
    }
    const confirmKill = run.killed === true && !run.killUnconfirmed && Boolean(run.child?.pid);
    const lifecycleHeld = run.killUnconfirmed || confirmKill;
    if (!lifecycleHeld && !descendantsUnknown) clearForegroundRecord(run);
    // Marked unconfirmed (with its force-release) only once an observation
    // finds a captured identity still alive or cannot tell.
    if (run.killUnconfirmed) deferCleanupToChildExit(run);
    else if (confirmKill) releaseAdmissionOnConfirmedTermination(run, { markNow: false });
    if (descendants) {
      // Share the observer with the detached task the renderer registers.
      // Direct runner callers also retain a cleanup owner if no task is made.
      run.treeSettled = waitForShellDescendants(descendants);
      if (run.ownedTree) unregisterOwnedShellTree(run.foregroundRecordId, run.ownedTree);
      run.ownedTree = {
        ownerSessionId: run.foregroundRecordInput?.ownerSessionId || null,
        prepareKill: () => killShellDescendants(descendants).then(() => true),
      };
      registerOwnedShellTree(run.foregroundRecordId, run.ownedTree);
      void run.treeSettled.then(() => {
        releaseShellJobWorkspace(run.foregroundRecordId);
        unregisterOwnedShellTree(run.foregroundRecordId, run.ownedTree);
      });
    }
    if (run.treeSettled) {
      // The result names these logs: a descendant may append after the root
      // exits, so neither a small initial capture nor a force-release can
      // delete them. Close the writer only at physical tree settlement.
      void run.treeSettled.then(() => taskOutput.closeFds());
    } else {
      if (run.ownedTree) unregisterOwnedShellTree(run.foregroundRecordId, run.ownedTree);
      // Small complete captures are already delivered inline. Compare bytes,
      // not rendered string length, so a CJK head+tail never loses its log.
      if (taskOutput.spilled && taskOutput.totalDiskBytes() <= SHELL_OUTPUT_INLINE_CAP) taskOutput.deleteFiles();
      else taskOutput.closeFds();
    }
    if (!run.killUnconfirmed) void releaseResourceLease(run);
    if (!lifecycleHeld && !descendantsUnknown && run.workspaceAdmission) {
      try {
        if (descendants) adoptShellWorkspaceAdmission(run.foregroundRecordId, run.workspaceAdmission);
        else run.workspaceAdmission();
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
        stdoutPath: taskOutput.spilled ? taskOutput.stdoutPath : null,
        stdoutFileSize: taskOutput.stdoutFileSize,
        stderrPath: taskOutput.spilled ? taskOutput.stderrPath : null,
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

/** Startup and output wiring share the same physical cleanup owner. The call
 *  reports its failure after a bounded kill attempt; capture files and the
 *  workspace remain owned until the tree, including surviving children, ends. */
export async function cleanupFailedShellRun(run) {
  run.settled = true;
  detachAbortHandler(run);
  clearForegroundTimers(run);
  let cleanupError = null;
  try {
    if (run.child?.pid) {
      const exitedOnItsOwn = !run.killed && shellRootExitObserved(run.child);
      const alreadyKilled = run.killed === true;
      const nativeExitUnconfirmed = run.child.rootExitObserved === false && run.child._closed;
      run.killed = true;
      run.killCause = run.killCause || 'startup-failed';
      run.killUnconfirmed = true;
      if (exitedOnItsOwn) {
        // No kill broke the parent links: use the same post-exit observation
        // as normal settlement, including a sweep of any survivors it finds.
        run.terminationTracker = run.terminationTracker || createProcessTreeTracker({ pid: run.child.pid });
        run.terminationTracker.acceptExitObservation();
      } else if (nativeExitUnconfirmed && alreadyKilled) {
        run.terminationTracker = run.terminationTracker || createProcessTreeTracker({ pid: run.child.pid });
        run.terminationTracker.requireRootIdentity();
      } else {
        await killAfterSnapshot(capturePreKill(run), () => treeKill(run.child));
      }
      releaseAdmissionOnConfirmedTermination(run);
      void run.treeSettled.then(() => run.taskOutput.deleteFiles()).catch((error) => {
        run.taskOutput.writeError = run.taskOutput.writeError || error;
      });
    } else {
      run.workspaceAdmission?.();
      run.workspaceAdmission = null;
      run.taskOutput.deleteFiles();
    }
  } catch (error) {
    cleanupError = error;
  }
  // A failed foreground call must not reserve an execution slot for a tree
  // whose cleanup may need an explicit workspace release or an indefinite wait.
  const leaseError = await releaseResourceLease(run);
  if (cleanupError && leaseError) return new AggregateError([cleanupError, leaseError], 'Shell cleanup failed.');
  return cleanupError || leaseError;
}
