// Open/close motion for the chrome stacked above the composer. Every dock slot
// sits in flow, so its height comes out of the transcript viewport: a slot that
// lands or leaves in one frame moved the pinned transcript by its whole height
// at once (user: 트랜스크립트가 컴포저 위에 붙을 때 들썩인다). Animating the
// slot's own box over the motion clock lets the follow hook re-pin the tail at
// every step. A conversation that is still entering takes its chrome in place,
// and a slot outside a conversation never moves.

type DockSlotMotion = { height: string; margin: string; timing: KeyframeAnimationOptions };

function dockSlotMotion(slot: HTMLElement): DockSlotMotion | null {
  const conversation = slot.closest<HTMLElement>('.conversation');
  if (!conversation || conversation.dataset.transcriptEntering === 'true') return null;
  const style = window.getComputedStyle(slot);
  return {
    height: `${slot.getBoundingClientRect().height}px`,
    margin: style.marginBottom,
    timing: {
      duration: Number.parseFloat(style.getPropertyValue('--mx-motion-base')),
      easing: style.getPropertyValue('--mx-ease-standard').trim(),
    },
  };
}

const CLOSED: Keyframe = { height: '0px', marginBottom: '0px', opacity: 0, overflow: 'hidden' };

/** Grows a slot that just appeared from nothing to its laid-out height. */
export function openDockSlot(slot: HTMLElement): Animation | null {
  const motion = dockSlotMotion(slot);
  if (!motion) return null;
  const open: Keyframe = { height: motion.height, marginBottom: motion.margin, opacity: 1, overflow: 'hidden' };
  return slot.animate([CLOSED, open], motion.timing);
}

/** Collapses a leaving slot; it holds zero height once the collapse ends. */
export function closeDockSlot(slot: HTMLElement): Animation | null {
  const motion = dockSlotMotion(slot);
  if (!motion) return null;
  const open: Keyframe = { height: motion.height, marginBottom: motion.margin, opacity: 1, overflow: 'hidden' };
  return slot.animate([open, CLOSED], { ...motion.timing, fill: 'forwards' });
}
