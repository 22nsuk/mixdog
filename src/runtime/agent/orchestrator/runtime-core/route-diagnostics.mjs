import { readRouteDiagnostics, routeSettingsSnapshot } from '../../../shared/route-diagnostics.mjs';
import { isActualUserInstructionMessage, isSummaryMessage } from '../session/compact/messages.mjs';

/** Runtime-only transcript inspection. The browser shares the bounded reader,
 * not the message classifier's Node-only compaction dependencies. */
export function inspectRouteDiagnostics(session, route = {}) {
  const current = session?.id ? session : route;
  const messages = Array.isArray(session?.liveTurnMessages) ? session.liveTurnMessages : session?.messages;
  let lastTurn = null;
  let stepEffort = null;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === 'user') {
        if (isSummaryMessage(message)) break;
        // A runtime-authored turn can have its own receipt. Even an invalid
        // receipt is a boundary: never borrow an older turn's preparation.
        const hasReceipt = Object.hasOwn(message.meta || {}, 'routeDiagnostics');
        if (!hasReceipt && !isActualUserInstructionMessage(message)) continue;
        if (hasReceipt) {
          const recordedEffort = routeSettingsSnapshot(message.meta?.effortConfiguration).effort;
          lastTurn = {
            ...message.meta.routeDiagnostics,
            recordedEffort: stepEffort || recordedEffort,
            effortSource: stepEffort ? 'tool-step' : recordedEffort ? 'turn-configuration' : 'not-recorded',
          };
        }
        break;
      }
      if (message?.role === 'tool' && !stepEffort) {
        stepEffort = routeSettingsSnapshot(message.meta?.effortConfiguration).effort;
      }
    }
  }
  // The same version, session binding and allowlists guard both boundaries.
  return readRouteDiagnostics({
    version: 1,
    sessionId: session?.id,
    current: routeSettingsSnapshot(current),
    currentSource: session?.id ? 'session' : 'route',
    lastTurn,
  });
}
