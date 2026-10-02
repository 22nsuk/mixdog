/** Both frame routes refuse transforms they cannot map exactly before input. */
export const BROWSER_FRAME_HAS_TRANSFORM = `function(frame) {
  for (let node = frame; node; node = node.parentElement || node.getRootNode?.().host) {
    const transform = frame.ownerDocument.defaultView.getComputedStyle(node).transform;
    if (transform && transform !== 'none') return true;
  }
  return false;
}`;
