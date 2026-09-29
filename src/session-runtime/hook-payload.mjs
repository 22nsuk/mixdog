/**
 * src/session-runtime/hook-payload.mjs - common payload fields for hook
 * dispatch (session id, transcript path, cwd, permission mode, effort).
 */
import { join } from 'node:path';
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { pluginDataDir } from './runtime-paths.mjs';
import { SESSION_ID_PATTERN } from '../runtime/agent/orchestrator/runtime-core/session-id.mjs';

export function createHookPayload({ rt, cfgMod }) {
  function hookTranscriptPath(sessionId) {
    const id = clean(sessionId);
    if (!id || !SESSION_ID_PATTERN.test(id)) return null;
    return join(pluginDataDir(cfgMod), 'sessions', `${id}.json`);
  }
  function hookEffortPayload() {
    const level = clean(rt.route.effectiveEffort || rt.route.effort);
    return level ? { level: level.toLowerCase() } : undefined;
  }
  function hookCommonPayload(extra = {}) {
    const sid = clean(extra.session_id || extra.sessionId || rt.session?.id);
    const effort = hookEffortPayload();
    return {
      ...(sid ? { session_id: sid, transcript_path: hookTranscriptPath(sid) } : {}),
      cwd: rt.currentCwd,
      permission_mode: rt.session?.permissionMode || 'default',
      ...(effort ? { effort } : {}),
      ...extra,
    };
  }
  return { hookCommonPayload };
}
