/** Wait for fonts and two paint frames, then fast-forward every finite
 *  animation. Hidden windows can suspend animation timelines, so a probe would
 *  otherwise capture an arbitrary partly transparent entry frame instead of the
 *  settled production appearance. */
export async function settleFrames(leadingDelayMs = 0): Promise<void> {
  if (leadingDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, leadingDelayMs));
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  for (const animation of document.getAnimations()) {
    if (Number.isFinite(animation.effect?.getTiming().iterations)) animation.finish();
  }
}
