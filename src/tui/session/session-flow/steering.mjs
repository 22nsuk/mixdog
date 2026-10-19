/**
 * src/tui/session/session-flow/steering.mjs - lead steering: mid-turn drain of
 * queued entries into model-visible steering messages, commit bookkeeping, and
 * crash-safe restore of persisted steering rows.
 */
import {
  isGoalQueuedEntry,
  isQueuedEntryEditable,
  isQueuedEntryVisible,
  isQueuedEntryAwaitingReview,
  isSlashQueuedEntry,
  queuePriorityValue,
  callCommitCallbacks,
  STEERING_SUPPRESSED_DISPLAY,
} from '../queue-helpers.mjs';
import { dropTuiSteeringPersist, readTuiSteeringPersist } from '../tui-steering-persist.mjs';
import { getBackgroundTask } from '../../../runtime/shared/background-tasks.mjs';

// Mid-chain drain converts queued prompt/task notification entries into
// model-visible "queued_command" style steering only at provider continuation
// boundaries. Slash commands stay queued for the post-turn command processor.
function isSteerableEntry(entry) {
  if (isQueuedEntryAwaitingReview(entry) || isSlashQueuedEntry(entry)) return false;
  const mode = entry?.mode || 'prompt';
  return mode === 'prompt' || mode === 'task-notification' || mode === 'goal-closeout';
}

// A completion is queued the moment its task settles, which is usually before
// the model's own `task wait`/`task read` returns that same result and ACKs it.
// Delivering the queued twin afterwards repeats a result the model already has.
function isAcknowledgedCompletion(entry) {
  if (entry?.mode !== 'task-notification' || !entry.execution?.id) return false;
  return getBackgroundTask(entry.execution.id)?.completionAcknowledged === true;
}

function steeringMessageFromEntry(entry) {
  if (isAcknowledgedCompletion(entry)) return null;
  const content = entry.content;
  const meta = {
    id: entry.id,
    submittedAt: entry.submittedAt,
    mode: entry.mode,
    ...(entry.execution && typeof entry.execution === 'object' ? { execution: { ...entry.execution } } : {}),
    ...(Array.isArray(entry.images) && entry.images.length ? { images: entry.images } : {}),
    ...(entry.transcriptMeta && typeof entry.transcriptMeta === 'object'
      ? { transcriptMeta: entry.transcriptMeta }
      : {}),
  };
  if (entry.suppressDisplay) {
    // Model-visible twin of an already-rendered live completion: deliver
    // content to the model but flag onSteerMessage to skip the duplicate
    // transcript card (no fall-back to content-derived display text).
    const hasContent = Array.isArray(content) ? content.length > 0 : String(content ?? '').trim().length > 0;
    return hasContent ? { ...meta, text: STEERING_SUPPRESSED_DISPLAY, content } : null;
  }
  const displayText = String(entry.text || '').trim();
  if (typeof content === 'string') {
    const value = content.trim();
    return value.length > 0 ? { ...meta, text: displayText || value, content: value } : null;
  }
  if (Array.isArray(content)) {
    return content.length > 0 ? { ...meta, text: displayText, content } : null;
  }
  return String(content ?? '').trim().length > 0 ? { ...meta, text: displayText, content } : null;
}

// A submission's identity is its receipt, never its text: users can submit
// the same instruction twice, and steering can wrap or merge the bodies.
function deliveredSubmissionIds(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const out = new Set();
  for (const message of messages) {
    if (message?.role !== 'user') continue;
    const meta = message.meta || {};
    const transcript = meta.transcript || {};
    const ids = [
      ...(Array.isArray(meta.submissionIds) ? meta.submissionIds : []),
      ...(Array.isArray(transcript.submissionIds) ? transcript.submissionIds : []),
      transcript.checkpointId,
    ];
    for (const id of ids) {
      if (typeof id === 'string' && id.trim()) out.add(id.trim());
    }
  }
  return out;
}

export function createSteeringOps(bag, { queue, submissions }) {
  const { runtime, pending, set } = bag;
  const turnSettlements = new Map();

  function settleSteeredSubmissions(epoch, detail) {
    const entries = turnSettlements.get(epoch);
    turnSettlements.delete(epoch);
    for (const entry of entries || []) {
      try {
        entry.onSettled(detail);
      } catch {}
    }
  }

  const leadSessionId = () => runtime.id;

  function shouldMirrorSteeringEntry(entry) {
    return isQueuedEntryEditable(entry) && !isSlashQueuedEntry(entry);
  }

  function releaseSteeringQueueEntries(entries) {
    const mirrored = (Array.isArray(entries) ? entries : []).filter(
      (entry) => shouldMirrorSteeringEntry(entry) && entry.steeringPersistId
    );
    if (mirrored.length > 0) return dropTuiSteeringPersist(leadSessionId(), mirrored);
  }

  function commitSteeringQueueEntries(entries) {
    callCommitCallbacks(entries);
    releaseSteeringQueueEntries(entries);
  }

  function canDeliverSteeringEntry(entry) {
    return !isGoalQueuedEntry(entry) || bag.shouldRunGoalContinuation?.(entry) === true;
  }

  // Pre-send steering is an admission route: a closing/closed session injects
  // nothing into a model request.
  const admissionOpen = () => !bag.flags?.admission || bag.flags.admission === 'open';

  function hasPendingSteering() {
    if (!admissionOpen()) return false;
    return pending.some(
      (entry) =>
        isSteerableEntry(entry) &&
        queuePriorityValue(entry.priority) <= queuePriorityValue('next') &&
        canDeliverSteeringEntry(entry) &&
        steeringMessageFromEntry(entry) !== null
    );
  }

  // Queued input the user typed (editable prompts), not runtime notices.
  function hasPendingUserInput() {
    if (!admissionOpen()) return false;
    return pending.some(
      (entry) => !isQueuedEntryAwaitingReview(entry) && isQueuedEntryEditable(entry) && !isSlashQueuedEntry(entry)
    );
  }

  // A notification the next boundary will deliver: a task notification (one
  // the agent already received through task wait/read is not deliverable) or
  // the Goal closeout. `later` entries (scheduled and channel injects) wait
  // for the turn to end, so they are not deliverable mid-turn.
  function isDeliverableNotification(entry) {
    const mode = entry?.mode;
    return (
      admissionOpen() &&
      (mode === 'task-notification' || mode === 'goal-closeout') &&
      queuePriorityValue(entry.priority) <= queuePriorityValue('next') &&
      canDeliverSteeringEntry(entry) &&
      steeringMessageFromEntry(entry) !== null
    );
  }

  function hasPendingNotification() {
    return pending.some(isDeliverableNotification);
  }

  // What one queued entry should wake a passive wait or shell hold for: typed
  // input, a deliverable notification, or nothing (slash commands and
  // informational meta prompts run or ride along without ending a wait).
  function taskWaitWakeForEntry(entry) {
    if (!admissionOpen() || isQueuedEntryAwaitingReview(entry)) return false;
    if (isQueuedEntryEditable(entry) && !isSlashQueuedEntry(entry)) return 'user-message';
    return isDeliverableNotification(entry) ? 'notification' : false;
  }

  // What a passive wait or shell hold should wake for right now: user input
  // first, else a deliverable notification.
  function pendingTaskWaitWake() {
    if (hasPendingUserInput()) return 'user-message';
    return hasPendingNotification() ? 'notification' : false;
  }

  // `later` notifications (scheduled tasks) are skipped unless the runtime
  // explicitly asks for a later flush.
  function drainPendingSteering(_sessionIdOrOptions = null, maybeOptions = null) {
    let options = {};
    if (maybeOptions && typeof maybeOptions === 'object') options = maybeOptions;
    else if (_sessionIdOrOptions && typeof _sessionIdOrOptions === 'object') options = _sessionIdOrOptions;
    const maxPriority = options.maxPriority || 'next';
    const out = [];
    if (!admissionOpen()) return out;
    for (;;) {
      const batch = queue.dequeueQueueBatch(maxPriority, { predicate: isSteerableEntry });
      if (batch.length === 0) break;
      const accepted = batch.filter(canDeliverSteeringEntry);
      for (const entry of accepted) {
        const message = steeringMessageFromEntry(entry);
        if (message) {
          out.push(message);
          if (typeof entry.onSettled === 'function') {
            const epoch = options.turnEpoch;
            const entries = turnSettlements.get(epoch) || new Set();
            entries.add(entry);
            turnSettlements.set(epoch, entries);
          }
        }
      }
      commitSteeringQueueEntries(accepted);
    }
    return out;
  }

  async function restoreLeadSteeringFromDisk() {
    // A closed/closing conversation never gets queue work restored into it.
    if (!admissionOpen()) return;
    const rows = await readTuiSteeringPersist(leadSessionId());
    if (!rows.length) return;
    const livePersistIds = new Set(pending.map((entry) => entry?.steeringPersistId).filter(Boolean));
    const liveSubmissionIds = new Set(pending.map((entry) => entry?.id).filter(Boolean));
    const delivered = deliveredSubmissionIds(runtime.session);
    const consumed = [];
    for (const row of rows) {
      const text = String(row?.text || '').trim();
      if (!text) continue;
      // Live enqueue already holds this row (id assigned before the async
      // disk write). Replaying it is the classic double-booked queue.
      if (row.steeringPersistId && livePersistIds.has(row.steeringPersistId)) continue;
      // Old process-local item counters can name unrelated submissions after
      // restart. Like idless legacy rows, use their unique disk row identity
      // and require review; an old it_N receipt cannot prove delivery.
      const hasStableSubmissionId = row.submissionId && !/^it_\d+$/.test(row.submissionId);
      const submissionId = hasStableSubmissionId ? row.submissionId : row.steeringPersistId;
      if (delivered.has(submissionId) || liveSubmissionIds.has(submissionId)) {
        consumed.push(row);
        submissions.remember(submissionId);
        continue;
      }
      const entry = queue.makeQueueEntry(row.content ?? row.text, {
        ...row,
        id: submissionId,
        displayText: row.text,
        recoveryNeedsReview: !hasStableSubmissionId || row.content === undefined,
      });
      pending.push(entry);
      submissions.remember(submissionId);
      liveSubmissionIds.add(submissionId);
      if (entry.steeringPersistId) livePersistIds.add(entry.steeringPersistId);
    }
    if (consumed.length > 0) await dropTuiSteeringPersist(leadSessionId(), consumed);
    // Resume clears the visible queue before this call. Republish live rows
    // too; an idempotent read must not hide entries already held in memory.
    set({ queued: pending.filter(isQueuedEntryVisible) });
    // The conversation closed while the rows were being read: settle them
    // explicitly (rejected + durable mirror released), never leave them parked.
    if (bag.flags?.admission === 'terminal') bag.settleClosedQueue?.();
    // A modern row retains its original delivery rules. Legacy rows cannot
    // establish their full payload or prior delivery and wait for an explicit
    // queue action, including through resume's commandBusy-release drain.
  }

  return {
    leadSessionId,
    shouldMirrorSteeringEntry,
    releaseSteeringQueueEntries,
    commitSteeringQueueEntries,
    settleSteeredSubmissions,
    hasPendingSteering,
    hasPendingUserInput,
    isDeliverableNotification,
    hasPendingNotification,
    taskWaitWakeForEntry,
    pendingTaskWaitWake,
    drainPendingSteering,
    restoreLeadSteeringFromDisk,
  };
}
