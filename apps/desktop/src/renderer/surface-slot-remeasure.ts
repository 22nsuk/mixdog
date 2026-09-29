import { useLayoutEffect, type RefObject } from 'react';

/** Re-measures a persistent surface's slot (resize, layout, finished
 *  transitions) through `controller.refresh`, coalesced to one per frame.
 *  `observeWorkspace` also watches the enclosing `.main-panel`, which an
 *  expanded surface follows instead of its slot. */
export function useSlotRemeasure(
  slotRef: RefObject<HTMLDivElement | null>,
  active: boolean,
  controller: { refresh(sessionId: string): void },
  sessionId: string,
  observeWorkspace = false
): void {
  useLayoutEffect(() => {
    const node = slotRef.current;
    if (!node || !active) return undefined;
    let frame = 0;
    const refresh = () => controller.refresh(sessionId);
    const schedule = () => {
      if (typeof window.requestAnimationFrame !== 'function') {
        refresh();
        return;
      }
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        refresh();
      });
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(node);
    const workspace = observeWorkspace ? node.closest('.main-panel') : null;
    if (workspace) observer?.observe(workspace);
    window.addEventListener('resize', schedule);
    // The phone dock SLIDES in: only the slot's position changes during the
    // transform, so a mid-slide rect would pin the surface off-screen. Any
    // finished transition re-measures.
    window.addEventListener('transitionend', schedule, true);
    schedule();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('transitionend', schedule, true);
    };
  }, [active, controller, observeWorkspace, sessionId, slotRef]);
}
