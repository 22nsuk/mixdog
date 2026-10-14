// Bounded read model of the existing session-scoped agentJobs projection.
// Unknown/legacy records never inherit the currently selected delegation mode.
const MODES = ['none', 'focused', 'balanced', 'swarm'];
const OUTCOMES = ['completed', 'failed', 'cancelled', 'partial'];
const PHASES = ['queued', 'preparing', 'running', 'finished'];
const row = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const text = (value) => (typeof value === 'string' ? value : '');
const number = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

export function delegationObservations(jobs, sessionId) {
  if (!Array.isArray(jobs) || typeof sessionId !== 'string' || !sessionId) {
    return { available: false, rows: [], unmeasured: 0, retained: null, inputMeasured: null, outputMeasured: null };
  }
  const byId = new Map();
  for (const value of jobs) {
    const job = row(value);
    const id = text(job.task_id) || text(job.taskId);
    if (id) byId.set(id, job);
  }
  let unmeasured = 0;
  const rows = [];
  for (const [id, job] of byId) {
    const observation = row(job.delegation);
    // The transport is session-scoped, but never count an explicitly foreign caller.
    if (text(observation.callerSessionId) && observation.callerSessionId !== sessionId) continue;
    if (observation.version !== 1 || observation.callerSessionId !== sessionId) {
      unmeasured += 1;
      continue;
    }
    const outcome = OUTCOMES.includes(observation.outcome) ? observation.outcome : null;
    rows.push({
      id,
      tag: text(job.tag),
      agent: text(job.agent),
      provider: text(job.provider),
      model: text(job.model),
      operation: job.type === 'spawn' || job.type === 'send' ? job.type : null,
      startedAt: text(job.startedAt),
      mode: MODES.includes(observation.mode) ? observation.mode : null,
      phase: PHASES.includes(observation.phase) ? observation.phase : null,
      outcome,
      queueWaitMs: number(observation.queueWaitMs),
      preparationMs: number(observation.preparationMs),
      executionMs: number(observation.executionMs),
      elapsedMs: number(observation.elapsedMs),
      inputTokens: number(observation.inputTokens),
      outputTokens: number(observation.outputTokens),
      toolCalls: number(observation.toolCalls),
    });
  }
  rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
  return {
    available: true,
    rows,
    unmeasured,
    retained: rows.length + unmeasured,
    inputMeasured: rows.filter((entry) => entry.inputTokens !== null).length,
    outputMeasured: rows.filter((entry) => entry.outputTokens !== null).length,
  };
}
