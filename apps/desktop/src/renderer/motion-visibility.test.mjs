import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  actEnvironment: false,
});

let visibilityState = 'visible';
Object.defineProperty(dom.window.document, 'visibilityState', {
  configurable: true,
  get: () => visibilityState,
});

const { installMotionVisibility } = await import('./motion-visibility.ts');
const root = dom.window.document.documentElement;

test('foreground lifecycle signals release a missed mobile animation pause', () => {
  const uninstall = installMotionVisibility();
  try {
    assert.equal(root.dataset.mixdogMotion, 'running');

    visibilityState = 'hidden';
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    assert.equal(root.dataset.mixdogMotion, 'paused');

    visibilityState = 'visible';
    window.dispatchEvent(new dom.window.Event('pageshow'));
    assert.equal(root.dataset.mixdogMotion, 'running');

    visibilityState = 'hidden';
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    visibilityState = 'visible';
    window.dispatchEvent(new dom.window.Event('focus'));
    assert.equal(root.dataset.mixdogMotion, 'running');
  } finally {
    uninstall();
  }
  assert.equal(root.dataset.mixdogMotion, undefined);
});

test('an uninstalled tracker no longer changes the motion state', () => {
  installMotionVisibility()();
  visibilityState = 'hidden';
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.equal(root.dataset.mixdogMotion, undefined);
});
