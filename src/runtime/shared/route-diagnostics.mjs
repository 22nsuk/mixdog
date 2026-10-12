// Bounded, body-free evidence for /context. These are runtime preparations,
// not captures of provider wire payloads or guarantees of provider acceptance.
// Old turns have no receipt: never reconstruct one from today's settings.
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const MODES = new Set(['off', 'observe', 'on']);
const REASONS = new Set([
  'configuration-unavailable', 'master-off', 'route-off', 'runtime-prompt', 'empty-or-tagged-prompt',
  'unsupported-route', 'judge-unavailable', 'outside-auto-range', 'observe-only', 'selected',
]);
// judge-client returns these codes, plus error text. Never expose that text.
const JUDGE_STATES = new Set(['unsupported', 'installing', 'model-missing', 'warming', 'busy', 'timeout', 'load-error', 'worker-exited', 'other']);
function judgeState(value) {
  if (JUDGE_STATES.has(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('load-error:')) return 'load-error';
  if (value === 'effort judge exited') return 'worker-exited';
  return 'other';
}
const TIERS = new Set(['auto', 'default', 'priority', 'flex', 'scale', 'ultrafast']);
const own = (value, key) => Object.hasOwn(value || {}, key);
const text = (value) => typeof value === 'string' && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value || null : null;
const effort = (value) => EFFORTS.has(value) ? value : null;
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const flag = (value) => typeof value === 'boolean' ? value : null;

/** Only known, non-secret route fields. Never copy arbitrary provider params. */
export function routeSettingsSnapshot(route = {}) {
  route = route && typeof route === 'object' && !Array.isArray(route) ? route : {};
  return {
    provider: text(route.provider),
    model: text(route.model),
    effort: effort(route.effort),
    fast: flag(route.fast),
    autoEffort: route.autoEffort !== false,
    autoEffortSource: own(route, 'autoEffort') ? 'recorded-field' : 'implicit-default',
    contextWindow: number(route.contextWindow),
    serviceTier: TIERS.has(route.modelParameters?.service_tier) ? route.modelParameters.service_tier : null,
  };
}

export function autoEffortDecisionSnapshot(value = {}) {
  value = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    mode: MODES.has(value.mode) ? value.mode : null,
    source: ['environment', 'built-in', 'unavailable'].includes(value.source) ? value.source : null,
    reason: REASONS.has(value.reason) ? value.reason : null,
    judge: judgeState(value.judge),
    selectedEffort: effort(value.selectedEffort),
    applied: flag(value.applied),
  };
}

/** Called only by the turn owner, before the user message's preflight save. */
export function captureRouteDiagnostics(session, { decision, turnEffort, at } = {}) {
  return {
    version: 1,
    sessionId: text(session?.id),
    at: number(at),
    configured: routeSettingsSnapshot(session),
    auto: autoEffortDecisionSnapshot(decision),
    preparedEffort: effort(turnEffort),
  };
}

function readReceipt(value) {
  if (value?.version !== 1 || !text(value.sessionId) || !value.configured || typeof value.configured !== 'object' || Array.isArray(value.configured) || typeof value.configured.autoEffort !== 'boolean') return null;
  const configured = routeSettingsSnapshot(value.configured);
  configured.serviceTier = TIERS.has(value.configured.serviceTier) ? value.configured.serviceTier : null;
  // The receipt was already normalized. Preserve the original evidence of
  // absent-vs-recorded Auto, not the property our own snapshot always writes.
  configured.autoEffortSource = ['recorded-field', 'implicit-default'].includes(value.configured.autoEffortSource)
    ? value.configured.autoEffortSource : 'unknown';
  return {
    version: 1,
    sessionId: text(value.sessionId),
    at: number(value.at),
    configured,
    auto: autoEffortDecisionSnapshot(value.auto),
    preparedEffort: effort(value.preparedEffort),
  };
}

/** Fresh per call, outside the context token cache. No disk, model or logs. */
export function inspectRouteDiagnostics(session, route = {}) {
  const current = session?.id ? session : route;
  const messages = Array.isArray(session?.liveTurnMessages) ? session.liveTurnMessages : session?.messages;
  let lastTurn = null;
  let stepEffort = null;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === 'user') {
        const receipt = readReceipt(message.meta?.routeDiagnostics);
        if (receipt && receipt.sessionId === text(session?.id)) {
          const recordedEffort = effort(message.meta?.effortConfiguration?.effort);
          lastTurn = {
            ...receipt,
            recordedEffort: stepEffort || recordedEffort,
            effortSource: stepEffort ? 'tool-step' : recordedEffort ? 'turn-configuration' : 'not-recorded',
          };
        }
        // A legacy or new unrecorded user turn invalidates older receipts.
        break;
      }
      if (message?.role === 'tool' && !stepEffort) stepEffort = effort(message.meta?.effortConfiguration?.effort);
    }
  }
  return {
    version: 1,
    sessionId: text(session?.id),
    current: routeSettingsSnapshot(current),
    currentSource: session?.id ? 'session' : 'route',
    lastTurn,
    // An explicit boundary, not a success-looking fallback.
    evidence: 'runtime-prepared-not-provider-confirmed',
  };
}

/** Validate a diagnostics response independently of host/client version. */
export function readRouteDiagnostics(value, sessionId) {
  if (value?.version !== 1 || !value.current || typeof value.current.autoEffort !== 'boolean') return null;
  if (sessionId !== undefined && text(value.sessionId) !== text(sessionId)) return null;
  const current = routeSettingsSnapshot(value.current);
  current.serviceTier = TIERS.has(value.current.serviceTier) ? value.current.serviceTier : null;
  current.autoEffortSource = ['recorded-field', 'implicit-default'].includes(value.current.autoEffortSource) ? value.current.autoEffortSource : 'unknown';
  const receipt = readReceipt(value.lastTurn);
  return {
    version: 1,
    sessionId: text(value.sessionId),
    current,
    currentSource: ['session', 'route'].includes(value.currentSource) ? value.currentSource : 'unknown',
    lastTurn: receipt && receipt.sessionId === text(value.sessionId) ? {
      ...receipt,
      recordedEffort: effort(value.lastTurn.recordedEffort),
      effortSource: ['tool-step', 'turn-configuration'].includes(value.lastTurn.effortSource) ? value.lastTurn.effortSource : 'not-recorded',
    } : null,
    evidence: 'runtime-prepared-not-provider-confirmed',
  };
}
