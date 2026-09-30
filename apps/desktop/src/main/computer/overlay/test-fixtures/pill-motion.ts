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

/** Press feedback must not shrink the area that accepts the eventual release. */
export async function checkOverlayControlHitTarget(
  contents: WebContents,
  selector: '#stop' | '#resume' = '#stop'
): Promise<void> {
  await contents.debugger.sendCommand('DOM.enable');
  await contents.debugger.sendCommand('CSS.enable');
  const { root } = await contents.debugger.sendCommand('DOM.getDocument');
  const { nodeId } = await contents.debugger.sendCommand('DOM.querySelector', {
    nodeId: root.nodeId,
    selector,
  });
  const inspect = `(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    for (const animation of button.getAnimations({subtree:true})) animation.finish();
    const rect = button.getBoundingClientRect();
    return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
  })()`;
  const resting = await contents.executeJavaScript(inspect);
  try {
    await contents.debugger.sendCommand('CSS.forcePseudoState', {
      nodeId,
      forcedPseudoClasses: ['hover', 'active'],
    });
    const pressed = await contents.executeJavaScript(inspect);
    assert.deepEqual(pressed, resting, `pressing ${selector} must not move or shrink its clickable bounds`);
    const edgesReachable = await contents.executeJavaScript(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      const rect = ${JSON.stringify(resting)};
      return [
        [rect.x + rect.width / 2, rect.y + 1],
        [rect.x + 1, rect.y + rect.height / 2],
      ].every(([x,y]) => button.contains(document.elementFromPoint(x,y)));
    })()`);
    assert.equal(edgesReachable, true, `pressing ${selector} must keep its edges clickable`);
  } finally {
    await contents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    await contents.executeJavaScript(inspect);
  }
}
