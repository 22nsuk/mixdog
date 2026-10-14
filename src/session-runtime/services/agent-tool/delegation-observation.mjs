// Read-only, process-local observations of agent background jobs. One job's
// first reported outcome is the boundary, NOT session lifetime usage or proof
// of correctness. No prompts, results, prices or authorization live here.
import { performance } from 'node:perf_hooks';
import { ORCHESTRATION_MODES } from '../../../runtime/shared/orchestration.mjs';

const clocks = new WeakMap();
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const elapsed = (start, end) => Math.max(0, Math.round(end - start));

export function beginDelegationObservation(job, context = {}, now = performance.now()) {
  if (!job?.meta || clocks.has(job)) return;
  const mode = ORCHESTRATION_MODES.includes(context.orchestrationMode) ? context.orchestrationMode : null;
  job.meta.delegation = Object.freeze({
    version: 1,
    callerSessionId: typeof context.callerSessionId === 'string' ? context.callerSessionId : null,
    mode,
    phase: 'queued',
    outcome: null,
    queueWaitMs: null,
    preparationMs: null,
    executionMs: null,
    elapsedMs: null,
    inputTokens: null,
    outputTokens: null,
    toolCalls: null,
  });
  clocks.set(job, { requested: now, admitted: null, running: null, finished: false });
}

export function admitDelegationObservation(job, now = performance.now()) {
  const timing = clocks.get(job);
  if (!timing || timing.finished || timing.admitted !== null) return;
  timing.admitted = now;
  job.meta.delegation = Object.freeze({
    ...job.meta.delegation,
    phase: 'preparing',
    queueWaitMs: elapsed(timing.requested, now),
  });
}

export function runDelegationObservation(job, now = performance.now()) {
  const timing = clocks.get(job);
  if (!timing || timing.finished || timing.running !== null) return;
  timing.running = now;
  job.meta.delegation = Object.freeze({
    ...job.meta.delegation,
    phase: 'running',
    preparationMs: timing.admitted === null ? null : elapsed(timing.admitted, now),
  });
}

/** Freeze once, including cancellation BEFORE a provider's late result. Missing
 *  usage stays unknown; never subtract cumulative counters from reused workers.
 *  The raw terminal result must be supplied before handoff rendering drops usage.
 *  Queued follow-ups are not additional job samples. */
export function finishDelegationObservation(job, outcome, result = null, now = performance.now()) {
  const timing = clocks.get(job);
  if (!timing || timing.finished) return;
  if (!['completed', 'failed', 'cancelled', 'partial'].includes(outcome)) return;
  if (job.status === 'cancelled') {
    outcome = 'cancelled';
    result = null;
  }
  timing.finished = true;
  const observation = job.meta.delegation;
  job.meta.delegation = Object.freeze({
    ...observation,
    phase: 'finished',
    outcome,
    queueWaitMs: observation.queueWaitMs ?? elapsed(timing.requested, now),
    preparationMs: timing.admitted === null ? null : (observation.preparationMs ?? elapsed(timing.admitted, now)),
    executionMs: timing.running === null ? null : elapsed(timing.running, now),
    elapsedMs: elapsed(timing.requested, now),
    inputTokens: count(result?.usage?.inputTokens),
    outputTokens: count(result?.usage?.outputTokens),
    toolCalls: count(result?.toolCallsTotal),
  });
}
