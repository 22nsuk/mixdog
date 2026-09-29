// Where the cross-process pending-message spool lives and how a session's touch
// stamp is recorded in it. Kept free of the queue machinery so the TUI steering
// mirror shares the exact same file without loading the runtime queue.
import { join } from 'node:path';
import { resolvePluginData } from '../../../../shared/plugin-paths.mjs';

export const PENDING_MESSAGES_MODE = 0o600;

export function pendingMessagesPath() {
  return join(resolvePluginData(), 'session-pending-messages.json');
}

export function touchPendingSessionEntry(next, sessionId, now = Date.now()) {
  if (!next.sessionTouchedAt || typeof next.sessionTouchedAt !== 'object') next.sessionTouchedAt = {};
  next.sessionTouchedAt[sessionId] = now;
}
