import type { DesktopModelSelection } from '../shared/contract';
import { t } from './i18n';

/** Confirm before any preview, preference write, or live-session mutation. */
export function confirmSessionModelChange(
  selection: Pick<DesktopModelSelection, 'provider' | 'model'>,
  current: Pick<DesktopModelSelection, 'provider' | 'model'>,
  sessionId?: string
): boolean {
  if (!sessionId || (selection.provider === current.provider && selection.model === current.model)) return true;
  return window.confirm(
    t(
      'Changing the model for this session may invalidate the prompt cache and increase the cost and latency of subsequent requests. The conversation will be kept. Change the model?'
    )
  );
}
