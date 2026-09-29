import assert from 'node:assert/strict';
import type { WebContents } from 'electron';

/** Pins prefers-reduced-motion through the already attached debugger, independent of the host's own setting. */
export async function emulateMotionPreference(contents: WebContents, value: 'no-preference' | 'reduce'): Promise<void> {
  await contents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value }],
  });
}

/** Work in progress shows as one turning mark that never covers Stop and rests under reduced motion. */
export async function checkOverlayPulse(contents: WebContents): Promise<void> {
  const active = await contents.executeJavaScript(`(() => {
    const animation = document.getElementById('mark').getAnimations({ subtree: true })[0];
    const button = document.getElementById('stop');
    const bounds = button.getBoundingClientRect();
    return {
      running: animation?.playState === 'running',
      repeating: animation?.effect.getTiming().iterations === Infinity,
      controlsReachable: button.contains(document.elementFromPoint(
        bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)),
    };
  })()`);
  assert.equal(active.running, true, 'the working mark must turn');
  assert.equal(active.repeating, true);
  assert.equal(active.controlsReachable, true, 'nothing may cover the control');
  await emulateMotionPreference(contents, 'reduce');
  try {
    const moving = await contents.executeJavaScript(
      `document.getElementById('mark').getAnimations({ subtree: true }).some((animation) => animation.playState === 'running')`
    );
    assert.equal(moving, false, 'reduced motion must rest the mark');
  } finally {
    await emulateMotionPreference(contents, 'no-preference');
  }
}
