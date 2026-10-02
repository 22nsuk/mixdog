import { paneLeafContainingKey, type PaneNode } from './pane-layout';
import { navigationKey } from './text-format';

/** The main process already foregrounded the app. A desktop notification
 * reveals an existing tab only; it must never reopen a closed conversation. */
export function focusOpenNotificationSession(
  workspace: { layout: PaneNode; activateTab(leafId: string, key: string): void },
  sessionId: string
): boolean {
  const key = navigationKey({ kind: 'session', id: sessionId });
  const owner = paneLeafContainingKey(workspace.layout, key);
  if (!owner) return false;
  workspace.activateTab(owner.id, key);
  return true;
}
