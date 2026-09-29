import { useCallback } from 'react';
import type { DesktopCapability, SessionSnapshot } from '../shared/contract';
import type { ComposerProps } from './Composer';

/** Capability calls issued by a composer, always addressed to the session IT paints. */
export function useComposerCapability({
  invokeResult,
  applySnapshot,
  sessionId,
}: {
  invokeResult: ComposerProps['invokeResult'];
  applySnapshot: (snapshot: SessionSnapshot | null) => void;
  sessionId?: string;
}) {
  const invokeCapabilityResult = useCallback(
    async <T>(capability: DesktopCapability, args: unknown[] = []) => {
      // Every command this composer issues belongs to the session IT paints —
      // the queue ×/Edit, /clear, /compact. Focus decides nothing.
      const result = await invokeResult(() =>
        window.mixdogDesktop.invokeCapability<T>({
          capability,
          args,
          ...(sessionId ? { sessionId } : {}),
        })
      );
      // Session commands already publish through the ordered session lane.
      // Their unversioned reply snapshot can arrive after a newer live frame;
      // replaying it here resurrected /compact's finished command spinner.
      if (!sessionId && result?.snapshot !== undefined) applySnapshot(result.snapshot);
      return result;
    },
    [applySnapshot, invokeResult, sessionId]
  );
  const invokeCapability = useCallback(
    async <T>(capability: DesktopCapability, args: unknown[] = []) =>
      (await invokeCapabilityResult<T>(capability, args))?.value,
    [invokeCapabilityResult]
  );
  return { invokeCapabilityResult, invokeCapability };
}
